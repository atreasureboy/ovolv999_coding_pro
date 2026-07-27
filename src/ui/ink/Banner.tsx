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
      <Box flexDirection="column" borderStyle="round" borderColor="magentaBright" paddingX={1}>
        <Box justifyContent="space-between">
          <Box>
            <Text color="cyanBright">◆ </Text>
            <Text bold color="cyanBright">OVOLV999</Text>
          </Box>
          <Text dimColor>v{version}</Text>
        </Box>
        <Box gap={1}>
          <Text bold color="cyan">{model}</Text>
          <Text color="greenBright">● ONLINE</Text>
          {ctxStr ? <Text dimColor>· {ctxStr} ctx</Text> : null}
          {gitBranch ? <Text color="magentaBright">· {gitBranch}</Text> : null}
        </Box>
        {cwd ? <Text dimColor>{shortenPath(cwd)}</Text> : null}
      </Box>
    </Box>
  )
}
