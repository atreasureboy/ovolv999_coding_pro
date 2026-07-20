/**
 * StatusBar — compact info bar at the bottom showing model, context pressure,
 * cost, and plan mode.
 *
 * Context pressure is shown as a visual bar: [████████░░░░░░░░] 50%
 * Color shifts: green < 50%, yellow 50-80%, red > 80%.
 */

import { Text, Box } from 'ink'

export interface StatusBarProps {
  model: string
  messageCount: number
  contextPct: number // 0..1
  cost: number
  apiCalls: number
  planMode: boolean
  verbose?: boolean
  gitBranch?: string | null
}

function contextBar(pct: number): { bar: string; color: string } {
  const rounded = Math.round(pct * 100)
  const width = 12
  const filled = Math.min(width, Math.round(pct * width))
  const empty = width - filled
  const bar = '█'.repeat(filled) + '░'.repeat(empty)
  const color = rounded > 80 ? 'redBright' : rounded > 50 ? 'yellow' : 'green'
  return { bar, color }
}

export function StatusBar({ model, messageCount, contextPct, cost, apiCalls, planMode, verbose, gitBranch }: StatusBarProps): React.ReactElement {
  const pct = Math.round(contextPct * 100)
  const { bar, color } = contextBar(contextPct)
  const costStr = cost < 0.01 ? cost.toFixed(4) : cost < 1 ? cost.toFixed(3) : cost.toFixed(2)

  return (
    <Box justifyContent="space-between" marginTop={1}>
      <Box gap={1}>
        <Text bold color="cyan">{model}</Text>
        {gitBranch ? <Text color="magenta"> {gitBranch}</Text> : null}
        {planMode ? <Text color="blueBright">◆ PLAN</Text> : null}
        {verbose ? <Text color="yellowBright">± VERBOSE</Text> : null}
        <Text dimColor>· {messageCount} msgs</Text>
      </Box>
      <Box gap={1}>
        <Text color={color}>[{bar}]</Text>
        <Text color={color}>{pct}%</Text>
        {apiCalls > 0 ? (
          <Text dimColor>${costStr} · {apiCalls} API</Text>
        ) : null}
      </Box>
    </Box>
  )
}
