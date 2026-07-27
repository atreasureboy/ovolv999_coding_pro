/**
 * SlashMenu — live slash command suggestions.
 *
 * Displays a filtered list of commands + skills below the input prompt.
 * Arrow keys navigate, Tab/Enter selects (autocompletes the input).
 *
 * This replaces the ANSI-overlay SlashSuggester with a proper Ink component.
 */

import { Text, Box } from 'ink'

export interface SlashEntry {
  name: string
  description: string
  kind: 'cmd' | 'skill'
}

export function SlashMenu({
  entries,
  selected,
  maxVisible = 7,
}: {
  entries: SlashEntry[]
  selected: number
  maxVisible?: number
}): React.ReactElement {
  if (entries.length === 0) return <></>

  const start = Math.min(
    Math.max(0, selected - Math.floor(maxVisible / 2)),
    Math.max(0, entries.length - maxVisible),
  )
  const visible = entries.slice(start, start + maxVisible)
  const maxName = Math.max(...visible.map((e) => e.name.length), 4)

  return (
    <Box flexDirection="column" marginTop={0}>
      {visible.map((entry, index) => {
        const absoluteIndex = start + index
        const isSel = absoluteIndex === selected
        const description = entry.description.length > 72
          ? entry.description.slice(0, 71) + '…'
          : entry.description
        return (
          <Box key={`${entry.kind}-${entry.name}`}>
            <Text color={isSel ? 'black' : 'cyan'} backgroundColor={isSel ? 'cyan' : undefined}>
              {' '}
              /{entry.name.padEnd(maxName)}{' '}
            </Text>
            <Text dimColor> {description}</Text>
            {entry.kind === 'skill' ? <Text dimColor italic> (skill)</Text> : null}
          </Box>
        )
      })}
      {entries.length > maxVisible ? (
        <Box paddingLeft={1}>
          <Text dimColor>
            ↑↓ navigate · {selected + 1}/{entries.length} · /? shows all commands
          </Text>
        </Box>
      ) : null}
    </Box>
  )
}
