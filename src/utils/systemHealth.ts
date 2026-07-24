/**
 * System Health Diagnostics
 *
 * Deep system/installation health checks for /doctor.
 * Covers: install path, multiple installations, npm dist-tag,
 * ripgrep/tsc/node presence, MCP config warnings, disk space,
 * network connectivity, shell environment.
 */

import { existsSync, readFileSync, statSync } from 'fs'
import { join, dirname } from 'path'
import { homedir, platform, freemem, totalmem } from 'os'
import { execSync } from 'child_process'

// ── Types ───────────────────────────────────────────────────────────────────

export type CheckLevel = 'ok' | 'warning' | 'error' | 'info'

export interface SystemCheck {
  id: string
  name: string
  level: CheckLevel
  message: string
  details?: string
  fix?: string
}

export interface SystemHealthReport {
  checks: SystemCheck[]
  summary: {
    ok: number
    warnings: number
    errors: number
    infos: number
  }
  environment: {
    platform: string
    arch: string
    nodeVersion: string
    shell: string
    homeDir: string
    diskFreeMB: number
    memoryFreeMB: number
    memoryTotalMB: number
  }
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function commandExists(cmd: string): boolean {
  try {
    execSync(`which ${cmd} 2>/dev/null || where ${cmd} 2>nul`, {
      encoding: 'utf8',
      timeout: 2000,
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    return true
  } catch {
    return false
  }
}

function commandVersion(cmd: string, versionFlag = '--version'): string | null {
  try {
    const out = execSync(`${cmd} ${versionFlag} 2>&1`, {
      encoding: 'utf8',
      timeout: 5000,
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    return out.trim().split('\n')[0]
  } catch {
    return null
  }
}

function getDiskFreeMB(path: string): number {
  try {
    if (platform() === 'win32') {
      const out = execSync(`dir "${path}" 2>nul | find "bytes free"`, { encoding: 'utf8', timeout: 5000 })
      const match = out.match(/([\d,]+)\s+bytes free/i)
      if (match) return parseInt(match[1].replace(/,/g, ''), 10) / (1024 * 1024)
    } else {
      const out = execSync(`df -m "${path}" 2>/dev/null | tail -1`, { encoding: 'utf8', timeout: 5000 })
      const parts = out.trim().split(/\s+/)
      if (parts.length >= 4) return parseInt(parts[3], 10)
    }
  } catch { /* ignore */ }
  return -1
}

// ── Individual Checks ───────────────────────────────────────────────────────

function checkNodeVersion(): SystemCheck {
  const version = process.versions.node
  const major = parseInt(version.split('.')[0], 10)

  if (major < 18) {
    return {
      id: 'node-version',
      name: 'Node.js Version',
      level: 'error',
      message: `Node.js ${version} is too old (requires >=18)`,
      fix: 'Update Node.js to v18 or later: https://nodejs.org/',
    }
  }

  if (major < 20) {
    return {
      id: 'node-version',
      name: 'Node.js Version',
      level: 'warning',
      message: `Node.js ${version} (v20+ recommended)`,
      fix: 'Consider updating to Node.js v20+ for better performance',
    }
  }

  return {
    id: 'node-version',
    name: 'Node.js Version',
    level: 'ok',
    message: `Node.js ${version}`,
  }
}

function checkNpm(): SystemCheck {
  const version = commandVersion('npm')
  if (!version) {
    return {
      id: 'npm',
      name: 'npm',
      level: 'error',
      message: 'npm not found in PATH',
      fix: 'Install Node.js which includes npm',
    }
  }
  return { id: 'npm', name: 'npm', level: 'ok', message: version }
}

function checkGit(): SystemCheck {
  const version = commandVersion('git')
  if (!version) {
    return {
      id: 'git',
      name: 'Git',
      level: 'error',
      message: 'Git not found',
      fix: 'Install Git: https://git-scm.com/',
    }
  }
  return { id: 'git', name: 'Git', level: 'ok', message: version }
}

function checkRipgrep(): SystemCheck {
  const rgExists = commandExists('rg')
  if (!rgExists) {
    return {
      id: 'ripgrep',
      name: 'Ripgrep',
      level: 'warning',
      message: 'ripgrep (rg) not found — grep tool will be slower',
      fix: 'Install ripgrep for faster text search: https://github.com/BurntSushi/ripgrep',
    }
  }
  const version = commandVersion('rg')
  return { id: 'ripgrep', name: 'Ripgrep', level: 'ok', message: version ?? 'installed' }
}

function checkTypeScript(): SystemCheck {
  const version = commandVersion('tsc')
  if (!version) {
    return {
      id: 'typescript',
      name: 'TypeScript',
      level: 'warning',
      message: 'tsc not found globally — diagnostics may be limited',
      fix: 'Install TypeScript: npm install -g typescript',
    }
  }
  return { id: 'typescript', name: 'TypeScript', level: 'ok', message: version }
}

function checkDiskSpace(): SystemCheck {
  const home = homedir()
  const freeMB = getDiskFreeMB(home)
  if (freeMB < 0) {
    return { id: 'disk-space', name: 'Disk Space', level: 'info', message: 'Unable to check disk space' }
  }
  if (freeMB < 500) {
    return {
      id: 'disk-space',
      name: 'Disk Space',
      level: 'error',
      message: `Only ${freeMB.toFixed(0)}MB free in home directory`,
      fix: 'Free up disk space (need at least 1GB)',
    }
  }
  if (freeMB < 2000) {
    return {
      id: 'disk-space',
      name: 'Disk Space',
      level: 'warning',
      message: `Low disk space: ${(freeMB / 1024).toFixed(1)}GB free`,
    }
  }
  return {
    id: 'disk-space',
    name: 'Disk Space',
    level: 'ok',
    message: `${(freeMB / 1024).toFixed(1)}GB free`,
  }
}

function checkMemory(): SystemCheck {
  const freeMB = freemem() / (1024 * 1024)
  const totalMB = totalmem() / (1024 * 1024)

  if (freeMB < 512) {
    return {
      id: 'memory',
      name: 'Memory',
      level: 'warning',
      message: `Low memory: ${freeMB.toFixed(0)}MB free of ${(totalMB / 1024).toFixed(1)}GB`,
      fix: 'Close other applications to free memory',
    }
  }
  return {
    id: 'memory',
    name: 'Memory',
    level: 'ok',
    message: `${freeMB.toFixed(0)}MB free of ${(totalMB / 1024).toFixed(1)}GB`,
  }
}

function checkInstallLocation(): SystemCheck {
  const execPath = process.execPath
  const installDir = dirname(dirname(execPath))

  // Check if installed in a writable location
  try {
    const stat = statSync(installDir)
    if (platform() !== 'win32' && stat.uid === 0) {
      return {
        id: 'install-location',
        name: 'Install Location',
        level: 'info',
        message: `Installed as root: ${installDir}`,
        details: execPath,
      }
    }
  } catch { /* ignore */ }

  return {
    id: 'install-location',
    name: 'Install Location',
    level: 'ok',
    message: installDir,
    details: execPath,
  }
}

function checkMultipleInstalls(): SystemCheck {
  const locations: string[] = []

  try {
    const npmGlobal = execSync('npm root -g 2>/dev/null', { encoding: 'utf8', timeout: 5000 }).trim()
    if (npmGlobal) locations.push(npmGlobal)
  } catch { /* ignore */ }

  const home = homedir()
  const possiblePaths = [
    join(home, '.npm-global'),
    join(home, '.local', 'bin'),
    '/usr/local/bin',
    '/usr/bin',
  ]

  for (const p of possiblePaths) {
    if (existsSync(join(p, 'ovolv999')) || existsSync(join(p, 'ovogogogo'))) {
      locations.push(p)
    }
  }

  if (locations.length > 1) {
    return {
      id: 'multiple-installs',
      name: 'Multiple Installations',
      level: 'warning',
      message: `Found ${locations.length} installations`,
      details: locations.join('\n'),
      fix: 'Remove duplicate installations to avoid confusion',
    }
  }

  return { id: 'multiple-installs', name: 'Multiple Installations', level: 'ok', message: 'Single installation' }
}

function checkShell(): SystemCheck {
  const shell = process.env.SHELL ?? process.env.COMSPEC ?? 'unknown'

  if (shell === 'unknown') {
    return { id: 'shell', name: 'Shell', level: 'info', message: 'Unknown shell' }
  }

  return { id: 'shell', name: 'Shell', level: 'ok', message: shell }
}

function checkNetworkConnectivity(): SystemCheck {
  const start = Date.now()
  try {
    execSync('ping -c 1 -W 2 8.8.8.8 2>/dev/null || ping -n 1 -w 2000 8.8.8.8 2>nul', {
      encoding: 'utf8',
      timeout: 5000,
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    const latency = Date.now() - start
    if (latency > 2000) {
      return {
        id: 'network',
        name: 'Network Connectivity',
        level: 'warning',
        message: `Slow network (${latency}ms latency)`,
      }
    }
    return {
      id: 'network',
      name: 'Network Connectivity',
      level: 'ok',
      message: `${latency}ms latency`,
    }
  } catch {
    return {
      id: 'network',
      name: 'Network Connectivity',
      level: 'warning',
      message: 'No network connectivity (offline mode)',
      fix: 'Some features require internet (web search, npm install, etc.)',
    }
  }
}

function checkOvolv999Dir(): SystemCheck {
  const dir = join(homedir(), '.ovolv999')
  if (!existsSync(dir)) {
    return {
      id: 'ovolv999-dir',
      name: 'Config Directory',
      level: 'info',
      message: `Not yet created: ${dir}`,
      fix: 'Will be created on first use',
    }
  }

  try {
    const stat = statSync(dir)
    const sizeMB = stat.size / (1024 * 1024)
    if (sizeMB > 100) {
      return {
        id: 'ovolv999-dir',
        name: 'Config Directory',
        level: 'warning',
        message: `Large config dir: ${sizeMB.toFixed(1)}MB`,
        fix: 'Consider cleaning old sessions/transcripts',
      }
    }
  } catch { /* ignore */ }

  return { id: 'ovolv999-dir', name: 'Config Directory', level: 'ok', message: dir }
}

function checkMcpConfig(): SystemCheck {
  const configPath = join(homedir(), '.ovolv999', 'mcp.json')
  if (!existsSync(configPath)) {
    return { id: 'mcp-config', name: 'MCP Config', level: 'ok', message: 'No MCP servers configured' }
  }

  try {
    const config = JSON.parse(readFileSync(configPath, 'utf8')) as {
      servers?: Record<string, unknown>
      mcpServers?: Record<string, unknown>
    }
    const servers = Object.keys(config.servers ?? config.mcpServers ?? {})
    if (servers.length > 10) {
      return {
        id: 'mcp-config',
        name: 'MCP Config',
        level: 'warning',
        message: `${servers.length} MCP servers configured (may slow startup)`,
        details: servers.join(', '),
      }
    }
    return {
      id: 'mcp-config',
      name: 'MCP Config',
      level: 'ok',
      message: `${servers.length} MCP server(s) configured`,
    }
  } catch {
    return {
      id: 'mcp-config',
      name: 'MCP Config',
      level: 'error',
      message: 'Invalid MCP config JSON',
      fix: `Fix or remove: ${configPath}`,
    }
  }
}

// ── Main Runner ─────────────────────────────────────────────────────────────

export function runSystemHealthChecks(): SystemHealthReport {
  const checks: SystemCheck[] = [
    checkNodeVersion(),
    checkNpm(),
    checkGit(),
    checkRipgrep(),
    checkTypeScript(),
    checkDiskSpace(),
    checkMemory(),
    checkInstallLocation(),
    checkMultipleInstalls(),
    checkShell(),
    checkNetworkConnectivity(),
    checkOvolv999Dir(),
    checkMcpConfig(),
  ]

  const summary = {
    ok: checks.filter(c => c.level === 'ok').length,
    warnings: checks.filter(c => c.level === 'warning').length,
    errors: checks.filter(c => c.level === 'error').length,
    infos: checks.filter(c => c.level === 'info').length,
  }

  return {
    checks,
    summary,
    environment: {
      platform: platform(),
      arch: process.arch,
      nodeVersion: process.versions.node,
      shell: process.env.SHELL ?? process.env.COMSPEC ?? 'unknown',
      homeDir: homedir(),
      diskFreeMB: getDiskFreeMB(homedir()),
      memoryFreeMB: freemem() / (1024 * 1024),
      memoryTotalMB: totalmem() / (1024 * 1024),
    },
  }
}

// ── Formatting ──────────────────────────────────────────────────────────────

const LEVEL_ICONS: Record<CheckLevel, string> = {
  ok: '✓',
  warning: '⚠',
  error: '✗',
  info: 'ℹ',
}

export function formatSystemHealth(report: SystemHealthReport): string {
  const lines: string[] = ['System Health:']

  const env = report.environment
  lines.push(`\nEnvironment:`)
  lines.push(`  Platform: ${env.platform} (${env.arch})`)
  lines.push(`  Node: ${env.nodeVersion}`)
  lines.push(`  Shell: ${env.shell}`)
  lines.push(`  Memory: ${(env.memoryFreeMB / 1024).toFixed(1)}GB free / ${(env.memoryTotalMB / 1024).toFixed(1)}GB total`)
  if (env.diskFreeMB > 0) {
    lines.push(`  Disk: ${(env.diskFreeMB / 1024).toFixed(1)}GB free`)
  }

  lines.push(`\nChecks (${report.checks.length}):`)
  for (const check of report.checks) {
    const icon = LEVEL_ICONS[check.level]
    lines.push(`  ${icon} ${check.name}: ${check.message}`)
    if (check.details) lines.push(`      ${check.details.split('\n').join('\n      ')}`)
    if (check.fix) lines.push(`      Fix: ${check.fix}`)
  }

  lines.push(`\nSummary: ${report.summary.ok} ok, ${report.summary.warnings} warnings, ${report.summary.errors} errors, ${report.summary.infos} info`)

  return lines.join('\n')
}
