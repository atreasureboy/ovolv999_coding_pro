/**
 * Hook protocol — typed JSON contract for tool/user/session hooks.
 *
 * Inherits the claude-code hook protocol shape so users can reuse
 * their existing scripts. Each hook is a child process that receives
 * a JSON-encoded HookInput on stdin and writes a JSON HookOutput
 * to stdout. Non-zero exit or unparseable stdout is treated as a
 * non-blocking error.
 */

export type HookEvent =
  | 'PreToolUse'
  | 'PostToolUse'
  | 'PostToolUseFailure'
  | 'UserPromptSubmit'
  | 'SessionStart'
  | 'SessionEnd'
  | 'Stop'
  | 'PreCompact'
  | 'PostCompact'

export const HOOK_EVENTS: readonly HookEvent[] = [
  'PreToolUse',
  'PostToolUse',
  'PostToolUseFailure',
  'UserPromptSubmit',
  'SessionStart',
  'SessionEnd',
  'Stop',
  'PreCompact',
  'PostCompact',
]

export interface HookInputBase {
  session_id: string
  cwd: string
  hook_event_name: HookEvent
}

export interface PreToolUseInput extends HookInputBase {
  hook_event_name: 'PreToolUse'
  tool_name: string
  tool_input: Record<string, unknown>
  tool_use_id: string
}

export interface PostToolUseInput extends HookInputBase {
  hook_event_name: 'PostToolUse'
  tool_name: string
  tool_input: Record<string, unknown>
  tool_result: {
    content: string
    is_error: boolean
  }
  tool_use_id: string
}

export interface PostToolUseFailureInput extends HookInputBase {
  hook_event_name: 'PostToolUseFailure'
  tool_name: string
  tool_input: Record<string, unknown>
  error: string
  tool_use_id: string
}

export interface UserPromptSubmitInput extends HookInputBase {
  hook_event_name: 'UserPromptSubmit'
  prompt: string
}

export interface SessionStartInput extends HookInputBase {
  hook_event_name: 'SessionStart'
  source?: 'startup' | 'resume' | 'clear' | 'compact'
}

export type HookInput =
  | PreToolUseInput
  | PostToolUseInput
  | PostToolUseFailureInput
  | UserPromptSubmitInput
  | SessionStartInput

export type HookOutput =
  | HookBaseOutput
  | (HookBaseOutput & {
      hookSpecificOutput: PreToolUseHookSpecificOutput
    })
  | (HookBaseOutput & {
      hookSpecificOutput: PostToolUseHookSpecificOutput
    })
  | (HookBaseOutput & {
      hookSpecificOutput: UserPromptSubmitHookSpecificOutput
    })
  | (HookBaseOutput & {
      hookSpecificOutput: SessionStartHookSpecificOutput
    })

export interface HookBaseOutput {
  continue?: boolean
  stopReason?: string
  suppressOutput?: boolean
  systemMessage?: string
  decision?: 'approve' | 'block'
  reason?: string
  hookSpecificOutput?: PreToolUseHookSpecificOutput | PostToolUseHookSpecificOutput | UserPromptSubmitHookSpecificOutput | SessionStartHookSpecificOutput
}

export interface PreToolUseHookSpecificOutput {
  hookEventName: 'PreToolUse'
  permissionDecision?: 'allow' | 'deny' | 'ask'
  permissionDecisionReason?: string
  updatedInput?: Record<string, unknown>
  additionalContext?: string
}

export interface PostToolUseHookSpecificOutput {
  hookEventName: 'PostToolUse'
  additionalContext?: string
}

export interface UserPromptSubmitHookSpecificOutput {
  hookEventName: 'UserPromptSubmit'
  additionalContext?: string
}

export interface SessionStartHookSpecificOutput {
  hookEventName: 'SessionStart'
  additionalContext?: string
}

export type HookPermissionDecision = 'allow' | 'deny' | 'ask'

export interface PreToolUseOutcome {
  decision: HookPermissionDecision
  reason?: string
  updatedInput?: Record<string, unknown>
  additionalContext?: string
  hookName: string
  error?: string
}

export interface PostToolUseOutcome {
  additionalContext?: string
  hookName: string
  error?: string
}

export const HOOK_DEFAULT_TIMEOUT_MS = 60_000
export const HOOK_OUTPUT_MAX_BYTES = 1_000_000

export function isPreToolUseInput(input: HookInput): input is PreToolUseInput {
  return input.hook_event_name === 'PreToolUse'
}

export function isPostToolUseInput(input: HookInput): input is PostToolUseInput {
  return input.hook_event_name === 'PostToolUse'
}

export function isUserPromptSubmitInput(input: HookInput): input is UserPromptSubmitInput {
  return input.hook_event_name === 'UserPromptSubmit'
}

export function isSessionStartInput(input: HookInput): input is SessionStartInput {
  return input.hook_event_name === 'SessionStart'
}

export function parseHookOutput(raw: string): HookOutput | null {
  if (!raw.trim()) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
  const obj = parsed as Record<string, unknown>
  const out: HookBaseOutput = {}
  if (typeof obj.continue === 'boolean') out.continue = obj.continue
  if (typeof obj.stopReason === 'string') out.stopReason = obj.stopReason
  if (typeof obj.suppressOutput === 'boolean') out.suppressOutput = obj.suppressOutput
  if (typeof obj.systemMessage === 'string') out.systemMessage = obj.systemMessage
  if (obj.decision === 'approve' || obj.decision === 'block') out.decision = obj.decision
  if (typeof obj.reason === 'string') out.reason = obj.reason
  if (obj.hookSpecificOutput && typeof obj.hookSpecificOutput === 'object') {
    const specific = obj.hookSpecificOutput as Record<string, unknown>
    if (specific.hookEventName === 'PreToolUse') {
      const pre: PreToolUseHookSpecificOutput = { hookEventName: 'PreToolUse' }
      if (specific.permissionDecision === 'allow' || specific.permissionDecision === 'deny' || specific.permissionDecision === 'ask') {
        pre.permissionDecision = specific.permissionDecision
      }
      if (typeof specific.permissionDecisionReason === 'string') {
        pre.permissionDecisionReason = specific.permissionDecisionReason
      }
      if (specific.updatedInput && typeof specific.updatedInput === 'object' && !Array.isArray(specific.updatedInput)) {
        pre.updatedInput = specific.updatedInput as Record<string, unknown>
      }
      if (typeof specific.additionalContext === 'string') {
        pre.additionalContext = specific.additionalContext
      }
      out.hookSpecificOutput = pre
    } else if (specific.hookEventName === 'PostToolUse') {
      const post: PostToolUseHookSpecificOutput = { hookEventName: 'PostToolUse' }
      if (typeof specific.additionalContext === 'string') {
        post.additionalContext = specific.additionalContext
      }
      out.hookSpecificOutput = post
    } else if (specific.hookEventName === 'UserPromptSubmit') {
      const ups: UserPromptSubmitHookSpecificOutput = { hookEventName: 'UserPromptSubmit' }
      if (typeof specific.additionalContext === 'string') {
        ups.additionalContext = specific.additionalContext
      }
      out.hookSpecificOutput = ups
    } else if (specific.hookEventName === 'SessionStart') {
      const ss: SessionStartHookSpecificOutput = { hookEventName: 'SessionStart' }
      if (typeof specific.additionalContext === 'string') {
        ss.additionalContext = specific.additionalContext
      }
      out.hookSpecificOutput = ss
    }
  }
  return out
}
