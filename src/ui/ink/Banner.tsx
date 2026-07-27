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
      <Box>
        <Text color="cyanBright">◆ </Text>
        <Text bold>ovolv999</Text>
        <Text dimColor> {version}</Text>
      </Box>
      <Box marginLeft={2} gap={1}>
        <Text color="cyan">{model}</Text>
        {ctxStr ? <Text dimColor> · {ctxStr} ctx</Text> : null}
        {gitBranch ? <Text dimColor> · {gitBranch}</Text> : null}
      </Box>
      {cwd ? (
        <Box marginLeft={2}>
          <Text dimColor>{shortenPath(cwd)}</Text>
        </Box>
      ) : null}
      <Text dimColor>{'─'.repeat(48)}</Text>
    </Box>
  )
}
