/**
 * Team Memory Sync
 *
 * Shares CLAUDE.md/AGENTS.md-style memory files across a team.
 * Strips secrets before syncing. Git-backed for history.
 *
 * Workflow:
 *   1. Team configures a shared git repo as memory store
 *   2. Local memory files are scanned for secrets
 *   3. Clean versions are pushed to the shared repo
 *   4. Other team members pull to get updates
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync, statSync } from 'fs'
import { join, basename } from 'path'
import { warnConfigOnce } from '../config/diagnostics.js'
import { homedir } from 'os'
import { execSync } from 'child_process'
import { scanText, formatScanResult } from '../utils/secretScanner.js'

// ── Types ───────────────────────────────────────────────────────────────────

export interface TeamMemoryConfig {
  /** Git remote URL for shared memory store */
  remoteUrl: string
  /** Branch to sync (default: main) */
  branch?: string
  /** Local memory files to sync */
  files: string[]
  /** Whether to auto-sync on changes */
  autoSync?: boolean
  /** Sync interval in ms (default: 5 min) */
  syncInterval?: number
}

export interface SyncResult {
  success: boolean
  pushed: string[]
  pulled: string[]
  errors: string[]
  secretsDetected: number
  warnings: string[]
}

export interface MemoryFile {
  path: string
  content: string
  hash: string
}

// ── Paths ───────────────────────────────────────────────────────────────────

export function getTeamMemoryDir(): string {
  return join(homedir(), '.ovolv999', 'team-memory')
}

export function getTeamMemoryConfigPath(): string {
  return join(homedir(), '.ovolv999', 'team-memory.json')
}

// ── Config ──────────────────────────────────────────────────────────────────

export function loadTeamConfig(): TeamMemoryConfig | null {
  const path = getTeamMemoryConfigPath()
  if (!existsSync(path)) return null
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as TeamMemoryConfig
  } catch (err) {
    warnConfigOnce({
      file: path, severity: 'warning',
      message: `team-memory config corrupt — treating as unconfigured (${(err as Error).message.split('\n')[0]})`,
      fix: `fix or remove "${path}"`,
    })
    return null
  }
}

export function saveTeamConfig(config: TeamMemoryConfig): void {
  const path = getTeamMemoryConfigPath()
  const dir = join(path, '..')
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  writeFileSync(path, JSON.stringify(config, null, 2))
}

// ── Memory File Discovery ───────────────────────────────────────────────────

const DEFAULT_MEMORY_FILES = [
  'CLAUDE.md',
  'AGENTS.md',
  '.cursorrules',
  '.windsurfrules',
  '.ovolv999/memory.md',
]

export function findMemoryFiles(cwd: string): string[] {
  const found: string[] = []
  for (const name of DEFAULT_MEMORY_FILES) {
    const path = join(cwd, name)
    if (existsSync(path)) found.push(path)
  }
  return found
}

export function loadMemoryFiles(files: string[]): MemoryFile[] {
  return files
    .filter(f => existsSync(f))
    .map(f => ({
      path: f,
      content: readFileSync(f, 'utf8'),
      hash: simpleHash(readFileSync(f, 'utf8')),
    }))
}

function simpleHash(s: string): string {
  let h = 0
  for (let i = 0; i < s.length; i++) {
    h = ((h << 5) - h + s.charCodeAt(i)) | 0
  }
  return h.toString(16)
}

// ── Git Operations ──────────────────────────────────────────────────────────

function runGit(args: string[], cwd?: string): { ok: boolean; stdout: string; stderr: string } {
  try {
    const stdout = execSync(`git ${args.join(' ')}`, {
      cwd: cwd ?? getTeamMemoryDir(),
      encoding: 'utf8',
      timeout: 30000,
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    return { ok: true, stdout, stderr: '' }
  } catch (err: unknown) {
    const e = err as { stdout?: string; stderr?: string }
    return {
      ok: false,
      stdout: (e.stdout ?? '').toString(),
      stderr: (e.stderr ?? '').toString(),
    }
  }
}

export function isTeamMemoryInitialized(): boolean {
  return existsSync(join(getTeamMemoryDir(), '.git'))
}

export function initTeamMemory(remoteUrl: string, branch = 'main'): SyncResult {
  const dir = getTeamMemoryDir()
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })

  const errors: string[] = []
  const warnings: string[] = []

  // Init local repo
  let res = runGit(['init'], dir)
  if (!res.ok) errors.push(`git init failed: ${res.stderr}`)

  // Set default branch
  runGit(['checkout', '-b', branch], dir)

  // Add remote
  res = runGit(['remote', 'add', 'origin', remoteUrl], dir)
  if (!res.ok) {
    // Remote might already exist
    runGit(['remote', 'set-url', 'origin', remoteUrl], dir)
  }

  // Pull
  res = runGit(['pull', 'origin', branch], dir)
  if (!res.ok) {
    warnings.push(`Initial pull failed (may be empty repo): ${res.stderr.slice(0, 100)}`)
  }

  return {
    success: errors.length === 0,
    pushed: [],
    pulled: [],
    errors,
    secretsDetected: 0,
    warnings,
  }
}

// ── Sync ────────────────────────────────────────────────────────────────────

export function syncTeamMemory(config?: TeamMemoryConfig): SyncResult {
  const cfg = config ?? loadTeamConfig()
  if (!cfg) {
    return {
      success: false,
      pushed: [],
      pulled: [],
      errors: ['No team memory config found. Use /team-memory init <remote-url>'],
      secretsDetected: 0,
      warnings: [],
    }
  }

  const errors: string[] = []
  const warnings: string[] = []
  const pushed: string[] = []
  const pulled: string[] = []
  let secretsDetected = 0

  // Ensure initialized
  if (!isTeamMemoryInitialized()) {
    const initResult = initTeamMemory(cfg.remoteUrl, cfg.branch ?? 'main')
    if (!initResult.success) {
      return {
        success: false,
        pushed,
        pulled,
        errors: initResult.errors,
        secretsDetected: 0,
        warnings: initResult.warnings,
      }
    }
  }

  // Scan and copy local files to team memory dir
  const memoryDir = getTeamMemoryDir()
  for (const file of cfg.files) {
    if (!existsSync(file)) {
      warnings.push(`File not found: ${file}`)
      continue
    }

    const content = readFileSync(file, 'utf8')
    const scan = scanText(content)
    secretsDetected += scan.matches.length

    if (scan.hasSecrets) {
      warnings.push(`Secrets in ${file}: ${formatScanResult(scan)}`)
    }

    const filename = basename(file)
    const destPath = join(memoryDir, filename)
    writeFileSync(destPath, scan.cleanedContent)
    pushed.push(filename)
  }

  // Git add
  runGit(['add', '.'])

  // Commit
  const commitRes = runGit(['commit', '-m', `sync memory files (${new Date().toISOString()})`])
  if (!commitRes.ok && !commitRes.stderr.includes('nothing to commit')) {
    warnings.push('Nothing to commit (no changes)')
  }

  // Pull first (to avoid conflicts)
  const pullRes = runGit(['pull', 'origin', cfg.branch ?? 'main', '--rebase'])
  if (pullRes.ok) {
    // Check what was pulled
    const files = listTeamMemoryFiles()
    pulled.push(...files.map(f => basename(f)))
  } else {
    warnings.push(`Pull failed: ${pullRes.stderr.slice(0, 100)}`)
  }

  // Push
  const pushRes = runGit(['push', 'origin', cfg.branch ?? 'main'])
  if (!pushRes.ok) {
    errors.push(`Push failed: ${pushRes.stderr.slice(0, 200)}`)
  }

  return {
    success: errors.length === 0,
    pushed,
    pulled,
    errors,
    secretsDetected,
    warnings,
  }
}

// ── File Operations ─────────────────────────────────────────────────────────

export function listTeamMemoryFiles(): string[] {
  const dir = getTeamMemoryDir()
  if (!existsSync(dir)) return []

  try {
    return readdirSync(dir)
      .filter(f => !f.startsWith('.') && f !== 'node_modules')
      .filter(f => {
        try {
          return statSync(join(dir, f)).isFile()
        } catch {
          return false
        }
      })
      .map(f => join(dir, f))
  } catch {
    return []
  }
}

export function readTeamMemoryFile(filename: string): string | null {
  const path = join(getTeamMemoryDir(), filename)
  if (!existsSync(path)) return null
  return readFileSync(path, 'utf8')
}

// ── Formatting ──────────────────────────────────────────────────────────────

export function formatSyncResult(result: SyncResult): string {
  const lines: string[] = []

  if (result.success) {
    lines.push('✓ Team memory sync successful')
  } else {
    lines.push('✗ Team memory sync failed')
  }

  if (result.pushed.length > 0) {
    lines.push(`Pushed (${result.pushed.length}):`)
    for (const f of result.pushed) lines.push(`  ↑ ${f}`)
  }

  if (result.pulled.length > 0) {
    lines.push(`Pulled (${result.pulled.length}):`)
    for (const f of result.pulled) lines.push(`  ↓ ${f}`)
  }

  if (result.secretsDetected > 0) {
    lines.push(`⚠ ${result.secretsDetected} secret(s) detected and redacted`)
  }

  for (const w of result.warnings) lines.push(`  ⚠ ${w}`)
  for (const e of result.errors) lines.push(`  ✗ ${e}`)

  return lines.join('\n')
}

export function formatTeamMemoryStatus(): string {
  const config = loadTeamConfig()
  if (!config) {
    return 'Team memory not configured. Use /team-memory init <remote-url>'
  }

  const initialized = isTeamMemoryInitialized()
  const files = listTeamMemoryFiles()

  const lines: string[] = [
    'Team Memory Status:',
    `  Remote: ${config.remoteUrl}`,
    `  Branch: ${config.branch ?? 'main'}`,
    `  Initialized: ${initialized ? '✓' : '✗'}`,
    `  Synced files: ${files.length}`,
    `  Auto-sync: ${config.autoSync ? 'enabled' : 'disabled'}`,
  ]

  if (config.files.length > 0) {
    lines.push(`  Local files:`)
    for (const f of config.files) {
      const exists = existsSync(f)
      lines.push(`    ${exists ? '✓' : '✗'} ${f}`)
    }
  }

  return lines.join('\n')
}
