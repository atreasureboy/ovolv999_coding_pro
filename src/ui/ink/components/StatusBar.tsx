/**
 * StatusBar — compact info bar at the bottom showing model, context pressure,
 * cost, and plan mode.
 *
 * Context pressure is shown as a visual bar: [████████░░░░░░░░] 50%
 * Color shifts: green < 50%, yellow 50-80%, red > 80%.
 * At >80% a ⚠ warning symbol is shown.
 */

import { Text, Box } from 'ink'

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
  gitBranch?: string | null
  terminalWidth?: number
}

function contextBar(pct: number): { bar: string; color: string } {
  const rounded = Math.round(pct * 100)
  const width = 8
  const filled = Math.min(width, Math.round(pct * width))
  const empty = width - filled
  const bar = '█'.repeat(filled) + '░'.repeat(empty)
  const color = rounded > 80 ? 'redBright' : rounded > 50 ? 'yellow' : 'green'
  return { bar, color }
}

function formatTokens(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`
  return `${n}`
}

export function StatusBar({ model, messageCount, contextPct, tokenCount, maxTokens, cost, apiCalls, planMode, verbose, gitBranch, terminalWidth = 160 }: StatusBarProps): React.ReactElement {
  const pct = Math.round(contextPct * 100)
  const { bar, color } = contextBar(contextPct)
  const costStr = cost < 0.01 ? cost.toFixed(4) : cost < 1 ? cost.toFixed(3) : cost.toFixed(2)
  const isHigh = pct > 80

  return (
    <Box width="100%" height={1} justifyContent="space-between" marginTop={1} paddingX={1} flexWrap="nowrap">
      <Box gap={1} flexShrink={1}>
        <Text color="#63B3ED">◆</Text>
        <Text bold color="#E8E3DA">BUILD</Text>
        <Text color="#7D8590">/</Text>
        <Text color="#C9A86A" wrap="truncate-end">{model}</Text>
        {gitBranch && terminalWidth >= 100 ? <Text dimColor wrap="truncate-end">{gitBranch}</Text> : null}
        {planMode ? <Text color="blueBright">PLAN</Text> : null}
        {verbose ? <Text color="yellowBright">VERBOSE</Text> : null}
        {terminalWidth >= 72 ? <Text dimColor>{messageCount} msgs</Text> : null}
      </Box>
      <Box gap={1} flexShrink={0}>
        {isHigh ? <Text color="redBright" bold>⚠</Text> : null}
        <Text dimColor>CONTEXT</Text>
        <Text color={color}>{bar}</Text>
        <Text color={color} bold={isHigh}>{pct}%</Text>
        {terminalWidth >= 105 && tokenCount !== undefined && maxTokens ? (
          <Text dimColor>{formatTokens(tokenCount)}/{formatTokens(maxTokens)}</Text>
        ) : null}
        {terminalWidth >= 130 && apiCalls > 0 ? (
          <Text dimColor>${costStr} · {apiCalls} API</Text>
        ) : null}
      </Box>
    </Box>
  )
}
