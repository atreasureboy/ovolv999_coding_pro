/**
 * Banner — startup banner: version, model, cwd, git info.
 *
 * Round 44: calmer composition — single-tone wordmark (no rainbow
 * letters), left column logo + right metadata panel with a proper
 * accent rule, everything theme-token colored.
 */

import { Text, Box } from 'ink'
import { BRAND_LOGO_ROWS } from '../brand.js'
import { t } from '../theme.js'

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
          {/* Wordmark: violet block glyphs, one calm tone */}
          <Text bold color={t.accent}>{BRAND_LOGO_ROWS.slice(0, 3).join('\n')}</Text>
          <Text bold color={t.accent}>{BRAND_LOGO_ROWS.slice(3).join('\n')}</Text>
        </Box>
        {wide ? (
          <Box flexDirection="column" borderLeft borderColor={t.border} paddingLeft={2} justifyContent="center">
            <Text bold color={t.text}>OVOLV999 <Text color={t.muted}>v{version}</Text></Text>
            <Text color={t.accent}>AUTONOMOUS SOFTWARE FORGE</Text>
            <Text color={t.info}>
              {model}
              {ctxStr ? <Text color={t.faint}> · {ctxStr} ctx</Text> : null}
            </Text>
            <Text color={t.muted}>
              {cwd ? shortenPath(cwd) : '—'}
              {gitBranch ? <Text color={t.primary}> ⎇ {gitBranch}</Text> : null}
            </Text>
            <Text color={t.success}>◆ ready</Text>
          </Box>
        ) : (
          <Box gap={1} flexDirection="column">
            <Text><Text bold color={t.text}>OVOLV999</Text> <Text color={t.muted}>v{version}</Text></Text>
            <Text color={t.info}>· {model}</Text>
            <Text color={t.muted}>· {cwd ? shortenPath(cwd) : '—'}</Text>
            <Text color={t.success}>· ◆ ready</Text>
          </Box>
        )}
      </Box>
      <Box paddingX={1}>
        <Text color={t.border}>{'━'.repeat(Math.max(18, terminalWidth - 2))}</Text>
      </Box>
    </Box>
  )
}
