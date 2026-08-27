/**
 * HelpOverlay — keyboard shortcuts reference card.
 *
 * Shown when the user presses `?` (when not in slash menu mode).
 * Displays all available keyboard shortcuts and commands in a
 * styled box. Press `?` or ESC to dismiss.
 */

import { Text, Box, useInput } from 'ink'
import { t } from '../../theme.js'

import { listCommands } from '../../../commands/index.js'

interface ShortcutGroup {
  title: string
  items: Array<{ key: string; desc: string }>
}

function getDynamicGroups(): ShortcutGroup[] {
  const cmds = listCommands()
  const topCmds = cmds.slice(0, 12).map((c) => ({
    key: `/${c.name}`,
    desc: c.description.slice(0, 50),
  }))

  return [
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
        { key: 'ESC', desc: 'Stop running turn (ESC again: force kill)' },
        { key: 'Ctrl+R', desc: 'Reverse history search (bash-style)' },
        { key: 'Ctrl+Y', desc: 'Copy last assistant reply' },
        { key: 'Ctrl+L', desc: 'Clear screen and redraw' },
        { key: 'Ctrl+O', desc: 'Toggle verbose/compact tool results' },
        { key: 'Ctrl+C ×2', desc: 'Exit ovolv999' },
        { key: '?', desc: 'Toggle this help overlay' },
      ],
    },
    {
      title: 'Slash Commands (Dynamic Registry)',
      items: topCmds,
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
}

export function HelpOverlay({ onDismiss }: { onDismiss: () => void }): React.ReactElement {
  useInput((input, key) => {
    if (input === '?' || key.escape) {
      onDismiss()
    }
  })

  return (
    <Box flexDirection="column" borderStyle="round" borderColor="cyan" paddingX={2} paddingY={1} marginY={1}>
      <Box>
        <Text bold color={t.accent}>⌨  Keyboard Shortcuts</Text>
      </Box>
      {getDynamicGroups().map((group, gi) => (
        <Box key={gi} flexDirection="column" marginTop={gi > 0 ? 1 : 0}>
          <Text bold color={t.text}>{group.title}</Text>
          {group.items.map((item, ii) => (
            <Box key={ii}>
              <Text bold color={t.primary}>{item.key.padEnd(16, ' ')}</Text>
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
