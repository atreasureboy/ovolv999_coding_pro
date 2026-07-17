/**
 * MessageList — renders the full conversation as a scrollable column of messages.
 *
 * Each UIMessage type gets its own visual treatment. The list grows downward
 * as the engine emits events. Ink handles terminal scrolling automatically
 * (it only re-renders the visible portion).
 */

import { Text, Box } from 'ink'
import type { UIMessage } from '../store.js'
import { ToolCallView } from '../ToolCallView.js'
import { TodoListView, type TodoItem } from './TodoListView.js'
import { Markdown } from './Markdown.js'

function MessageRow({ msg }: { msg: UIMessage }): React.ReactElement {
  switch (msg.type) {
    case 'user':
      return (
        <Box marginTop={1}>
          <Text bold color="blueBright">❯ </Text>
          <Text bold>{msg.text}</Text>
        </Box>
      )

    case 'assistant':
      return (
        <Box marginLeft={2} flexDirection="column">
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
          />
        </Box>
      )

    case 'info':
      return (
        <Box>
          <Text dimColor>{msg.text}</Text>
        </Box>
      )

    case 'success':
      return (
        <Box>
          <Text color="greenBright">✓ </Text>
          <Text>{msg.text}</Text>
        </Box>
      )

    case 'warn':
      return (
        <Box>
          <Text color="yellowBright">⚠ </Text>
          <Text>{msg.text}</Text>
        </Box>
      )

    case 'error':
      return (
        <Box marginTop={1}>
          <Text color="redBright">✗ {msg.text}</Text>
        </Box>
      )

    case 'agent':
      return (
        <Box marginTop={1} flexDirection="column">
          <Box>
            <Text color="magentaBright">⊕ </Text>
            <Text bold>Agent</Text>
            {msg.agentType !== 'general-purpose' ? (
              <Text dimColor> [{msg.agentType}]</Text>
            ) : null}
            <Text dimColor> {msg.desc}</Text>
            <Text color={msg.status === 'done' ? 'greenBright' : msg.status === 'failed' ? 'redBright' : 'yellow'}>
              {' '}
              {msg.status === 'done' ? '✓' : msg.status === 'failed' ? '✗' : '...'}
            </Text>
          </Box>
          {msg.summary ? (
            <Box marginLeft={4}>
              <Text dimColor>{msg.summary.split('\n').slice(0, 4).join('\n')}</Text>
            </Box>
          ) : null}
        </Box>
      )

    case 'compact':
      return msg.phase === 'start' ? (
        <Box marginTop={1}>
          <Text color="yellow">⟳ </Text>
          <Text dimColor>Context {Math.round((msg.origTokens ?? 0) / 1000)}k — compacting...</Text>
        </Box>
      ) : (
        <Box>
          <Text color="greenBright">✓ </Text>
          <Text dimColor>
            {Math.round((msg.origTokens ?? 0) / 1000)}k → {Math.round((msg.sumTokens ?? 0) / 1000)}k (
            {Math.round((1 - (msg.sumTokens ?? 1) / (msg.origTokens ?? 1)) * 100)}% saved)
          </Text>
        </Box>
      )

    case 'context-warning':
      return (
        <Box marginTop={1}>
          <Text color="yellowBright">⚠ </Text>
          <Text dimColor>
            Context {Math.round(msg.pct * 100)}% ({Math.round(msg.tokens / 1000)}k/
            {Math.round(msg.max / 1000)}k)
          </Text>
        </Box>
      )
  }
}

export function MessageList({ messages }: { messages: UIMessage[] }): React.ReactElement {
  return (
    <Box flexDirection="column">
      {messages.map((msg) => (
        <MessageRow key={msg.id} msg={msg} />
      ))}
    </Box>
  )
}
