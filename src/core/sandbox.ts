/**
 * Sandbox Configuration
 *
 * Generates and applies OS-level sandbox profiles to isolate tool
 * execution (primarily the Bash tool). Two backends:
 *
 *   macOS: sandbox-exec with a generated .sb profile (Seatbelt)
 *   Linux: bubblewrap (bwrap) — non-setuid namespace isolation
 *
 * Levels:
 *   permissive: no sandboxing (passthrough)
 *   standard:   restrict writes to cwd + temp; allow network
 *   strict:     no network; writes only to cwd + temp; no exec of
 *               binaries outside /usr, /bin, cwd
 *
 * The sandbox wraps a command prefix that the Bash tool prepends to
 * every shellout. Commands run transparently — the user never sees
 * the wrapper unless a violation occurs.
 */

import { existsSync, writeFileSync, mkdirSync, readFileSync } from 'fs'
import { join } from 'path'
import { homedir, tmpdir } from 'os'
import { execSync } from 'child_process'
import { warnConfigOnce } from '../config/diagnostics.js'

// ── Types ───────────────────────────────────────────────────────────────────

export type SandboxLevel = 'permissive' | 'standard' | 'strict'
export type SandboxBackend = 'none' | 'macos-seatbelt' | 'linux-bubblewrap'

export interface SandboxConfig {
  enabled: boolean
  level: SandboxLevel
  /** Extra read-only paths (in addition to defaults) */
  readOnlyPaths: string[]
  /** Extra writable paths (in addition to cwd + temp) */
  writablePaths: string[]
  /** Paths to deny entirely (no read, no write) */
  deniedPaths: string[]
  /** Allow network access (default: true for standard, false for strict) */
  allowNetwork: boolean
}

export interface SandboxProfile {
  backend: SandboxBackend
  level: SandboxLevel
  /** The generated wrapper command prefix */
  prefix: string
  /** Path to the generated profile file (macOS) or null */
  profilePath?: string
}

// ── Defaults ────────────────────────────────────────────────────────────────

export const DEFAULT_CONFIG: SandboxConfig = {
  enabled: false,
  level: 'standard',
  readOnlyPaths: [],
  writablePaths: [],
  deniedPaths: [],
  allowNetwork: true,
}

// ── Storage ─────────────────────────────────────────────────────────────────

function getConfigPath(): string {
  return join(homedir(), '.ovolv999', 'sandbox.json')
}

export function loadConfig(): SandboxConfig {
  const path = getConfigPath()
  if (!existsSync(path)) return { ...DEFAULT_CONFIG }
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8')) as Partial<SandboxConfig>
    return { ...DEFAULT_CONFIG, ...raw }
  } catch (err) {
    warnConfigOnce({
      file: path, severity: 'warning',
      message: `sandbox config corrupt — using defaults (${(err as Error).message.split('\n')[0]})`,
      fix: `fix or remove "${path}"`,
    })
    return { ...DEFAULT_CONFIG }
  }
}

export function saveConfig(config: SandboxConfig): void {
  const path = getConfigPath()
  const dir = join(path, '..')
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  writeFileSync(path, JSON.stringify(config, null, 2))
}

export function updateConfig(patch: Partial<SandboxConfig>): SandboxConfig {
  const current = loadConfig()
  const updated = { ...current, ...patch }
  saveConfig(updated)
  return updated
}

// ── Backend Detection ───────────────────────────────────────────────────────

export function detectBackend(): SandboxBackend {
  if (process.platform === 'darwin') {
    try {
      execSync('which sandbox-exec', { stdio: 'pipe', timeout: 2000 })
      return 'macos-seatbelt'
    } catch { /* not found */ }
  }
  if (process.platform === 'linux') {
    try {
      execSync('which bwrap', { stdio: 'pipe', timeout: 2000 })
      return 'linux-bubblewrap'
    } catch { /* not found */ }
  }
  return 'none'
}

// ── Profile Generation ──────────────────────────────────────────────────────

function getDefaultReadOnlyPaths(): string[] {
  return ['/usr', '/bin', '/sbin', '/lib', '/lib64', '/etc', '/opt', '/System', '/Library']
}

function getTempPaths(): string[] {
  const tmp = tmpdir()
  const cache = join(homedir(), '.ovolv999')
  return [tmp, cache, '/var/tmp', '/tmp']
}

/**
 * Generate a macOS Seatbelt (.sb) profile for the given config + cwd.
 */
export function generateMacOSProfile(config: SandboxConfig, cwd: string): string {
  const lines: string[] = [
    ';;; ovolv999 sandbox profile (auto-generated)',
    `;;; level: ${config.level}`,
    '(version 1)',
    '(allow default-services)',
    '(deny default-disallowed)',
  ]

  // File system
  const readOnly = [...getDefaultReadOnlyPaths(), ...config.readOnlyPaths]
  const writable = [cwd, ...getTempPaths(), ...config.writablePaths]

  for (const p of readOnly) {
    lines.push(`(allow file-read* (subpath "${p}"))`)
  }
  for (const p of writable) {
    lines.push(`(allow file-write* (subpath "${p}"))`)
    lines.push(`(allow file-read* (subpath "${p}"))`)
  }
  for (const p of config.deniedPaths) {
    lines.push(`(deny file-read* (subpath "${p}"))`)
    lines.push(`(deny file-write* (subpath "${p}"))`)
  }

  // Process execution
  if (config.level === 'strict') {
    lines.push('(allow process-exec (subpath "/usr/bin"))')
    lines.push('(allow process-exec (subpath "/bin"))')
    lines.push('(allow process-exec (subpath "/usr/local/bin"))')
    lines.push(`(allow process-exec (subpath "${cwd}"))`)
  } else {
    lines.push('(allow process-exec)')
    lines.push('(allow process-fork)')
  }

  // Network
  if (config.allowNetwork && config.level !== 'strict') {
    lines.push('(allow network*)')
  } else {
    lines.push('(deny network*)')
  }

  // IPC
  lines.push('(allow ipc-posix*)')
  lines.push('(allow sysctl-read)')
  lines.push('(allow signal)')

  return lines.join('\n')
}

/**
 * Generate a Linux bubblewrap (bwrap) argument list for the config.
 */
export function generateBubblewrapArgs(config: SandboxConfig, cwd: string): string[] {
  const args: string[] = ['bwrap']

  // Bind read-only system paths
  const readOnly = [...getDefaultReadOnlyPaths(), ...config.readOnlyPaths]
  for (const p of readOnly) {
    if (existsSync(p)) {
      args.push('--ro-bind', p, p)
    }
  }

  // Bind writable paths
  const writable = [cwd, ...getTempPaths(), ...config.writablePaths]
  for (const p of writable) {
    if (existsSync(p)) {
      args.push('--bind', p, p)
    }
  }

  // Denied paths — don't bind them at all
  // (bwrap doesn't have an explicit deny; just omit the bind)

  // Proc + dev
  args.push('--proc', '/proc')
  args.push('--dev', '/dev')

  // Network: bubblewrap can't restrict network without unshare-net + setup
  if (!config.allowNetwork || config.level === 'strict') {
    args.push('--unshare-net')
  }

  // Don't grant elevated privileges
  args.push('--die-with-parent')

  // Shell to execute the wrapped command
  args.push('--', '/bin/sh', '-c')

  return args
}

// ── Profile Compilation ─────────────────────────────────────────────────────

let cachedProfile: SandboxProfile | null = null

/**
 * Compile the current config into a sandbox profile. The profile
 * includes a command prefix to prepend to every wrapped command.
 */
export function compileProfile(cwd: string, config?: SandboxConfig): SandboxProfile {
  const cfg = config ?? loadConfig()

  if (!cfg.enabled || cfg.level === 'permissive') {
    return {
      backend: 'none',
      level: 'permissive',
      prefix: '',
    }
  }

  const backend = detectBackend()

  switch (backend) {
    case 'macos-seatbelt': {
      const profileDir = join(homedir(), '.ovolv999', 'sandbox')
      if (!existsSync(profileDir)) mkdirSync(profileDir, { recursive: true })
      const profilePath = join(profileDir, `ovolv999-${cfg.level}.sb`)
      const content = generateMacOSProfile(cfg, cwd)
      writeFileSync(profilePath, content)
      return {
        backend,
        level: cfg.level,
        prefix: `sandbox-exec -f ${shellQuote(profilePath)} `,
        profilePath,
      }
    }
    case 'linux-bubblewrap': {
      const args = generateBubblewrapArgs(cfg, cwd)
      return {
        backend,
        level: cfg.level,
        prefix: args.map(shellQuote).join(' ') + ' ',
      }
    }
    default:
      return {
        backend: 'none',
        level: 'permissive',
        prefix: '',
      }
  }
}

export function getCachedProfile(cwd: string): SandboxProfile {
  if (cachedProfile) return cachedProfile
  cachedProfile = compileProfile(cwd)
  return cachedProfile
}

export function invalidateProfileCache(): void {
  cachedProfile = null
}

// ── Command Wrapping ────────────────────────────────────────────────────────

/**
 * Wrap a shell command with the sandbox prefix. If sandboxing is
 * disabled, returns the command unchanged.
 */
export function wrapCommand(command: string, cwd: string, config?: SandboxConfig): string {
  const cfg = config ?? loadConfig()
  if (!cfg.enabled || cfg.level === 'permissive') return command
  const profile = compileProfile(cwd, cfg)
  if (!profile.prefix) return command
  return profile.prefix + command
}

// ── Validation ──────────────────────────────────────────────────────────────

export interface ValidationResult {
  valid: boolean
  issues: string[]
}

export function validateConfig(config: SandboxConfig): ValidationResult {
  const issues: string[] = []

  if (!['permissive', 'standard', 'strict'].includes(config.level)) {
    issues.push(`Invalid level: ${config.level}`)
  }

  // strict implies no network
  if (config.level === 'strict' && config.allowNetwork) {
    issues.push('strict level should disable network (allowNetwork=false)')
  }

  for (const p of config.deniedPaths) {
    if (!p.startsWith('/')) {
      issues.push(`deniedPath must be absolute: ${p}`)
    }
  }

  for (const p of config.writablePaths) {
    if (!p.startsWith('/')) {
      issues.push(`writablePath must be absolute: ${p}`)
    }
  }

  return { valid: issues.length === 0, issues }
}

// ── Formatting ──────────────────────────────────────────────────────────────

export function formatConfig(config: SandboxConfig): string {
  const lines = [
    'Sandbox Configuration:',
    `  Enabled: ${config.enabled ? '✓' : '✗'}`,
    `  Level: ${config.level}`,
    `  Network: ${config.allowNetwork ? 'allowed' : 'denied'}`,
  ]
  if (config.writablePaths.length > 0) {
    lines.push(`  Writable: ${config.writablePaths.join(', ')}`)
  }
  if (config.readOnlyPaths.length > 0) {
    lines.push(`  Read-only: ${config.readOnlyPaths.join(', ')}`)
  }
  if (config.deniedPaths.length > 0) {
    lines.push(`  Denied: ${config.deniedPaths.join(', ')}`)
  }
  const backend = detectBackend()
  lines.push(`  Backend: ${backend}`)
  return lines.join('\n')
}

export function formatProfile(profile: SandboxProfile): string {
  const lines = [
    'Sandbox Profile:',
    `  Backend: ${profile.backend}`,
    `  Level: ${profile.level}`,
  ]
  if (profile.profilePath) lines.push(`  Profile: ${profile.profilePath}`)
  if (profile.prefix) {
    lines.push(`  Prefix: ${profile.prefix.slice(0, 80)}${profile.prefix.length > 80 ? '...' : ''}`)
  } else {
    lines.push('  Prefix: (none — passthrough)')
  }
  return lines.join('\n')
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function shellQuote(s: string): string {
  if (/^[A-Za-z0-9_:.@/=-]+$/.test(s)) return s
  return `'${s.replace(/'/g, "'\\''")}'`
}
