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
import { shellQuote } from '../utils/shellQuote.js'

// ── Types ───────────────────────────────────────────────────────────────────

export type SandboxLevel = 'permissive' | 'standard' | 'strict'
export type SandboxBackend =
  | 'none'
  | 'macos-seatbelt'
  | 'linux-bubblewrap'
  | 'linux-landlock'
  | 'windows-jobobject'

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

import { atomicWriteSync, preserveCorruptFile } from './atomicWrite.js'

function getConfigPath(): string {
  return join(homedir(), '.ovolv999', 'sandbox.json')
}

// §sandbox store: updateConfig is load→mutate→save — a torn or corrupt file
// must not fall back to defaults inside the load, or the next /sandbox toggle
// silently rewrites the user's real config as defaults + the toggle.
function isShapedSandboxConfig(parsed: unknown): parsed is Partial<SandboxConfig> {
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return false
  const raw = parsed as Partial<SandboxConfig>
  if (raw.enabled !== undefined && typeof raw.enabled !== 'boolean') return false
  if (raw.level !== undefined && !['permissive', 'standard', 'strict'].includes(raw.level)) return false
  for (const key of ['readOnlyPaths', 'writablePaths', 'deniedPaths'] as const) {
    if (raw[key] !== undefined && !Array.isArray(raw[key])) return false
  }
  return true
}

export function loadConfig(): SandboxConfig {
  const path = getConfigPath()
  if (!existsSync(path)) return { ...DEFAULT_CONFIG }
  try {
    const raw: unknown = JSON.parse(readFileSync(path, 'utf8'))
    if (!isShapedSandboxConfig(raw)) throw new Error('sandbox config shape violation')
    return { ...DEFAULT_CONFIG, ...raw }
  } catch (err) {
    preserveCorruptFile(path)
    warnConfigOnce({
      file: path, severity: 'warning',
      message: `sandbox config corrupt — backed up and reset to defaults (${(err as Error).message.split('\n')[0]})`,
      fix: `restore from "${path}.corrupt" or reconfigure /sandbox`,
    })
    return { ...DEFAULT_CONFIG }
  }
}

export function saveConfig(config: SandboxConfig): void {
  atomicWriteSync(getConfigPath(), JSON.stringify(config, null, 2))
}

export function updateConfig(patch: Partial<SandboxConfig>): SandboxConfig {
  const current = loadConfig()
  const updated = { ...current, ...patch }
  saveConfig(updated)
  return updated
}

// ── Backend Detection ───────────────────────────────────────────────────────

/**
 * v0.5.3 (P0.5): detectBackend returns the backend whose enforcement
 * code this build actually ships. It MUST agree with what the
 * SandboxManager reports — when they diverge, the UI shows one
 * backend and the Bash tool runs another, which is the v0.5.2
 * false-safety failure mode.
 *
 * Currently shipped: macos-seatbelt, linux-bubblewrap.
 * NOT shipped (reported via SandboxManager with reason): linux-landlock,
 * windows-jobobject.
 */
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
    // v0.5.3: landlock kernel-side check removed. Until we ship
    // the syscall emitter we MUST NOT claim landlock is enforced.
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
  // Round 26 (L7): standard Seatbelt profile shape. The previous header
  // used nonstandard directives (`(allow default-services)`,
  // `(deny default-disallowed)`) which recent sandbox-exec versions
  // reject at compile time — turning the macOS sandbox into a silent
  // no-op or error. `(deny default)` + the system profile import is the
  // portable base used by mainstream macOS sandbox tooling.
  const lines: string[] = [
    ';;; ovolv999 sandbox profile (auto-generated)',
    `;;; level: ${config.level}`,
    '(version 1)',
    '(deny default)',
    '(import "/System/Library/Sandbox/Profiles/system.sb")',
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
    // Round 26 re-audit (D10): under (deny default), fork(2) alone is
    // denied — shells running pipelines / make / node fork paths die
    // without this even though exec is allowed.
    lines.push('(allow process-fork)')
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

  // Security (M5): denied paths must actually be inaccessible. bwrap has
  // no explicit deny flag, and merely "not binding" them is a no-op when
  // the path sits inside a default ro-bind (e.g. denying /etc/keys while
  // /etc is ro-bound left it fully readable). Enforcement: drop any bind
  // that intersects a denied path, then mask each denied path with an
  // empty tmpfs mounted AFTER the binds (later mounts win).
  const denied = config.deniedPaths.filter((p) => typeof p === 'string' && p.length > 1)
  const isDenied = (p: string): boolean =>
    denied.some((d) => p === d || p.startsWith(d.endsWith('/') ? d : d + '/'))

  // Bind read-only system paths
  const readOnly = [...getDefaultReadOnlyPaths(), ...config.readOnlyPaths].filter((p) => !isDenied(p))
  for (const p of readOnly) {
    if (existsSync(p)) {
      args.push('--ro-bind', p, p)
    }
  }

  // Bind writable paths
  const writable = [cwd, ...getTempPaths(), ...config.writablePaths].filter((p) => !isDenied(p))
  for (const p of writable) {
    if (existsSync(p)) {
      args.push('--bind', p, p)
    }
  }

  // Denied paths — mask with empty tmpfs (ordered after binds so the
  // tmpfs shadows any earlier mount covering the same subtree)
  for (const p of denied) {
    args.push('--tmpfs', p)
  }

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

// ── v0.5.3 (P0.5) — HONEST BACKEND DECLARATION ────────────────────────────

/**
 * v0.5.2 (C9) SandboxManager was overly optimistic — it reported
 * `linux-landlock` and `windows-jobobject` as available without
 * having any enforcement code. v0.5.3 is the reality repair:
 *
 *   * `macos-seatbelt`     — IMPLEMENTED (sandbox-exec + .sb profile)
 *   * `linux-bubblewrap`  — IMPLEMENTED (bwrap wrapper)
 *   * `linux-landlock`    — NOT IMPLEMENTED in this build; reported
 *                            as `available: false` with reason
 *                            'syscall emitter not shipped'
 *   * `windows-jobobject` — NOT IMPLEMENTED in this build; reported
 *                            as `available: false` with reason
 *                            'native addon not shipped'
 *   * `none`              — fallback when no backend runs
 *
 * The Bash tool's `wrapCommand()` continues to consult the SAME
 * `detectBackend()` the UI displays, so the user never sees a
 * "sandbox active" message when the command actually runs without
 * one.
 */
export interface SandboxBackendStatus {
  backend: SandboxBackend
  available: boolean
  /** When `available=false`, why. */
  reason?: string
}

export interface SandboxSelectionResult {
  selected: SandboxBackend
  attempted: SandboxBackendStatus[]
  fallbackReason?: string
}

const LANDLOCK_NOT_SHIPPED = 'syscall emitter not shipped (zero-deps contract)'
const JOBOBJECT_NOT_SHIPPED = 'native addon not shipped (zero-deps contract)'

export class SandboxManager {
  /**
   * v0.5.3: status for every backend the manager knows about.
   * Backends without enforcement code are reported as
   * `available: false` with an explicit reason.
   */
  listAvailable(): SandboxBackendStatus[] {
    const out: SandboxBackendStatus[] = []
    if (process.platform === 'darwin') {
      const ok = this.hasExecutable('sandbox-exec')
      out.push({ backend: 'macos-seatbelt', available: ok, reason: ok ? undefined : 'sandbox-exec not in PATH' })
    }
    if (process.platform === 'linux') {
      const bwrapOk = this.hasExecutable('bwrap')
      out.push({ backend: 'linux-bubblewrap', available: bwrapOk, reason: bwrapOk ? undefined : 'bwrap not in PATH' })
      // v0.5.3: never claim landlock without an emitter. seccomp
      // existing does NOT prove landlock is usable from this build.
      out.push({ backend: 'linux-landlock', available: false, reason: LANDLOCK_NOT_SHIPPED })
    }
    if (process.platform === 'win32') {
      out.push({ backend: 'windows-jobobject', available: false, reason: JOBOBJECT_NOT_SHIPPED })
    }
    return out
  }

  select(): SandboxSelectionResult {
    const attempted = this.listAvailable()
    const usable = attempted.find((s) => s.available)
    if (usable) {
      return { selected: usable.backend, attempted }
    }
    const reasons = attempted
      .filter((s) => !s.available)
      .map((s) => `${s.backend}: ${s.reason ?? 'unavailable'}`)
    return {
      selected: 'none',
      attempted,
      fallbackReason: reasons.length > 0 ? reasons.join('; ') : 'no backend matched platform',
    }
  }

  selectedBackend(): SandboxBackend {
    return this.select().selected
  }

  private hasExecutable(name: string): boolean {
    try {
      execSync(`which ${name}`, { stdio: 'pipe', timeout: 2000 })
      return true
    } catch {
      return false
    }
  }
}
