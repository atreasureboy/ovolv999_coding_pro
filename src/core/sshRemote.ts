/**
 * SSH Remote Sessions
 *
 * Execute agent operations on a remote machine via SSH. The remote
 * host must have ovolv999 (or at least Node.js) installed.
 *
 * Workflow:
 *   1. connect(host)              — verify SSH connectivity + tools
 *   2. syncUp(host, localPath)     — rsync local dir → remote
 *   3. runRemote(host, command)    — execute, stream stdout/stderr back
 *   4. syncDown(host, remotePath)  — rsync remote → local (fetch results)
 *   5. disconnect(host)            — cleanup
 *
 * Connection profiles are stored in ~/.ovolv999/ssh-profiles.json so
 * the user configures each host once. Supports SSH config inheritance
 * (~/.ssh/config), key-based auth, and jump hosts (ProxyJump).
 */

import { execSync } from 'child_process'
import { existsSync, readFileSync } from 'fs'
import { atomicWriteSync, preserveCorruptFile } from './atomicWrite.js'
import { shellQuote } from '../utils/shellQuote.js'
import { join } from 'path'
import { homedir } from 'os'

// ── Types ───────────────────────────────────────────────────────────────────

export interface SshProfile {
  name: string
  host: string
  /** SSH user (default: current user) */
  user?: string
  /** SSH port (default: 22) */
  port?: number
  /** Identity file path */
  identityFile?: string
  /** Jump host (ProxyJump) */
  proxyJump?: string
  /** Remote working directory base */
  remoteBase?: string
  /** Known host fingerprint (optional, for verification) */
  knownHostFingerprint?: string
  /** Connection timeout (ms) */
  timeoutMs?: number
}

export interface SshExecResult {
  exitCode: number
  stdout: string
  stderr: string
  duration: number
}

export interface SshExecOptions {
  /** Working directory on the remote */
  cwd?: string
  /** Timeout (ms) */
  timeoutMs?: number
  /** Environment variables to set on the remote */
  env?: Record<string, string>
  /** Stream stdout/stderr line by line via callback */
  onStdout?: (line: string) => void
  onStderr?: (line: string) => void
}

export interface SshConnectionTest {
  connected: boolean
  latency: number
  version?: string
  error?: string
}

// ── Profile Storage ─────────────────────────────────────────────────────────

function getProfilesPath(): string {
  return join(homedir(), '.ovolv999', 'ssh-profiles.json')
}

function isShapedProfile(p: unknown): p is SshProfile {
  return (
    typeof p === 'object' && p !== null &&
    typeof (p as SshProfile).name === 'string' &&
    typeof (p as SshProfile).host === 'string'
  )
}

export function loadProfiles(): SshProfile[] {
  const path = getProfilesPath()
  if (!existsSync(path)) return []
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'))
    // name/host are dereferenced unguarded by buildSshArgs and the remove
    // filter — a half-written entry must not load.
    if (!Array.isArray(parsed) || !parsed.every(isShapedProfile)) {
      throw new Error('ssh profile store shape violation')
    }
    return parsed
  } catch {
    // §ssh-profiles: profiles are user-configured host definitions
    // (identity paths, jump hosts) — preserve the corrupt bytes before
    // resetting, or the next addProfile/removeProfile destroys them all.
    preserveCorruptFile(path)
    return []
  }
}

export function saveProfiles(profiles: SshProfile[]): void {
  atomicWriteSync(getProfilesPath(), JSON.stringify(profiles, null, 2))
}

export function getProfile(name: string): SshProfile | undefined {
  return loadProfiles().find((p) => p.name === name)
}

export function addProfile(profile: SshProfile): SshProfile[] {
  const profiles = loadProfiles().filter((p) => p.name !== profile.name)
  profiles.push(profile)
  saveProfiles(profiles)
  return profiles
}

export function removeProfile(name: string): boolean {
  const profiles = loadProfiles()
  const filtered = profiles.filter((p) => p.name !== name)
  if (filtered.length === profiles.length) return false
  saveProfiles(filtered)
  return true
}

// ── SSH Command Building ────────────────────────────────────────────────────

export function buildSshArgs(profile: SshProfile, remoteCommand?: string): string[] {
  const args: string[] = []

  if (profile.port) args.push('-p', String(profile.port))
  if (profile.identityFile) args.push('-i', profile.identityFile)
  if (profile.proxyJump) args.push('-J', profile.proxyJump)

  // BatchMode for non-interactive. StrictHostKeyChecking defaults to
  // accept-new (TOFU); set OVOLV999_SSH_STRICT_HOST_KEY=1 to require a
  // pre-known host key (fails on first connect to any new host) for
  // environments where first-connection MITM is in scope.
  args.push('-o', 'BatchMode=yes')
  args.push('-o', `StrictHostKeyChecking=${process.env.OVOLV999_SSH_STRICT_HOST_KEY === '1' ? 'yes' : 'accept-new'}`)
  args.push('-o', `ConnectTimeout=${Math.floor((profile.timeoutMs ?? 10000) / 1000)}`)

  // Target
  const target = profile.user ? `${profile.user}@${profile.host}` : profile.host
  args.push(target)

  if (remoteCommand) args.push(remoteCommand)

  return args
}

function buildRsyncArgs(
  profile: SshProfile,
  src: string,
  dst: string,
  direction: 'up' | 'down',
): string[] {
  const args: string[] = ['-avz', '--delete']

  // Rsync uses -e to specify the remote shell
  const sshArgs = buildSshArgs(profile).filter((a) => a !== targetStr(profile))
  args.push('-e', `ssh ${sshArgs.join(' ')}`)

  const remoteTarget = targetStr(profile)
  const remoteBase = profile.remoteBase ?? '~/ovolv999-remote'

  if (direction === 'up') {
    args.push(src + '/', `${remoteTarget}:${join(remoteBase, dst)}`)
  } else {
    args.push(`${remoteTarget}:${join(remoteBase, src)}/`, dst)
  }

  return args
}

function targetStr(profile: SshProfile): string {
  return profile.user ? `${profile.user}@${profile.host}` : profile.host
}

// ── Connection Test ─────────────────────────────────────────────────────────

export function testConnection(profile: SshProfile): SshConnectionTest {
  const start = Date.now()
  try {
    const args = buildSshArgs(profile, 'echo "__OVOLV999_SSH_OK__"; node --version 2>/dev/null || echo "no-node"')
    const result = execSync(`ssh ${args.map(shellQuote).join(' ')}`, {
      encoding: 'utf8',
      stdio: 'pipe',
      timeout: profile.timeoutMs ?? 10000,
    })
    const latency = Date.now() - start

    if (result.includes('__OVOLV999_SSH_OK__')) {
      const versionMatch = result.match(/v(\d+\.\d+\.\d+)/)
      return {
        connected: true,
        latency,
        version: versionMatch ? `node ${versionMatch[0]}` : 'no-node',
      }
    }
    return { connected: false, latency, error: 'Unexpected response' }
  } catch (err) {
    return {
      connected: false,
      latency: Date.now() - start,
      error: err instanceof Error ? err.message : String(err),
    }
  }
}

// ── Remote Execution ────────────────────────────────────────────────────────

export function execRemote(profile: SshProfile, command: string, options: SshExecOptions = {}): SshExecResult {
  const start = Date.now()

  // Build the remote command with optional cwd + env
  let remoteCmd = command
  if (options.cwd) {
    remoteCmd = `cd ${shellQuote(options.cwd)} && ${remoteCmd}`
  }
  if (options.env) {
    const envPrefix = Object.entries(options.env)
      .map(([k, v]) => `${k}=${shellQuote(v)}`)
      .join(' ')
    remoteCmd = `${envPrefix} ${remoteCmd}`
  }

  const args = buildSshArgs(profile, remoteCmd)
  const execOptions = {
    encoding: 'utf8' as const,
    stdio: ['pipe', 'pipe', 'pipe'] as ['pipe', 'pipe', 'pipe'],
    timeout: options.timeoutMs ?? 120000,
  }

  try {
    const stdout = execSync(`ssh ${args.map(shellQuote).join(' ')}`, execOptions)

    // Stream lines if callbacks provided
    if (options.onStdout) {
      for (const line of stdout.split('\n')) {
        if (line) options.onStdout(line)
      }
    }

    return {
      exitCode: 0,
      stdout,
      stderr: '',
      duration: Date.now() - start,
    }
  } catch (err) {
    const e = err as { status?: number; stdout?: string; stderr?: string; message: string }
    if (options.onStderr && e.stderr) {
      for (const line of e.stderr.split('\n')) {
        if (line) options.onStderr(line)
      }
    }
    return {
      exitCode: e.status ?? 1,
      stdout: e.stdout ?? '',
      stderr: e.stderr ?? e.message,
      duration: Date.now() - start,
    }
  }
}

// ── File Sync ───────────────────────────────────────────────────────────────

export function syncUp(profile: SshProfile, localPath: string, remoteSubdir: string = '.'): boolean {
  const remoteBase = profile.remoteBase ?? '~/ovolv999-remote'
  // Ensure remote base exists
  execRemote(profile, `mkdir -p ${shellQuote(remoteBase)}`)
  const args = buildRsyncArgs(profile, localPath, remoteSubdir, 'up')
  try {
    execSync(`rsync ${args.map(shellQuote).join(' ')}`, {
      encoding: 'utf8',
      stdio: 'pipe',
      timeout: 120000,
    })
    return true
  } catch {
    return false
  }
}

export function syncDown(profile: SshProfile, remoteSubdir: string, localPath: string): boolean {
  const args = buildRsyncArgs(profile, remoteSubdir, localPath, 'down')
  try {
    execSync(`rsync ${args.map(shellQuote).join(' ')}`, {
      encoding: 'utf8',
      stdio: 'pipe',
      timeout: 120000,
    })
    return true
  } catch {
    return false
  }
}

// ── Remote Agent Session ────────────────────────────────────────────────────

export interface RemoteAgentOptions {
  task: string
  syncBefore?: boolean
  syncAfter?: boolean
  model?: string
  timeoutMs?: number
  onOutput?: (line: string) => void
}

export interface RemoteAgentResult {
  success: boolean
  output: string
  duration: number
  syncedUp: boolean
  syncedDown: boolean
}

/**
 * Run a full agent task on the remote host. Optionally syncs the
 * working directory up before and down after.
 */
export function runRemoteAgent(profile: SshProfile, options: RemoteAgentOptions): RemoteAgentResult {
  const start = Date.now()
  const remoteBase = profile.remoteBase ?? '~/ovolv999-remote'
  let syncedUp = false
  let syncedDown = false

  // Sync up
  if (options.syncBefore) {
    syncedUp = syncUp(profile, '.', '.')
  }

  // Build the remote ovolv999 command
  let cmd = 'ovolv999'
  if (options.model) cmd += ` --model ${shellQuote(options.model)}`
  cmd += ` --llm-only`  // v0.4.1 WS3: frozen raw single-shot path (--pipe now runs the full engine; latency/semantics contract preserved here)
  cmd += ` ${shellQuote(options.task)}`

  const result = execRemote(profile, cmd, {
    cwd: remoteBase,
    timeoutMs: options.timeoutMs ?? 600000,
    onStdout: options.onOutput,
    onStderr: options.onOutput,
  })

  // Sync down
  if (options.syncAfter) {
    syncedDown = syncDown(profile, '.', '.')
  }

  return {
    success: result.exitCode === 0,
    output: result.stdout + (result.stderr ? '\n' + result.stderr : ''),
    duration: Date.now() - start,
    syncedUp,
    syncedDown,
  }
}

// ── Formatting ──────────────────────────────────────────────────────────────

export function formatProfile(profile: SshProfile): string {
  const lines = [
    `SSH Profile: ${profile.name}`,
    `  Host: ${profile.host}`,
  ]
  if (profile.user) lines.push(`  User: ${profile.user}`)
  if (profile.port) lines.push(`  Port: ${profile.port}`)
  if (profile.identityFile) lines.push(`  Key: ${profile.identityFile}`)
  if (profile.proxyJump) lines.push(`  ProxyJump: ${profile.proxyJump}`)
  if (profile.remoteBase) lines.push(`  Remote base: ${profile.remoteBase}`)
  return lines.join('\n')
}

export function formatProfileList(profiles: SshProfile[]): string {
  if (profiles.length === 0) return 'No SSH profiles configured.'
  const lines = ['SSH profiles:']
  for (const p of profiles) {
    const target = p.user ? `${p.user}@${p.host}` : p.host
    const port = p.port ? `:${p.port}` : ''
    lines.push(`  ${p.name} → ${target}${port}`)
  }
  return lines.join('\n')
}

export function formatConnectionTest(test: SshConnectionTest): string {
  if (test.connected) {
    return `Connected (${test.latency}ms)${test.version ? ` — ${test.version}` : ''}`
  }
  return `Connection failed (${test.latency}ms): ${test.error ?? 'unknown error'}`
}

export function formatExecResult(result: SshExecResult): string {
  const lines = [
    `Exit code: ${result.exitCode}`,
    `Duration: ${result.duration}ms`,
  ]
  if (result.stdout) lines.push('', 'stdout:', result.stdout.trimEnd())
  if (result.stderr) lines.push('', 'stderr:', result.stderr.trimEnd())
  return lines.join('\n')
}
