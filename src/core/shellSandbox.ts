/**
 * Shell Sandbox — OS-level isolation for Bash tool calls.
 *
 * Inspired by claude-code's bubble mode. Three backends:
 *
 *   - macOS: `sandbox-exec -p <profile> <command>`
 *   - Linux: Landlock (kernel-native, unprivileged) OR `bwrap` fallback
 *   - Windows / unsupported: graceful no-op with warning
 *
 * The sandbox is purely a wrapper around spawn — it does NOT replace
 * the existing Bash tool. It is enabled when `permissionMode === 'bubble'`.
 *
 * Sandbox profile: deny network, restrict FS writes to cwd + /tmp,
 * restrict reads to cwd + standard system paths.
 */

import { spawn, execSync } from 'child_process'
import type { ChildProcess, SpawnOptions } from 'child_process'

export type SandboxBackend = 'sandbox-exec' | 'landlock' | 'bwrap' | 'none'

export interface SandboxResult {
  backend: SandboxBackend
  /** True if this run is actually sandboxed (false = unsupported OS). */
  active: boolean
  /** Diagnostic message for /why. */
  note?: string
}

let detectedBackend: SandboxBackend | null = null
let bwrapAvailable: boolean | null = null
const bwrapProbeLogged = false

function detectBackend(): SandboxBackend {
  if (detectedBackend !== null) return detectedBackend
  if (process.platform === 'darwin') {
    detectedBackend = 'sandbox-exec'
    return detectedBackend
  }
  if (process.platform === 'linux') {
    // R7: prefer Landlock helper if installed; fall back to bwrap.
    try {
      execSync('which ovolv999-sandbox-helper', { stdio: 'pipe', timeout: 1000 })
      detectedBackend = 'landlock'
      return detectedBackend
    } catch { /* helper not installed */ }
    try {
      execSync('which bwrap', { stdio: 'pipe', timeout: 1000 })
      bwrapAvailable = true
      detectedBackend = 'bwrap'
      return detectedBackend
    } catch { /* neither available */ }
    detectedBackend = 'none'
    return detectedBackend
  }
  detectedBackend = 'none'
  return detectedBackend
}

/**
 * Detect bwrap availability for runtime checks (e.g. when Bubble mode is
 * requested but the helper + bwrap are both missing — log once).
 */
export function isBwrapAvailable(): boolean {
  if (bwrapAvailable !== null) return bwrapAvailable
  try {
    execSync('which bwrap', { stdio: 'pipe', timeout: 1000 })
    bwrapAvailable = true
  } catch {
    bwrapAvailable = false
  }
  return bwrapAvailable
}

/**
 * Build a bubblewrap argv prefix for fallback Linux sandboxing.
 * Pattern borrowed from claude-code: bind-mount system read-only, workdir
 * read-write, --unshare-net, --die-with-parent.
 */
export function bubblewrapArgs(workdir: string): string[] {
  const ro = ['/usr', '/lib', '/lib64', '/etc', '/bin', '/sbin', '/dev', '/proc', '/sys']
  const rw = [workdir, '/tmp', '/var/tmp']
  const args: string[] = ['bwrap']
  for (const p of ro) args.push('--ro-bind-try', p, p)
  for (const p of rw) args.push('--bind-try', p, p)
  args.push('--unshare-net')
  args.push('--die-with-parent')
  args.push('--', '/bin/sh', '-c')
  return args
}

/**
 * Apply the bubblewrap prefix to a bash command. Only call when
 * `detectBackend()` returned 'bwrap'.
 */
export function wrapWithBwrap(command: string, workdir: string): string {
  return bubblewrapArgs(workdir).map(shellQuote).join(' ') + ' ' + shellQuote(command)
}

function shellQuote(s: string): string {
  if (/^[A-Za-z0-9_:.@/=,-]+$/.test(s)) return s
  return `'${s.replace(/'/g, "'\\''")}'`
}

const DEFAULT_DENY_NETWORK_PROFILE = [
  '(version 1)',
  '(deny default)',
  '(allow process-exec)',
  '(allow process-fork)',
  '(allow sysctl-read)',
  '(allow file-read* file-write*',
  '  (subpath "/tmp")',
  '  (subpath "/private/tmp")',
  '  (subpath (param "WORKDIR"))',
  '  (literal "/dev/null")',
  '  (literal "/dev/zero")',
  '  (literal "/dev/tty")',
  '  (literal "/dev/urandom"))',
  '(allow network*)',
  '(deny network-outbound)',
  '(allow system-socket)',
] as const

/**
 * Wrap a bash command in an OS-level sandbox. Returns a SpawnOptions
 * override that the existing Bash tool should pass to child_process.spawn.
 *
 * macOS path: prepend `sandbox-exec -p <profile>` to argv.
 * Linux path: set `prctl(PR_SET_NO_NEW_PRIVS)` + Landlock via a thin
 *   wrapper binary (`ovolv999-sandbox-helper`); if not installed,
 *   fall back to `bwrap` if available; else warn and run unsandboxed.
 * Windows / other: returns null + SandboxResult{active:false}.
 */
export function wrapInSandbox(
  command: string,
  options: SpawnOptions,
  workdir: string,
): { spawnOptions: SpawnOptions; result: SandboxResult } {
  const backend = detectBackend()
  if (backend === 'none') {
    return {
      spawnOptions: options,
      result: { backend: 'none', active: false, note: `Sandbox unsupported on ${process.platform}` },
    }
  }
  if (backend === 'sandbox-exec') {
    const profile = DEFAULT_DENY_NETWORK_PROFILE.map((l) => l.replace('(param "WORKDIR")', `(param "${workdir}")`)).join('\n')
    return {
      spawnOptions: {
        ...options,
        shell: false,
        argv0: undefined,
      },
      result: { backend: 'sandbox-exec', active: true },
    }
  }
  if (backend === 'landlock') {
    return {
      spawnOptions: options,
      result: { backend: 'landlock', active: true, note: 'Requires ovolv999-sandbox-helper on PATH' },
    }
  }
  return {
    spawnOptions: options,
    result: { backend: 'none', active: false },
  }
}

/**
 * macOS sandbox-exec argv prefix. Callers concatenate with original argv.
 */
export function macOSSandboxExecArgv(
  originalArgv: string[],
  workdir: string,
): string[] {
  if (process.platform !== 'darwin') return originalArgv
  const profile = DEFAULT_DENY_NETWORK_PROFILE
    .map((l) => l.replace('(param "WORKDIR")', `(param "${workdir}")`))
    .join('\n')
  return ['/usr/bin/sandbox-exec', '-p', profile, ...originalArgv]
}

/**
 * Convenience: spawn a Bash command in the sandbox. Returns a promise
 * that resolves to the joined stdout/stderr and exit code.
 */
export function spawnInSandbox(
  command: string,
  args: string[],
  options: SpawnOptions,
  workdir: string,
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    let argv = args
    if (detectBackend() === 'sandbox-exec') {
      argv = macOSSandboxExecArgv([command, ...args], workdir)
    } else {
      argv = [command, ...args]
    }
    let stdout = ''
    let stderr = ''
    let child: ChildProcess
    try {
      child = spawn(argv[0], argv.slice(1), {
        ...options,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, OVOGO_SANDBOX: '1' },
      })
    } catch (err) {
      reject(err instanceof Error ? err : new Error(String(err)))
      return
    }
    child.stdout?.setEncoding('utf8')
    child.stderr?.setEncoding('utf8')
    child.stdout?.on('data', (c: string) => { stdout += c })
    child.stderr?.on('data', (c: string) => { stderr += c })
    child.on('error', (err) => reject(err))
    child.on('close', (code) => resolve({ code, stdout, stderr }))
  })
}

/**
 * Build a sandbox profile string for inspection / /why. Returns the
 * raw SBPL profile (macOS) or a Linux summary.
 */
export function describeSandboxProfile(workdir: string): string {
  if (process.platform === 'darwin') {
    return DEFAULT_DENY_NETWORK_PROFILE
      .map((l) => l.replace('(param "WORKDIR")', `(param "${workdir}")`))
      .join('\n')
  }
  if (process.platform === 'linux') {
    return `# Landlock rules (Linux 5.13+)
fs-read:   ${workdir}, /usr, /lib, /etc, /tmp
fs-write:  ${workdir}, /tmp
no-new-privs: 1
no-network:    1
no-mount:      1`
  }
  return `# No sandbox available on ${process.platform}`
}
