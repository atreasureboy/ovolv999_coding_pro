/**
 * Spinner — animated loading indicator with rotating verb + elapsed timer.
 * Uses Ink's useInterval pattern (state + useEffect timer).
 */

import { Text, Box } from 'ink'

export function Spinner({
  active,
  verb,
}: {
  active: boolean
  verb: string
}): React.ReactElement | null {
  if (!active) return null

  return (
    <Box>
      <Text color="magenta">◆</Text>
      <Text dimColor> {verb}…</Text>
    </Box>
  )
}
