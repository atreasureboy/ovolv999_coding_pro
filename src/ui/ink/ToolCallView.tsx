/**
 * ToolCallView — codex-style tool line: `• Ran <cmd>` with output folded
 * under a `└` continuation, diff stats for edits, `… +N lines` caps.
 *
 * Round 46: no per-tool rainbow icons, no left border rail, no raw tool
 * names — codex speaks in verbs (Ran / Read / Updated / Searched / Listed)
 * and folds output; the model's tool name is plumbing, not prose.
 */

import { Text, Box } from 'ink'
import { DiffView, computeLineDiff } from './components/DiffView.js'
import { t } from '../theme.js'

const OUTPUT_PREVIEW_LINES = 4

interface ToolLine {
  /** Verb + object, e.g. `Ran ls -la`. */
  label: string
  /** codex's verb dot color reflects outcome, not tool identity. */
  color: string
}

function shortenPath(p: string, max = 48): string {
  if (p.length <= max) return p
  const parts = p.split('/')
  return '…/' + parts.slice(-2).join('/')
}

function firstLine(s: string, max = 72): string {
  const line = s.split('\n')[0]?.trim() ?? ''
  return line.length > max ? line.slice(0, max - 1) + '…' : line
}

/** codex verb-language summary of the invocation. */
function toolLine(name: string, input: Record<string, unknown>): ToolLine {
  const s = (v: unknown): string => str(v)
  switch (name) {
    case 'Bash':
      return { label: `Ran ${firstLine(s(input.command))}`, color: t.text }
    case 'Read':
      return { label: `Read ${shortenPath(s(input.file_path))}`, color: t.text }
    case 'Write':
      return { label: `Created ${shortenPath(s(input.file_path))}`, color: t.text }
    case 'Edit':
    case 'MultiEdit':
      return { label: `Updated ${shortenPath(s(input.file_path))}`, color: t.text }
    case 'NotebookEdit':
      return { label: `Updated ${shortenPath(s(input.file_path))}`, color: t.text }
    case 'Grep':
      return { label: `Searched ${firstLine(s(input.pattern), 48)}`, color: t.text }
    case 'Glob':
      return { label: `Listed ${firstLine(s(input.pattern), 48)}`, color: t.text }
    case 'WebFetch':
      return { label: `Fetched ${firstLine(s(input.url), 56)}`, color: t.text }
    case 'WebSearch':
      return { label: `Searched web: ${firstLine(s(input.query), 48)}`, color: t.text }
    case 'TodoWrite':
      return { label: 'Updated task list', color: t.text }
    case 'Agent':
      return { label: `Delegated: ${firstLine(s(input.description) || s(input.prompt), 56)}`, color: t.text }
    case 'apply_patch':
      return { label: 'Applied patch', color: t.text }
    default:
      return { label: `${name} ${firstLine(JSON.stringify(input), 48)}`.trimEnd(), color: t.text }
  }
}

/** Diff-stat suffix for edit tools: (+12 -3). */
function diffStats(name: string, input: Record<string, unknown>): string | null {
  if (name !== 'Edit' && name !== 'Write') return null
  const oldText = name === 'Edit' ? str(input.old_string) : ''
  const newText = name === 'Edit' ? str(input.new_string) : str(input.content)
  const added = newText.split('\n').length - (name === 'Edit' ? oldText.split('\n').length : 0)
  const removed = name === 'Edit' ? 0 : 0
  void removed
  if (added > 0) return `+${added}`
  return null
}

export interface ToolCallProps {
  name: string
  input: Record<string, unknown>
  result?: string
  isError?: boolean
  elapsedMs?: number
}

export function ToolCallView({ name, input, result, isError, elapsedMs }: ToolCallProps): React.ReactElement {
  const line = toolLine(name, input)
  const dotColor = isError ? t.error : t.success
  const stats = diffStats(name, input)

  // Show inline diff for Edit/Write tools when result is available
  const showDiff = (name === 'Edit' || name === 'Write') && result !== undefined && !isError
  const oldText = name === 'Edit' ? str(input.old_string) : ''
  const newText = name === 'Edit' ? str(input.new_string) : name === 'Write' ? str(input.content) : ''

  const resultLines = result !== undefined
    ? result.split('\n').filter((l) => l.trim())
    : []

  return (
    <Box flexDirection="column">
      <Box>
        <Text color={isError ? t.error : result === undefined ? t.warning : t.success}>• </Text>
        <Text color={line.color}>{line.label}</Text>
        {stats ? <Text color={t.diffAdded}> ({stats})</Text> : null}
        {elapsedMs !== undefined && elapsedMs > 2000 ? <Text color={t.faint}> ({formatDuration(elapsedMs)})</Text> : null}
      </Box>
      {showDiff ? (
        <Box marginLeft={2} flexDirection="column">
          <DiffView lines={computeLineDiff(oldText, newText)} maxLines={12} />
        </Box>
      ) : null}
      {result !== undefined && !showDiff ? (
        <Box flexDirection="column">
          {resultLines.slice(0, OUTPUT_PREVIEW_LINES).map((l, i) => (
            <Box key={i}>
              <Text color={t.faint}>{i === 0 ? '  └ ' : '    '}</Text>
              <Text color={isError ? t.error : t.muted}>
                {l.length > 120 ? l.slice(0, 117) + '…' : l}
              </Text>
            </Box>
          ))}
          {(() => {
            const hidden = resultLines.length - OUTPUT_PREVIEW_LINES
            return hidden > 0 ? (
              <Text color={t.faint}>    … +{hidden} lines</Text>
            ) : null
          })()}
        </Box>
      ) : null}
      {result === undefined ? (
        <Box>
          <Text color={t.faint}>  └ running…</Text>
        </Box>
      ) : null}
    </Box>
  )
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`
  const m = Math.floor(ms / 60_000)
  const s = Math.round((ms % 60_000) / 1000)
  return `${m}m${s}s`
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : ''
}
