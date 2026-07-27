/**
 * Banner — startup banner showing version, model, cwd, and git info.
 */

import { Text, Box } from 'ink'

export interface BannerProps {
  version: string
  model: string
  cwd?: string
  gitBranch?: string | null
  contextWindow?: number
}

function shortenPath(p: string, max = 40): string {
  if (p.length <= max) return p
  const parts = p.split('/')
  if (parts.length <= 2) return p
  return '…/' + parts.slice(-2).join('/')
}

export function Banner({ version, model, cwd, gitBranch, contextWindow }: BannerProps): React.ReactElement {
  const ctxStr = contextWindow
    ? contextWindow >= 1000
      ? `${(contextWindow / 1000).toFixed(0)}k`
      : `${contextWindow}`
    : ''

  return (
    <Box flexDirection="column" marginBottom={1}>
      <Box justifyContent="space-between">
        <Box>
          <Text color="#C9A86A">◈ </Text>
          <Text bold color="#E8E3DA">ovolv999</Text>
        </Box>
        <Text dimColor>v{version}</Text>
      </Box>
      <Text color="#7D8590">{'─'.repeat(48)}</Text>
      <Box gap={1}>
        <Text color="#C9A86A">{model}</Text>
        <Text dimColor>· ready</Text>
        {ctxStr ? <Text dimColor>· {ctxStr} ctx</Text> : null}
        {gitBranch ? <Text dimColor>· {gitBranch}</Text> : null}
      </Box>
      {cwd ? <Text dimColor>{shortenPath(cwd)}</Text> : null}
    </Box>
  )
}
