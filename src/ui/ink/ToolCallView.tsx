/**
 * ToolCallView — collapsible display of a tool invocation + its result.
 *
 * Shows the tool icon, name, input preview, and result (truncated).
 * In the future this could support expand/collapse via keypress.
 */

import { Text, Box } from 'ink'
import { str } from '../../core/strings.js'
import { DiffView, computeLineDiff } from './components/DiffView.js'

interface ToolVisual {
  icon: string
  color: string
}

const TOOL_VIZ: Record<string, ToolVisual> = {
  Bash: { icon: '$', color: 'yellowBright' },
  Read: { icon: '📖', color: 'cyanBright' },
  Write: { icon: '✎', color: 'greenBright' },
  Edit: { icon: '✎', color: 'blueBright' },
  Glob: { icon: '◆', color: 'magentaBright' },
  Grep: { icon: '⌕', color: 'magentaBright' },
  WebFetch: { icon: '🌐', color: 'cyan' },
  WebSearch: { icon: '🔍', color: 'cyan' },
  TodoWrite: { icon: '☑', color: 'greenBright' },
  Agent: { icon: '⊕', color: 'magentaBright' },
  ShellSession: { icon: '⌁', color: 'redBright' },
  TmuxSession: { icon: '⌁', color: 'redBright' },
  AskUserQuestion: { icon: '?', color: 'yellowBright' },
  ExitPlanMode: { icon: '⚡', color: 'greenBright' },
  Sleep: { icon: '⏸', color: 'gray' },
  Snip: { icon: '✂', color: 'yellowBright' },
  NotebookEdit: { icon: '📓', color: 'magentaBright' },
}

function viz(name: string): ToolVisual {
  return TOOL_VIZ[name] ?? { icon: '·', color: 'white' }
}

function previewTool(name: string, input: Record<string, unknown>): string {
  const s = (v: unknown): string => str(v)
  switch (name) {
    case 'Bash': {
      const c = s(input.command).trim()
      return c.length > 72 ? c.slice(0, 69) + '...' : c
    }
    case 'Read':
      return s(input.file_path) + (input.offset ? ` from line ${s(input.offset)}` : '')
    case 'Write':
      return `${s(input.file_path)} (${s(input.content).split('\n').length}L)`
    case 'Edit':
      return s(input.file_path)
    case 'Glob':
      return s(input.pattern)
    case 'Grep':
      return `/${s(input.pattern)}/${input.include ? ` [${s(input.include)}]` : ''}`
    case 'WebFetch':
      return s(input.url)
    case 'WebSearch':
      return `"${s(input.query)}"`
    case 'Agent':
      return `${input.subagent_type ? `[${s(input.subagent_type)}] ` : ''}${s(input.description)}`
    case 'TodoWrite': {
      const count = Array.isArray(input.todos) ? input.todos.length : 0
      return `${count} item${count === 1 ? '' : 's'}`
    }
    case 'Snip':
      return `keep ${s(input.keep_recent)} recent`
    default:
      return ''
  }
}

export interface ToolCallProps {
  name: string
  input: Record<string, unknown>
  result?: string
  isError?: boolean
  elapsedMs?: number
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`
  const min = Math.floor(ms / 60_000)
  const sec = Math.round((ms % 60_000) / 1000)
  return `${min}m${sec}s`
}

/**
 * Compute a tool-specific result badge (e.g. exit code, match count).
 * Returns null if no badge applies.
 */
function resultBadge(
  name: string,
  input: Record<string, unknown>,
  result: string | undefined,
  isError: boolean | undefined,
): { text: string; color: string } | null {
  if (result === undefined) return null

  switch (name) {
    case 'Bash': {
      // Detect exit code from result (engine appends "Exit code: N")
      const exitMatch = result.match(/Exit code: (\d+)/)
      const code = exitMatch ? parseInt(exitMatch[1], 10) : (isError ? 1 : 0)
      return code === 0
        ? { text: '✓ exit 0', color: 'greenBright' }
        : { text: `✗ exit ${code}`, color: 'redBright' }
    }
    case 'Read': {
      const lines = result.split('\n').length
      return { text: `${lines}L`, color: 'dim' }
    }
    case 'Grep': {
      const matches = result.split('\n').filter((l) => l.trim() && !l.startsWith('Found')).length
      return { text: `${matches} matches`, color: 'magentaBright' }
    }
    case 'Glob': {
      const files = result.split('\n').filter((l) => l.trim()).length
      return { text: `${files} file${files !== 1 ? 's' : ''}`, color: 'magentaBright' }
    }
    case 'WebFetch':
      return { text: `${result.length} chars`, color: 'cyan' }
    default:
      return null
  }
}

export function ToolCallView({ name, input, result, isError, elapsedMs }: ToolCallProps): React.ReactElement {
  const v = viz(name)
  const preview = previewTool(name, input)

  // Show inline diff for Edit/Write tools when result is available
  const showDiff = (name === 'Edit' || name === 'Write') && result !== undefined && !isError
  const oldText = name === 'Edit' ? str(input.old_string) : ''
  const newText = name === 'Edit' ? str(input.new_string) : name === 'Write' ? str(input.content) : ''

  return (
    <Box flexDirection="column">
      <Box>
        <Text color={v.color}>{v.icon}</Text>
        <Text bold color={v.color}> {name}</Text>
        {preview ? <Text dimColor> {preview}</Text> : null}
        {elapsedMs !== undefined ? <Text dimColor> · {formatDuration(elapsedMs)}</Text> : null}
        {(() => {
          const badge = resultBadge(name, input, result, isError)
          if (!badge) return null
          return <Text color={badge.color}> · {badge.text}</Text>
        })()}
      </Box>
      {showDiff ? (
        <Box marginLeft={4} flexDirection="column">
          <DiffView lines={computeLineDiff(oldText, newText)} maxLines={12} />
        </Box>
      ) : null}
      {result !== undefined && !showDiff ? (
        <Box marginLeft={4} flexDirection="column">
          {result
            .split('\n')
            .filter((l) => l.trim())
            .slice(0, 6)
            .map((line, i) => (
              <Box key={i}>
                <Text color={isError ? 'red' : undefined} dimColor={!isError}>
                  {line.length > 120 ? line.slice(0, 117) + '...' : line}
                </Text>
              </Box>
            ))}
          {(() => {
            const lines = result.split('\n').filter((l) => l.trim())
            const hidden = lines.length - 6
            return hidden > 0 ? <Text dimColor> +{hidden} more</Text> : null
          })()}
        </Box>
      ) : null}
      {result === undefined ? (
        <Box marginLeft={4}>
          <Text dimColor italic>running...</Text>
        </Box>
      ) : null}
    </Box>
  )
}
