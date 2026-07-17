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
}

export function ToolCallView({ name, input, result, isError }: ToolCallProps): React.ReactElement {
  const v = viz(name)
  const preview = previewTool(name, input)

  // Show inline diff for Edit tools when result is available
  const showDiff = name === 'Edit' && result !== undefined && !isError
  const oldText = showDiff ? str(input.old_string) : ''
  const newText = showDiff ? str(input.new_string) : ''

  return (
    <Box flexDirection="column">
      <Box>
        <Text color={v.color}>{v.icon}</Text>
        <Text bold color={v.color}> {name}</Text>
        {preview ? <Text dimColor> {preview}</Text> : null}
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
