/**
 * StatusBar — compact info bar at the bottom showing model, context pressure,
 * cost, and plan mode.
 *
 * Round 44: theme-token colors; a real gauge (━━━╸) instead of block
 * glyphs; profile chips calm enough to coexist with plan mode.
 */

import { Text, Box } from 'ink'
import { t, pressureColor } from '../../theme.js'

export interface StatusBarProps {
  model: string
  messageCount: number
  contextPct: number // 0..1
  tokenCount?: number // estimated total tokens
  maxTokens?: number // context window size
  cost: number
  apiCalls: number
  planMode: boolean
  verbose?: boolean
  /**
   * v0.4.1 WS4 (ExecutionProfile): the profile the current turn runs
   * under. Anything but 'standard' renders a chip so users can SEE that
   * a Q&A turn dropped the Critic/Reflection machinery.
   */
  profile?: 'fast' | 'standard' | 'deep' | 'autonomous' | null
  gitBranch?: string | null
  terminalWidth?: number
}

/** Thin ruler gauge: ━━━━╺──── 40% */
function contextGauge(pct: number): { bar: string; color: string } {
  const width = 10
  const clamped = Math.max(0, Math.min(1, pct))
  const filled = Math.round(clamped * width)
  const head = filled > 0 ? '╸' : ''
  const body = '━'.repeat(Math.max(0, filled - (filled > 0 ? 1 : 0)))
  const empty = '─'.repeat(width - filled)
  return { bar: body + head + empty, color: pressureColor(clamped) }
}

function formatTokens(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`
  return `${n}`
}

export function StatusBar({ model, messageCount, contextPct, tokenCount, maxTokens, cost, apiCalls, planMode, verbose, profile, gitBranch, terminalWidth = 160 }: StatusBarProps): React.ReactElement {
  const pct = Math.round(contextPct * 100)
  const { bar, color } = contextGauge(contextPct)
  const costStr = cost < 0.01 ? cost.toFixed(4) : cost < 1 ? cost.toFixed(3) : cost.toFixed(2)
  const isHigh = pct > 80

  return (
    <Box width="100%" height={1} justifyContent="space-between" marginTop={1} paddingX={1} flexWrap="nowrap">
      <Box gap={1} flexShrink={1}>
        <Text color={t.accent}>◆</Text>
        <Text bold color={t.text}>BUILD</Text>
        <Text color={t.faint}>/</Text>
        <Text color={t.primary} wrap="truncate-end">{model}</Text>
        {gitBranch && terminalWidth >= 100 ? <Text color={t.muted} wrap="truncate-end">{gitBranch}</Text> : null}
        {planMode ? <Text bold color={t.info}>◇ PLAN</Text> : null}
        {profile && profile !== 'standard' ? (
          <Text color={profile === 'fast' ? t.info : profile === 'deep' ? t.accent : t.success}>
            {profile.toUpperCase()}
          </Text>
        ) : null}
        {verbose ? <Text color={t.warning}>VERBOSE</Text> : null}
        {terminalWidth >= 72 ? <Text color={t.muted}>{messageCount} msgs</Text> : null}
      </Box>
      <Box gap={1} flexShrink={0}>
        {isHigh ? <Text bold color={t.error}>⚠</Text> : null}
        <Text color={t.muted}>CTX</Text>
        <Text color={color}>{bar}</Text>
        <Text color={color} bold={isHigh}>{pct}%</Text>
        {terminalWidth >= 105 && tokenCount !== undefined && maxTokens ? (
          <Text color={t.faint}>{formatTokens(tokenCount)}/{formatTokens(maxTokens)}</Text>
        ) : null}
        {terminalWidth >= 130 && apiCalls > 0 ? (
          <Text color={t.muted}>${costStr} · {apiCalls} API</Text>
        ) : null}
      </Box>
    </Box>
  )
}
