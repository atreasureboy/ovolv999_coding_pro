/**
 * PlanView — displays a plan from ExitPlanMode tool for user approval.
 *
 * Shows the plan text in a styled box with a magenta header. The user
 * can approve (y) or reject (n/ESC) the plan. Approval switches the
 * engine out of plan mode so the agent can execute.
 */

import { Text, Box, useInput } from 'ink'

export function PlanView({
  plan,
  onResolve,
}: {
  plan: string
  onResolve: (approved: boolean) => void
}): React.ReactElement {
  useInput((input, key) => {
    if (input === 'y' || input === 'Y') {
      onResolve(true)
    } else if (input === 'n' || input === 'N' || key.escape) {
      onResolve(false)
    }
  })

  // Truncate very long plans for display (keep first ~40 lines)
  const lines = plan.split('\n')
  const maxLines = 40
  const displayLines = lines.slice(0, maxLines)
  const truncated = lines.length > maxLines

  return (
    <Box flexDirection="column" borderStyle="round" borderColor="magentaBright" paddingX={1} marginY={1}>
      <Box>
        <Text bold color="magentaBright">{'⚡ Plan'}</Text>
      </Box>
      <Box flexDirection="column" marginTop={1}>
        {displayLines.map((line, i) => (
          <Text key={i} wrap="truncate">{line}</Text>
        ))}
        {truncated ? <Text dimColor> ... +{lines.length - maxLines} more lines</Text> : null}
      </Box>
      <Box marginTop={1}>
        <Text dimColor> [y] approve · [n] reject · [ESC] reject</Text>
      </Box>
    </Box>
  )
}
