/**
 * HistorySearchOverlay — bash-style reverse incremental search.
 *
 * Triggered by Ctrl+R. Shows a text input + filtered history results.
 * Up/Down to navigate, Enter to select (fills PromptInput), Esc to cancel.
 */

import { Text, Box, useInput } from 'ink'
import { t } from '../../theme.js'
import { useState, useMemo } from 'react'
import { prevCursor } from '../textCursor.js'

export interface HistorySearchProps {
  history: string[]
  onSelect: (text: string) => void
  onCancel: () => void
}

export function HistorySearchOverlay({ history, onSelect, onCancel }: HistorySearchProps): React.ReactElement {
  const [query, setQuery] = useState('')
  const [selected, setSelected] = useState(0)

  const matches = useMemo(() => {
    if (!query.trim()) return history.slice(0, 10)
    const q = query.toLowerCase()
    return history.filter((h) => h.toLowerCase().includes(q)).slice(0, 10)
  }, [query, history])

  useInput((input, key) => {
    if (key.escape) {
      onCancel()
      return
    }
    if (key.return) {
      const match = matches[selected] ?? matches[0]
      if (match) onSelect(match)
      else onCancel()
      return
    }
    if (key.upArrow) {
      setSelected((s) => Math.max(0, s - 1))
      return
    }
    if (key.downArrow) {
      setSelected((s) => Math.min(matches.length - 1, s + 1))
      return
    }
    if (key.backspace || key.delete) {
      setQuery((q) => q.slice(0, prevCursor(q, q.length)))
      setSelected(0)
      return
    }
    // Ctrl+R again — cycle to next match
    if (input === '\x12') {
      setSelected((s) => Math.min(matches.length - 1, s + 1))
      return
    }
    // Regular character
    if (input && !key.ctrl && !key.meta && input !== '\r' && input !== '\n') {
      setQuery((q) => q + input)
      setSelected(0)
    }
  })

  return (
    <Box flexDirection="column" borderStyle="round" borderColor={t.borderActive} paddingX={1} marginY={0}>
      <Box>
        <Text bold color={t.info}>⌕ reverse-i-search: </Text>
        <Text color="cyanBright">{query}</Text>
        <Text color={t.info}>_</Text>
      </Box>
      {matches.length > 0 ? (
        <Box flexDirection="column" marginTop={0}>
          {matches.slice(0, 6).map((m, i) => (
            <Box key={i}>
              <Text color={i === selected ? 'cyanBright' : undefined} bold={i === selected}>
                {i === selected ? '▸ ' : '  '}
                {m.length > 100 ? m.slice(0, 97) + '...' : m}
              </Text>
            </Box>
          ))}
          {matches.length > 6 ? (
            <Text dimColor>  +{matches.length - 6} more</Text>
          ) : null}
        </Box>
      ) : (
        <Text dimColor>  no matches</Text>
      )}
      <Text dimColor> Enter=select · ↑↓=navigate · Ctrl+R=next · Esc=cancel</Text>
    </Box>
  )
}
