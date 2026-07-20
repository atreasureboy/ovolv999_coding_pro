/**
 * Auto-Compact Guard
 *
 * Monitors context window usage and triggers compaction when approaching limits.
 * Provides graduated warnings and automatic compaction.
 */

import type { OpenAIMessage } from './types.js'
import { estimateTokens } from './compact.js'

// ── Types ───────────────────────────────────────────────────────────────────

export type CompactStage = 'safe' | 'caution' | 'warning' | 'critical' | 'compact'

export interface ContextStats {
  /** Total tokens used by all messages */
  totalTokens: number
  /** Number of messages */
  messageCount: number
  /** Model context window size */
  contextWindow: number
  /** Usage ratio (0-1) */
  usageRatio: number
  /** Remaining tokens */
  remainingTokens: number
  /** Current stage */
  stage: CompactStage
  /** Estimated messages that can still be added */
  estimatedSlotsRemaining: number
}

export interface CompactThresholds {
  /** Caution: start hinting (default 0.5) */
  caution: number
  /** Warning: show prominent warning (default 0.7) */
  warning: number
  /** Critical: last chance before compact (default 0.85) */
  critical: number
  /** Auto-compact trigger (default 0.92) */
  compact: number
}

export interface CompactConfig {
  thresholds: CompactThresholds
  /** Context window size for the model */
  contextWindow: number
  /** Whether auto-compact is enabled */
  autoCompact: boolean
  /** Number of messages to keep after compaction (recent context) */
  keepRecent: number
  /** Minimum messages before considering compaction */
  minMessages: number
}

export const DEFAULT_THRESHOLDS: CompactThresholds = {
  caution: 0.5,
  warning: 0.7,
  critical: 0.85,
  compact: 0.92,
}

export const DEFAULT_COMPACT_CONFIG: CompactConfig = {
  thresholds: DEFAULT_THRESHOLDS,
  contextWindow: 200_000,
  autoCompact: true,
  keepRecent: 10,
  minMessages: 20,
}

// ── Context Analysis ────────────────────────────────────────────────────────

export function analyzeContext(
  messages: OpenAIMessage[],
  config: CompactConfig = DEFAULT_COMPACT_CONFIG,
): ContextStats {
  const totalTokens = estimateTokens(messages)
  const contextWindow = config.contextWindow
  const usageRatio = contextWindow > 0 ? totalTokens / contextWindow : 0
  const remainingTokens = Math.max(0, contextWindow - totalTokens)

  const stage = getStage(usageRatio, config.thresholds)

  // Estimate remaining message slots
  const avgTokensPerMessage = messages.length > 0
    ? totalTokens / messages.length
    : 500
  const estimatedSlotsRemaining = avgTokensPerMessage > 0
    ? Math.floor(remainingTokens / avgTokensPerMessage)
    : 0

  return {
    totalTokens,
    messageCount: messages.length,
    contextWindow,
    usageRatio,
    remainingTokens,
    stage,
    estimatedSlotsRemaining,
  }
}

export function getStage(ratio: number, thresholds: CompactThresholds): CompactStage {
  if (ratio >= thresholds.compact) return 'compact'
  if (ratio >= thresholds.critical) return 'critical'
  if (ratio >= thresholds.warning) return 'warning'
  if (ratio >= thresholds.caution) return 'caution'
  return 'safe'
}

// ── Compact Decision ────────────────────────────────────────────────────────

export interface CompactDecision {
  /** Whether to trigger compaction */
  shouldCompact: boolean
  /** Reason for the decision */
  reason: string
  /** Current stage */
  stage: CompactStage
  /** Stats at decision time */
  stats: ContextStats
  /** Whether compaction was forced (ignoring minMessages) */
  forced: boolean
}

export function shouldCompact(
  messages: OpenAIMessage[],
  config: CompactConfig = DEFAULT_COMPACT_CONFIG,
  force = false,
): CompactDecision {
  const stats = analyzeContext(messages, config)

  if (stats.stage === 'compact' && config.autoCompact) {
    if (messages.length >= config.minMessages || force) {
      return {
        shouldCompact: true,
        reason: `Context at ${Math.round(stats.usageRatio * 100)}% (${stats.totalTokens}/${stats.contextWindow} tokens). Auto-compacting.`,
        stage: stats.stage,
        stats,
        forced: force,
      }
    }
    return {
      shouldCompact: false,
      reason: `Context at ${Math.round(stats.usageRatio * 100)}% but only ${messages.length} messages (min: ${config.minMessages}).`,
      stage: stats.stage,
      stats,
      forced: false,
    }
  }

  if (force && messages.length >= config.minMessages) {
    return {
      shouldCompact: true,
      reason: 'Manual compaction requested.',
      stage: stats.stage,
      stats,
      forced: true,
    }
  }

  return {
    shouldCompact: false,
    reason: `Context at ${Math.round(stats.usageRatio * 100)}% (${stats.totalTokens}/${stats.contextWindow} tokens). Stage: ${stats.stage}.`,
    stage: stats.stage,
    stats,
    forced: false,
  }
}

// ── Message Selection for Compaction ────────────────────────────────────────

export interface CompactPlan {
  /** Messages to summarize */
  toSummarize: OpenAIMessage[]
  /** Messages to keep verbatim */
  toKeep: OpenAIMessage[]
  /** Total tokens being compacted */
  compactedTokens: number
  /** Total tokens kept */
  keptTokens: number
  /** Estimated tokens after compaction (summary + kept) */
  estimatedAfterCompact: number
}

export function planCompaction(
  messages: OpenAIMessage[],
  config: CompactConfig = DEFAULT_COMPACT_CONFIG,
): CompactPlan {
  const keepCount = Math.min(config.keepRecent, messages.length)
  const toKeep = messages.slice(-keepCount)
  const toSummarize = messages.length > keepCount ? messages.slice(0, -keepCount) : []

  const compactedTokens = estimateTokens(toSummarize)
  const keptTokens = estimateTokens(toKeep)

  // Estimate: a summary is typically ~10% of original tokens
  const summaryTokens = Math.round(compactedTokens * 0.1)
  const estimatedAfterCompact = summaryTokens + keptTokens

  return {
    toSummarize,
    toKeep,
    compactedTokens,
    keptTokens,
    estimatedAfterCompact,
  }
}

// ── Formatting ──────────────────────────────────────────────────────────────

const STAGE_ICONS: Record<CompactStage, string> = {
  safe: '✓',
  caution: '○',
  warning: '⚠',
  critical: '⚠!',
  compact: '✗',
}

const STAGE_COLORS: Record<CompactStage, string> = {
  safe: 'green',
  caution: 'yellow',
  warning: 'yellow',
  critical: 'red',
  compact: 'red',
}

export function formatContextBar(
  stats: ContextStats,
  width = 30,
): string {
  const ratio = Math.min(1, stats.usageRatio)
  const filled = Math.round(ratio * width)
  const empty = width - filled

  const icon = STAGE_ICONS[stats.stage]
  const percent = Math.round(stats.usageRatio * 100)
  const bar = `${'█'.repeat(filled)}${'░'.repeat(empty)}`

  return `${icon} [${bar}] ${percent}% (${stats.totalTokens}/${stats.contextWindow} tokens, ~${stats.estimatedSlotsRemaining} msgs left)`
}

export function formatStageWarning(stage: CompactStage, stats: ContextStats): string {
  switch (stage) {
    case 'safe':
      return '' // No warning needed
    case 'caution':
      return `ℹ Context at ${Math.round(stats.usageRatio * 100)}%. Consider compacting soon.`
    case 'warning':
      return `⚠ Context at ${Math.round(stats.usageRatio * 100)}%. Compaction recommended. Use /compact.`
    case 'critical':
      return `⚠! Context at ${Math.round(stats.usageRatio * 100)}%. Will auto-compact on next message. Use /compact to do it now.`
    case 'compact':
      return `✗ Context at ${Math.round(stats.usageRatio * 100)}%. Auto-compacting now.`
  }
}

export function formatCompactPlan(plan: CompactPlan): string {
  const lines: string[] = [
    'Compaction Plan:',
    `  Messages to summarize: ${plan.toSummarize.length} (${plan.compactedTokens} tokens)`,
    `  Messages to keep: ${plan.toKeep.length} (${plan.keptTokens} tokens)`,
    `  Estimated after compaction: ${plan.estimatedAfterCompact} tokens`,
    `  Space savings: ~${Math.round((1 - plan.estimatedAfterCompact / (plan.compactedTokens + plan.keptTokens)) * 100)}%`,
  ]
  return lines.join('\n')
}

export function formatStats(stats: ContextStats): string {
  const lines: string[] = [
    `Context Window: ${stats.totalTokens.toLocaleString()} / ${stats.contextWindow.toLocaleString()} tokens (${Math.round(stats.usageRatio * 100)}%)`,
    `  Remaining: ${stats.remainingTokens.toLocaleString()} tokens`,
    `  Messages: ${stats.messageCount}`,
    `  Stage: ${stats.stage}`,
    `  Estimated slots remaining: ~${stats.estimatedSlotsRemaining}`,
  ]
  return lines.join('\n')
}

// ── Model Context Windows ───────────────────────────────────────────────────

export const MODEL_CONTEXT_WINDOWS: Record<string, number> = {
  'gpt-4o': 128_000,
  'gpt-4o-mini': 128_000,
  'gpt-4-turbo': 128_000,
  'gpt-4': 8_192,
  'gpt-3.5-turbo': 16_385,
  'claude-3-opus': 200_000,
  'claude-3-sonnet': 200_000,
  'claude-3-haiku': 200_000,
  'claude-3.5-sonnet': 200_000,
  'claude-3.5-haiku': 200_000,
  'gemini-1.5-pro': 2_000_000,
  'gemini-1.5-flash': 1_000_000,
  'o1': 200_000,
  'o1-mini': 128_000,
  'o3': 200_000,
  'o3-mini': 200_000,
}

export function getContextWindowForModel(model: string): number {
  // Direct match
  if (model in MODEL_CONTEXT_WINDOWS) {
    return MODEL_CONTEXT_WINDOWS[model]
  }

  // Partial match
  for (const [key, size] of Object.entries(MODEL_CONTEXT_WINDOWS)) {
    if (model.includes(key)) return size
  }

  // Default
  return DEFAULT_COMPACT_CONFIG.contextWindow
}

export function createConfigForModel(model: string, overrides: Partial<CompactConfig> = {}): CompactConfig {
  return {
    ...DEFAULT_COMPACT_CONFIG,
    contextWindow: getContextWindowForModel(model),
    ...overrides,
  }
}
