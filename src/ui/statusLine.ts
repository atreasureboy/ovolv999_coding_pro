/**
 * StatusLine
 *
 * Rich status bar showing model, tokens, cost, git branch, mode, and more.
 */

import { stripAnsi, ansiLength, padRight, truncate, ANSI } from '../utils/ansi.js'
import { getActiveTheme } from './theme.js'

// ── Types ───────────────────────────────────────────────────────────────────

export interface StatusLineData {
  model?: string
  mode?: string
  modeIcon?: string
  gitBranch?: string | null
  gitDirty?: boolean
  tokenCount?: number
  contextWindow?: number
  cost?: number
  messageCount?: number
  cwd?: string
  provider?: string
  sessionDuration?: number
  customSegment?: string
}

export interface StatusLineConfig {
  segments: SegmentConfig[]
  separator: string
  maxWidth: number
}

export interface SegmentConfig {
  id: string
  render: (data: StatusLineData) => string | null
  priority: number
  minWidth?: number
}

// ── Built-in Segments ───────────────────────────────────────────────────────

export function modelSegment(data: StatusLineData): string | null {
  if (!data.model) return null
  const provider = data.provider ? `${data.provider}/` : ''
  return `${provider}${data.model}`
}

export function modeSegment(data: StatusLineData): string | null {
  if (!data.mode) return null
  const icon = data.modeIcon ?? ''
  return `${icon} ${data.mode}`.trim()
}

export function gitSegment(data: StatusLineData): string | null {
  if (!data.gitBranch) return null
  const dirty = data.gitDirty ? '*' : ''
  return `${data.gitBranch}${dirty}`
}

export function tokenSegment(data: StatusLineData): string | null {
  if (data.tokenCount === undefined) return null
  const formatted = formatTokens(data.tokenCount)
  if (data.contextWindow) {
    const ratio = Math.round((data.tokenCount / data.contextWindow) * 100)
    return `${formatted} (${ratio}%)`
  }
  return formatted
}

export function costSegment(data: StatusLineData): string | null {
  if (data.cost === undefined || data.cost === 0) return null
  return `$${data.cost.toFixed(4)}`
}

export function messageCountSegment(data: StatusLineData): string | null {
  if (!data.messageCount || data.messageCount === 0) return null
  return `${data.messageCount} msg`
}

export function cwdSegment(data: StatusLineData): string | null {
  if (!data.cwd) return null
  const parts = data.cwd.split('/')
  const short = parts.slice(-2).join('/')
  return short
}

export function durationSegment(data: StatusLineData): string | null {
  if (!data.sessionDuration) return null
  return formatDuration(data.sessionDuration)
}

export function customSegment(data: StatusLineData): string | null {
  return data.customSegment ?? null
}

// ── Default Config ──────────────────────────────────────────────────────────

export const DEFAULT_SEGMENTS: SegmentConfig[] = [
  { id: 'mode', render: modeSegment, priority: 100, minWidth: 4 },
  { id: 'model', render: modelSegment, priority: 90, minWidth: 6 },
  { id: 'git', render: gitSegment, priority: 80, minWidth: 4 },
  { id: 'cwd', render: cwdSegment, priority: 70, minWidth: 4 },
  { id: 'tokens', render: tokenSegment, priority: 60, minWidth: 6 },
  { id: 'cost', render: costSegment, priority: 50, minWidth: 4 },
  { id: 'messages', render: messageCountSegment, priority: 40, minWidth: 4 },
  { id: 'duration', render: durationSegment, priority: 30, minWidth: 4 },
  { id: 'custom', render: customSegment, priority: 10 },
]

// ── Rendering ───────────────────────────────────────────────────────────────

export function renderStatusLine(
  data: StatusLineData,
  config: StatusLineConfig = { segments: DEFAULT_SEGMENTS, separator: ' │ ', maxWidth: 80 },
): string {
  const segments = [...config.segments].sort((a, b) => b.priority - a.priority)

  const rendered: Array<{ id: string; text: string; width: number }> = []

  for (const seg of segments) {
    const text = seg.render(data)
    if (text === null || text.trim() === '') continue
    const width = ansiLength(text)
    rendered.push({ id: seg.id, text, width })
  }

  // Fit segments within maxWidth
  const sepWidth = config.separator.length
  const fitted = fitSegments(rendered, config.maxWidth, sepWidth)

  if (fitted.length === 0) return ''

  const parts = fitted.map(s => colorizeSegment(s))
  return parts.join(config.separator)
}

function fitSegments(
  segments: Array<{ id: string; text: string; width: number }>,
  maxWidth: number,
  sepWidth: number,
): Array<{ id: string; text: string; width: number }> {
  let totalWidth = segments.reduce((s, seg) => s + seg.width, 0)
  totalWidth += sepWidth * Math.max(0, segments.length - 1)

  if (totalWidth <= maxWidth) return segments

  // Remove lowest priority segments until it fits
  const result = [...segments]
  while (result.length > 1 && totalWidth > maxWidth) {
    const removed = result.pop()!
    totalWidth -= removed.width + sepWidth
  }

  // If still too wide, truncate the last one
  if (totalWidth > maxWidth && result.length > 0) {
    const overflow = totalWidth - maxWidth
    const last = result[result.length - 1]
    const newWidth = Math.max(4, last.width - overflow)
    last.text = truncate(last.text, newWidth)
    last.width = newWidth
  }

  return result
}

function colorizeSegment(seg: { id: string; text: string }): string {
  const theme = getActiveTheme()

  switch (seg.id) {
    case 'mode':
      return seg.text
    case 'model':
      return `${ANSI.DIM}${seg.text}${ANSI.RESET}`
    case 'git':
      return seg.text
    case 'tokens': {
      // Check if contains percentage
      const match = seg.text.match(/(\d+)%/)
      if (match) {
        const pct = parseInt(match[1], 10)
        if (pct >= 90) return `\x1b[38;2;${hexToRgbStr(theme.colors.error)}m${seg.text}${ANSI.RESET}`
        if (pct >= 70) return `\x1b[38;2;${hexToRgbStr(theme.colors.warning)}m${seg.text}${ANSI.RESET}`
      }
      return `${ANSI.DIM}${seg.text}${ANSI.RESET}`
    }
    case 'cost':
      return `\x1b[38;2;${hexToRgbStr(theme.colors.success)}m${seg.text}${ANSI.RESET}`
    default:
      return `${ANSI.DIM}${seg.text}${ANSI.RESET}`
  }
}

function hexToRgbStr(hex: string): string {
  const cleaned = hex.replace('#', '')
  const r = parseInt(cleaned.slice(0, 2), 16)
  const g = parseInt(cleaned.slice(2, 4), 16)
  const b = parseInt(cleaned.slice(4, 6), 16)
  return `${r};${g};${b}`
}

// ── Formatting Helpers ──────────────────────────────────────────────────────

export function formatTokens(count: number): string {
  if (count < 1000) return `${count}t`
  if (count < 1_000_000) return `${(count / 1000).toFixed(1)}K`
  return `${(count / 1_000_000).toFixed(1)}M`
}

export function formatDuration(seconds: number): string {
  if (seconds < 60) return `${Math.round(seconds)}s`
  const minutes = Math.floor(seconds / 60)
  const remainingSeconds = Math.round(seconds % 60)
  if (minutes < 60) return `${minutes}m${remainingSeconds}s`
  const hours = Math.floor(minutes / 60)
  const remainingMinutes = minutes % 60
  return `${hours}h${remainingMinutes}m`
}

// ── Full Status Line with Borders ───────────────────────────────────────────

export function renderFullStatusLine(
  data: StatusLineData,
  width?: number,
): string {
  const maxWidth = width ?? process.stdout.columns ?? 80
  const line = renderStatusLine(data, { segments: DEFAULT_SEGMENTS, separator: ' │ ', maxWidth })

  if (!line) return ''

  const padding = Math.max(0, maxWidth - ansiLength(line))
  return `${line}${' '.repeat(padding)}`
}

// ── Minimal Status Line ─────────────────────────────────────────────────────

export function renderMinimalStatusLine(data: StatusLineData): string {
  const parts: string[] = []

  if (data.modeIcon) parts.push(data.modeIcon)
  if (data.gitBranch) parts.push(data.gitBranch)
  if (data.tokenCount !== undefined) parts.push(formatTokens(data.tokenCount))
  if (data.cost) parts.push(`$${data.cost.toFixed(2)}`)

  return parts.join(' ')
}
