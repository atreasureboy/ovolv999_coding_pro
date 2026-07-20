/**
 * HelpOverlay — keyboard shortcuts reference card.
 *
 * Shown when the user presses `?` (when not in slash menu mode).
 * Displays all available keyboard shortcuts and commands in a
 * styled box. Press `?` or ESC to dismiss.
 */

import { Text, Box, useInput } from 'ink'

interface ShortcutGroup {
  title: string
  items: Array<{ key: string; desc: string }>
}

const GROUPS: ShortcutGroup[] = [
  {
    title: 'Input',
    items: [
      { key: 'Enter', desc: 'Submit prompt / autocomplete slash command' },
      { key: 'Tab', desc: 'Autocomplete selected slash command' },
      { key: 'Ctrl+J', desc: 'Insert newline (multi-line input)' },
      { key: 'Ctrl+G', desc: 'Open external editor ($EDITOR)' },
      { key: 'Ctrl+A / E', desc: 'Move cursor to start / end' },
      { key: 'Ctrl+U', desc: 'Clear input line' },
      { key: '↑ / ↓', desc: 'Navigate input history / slash menu' },
    ],
  },
  {
    title: 'Navigation',
    items: [
      { key: 'ESC', desc: 'Interrupt running turn' },
      { key: 'Ctrl+R', desc: 'Reverse history search (bash-style)' },
      { key: 'Ctrl+Y', desc: 'Copy last assistant reply' },
      { key: 'Ctrl+L', desc: 'Clear screen and redraw' },
      { key: 'Ctrl+O', desc: 'Toggle verbose/compact tool results' },
      { key: 'Ctrl+C ×2', desc: 'Exit ovolv999' },
      { key: '?', desc: 'Toggle this help overlay' },
    ],
  },
  {
    title: 'Slash Commands',
    items: [
      { key: '/help', desc: 'List all commands' },
      { key: '/model', desc: 'Interactive model switcher' },
      { key: '/resume', desc: 'Interactive session resume' },
      { key: '/compact', desc: 'Compact conversation context' },
      { key: '/clear', desc: 'Clear conversation history' },
      { key: '/snip N', desc: 'Snip old messages (keep N recent)' },
      { key: '/copy', desc: 'Copy last reply to clipboard' },
      { key: '/retry', desc: 'Retry last user prompt' },
      { key: '/plan', desc: 'Enter plan mode (read-only analysis)' },
      { key: '/git status', desc: 'Git status --short' },
      { key: '/git log', desc: 'Recent git log (graph)' },
      { key: '/diff [full]', desc: 'Show git diff (stat/full/staged)' },
      { key: '/commit <msg>', desc: 'Stage all + commit' },
      { key: '/cost', desc: 'Show cost breakdown by model' },
      { key: '/exit', desc: 'Exit ovolv999' },
    ],
  },
  {
    title: 'Permissions',
    items: [
      { key: 'y', desc: 'Approve tool / plan' },
      { key: 'n', desc: 'Deny tool / plan' },
      { key: 'a', desc: 'Always allow this tool' },
      { key: 't / Tab', desc: 'Deny with natural-language feedback' },
    ],
  },
]

export function HelpOverlay({ onDismiss }: { onDismiss: () => void }): React.ReactElement {
  useInput((input, key) => {
    if (input === '?' || key.escape) {
      onDismiss()
    }
  })

  return (
    <Box flexDirection="column" borderStyle="round" borderColor="cyan" paddingX={2} paddingY={1} marginY={1}>
      <Box>
        <Text bold color="cyan">⌨  Keyboard Shortcuts</Text>
      </Box>
      {GROUPS.map((group, gi) => (
        <Box key={gi} flexDirection="column" marginTop={gi > 0 ? 1 : 0}>
          <Text bold color="cyanBright">{group.title}</Text>
          {group.items.map((item, ii) => (
            <Box key={ii}>
              <Text bold color="yellowBright">{item.key.padEnd(16, ' ')}</Text>
              <Text dimColor> {item.desc}</Text>
            </Box>
          ))}
        </Box>
      ))}
      <Box marginTop={1}>
        <Text dimColor>Press ? or ESC to dismiss</Text>
      </Box>
    </Box>
  )
}
