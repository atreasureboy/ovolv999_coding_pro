/**
 * TodoListView — renders a TodoWrite tool call as a checklist.
 *
 * Shows each todo item with a status indicator:
 *   ☑ completed  (green)
 *   → in_progress (yellow)
 *   ☐ pending    (dim)
 *
 * Also shows a progress bar at the top: [████████░░░░] 4/8 done
 */

import { Text, Box } from 'ink'
import { t } from '../../theme.js'

export interface TodoItem {
  content: string
  status: 'pending' | 'in_progress' | 'completed'
  activeForm?: string
}

function statusIcon(status: string): { icon: string; color: string } {
  switch (status) {
    case 'completed': return { icon: '☑', color: 'greenBright' }
    case 'in_progress': return { icon: '→', color: 'yellowBright' }
    default: return { icon: '☐', color: 'gray' }
  }
}

export function TodoListView({ todos }: { todos: TodoItem[] }): React.ReactElement {
  const done = todos.filter((t) => t.status === 'completed').length
  const total = todos.length
  const width = 16
  const filled = total > 0 ? Math.round((done / total) * width) : 0
  const bar = '█'.repeat(filled) + '░'.repeat(width - filled)
  const barColor = done === total ? 'greenBright' : done > 0 ? 'yellow' : 'gray'

  return (
    <Box flexDirection="column">
      <Box>
        <Text bold color={t.success}>☑ Tasks</Text>
        <Text dimColor> [{bar}]</Text>
        <Text color={barColor}> {done}/{total}</Text>
      </Box>
      <Box flexDirection="column" marginLeft={2} marginTop={0}>
        {todos.map((todo, i) => {
          const { icon, color } = statusIcon(todo.status)
          const text = todo.activeForm || todo.content
          return (
            <Box key={i}>
              <Text color={color}>{icon}</Text>
              <Text color={color === 'gray' ? undefined : color} dimColor={todo.status === 'pending'}>
                {' '}{text.length > 80 ? text.slice(0, 77) + '...' : text}
              </Text>
            </Box>
          )
        })}
      </Box>
    </Box>
  )
}
