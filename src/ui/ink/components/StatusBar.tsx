/**
 * StatusBar — footer line under the composer.
 *
 * Round 46 (codex layout language): the old footer was a dense strip —
 * BUILD / model / branch / chips / gauge / pct / tokens / cost all at
 * once. Codex's footer is ONE quiet line: hints on the left, context on
 * the right (`? for shortcuts          100% context left`). Everything
 * else (model, branch) already lives in the banner at startup; cost
 * surfaces via /cost. Density was the amateur tell, not polish.
 */

import { Text, Box } from 'ink'
import { t, pressureColor } from '../../theme.js'

export interface StatusBarProps {
  model: string
  messageCount: number
  contextPct: number // 0..1
  tokenCount?: number
  maxTokens?: number
  cost: number
  apiCalls: number
  planMode: boolean
  verbose?: boolean
  profile?: 'fast' | 'standard' | 'deep' | 'autonomous' | null
  gitBranch?: string | null
  terminalWidth?: number
}

export function StatusBar({ contextPct, planMode, verbose, profile, terminalWidth = 160 }: StatusBarProps): React.ReactElement {
  const pct = Math.round(contextPct * 100)
  const remaining = Math.max(0, 100 - pct)
  const color = pressureColor(contextPct)

  const left: string[] = []
  left.push('? for shortcuts')
  if (planMode) left.push('Plan mode ◇')
  if (profile && profile !== 'standard') left.push(profile)
  if (verbose) left.push('verbose')

  const right = `${remaining}% context left`

  return (
    <Box width="100%" justifyContent="space-between" paddingX={2} flexWrap="nowrap">
      <Box gap={2} flexShrink={1}>
        <Text color={t.faint} wrap="truncate-end">{left.join(' · ')}</Text>
      </Box>
      <Box flexShrink={0} gap={1}>
        <Text color={color}>{right}</Text>
      </Box>
    </Box>
  )
}
