/**
 * MessageList — renders the conversation as a column of messages.
 *
 * Implements scrollback limiting: only the most recent `maxMessages` are
 * rendered (default 50). When truncated, a dim indicator shows the count.
 *
 * In compact mode (default), consecutive Read/Grep/Glob tool calls are
 * collapsed into a single summary line. Verbose mode (Ctrl+O) shows all.
 *
 * Round 44: all colors come from the semantic theme (`t`) — no ad-hoc
 * literals.
 */

import { Text, Box } from 'ink'
import type { UIMessage } from '../store.js'
import { ToolCallView } from '../ToolCallView.js'
import { TodoListView, type TodoItem } from './TodoListView.js'
import { Markdown } from './Markdown.js'
import { t } from '../../theme.js'

/** Tool types that are collapsible when appearing consecutively. */
const COLLAPSIBLE_TOOLS = new Set(['Read', 'Grep', 'Glob'])

export function MessageRow({ msg }: { msg: UIMessage }): React.ReactElement {
  switch (msg.type) {
    case 'user':
      return (
        <Box marginTop={1} paddingX={1}>
          <Text color={t.primary}>› </Text>
          <Text bold color={t.text}>{msg.text}</Text>
        </Box>
      )

    case 'assistant':
      return (
        <Box marginTop={1} paddingX={1}>
          <Text color={t.accent}>● </Text>
          <Markdown>{msg.text}</Markdown>
        </Box>
      )

    case 'tool':
      // TodoWrite gets its own rich rendering
      if (msg.name === 'TodoWrite' && Array.isArray(msg.input.todos)) {
        return (
          <Box marginTop={1}>
            <TodoListView todos={msg.input.todos as TodoItem[]} />
          </Box>
        )
      }
      return (
        <Box marginTop={1}>
          <ToolCallView
            name={msg.name}
            input={msg.input}
            result={msg.result}
            isError={msg.isError}
            elapsedMs={msg.elapsedMs}
          />
        </Box>
      )

    case 'info':
      return (
        <Box>
          <Text color={t.muted}>· {msg.text}</Text>
        </Box>
      )

    case 'success':
      return (
        <Box>
          <Text color={t.success}>✓ </Text>
          <Text color={t.text}>{msg.text}</Text>
        </Box>
      )

    case 'warn':
      return (
        <Box>
          <Text color={t.warning}>⚠ </Text>
          <Text color={t.text}>{msg.text}</Text>
        </Box>
      )

    case 'error':
      return (
        <Box marginTop={1}>
          <Text color={t.error}>✗ {msg.text}</Text>
        </Box>
      )

    case 'agent':
      return (
        <Box marginTop={1} flexDirection="column">
          <Box>
            <Text color={t.primary}>⊕ </Text>
            <Text bold color={t.text}>Agent</Text>
            {msg.agentType !== 'general-purpose' ? (
              <Text color={t.muted}> [{msg.agentType}]</Text>
            ) : null}
            <Text color={t.muted}> {msg.desc}</Text>
            <Text color={msg.status === 'done' ? t.success : msg.status === 'failed' ? t.error : t.warning}>
              {' '}
              {msg.status === 'done' ? '✓' : msg.status === 'failed' ? '✗' : '…'}
            </Text>
          </Box>
          {msg.summary ? (
            <Box marginLeft={4}>
              <Text color={t.muted}>{msg.summary.split('\n').slice(0, 4).join('\n')}</Text>
            </Box>
          ) : null}
        </Box>
      )

    case 'compact':
      return msg.phase === 'start' ? (
        <Box marginTop={1}>
          <Text color={t.info}>⟳ </Text>
          <Text color={t.muted}>Context {Math.round((msg.origTokens ?? 0) / 1000)}k — compacting…</Text>
        </Box>
      ) : (
        <Box>
          <Text color={t.success}>✓ </Text>
          <Text color={t.muted}>
            {Math.round((msg.origTokens ?? 0) / 1000)}k → {Math.round((msg.sumTokens ?? 0) / 1000)}k (
            {Math.round((1 - (msg.sumTokens ?? 1) / (msg.origTokens ?? 1)) * 100)}% saved)
          </Text>
        </Box>
      )

    case 'context-warning':
      return (
        <Box marginTop={1}>
          <Text color={t.warning}>⚠ </Text>
          <Text color={t.muted}>
            Context {Math.round(msg.pct * 100)}% ({Math.round(msg.tokens / 1000)}k/
            {Math.round(msg.max / 1000)}k)
          </Text>
        </Box>
      )
  }
}

export interface MessageListProps {
  messages: UIMessage[]
  /** Maximum number of messages to render (default 50). */
  maxMessages?: number
  /** Show all tool results expanded (default false = compact). */
  verbose?: boolean
}

/**
 * Group consecutive collapsible tool messages for compact display.
 * Returns groups: each item is either a single message or a group of
 * consecutive collapsible tools.
 */
type MessageGroup =
  | { type: 'single'; msg: UIMessage }
  | { type: 'collapsed'; msgs: UIMessage[] }

function groupMessages(messages: UIMessage[]): MessageGroup[] {
  const groups: MessageGroup[] = []
  let i = 0
  while (i < messages.length) {
    const msg = messages[i]
    if (msg.type === 'tool' && COLLAPSIBLE_TOOLS.has(msg.name) && msg.result !== undefined) {
      // Start a potential group
      const group: UIMessage[] = [msg]
      let j = i + 1
      while (j < messages.length) {
        const next = messages[j]
        if (next.type === 'tool' && COLLAPSIBLE_TOOLS.has(next.name) && next.result !== undefined) {
          group.push(next)
          j++
        } else {
          break
        }
      }
      if (group.length >= 3) {
        groups.push({ type: 'collapsed', msgs: group })
        i = j
      } else {
        for (const m of group) groups.push({ type: 'single', msg: m })
        i = j
      }
    } else {
      groups.push({ type: 'single', msg })
      i++
    }
  }
  return groups
}

function CollapsedToolGroup({ msgs }: { msgs: UIMessage[] }): React.ReactElement {
  // Round 46 (codex grouping): consecutive read-only tools collapse into
  // a verb group — `• Explored` with children under `└` — instead of a
  // `⤿ Read/Grep ×3` counter row.
  const errors = msgs.filter((m) => m.type === 'tool' && m.isError).length
  const child = (m: UIMessage): string => {
    if (m.type !== 'tool') return ''
    const p = (m.input.file_path ?? m.input.pattern ?? m.input.command ?? m.input.query ?? '') as string
    const s = typeof p === 'string' ? p.split('/').slice(-1)[0] || p : ''
    return `${m.name === 'Grep' ? 'Searched' : m.name === 'Glob' ? 'Listed' : 'Read'} ${s.slice(0, 48)}`
  }
  return (
    <Box marginTop={1} flexDirection="column">
      <Box>
        <Text color={errors > 0 ? t.error : t.success}>• </Text>
        <Text color={t.text}>Explored</Text>
        {errors > 0 ? <Text color={t.error}> ({errors} failed)</Text> : null}
      </Box>
      {msgs.slice(0, 6).map((m) => (
        <Box key={m.id} paddingLeft={2}>
          <Text color={t.faint}>└ </Text>
          <Text color={t.muted}>{child(m)}</Text>
        </Box>
      ))}
      {msgs.length > 6 ? <Text color={t.faint}>  … +{msgs.length - 6} more</Text> : null}
    </Box>
  )
}

export function MessageList({ messages, maxMessages = 50, verbose = false }: MessageListProps): React.ReactElement {
  const total = messages.length
  const truncated = total > maxMessages
  const visible = truncated ? messages.slice(total - maxMessages) : messages

  const groups = verbose ? visible.map((msg) => ({ type: 'single' as const, msg })) : groupMessages(visible)

  return (
    <Box flexDirection="column">
      {truncated ? (
        <Box marginBottom={1}>
          <Text color={t.faint} italic>↑ {total - maxMessages} earlier message{(total - maxMessages) !== 1 ? 's' : ''} hidden (showing last {maxMessages})</Text>
        </Box>
      ) : null}
      {groups.map((group, gi) => {
        if (group.type === 'collapsed') {
          return <CollapsedToolGroup key={gi} msgs={group.msgs} />
        }
        const msg = group.msg
        return <MessageRow key={msg.id} msg={msg} />
      })}
    </Box>
  )
}
