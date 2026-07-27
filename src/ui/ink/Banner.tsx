/**
 * Banner — startup banner showing version, model, cwd, and git info.
 */

import { Text, Box } from 'ink'
import { BRAND_LOGO_ROWS } from '../brand.js'

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
      <Text bold color="#63B3ED">{BRAND_LOGO_ROWS.slice(0, 2).join('\n')}</Text>
      <Text bold color="#A78BFA">{BRAND_LOGO_ROWS.slice(2, 4).join('\n')}</Text>
      <Text bold color="#C9A86A">{BRAND_LOGO_ROWS[4]}</Text>
      <Box justifyContent="space-between">
        <Box gap={1}>
          <Text bold color="#E8E3DA">◆ OVOLV999</Text>
          <Text dimColor>AUTONOMOUS DEVELOPER ENVIRONMENT</Text>
          <Text dimColor>· v{version}</Text>
        </Box>
        <Text color="#68D391">● ONLINE</Text>
      </Box>
      <Box borderStyle="round" borderColor="#7D8590" paddingX={1} flexDirection="column">
        <Box>
          <Box width="50%">
            <Text color="#63B3ED">WORKSPACE  </Text>
            <Text>{cwd ? shortenPath(cwd) : '—'}</Text>
          </Box>
          <Box width="50%">
            <Text color="#C9A86A">RUNTIME  </Text>
            <Text>{model}</Text>
          </Box>
        </Box>
        <Box>
          <Box width="50%">
            <Text color="#A78BFA">SOURCE     </Text>
            <Text>{gitBranch ?? 'no git'}</Text>
          </Box>
          <Box width="50%">
            <Text color="#68D391">CONTEXT  </Text>
            <Text>{ctxStr ? `${ctxStr} tokens` : '—'}</Text>
          </Box>
        </Box>
      </Box>
    </Box>
  )
}
