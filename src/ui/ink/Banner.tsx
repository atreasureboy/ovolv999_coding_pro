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
  terminalWidth?: number
}

function shortenPath(p: string, max = 40): string {
  if (p.length <= max) return p
  const parts = p.split('/')
  if (parts.length <= 2) return p
  return '…/' + parts.slice(-2).join('/')
}

export function Banner({ version, model, cwd, gitBranch, contextWindow, terminalWidth = 100 }: BannerProps): React.ReactElement {
  const ctxStr = contextWindow
    ? contextWindow >= 1000
      ? `${(contextWindow / 1000).toFixed(0)}k`
      : `${contextWindow}`
    : ''
  const wide = terminalWidth >= 96

  return (
    <Box flexDirection="column" marginBottom={1}>
      <Box paddingX={1} flexDirection={wide ? 'row' : 'column'}>
        <Box width={wide ? 54 : undefined} flexDirection="column">
          <Text bold color="#63B3ED">{BRAND_LOGO_ROWS.slice(0, 2).join('\n')}</Text>
          <Text bold color="#A78BFA">{BRAND_LOGO_ROWS.slice(2, 4).join('\n')}</Text>
          <Text bold color="#C9A86A">{BRAND_LOGO_ROWS[4]}</Text>
        </Box>
        {wide ? (
          <Box
            flexDirection="column"
            borderStyle="single"
            borderLeft
            borderTop={false}
            borderRight={false}
            borderBottom={false}
            borderColor="#7D8590"
            paddingLeft={2}
          >
            <Text bold color="#E8E3DA">OVOLV999 / v{version}</Text>
            <Text color="#A78BFA">AUTONOMOUS SOFTWARE FORGE</Text>
            <Text color="#C9A86A">{model} · {ctxStr || '—'} CONTEXT</Text>
            <Text dimColor>{cwd ? shortenPath(cwd) : '—'} · {gitBranch ?? 'NO GIT'}</Text>
            <Text color="#68D391">◆ SYSTEM READY</Text>
          </Box>
        ) : (
          <Box gap={1}>
            <Text bold color="#E8E3DA">OVOLV999 / v{version}</Text>
            <Text color="#A78BFA">· {model}</Text>
            <Text dimColor>· {cwd ? shortenPath(cwd) : '—'}</Text>
            <Text color="#68D391">· ◆ READY</Text>
          </Box>
        )}
      </Box>
      <Box paddingX={1}>
        <Text color="#7D8590">{'━'.repeat(Math.max(18, terminalWidth - 2))}</Text>
      </Box>
    </Box>
  )
}
