/**
 * PermissionDialog — y/n confirmation for tool execution approval.
 *
 * Shows the tool name, a preview of what it wants to do, and waits for
 * y/n/a/Escape. Pressing 'n' then Tab enters feedback mode, where the
 * user can type natural-language guidance for the model (e.g. "use a
 * different approach"). The feedback is passed back to the engine as
 * part of the rejection message.
 */

import { Text, Box, useInput } from 'ink'
import { t } from '../../theme.js'
import { useState } from 'react'

export interface PermissionRequest {
  toolName: string
  preview: string
  riskLevel: 'safe' | 'needs-approval' | 'dangerous'
}

export function PermissionDialog({
  request,
  onResolve,
}: {
  request: PermissionRequest
  onResolve: (approved: boolean, alwaysAllow: boolean, feedback?: string) => void
}): React.ReactElement {
  const [feedbackMode, setFeedbackMode] = useState(false)
  const [feedback, setFeedback] = useState('')

  useInput((input, key) => {
    if (feedbackMode) {
      if (key.return) {
        onResolve(false, false, feedback.trim() || undefined)
        return
      }
      if (key.escape) {
        setFeedbackMode(false)
        return
      }
      if (key.backspace || key.delete) {
        setFeedback((f) => f.slice(0, -1))
        return
      }
      if (input && !key.ctrl && !key.meta && input !== '\r' && input !== '\n') {
        setFeedback((f) => f + input)
      }
      return
    }

    if (input === 'y' || input === 'Y') {
      onResolve(true, false)
    } else if (input === 'n' || input === 'N') {
      onResolve(false, false)
    } else if (key.escape) {
      onResolve(false, false)
    } else if (input === 'a' || input === 'A') {
      onResolve(true, true)
    } else if (input === 't' || input === 'T' || key.tab) {
      setFeedbackMode(true)
    }
  })

  const riskColor =
    request.riskLevel === 'dangerous'
      ? 'redBright'
      : request.riskLevel === 'needs-approval'
        ? 'yellowBright'
        : 'greenBright'

  const riskLabel =
    request.riskLevel === 'dangerous'
      ? 'DANGEROUS'
      : request.riskLevel === 'needs-approval'
        ? 'needs approval'
        : 'safe'

  if (feedbackMode) {
    return (
      <Box flexDirection="column" borderStyle="round" borderColor="yellowBright" paddingX={1} marginY={1}>
        <Box>
          <Text bold color={t.warning}>💬 Feedback for denial</Text>
        </Box>
        <Box marginTop={1}>
          <Text dimColor>Tell the model what to do differently:</Text>
        </Box>
        <Box marginLeft={2}>
          <Text color={t.warning}>{'> '} {feedback}_</Text>
        </Box>
        <Box marginTop={1}>
          <Text dimColor> Enter=submit · ESC=back</Text>
        </Box>
      </Box>
    )
  }

  return (
    <Box flexDirection="column" borderStyle="round" borderColor={riskColor} paddingX={1} marginY={1}>
      <Box>
        <Text bold color={riskColor}>⚠ Permission Request</Text>
        <Text dimColor> [{riskLabel}]</Text>
      </Box>
      <Box marginTop={1}>
        <Text bold color={t.info}>{request.toolName}</Text>
      </Box>
      <Box marginLeft={2}>
        <Text dimColor>{request.preview.slice(0, 100)}</Text>
      </Box>
      <Box marginTop={1}>
        <Text dimColor>
          {' '}
          [y] approve · [n] deny · [a] always · [t] deny with feedback · [ESC] deny
        </Text>
      </Box>
    </Box>
  )
}
