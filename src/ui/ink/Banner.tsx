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
    <Box flexDirection="column" marginBottom={1} paddingX={1}>
      <Box justifyContent="space-between">
        <Box gap={1}>
          <Text bold color="#63B3ED">◆ ovolv999</Text>
          <Text dimColor>developer agent</Text>
        </Box>
        <Box>
          <Text color="#C9A86A">{model}</Text>
          <Text dimColor> · v{version}</Text>
        </Box>
      </Box>
      <Box gap={1}>
        <Text dimColor>{cwd ? shortenPath(cwd) : '—'}</Text>
        <Text color="#7D8590">·</Text>
        <Text color="#A78BFA">{gitBranch ?? 'no git'}</Text>
        {ctxStr ? <Text dimColor>· {ctxStr} context</Text> : null}
      </Box>
    </Box>
  )
}
