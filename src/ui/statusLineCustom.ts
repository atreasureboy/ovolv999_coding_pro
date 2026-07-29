/**
 * Custom StatusLine scripting
 *
 * Lets users define their own status line via a script (shell command)
 * or a built-in segment configuration.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'
import { execSync } from 'child_process'
import { stripAnsi } from '../utils/ansi.js'
import { warnConfigOnce } from '../config/diagnostics.js'

// ── Types ───────────────────────────────────────────────────────────────────

export type SegmentType =
  | 'mode' | 'model' | 'git' | 'cwd' | 'tokens' | 'cost'
  | 'messages' | 'duration' | 'context' | 'cache' | 'effort'
  | 'goal' | 'budget' | 'session' | 'diagnostics' | 'custom'

export interface StatusSegment {
  type: SegmentType
  label?: string
  color?: string
  priority?: number
  maxWidth?: number
}

export type StatusLineConfig = StatusSegment[] | { script: string; refreshMs?: number }

export interface StatusLineContext {
  cwd: string
  mode?: string
  model?: string
  gitBranch?: string
  gitDirty?: boolean
  tokenCount?: number
  tokenLimit?: number
  cost?: number
  messageCount?: number
  duration?: number
  contextPercent?: number
  cacheHitRate?: number
  effort?: string
  activeGoals?: number
  budgetUsed?: number
  budgetLimit?: number
  sessionId?: string
  errorCount?: number
  warningCount?: number
}

// ── Storage ─────────────────────────────────────────────────────────────────

function getConfigPath(): string {
  return join(homedir(), '.ovolv999', 'statusline.json')
}

export function loadConfig(): StatusLineConfig | null {
  const path = getConfigPath()
  if (!existsSync(path)) return null
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as StatusLineConfig
  } catch (err) {
    warnConfigOnce({
      file: path, severity: 'warning',
      message: `statusline config corrupt — using built-in status line (${(err as Error).message.split('\n')[0]})`,
      fix: `fix or remove "${path}"`,
    })
    return null
  }
}

export function saveConfig(config: StatusLineConfig): void {
  const path = getConfigPath()
  const dir = join(path, '..')
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  writeFileSync(path, JSON.stringify(config, null, 2))
}

// ── Built-in Segments ───────────────────────────────────────────────────────

export const DEFAULT_SEGMENTS: StatusSegment[] = [
  { type: 'mode', priority: 100 },
  { type: 'model', priority: 90 },
  { type: 'git', priority: 80 },
  { type: 'cwd', priority: 70, maxWidth: 30 },
  { type: 'tokens', priority: 60 },
  { type: 'cost', priority: 50 },
  { type: 'duration', priority: 40 },
]

// ── Segment Renderers ───────────────────────────────────────────────────────

const COLORS = {
  reset: '\x1b[0m',
  dim: '\x1b[2m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m',
  cyan: '\x1b[36m',
  white: '\x1b[37m',
}

function colorize(text: string, color?: string): string {
  if (!color) return text
  const code = (COLORS as Record<string, string>)[color]
  return code ? `${code}${text}${COLORS.reset}` : text
}

function truncate(text: string, maxWidth?: number): string {
  if (!maxWidth || text.length <= maxWidth) return text
  if (maxWidth <= 3) return text.slice(0, maxWidth)
  return text.slice(0, maxWidth - 3) + '...'
}

function renderSegment(segment: StatusSegment, ctx: StatusLineContext): string {
  const label = segment.label
  let text = ''
  let color: string | undefined

  switch (segment.type) {
    case 'mode':
      text = ctx.mode ?? 'default'
      color = 'cyan'
      break

    case 'model':
      text = ctx.model ?? 'unknown'
      color = 'magenta'
      break

    case 'git': {
      if (!ctx.gitBranch) return ''
      const dirty = ctx.gitDirty ? '*' : ''
      text = `${ctx.gitBranch}${dirty}`
      color = ctx.gitDirty ? 'yellow' : 'green'
      break
    }

    case 'cwd': {
      const cwd = ctx.cwd ?? ''
      const home = homedir()
      text = cwd.startsWith(home) ? '~' + cwd.slice(home.length) : cwd
      text = text.split('/').pop() || text
      color = 'blue'
      break
    }

    case 'tokens': {
      if (ctx.tokenCount === undefined) return ''
      const count = ctx.tokenCount > 1000 ? `${(ctx.tokenCount / 1000).toFixed(1)}k` : String(ctx.tokenCount)
      text = `${count} tok`
      if (ctx.tokenLimit) {
        const pct = (ctx.tokenCount / ctx.tokenLimit) * 100
        color = pct > 80 ? 'red' : pct > 60 ? 'yellow' : 'green'
      }
      break
    }

    case 'cost':
      if (ctx.cost === undefined) return ''
      text = `$${ctx.cost.toFixed(3)}`
      color = ctx.cost > 1 ? 'yellow' : undefined
      break

    case 'messages':
      if (ctx.messageCount === undefined) return ''
      text = `${ctx.messageCount} msg`
      break

    case 'duration': {
      if (ctx.duration === undefined) return ''
      const min = Math.floor(ctx.duration / 60000)
      const sec = Math.floor((ctx.duration % 60000) / 1000)
      text = min > 0 ? `${min}m${sec}s` : `${sec}s`
      break
    }

    case 'context':
      if (ctx.contextPercent === undefined) return ''
      text = `${ctx.contextPercent.toFixed(0)}% ctx`
      color = ctx.contextPercent > 80 ? 'red' : ctx.contextPercent > 60 ? 'yellow' : 'green'
      break

    case 'cache':
      if (ctx.cacheHitRate === undefined) return ''
      text = `${(ctx.cacheHitRate * 100).toFixed(0)}% cache`
      color = ctx.cacheHitRate > 0.5 ? 'green' : 'yellow'
      break

    case 'effort':
      if (!ctx.effort) return ''
      text = ctx.effort
      color = 'dim'
      break

    case 'goal':
      if (ctx.activeGoals === undefined || ctx.activeGoals === 0) return ''
      text = `${ctx.activeGoals} goal${ctx.activeGoals > 1 ? 's' : ''}`
      color = 'cyan'
      break

    case 'budget': {
      if (ctx.budgetUsed === undefined) return ''
      const budgetPct = ctx.budgetLimit ? (ctx.budgetUsed / ctx.budgetLimit) * 100 : 0
      text = `${budgetPct.toFixed(0)}% budget`
      color = budgetPct > 90 ? 'red' : budgetPct > 70 ? 'yellow' : 'green'
      break
    }

    case 'session':
      if (!ctx.sessionId) return ''
      text = ctx.sessionId.slice(0, 8)
      color = 'dim'
      break

    case 'diagnostics': {
      const parts: string[] = []
      if (ctx.errorCount && ctx.errorCount > 0) parts.push(`${ctx.errorCount}E`)
      if (ctx.warningCount && ctx.warningCount > 0) parts.push(`${ctx.warningCount}W`)
      if (parts.length === 0) return ''
      text = parts.join(' ')
      color = ctx.errorCount && ctx.errorCount > 0 ? 'red' : 'yellow'
      break
    }

    case 'custom':
      return label ?? ''
  }

  if (label) text = `${label}: ${text}`
  text = truncate(text, segment.maxWidth)
  return colorize(text, segment.color ?? color)
}

// ── Main Render ─────────────────────────────────────────────────────────────

export function renderStatusLine(ctx: StatusLineContext, config?: StatusLineConfig | null, maxWidth = 120): string {
  const cfg = config ?? loadConfig() ?? DEFAULT_SEGMENTS

  // Script mode
  if (!Array.isArray(cfg)) {
    return runScript(cfg.script, ctx)
  }

  // Sort by priority (higher first)
  const sorted = [...cfg].sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0))

  const segments: string[] = []
  let totalWidth = 0

  for (const segment of sorted) {
    const rendered = renderSegment(segment, ctx)
    if (!rendered) continue

    // Check if it fits
    const strippedLen = stripAnsi(rendered).length
    if (totalWidth + strippedLen + 3 > maxWidth && segments.length > 0) break

    segments.push(rendered)
    totalWidth += strippedLen + 3
  }

  return segments.join(colorize(' | ', 'dim'))
}

function runScript(script: string, ctx: StatusLineContext): string {
  const env: Record<string, string> = {
    STATUS_CWD: ctx.cwd,
    STATUS_MODE: ctx.mode ?? '',
    STATUS_MODEL: ctx.model ?? '',
    STATUS_GIT_BRANCH: ctx.gitBranch ?? '',
    STATUS_GIT_DIRTY: ctx.gitDirty ? '1' : '0',
    STATUS_TOKENS: String(ctx.tokenCount ?? 0),
    STATUS_COST: String(ctx.cost ?? 0),
    STATUS_MESSAGES: String(ctx.messageCount ?? 0),
    STATUS_DURATION: String(ctx.duration ?? 0),
  }

  try {
    const output = execSync(script, {
      encoding: 'utf8',
      timeout: 2000,
      env: { ...process.env, ...env },
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    return output.trim()
  } catch {
    return '[statusline script error]'
  }
}

// ── PS1 Import ──────────────────────────────────────────────────────────────

export function importFromPS1(ps1: string): StatusSegment[] {
  // Parse common PS1 escape sequences into segments
  const segments: StatusSegment[] = []

  // Detect \u (user)
  if (ps1.includes('\\u') || ps1.includes('$USER')) {
    segments.push({ type: 'custom', label: 'user', priority: 50 })
  }

  // Detect \w (cwd)
  if (ps1.includes('\\w') || ps1.includes('$PWD')) {
    segments.push({ type: 'cwd', priority: 70 })
  }

  // Detect git
  if (ps1.includes('git') || ps1.includes('__git_ps1')) {
    segments.push({ type: 'git', priority: 80 })
  }

  // If nothing detected, use defaults
  if (segments.length === 0) {
    return DEFAULT_SEGMENTS
  }

  return segments
}

// ── Formatting ──────────────────────────────────────────────────────────────

export function formatSegmentList(segments: StatusSegment[]): string {
  if (segments.length === 0) return 'No segments configured.'
  const lines: string[] = [`Segments (${segments.length}):`]
  for (const s of segments) {
    const label = s.label ? ` "${s.label}"` : ''
    const color = s.color ? ` [${s.color}]` : ''
    const priority = s.priority ? ` prio=${s.priority}` : ''
    lines.push(`  ${s.type}${label}${color}${priority}`)
  }
  return lines.join('\n')
}

export function formatConfig(config: StatusLineConfig): string {
  if (!Array.isArray(config)) {
    return `Script mode: ${config.script}${config.refreshMs ? ` (refresh: ${config.refreshMs}ms)` : ''}`
  }
  return formatSegmentList(config)
}
