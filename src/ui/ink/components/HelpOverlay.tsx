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
import { DEFAULT_BINDINGS, actionToCombo, formatCombo, type KeyAction } from '../../keybindings.js'

interface ShortcutGroup {
  title: string
  items: Array<{ key: string; desc: string }>
}

/** Shortcut keys are derived from the resolved bindings so the card can't
 * drift from real behavior after a user rebinding in keybindings.json. */
function getDynamicGroups(bindings: Map<string, KeyAction>): ShortcutGroup[] {
  const cmds = listCommands()
  const topCmds = cmds.slice(0, 12).map((c) => ({
    key: `/${c.name}`,
    desc: c.description.slice(0, 50),
  }))

  const key = (action: KeyAction): string => {
    const combo = actionToCombo(bindings, action)
    return combo === null ? '—' : formatCombo(combo)
  }

  return [
    {
      title: 'Input',
      items: [
        { key: 'Enter', desc: 'Submit prompt / autocomplete slash command' },
        { key: 'Tab', desc: 'Autocomplete selected slash command' },
        { key: key('newline'), desc: 'Insert newline (multi-line input)' },
        { key: key('open-editor'), desc: 'Open external editor ($EDITOR)' },
        { key: `${key('cursor-home')} / ${key('cursor-end')}`, desc: 'Move cursor to start / end' },
        { key: key('clear-line'), desc: 'Clear input line' },
        { key: '↑ / ↓', desc: 'Navigate input history / slash menu' },
      ],
    },
    {
      title: 'Navigation',
      items: [
        { key: 'ESC', desc: 'Stop running turn (ESC again: force kill)' },
        { key: key('search-history'), desc: 'Reverse history search (bash-style)' },
        { key: key('copy-reply'), desc: 'Copy last assistant reply' },
        { key: key('clear-screen'), desc: 'Clear screen and redraw' },
        { key: key('toggle-verbose'), desc: 'Toggle verbose/compact tool results' },
        { key: key('undo-edit'), desc: 'Undo last file edit (/undo)' },
        { key: key('toggle-plan-mode'), desc: 'Cycle permission mode (Shift+Tab also)' },
        { key: `${key('exit')} ×2`, desc: 'Exit ovolv999' },
        { key: key('toggle-help'), desc: 'Toggle this help overlay' },
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

export function HelpOverlay({ onDismiss, bindings }: { onDismiss: () => void; bindings?: Map<string, KeyAction> }): React.ReactElement {
  useInput((input, key) => {
    if (input === '?' || key.escape) {
      onDismiss()
    }
  })

  const resolved = bindings ?? new Map<string, KeyAction>(
    Object.entries(DEFAULT_BINDINGS).map(([action, combo]) => [combo, action as KeyAction]),
  )
  useInput((input, key) => {
    if (input === '?' || key.escape) {
      onDismiss()
    }
  })

  return (
    <Box flexDirection="column" borderStyle="round" borderColor={t.borderActive} paddingX={2} paddingY={1} marginY={1}>
      <Box>
        <Text bold color={t.accent}>⌨  Keyboard Shortcuts</Text>
      </Box>
      {getDynamicGroups(resolved).map((group, gi) => (
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
