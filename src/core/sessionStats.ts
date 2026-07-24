/**
 * Session Statistics
 *
 * Tracks and reports comprehensive statistics about a conversation session.
 * Aggregates message counts, token usage, tool calls, cost, duration,
 * files touched, and more.
 */

import type { OpenAIMessage, ToolCall } from '../core/types.js'
import { extname } from 'path'

// ── Types ───────────────────────────────────────────────────────────────────

export interface SessionStats {
  /** Total messages (including system, user, assistant, tool) */
  totalMessages: number
  /** Messages by role */
  messagesByRole: Record<string, number>
  /** Estimated input tokens */
  estimatedInputTokens: number
  /** Estimated output tokens */
  estimatedOutputTokens: number
  /** Total estimated tokens */
  totalTokens: number
  /** Total tool calls made */
  totalToolCalls: number
  /** Tool calls by tool name */
  toolCallsByName: Record<string, number>
  /** Tool errors count */
  toolErrors: number
  /** Tool success rate (0-1) */
  toolSuccessRate: number
  /** Files read */
  filesRead: string[]
  /** Files written */
  filesWritten: string[]
  /** Files edited */
  filesEdited: string[]
  /** Unique files touched */
  uniqueFilesTouched: number
  /** Commands executed (Bash) */
  commandsExecuted: number
  /** Grep searches */
  grepSearches: number
  /** Glob searches */
  globSearches: number
  /** Sub-agents spawned */
  subAgentsSpawned: number
  /** Languages detected from file extensions */
  languages: Record<string, number>
  /** Average assistant message length (chars) */
  avgAssistantMessageLength: number
  /** Longest assistant message (chars) */
  longestAssistantMessage: number
  /** Total assistant content length */
  totalAssistantChars: number
  /** First message timestamp (from metadata, if available) */
  firstMessageAt: string | null
  /** Last message timestamp */
  lastMessageAt: string | null
  /** Estimated duration (seconds, from timestamps) */
  estimatedDurationSec: number | null
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4)
}

function getMessageContent(msg: OpenAIMessage): string {
  if (typeof msg.content === 'string') return msg.content
  if (msg.content === null) return ''
  if (Array.isArray(msg.content)) {
    return msg.content.map(part => {
      if (typeof part === 'string') return part
      if ('text' in part) return part.text
      return ''
    }).join('')
  }
  return ''
}

function tryParseToolArgs(args: string): Record<string, unknown> {
  try {
    return JSON.parse(args)
  } catch {
    return {}
  }
}

// ── Analysis ────────────────────────────────────────────────────────────────

/**
 * Analyze a conversation history and produce session statistics.
 */
export function analyzeSession(messages: OpenAIMessage[]): SessionStats {
  const stats: SessionStats = {
    totalMessages: messages.length,
    messagesByRole: {},
    estimatedInputTokens: 0,
    estimatedOutputTokens: 0,
    totalTokens: 0,
    totalToolCalls: 0,
    toolCallsByName: {},
    toolErrors: 0,
    toolSuccessRate: 0,
    filesRead: [],
    filesWritten: [],
    filesEdited: [],
    uniqueFilesTouched: 0,
    commandsExecuted: 0,
    grepSearches: 0,
    globSearches: 0,
    subAgentsSpawned: 0,
    languages: {},
    avgAssistantMessageLength: 0,
    longestAssistantMessage: 0,
    totalAssistantChars: 0,
    firstMessageAt: null,
    lastMessageAt: null,
    estimatedDurationSec: null,
  }

  let assistantMessageCount = 0
  let assistantTotalLength = 0
  const allFiles = new Set<string>()

  for (const msg of messages) {
    // Count by role
    stats.messagesByRole[msg.role] = (stats.messagesByRole[msg.role] ?? 0) + 1

    const content = getMessageContent(msg)

    // Token estimation
    if (msg.role === 'user' || msg.role === 'system') {
      stats.estimatedInputTokens += estimateTokens(content)
    } else if (msg.role === 'assistant') {
      stats.estimatedOutputTokens += estimateTokens(content)
      assistantMessageCount++
      assistantTotalLength += content.length
      stats.longestAssistantMessage = Math.max(stats.longestAssistantMessage, content.length)
    } else if (msg.role === 'tool') {
      stats.estimatedInputTokens += estimateTokens(content)
      // Check for errors in tool results
      if (content.toLowerCase().includes('error') || content.toLowerCase().includes('failed')) {
        stats.toolErrors++
      }
    }

    // Track tool calls
    if (msg.tool_calls) {
      for (const tc of msg.tool_calls) {
        stats.totalToolCalls++
        const name = tc.function.name
        stats.toolCallsByName[name] = (stats.toolCallsByName[name] ?? 0) + 1
        analyzeToolCall(tc, stats, allFiles)
      }
    }
  }

  // Compute derived stats
  stats.totalTokens = stats.estimatedInputTokens + stats.estimatedOutputTokens
  stats.uniqueFilesTouched = allFiles.size
  stats.avgAssistantMessageLength = assistantMessageCount > 0
    ? Math.round(assistantTotalLength / assistantMessageCount)
    : 0
  stats.totalAssistantChars = assistantTotalLength

  // Compute success rate
  if (stats.totalToolCalls > 0) {
    stats.toolSuccessRate = (stats.totalToolCalls - stats.toolErrors) / stats.totalToolCalls
  }

  // Language detection from files
  for (const file of allFiles) {
    const ext = extname(file).toLowerCase()
    if (ext) {
      stats.languages[ext] = (stats.languages[ext] ?? 0) + 1
    }
  }

  // Timestamps (best-effort from metadata)
  for (const msg of messages) {
    const m = msg as OpenAIMessage & { timestamp?: string; createdAt?: string }
    const ts = m.timestamp ?? m.createdAt
    if (ts) {
      if (!stats.firstMessageAt) stats.firstMessageAt = ts
      stats.lastMessageAt = ts
    }
  }

  if (stats.firstMessageAt && stats.lastMessageAt) {
    const start = new Date(stats.firstMessageAt).getTime()
    const end = new Date(stats.lastMessageAt).getTime()
    stats.estimatedDurationSec = Math.round((end - start) / 1000)
  }

  return stats
}

function analyzeToolCall(tc: ToolCall, stats: SessionStats, allFiles: Set<string>): void {
  const args = tryParseToolArgs(tc.function.arguments)

  switch (tc.function.name) {
    case 'Read': {
      const path = args.file_path ?? args.path ?? ''
      if (typeof path === 'string' && path) {
        stats.filesRead.push(path)
        allFiles.add(path)
      }
      break
    }
    case 'Write': {
      const path = args.file_path ?? args.path ?? ''
      if (typeof path === 'string' && path) {
        stats.filesWritten.push(path)
        allFiles.add(path)
      }
      break
    }
    case 'Edit': {
      const path = args.file_path ?? args.path ?? ''
      if (typeof path === 'string' && path) {
        stats.filesEdited.push(path)
        allFiles.add(path)
      }
      break
    }
    case 'Bash': {
      stats.commandsExecuted++
      break
    }
    case 'Grep': {
      stats.grepSearches++
      break
    }
    case 'Glob': {
      stats.globSearches++
      break
    }
    case 'Agent':
    case 'Task': {
      stats.subAgentsSpawned++
      break
    }
  }
}

// ── Formatting ──────────────────────────────────────────────────────────────

export function formatSessionStats(stats: SessionStats): string {
  const lines: string[] = [
    '── Session Statistics ──',
    '',
    `Messages: ${stats.totalMessages}`,
  ]

  // Role breakdown
  const roleParts = Object.entries(stats.messagesByRole)
    .map(([role, count]) => `${role}: ${count}`)
    .join(' · ')
  if (roleParts) {
    lines.push(`  ${roleParts}`)
  }

  // Tokens
  lines.push('')
  lines.push(`Tokens: ${stats.totalTokens.toLocaleString()} total`)
  lines.push(`  Input: ${stats.estimatedInputTokens.toLocaleString()}`)
  lines.push(`  Output: ${stats.estimatedOutputTokens.toLocaleString()}`)

  // Tool usage
  lines.push('')
  lines.push(`Tool calls: ${stats.totalToolCalls}`)
  if (stats.totalToolCalls > 0) {
    lines.push(`  Success rate: ${(stats.toolSuccessRate * 100).toFixed(1)}%`)
    lines.push(`  Errors: ${stats.toolErrors}`)
    const sorted = Object.entries(stats.toolCallsByName).sort((a, b) => b[1] - a[1])
    for (const [name, count] of sorted.slice(0, 5)) {
      lines.push(`  ${name}: ${count}`)
    }
  }

  // Files
  lines.push('')
  lines.push(`Files touched: ${stats.uniqueFilesTouched}`)
  if (stats.filesRead.length > 0) lines.push(`  Read: ${stats.filesRead.length}`)
  if (stats.filesWritten.length > 0) lines.push(`  Written: ${stats.filesWritten.length}`)
  if (stats.filesEdited.length > 0) lines.push(`  Edited: ${stats.filesEdited.length}`)

  // Languages
  if (Object.keys(stats.languages).length > 0) {
    lines.push('')
    lines.push('Languages:')
    const sortedLangs = Object.entries(stats.languages).sort((a, b) => b[1] - a[1])
    for (const [ext, count] of sortedLangs) {
      lines.push(`  ${ext}: ${count}`)
    }
  }

  // Activity
  lines.push('')
  lines.push('Activity:')
  lines.push(`  Commands executed: ${stats.commandsExecuted}`)
  lines.push(`  Grep searches: ${stats.grepSearches}`)
  lines.push(`  Glob searches: ${stats.globSearches}`)
  lines.push(`  Sub-agents spawned: ${stats.subAgentsSpawned}`)

  // Duration
  if (stats.estimatedDurationSec !== null) {
    lines.push('')
    const duration = formatDuration(stats.estimatedDurationSec)
    lines.push(`Duration: ${duration}`)
  }

  // Assistant stats
  if (stats.avgAssistantMessageLength > 0) {
    lines.push('')
    lines.push(`Assistant messages:`)
    lines.push(`  Average length: ${stats.avgAssistantMessageLength} chars`)
    lines.push(`  Longest: ${stats.longestAssistantMessage} chars`)
    lines.push(`  Total: ${stats.totalAssistantChars} chars`)
  }

  return lines.join('\n')
}

export function formatDuration(seconds: number): string {
  if (seconds < 60) return `${seconds}s`
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${seconds % 60}s`
  const h = Math.floor(seconds / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  return `${h}h ${m}m`
}

/**
 * Get a brief one-line summary of session stats.
 */
export function formatBriefStats(stats: SessionStats): string {
  const parts: string[] = [
    `${stats.totalMessages} msg`,
    `${stats.totalTokens} tok`,
    `${stats.totalToolCalls} tools`,
    `${stats.uniqueFilesTouched} files`,
  ]
  if (stats.estimatedDurationSec !== null) {
    parts.push(formatDuration(stats.estimatedDurationSec))
  }
  return parts.join(' · ')
}
