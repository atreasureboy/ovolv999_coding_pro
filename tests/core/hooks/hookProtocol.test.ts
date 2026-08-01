import { describe, expect, it } from 'vitest'
import { parseHookOutput, isPreToolUseInput } from '../../../src/core/hooks/hookProtocol.js'

describe('parseHookOutput', () => {
  it('returns null for empty input', () => {
    expect(parseHookOutput('')).toBeNull()
    expect(parseHookOutput('   ')).toBeNull()
  })

  it('returns null for invalid JSON', () => {
    expect(parseHookOutput('not json')).toBeNull()
    expect(parseHookOutput('{')).toBeNull()
  })

  it('returns null for non-object JSON', () => {
    expect(parseHookOutput('null')).toBeNull()
    expect(parseHookOutput('[]')).toBeNull()
    expect(parseHookOutput('"string"')).toBeNull()
    expect(parseHookOutput('123')).toBeNull()
  })

  it('extracts base fields', () => {
    const parsed = parseHookOutput(JSON.stringify({
      continue: false,
      stopReason: 'because',
      suppressOutput: true,
      systemMessage: 'msg',
      decision: 'approve',
      reason: 'r',
    }))
    expect(parsed).toEqual({
      continue: false,
      stopReason: 'because',
      suppressOutput: true,
      systemMessage: 'msg',
      decision: 'approve',
      reason: 'r',
    })
  })

  it('rejects invalid decision values', () => {
    const parsed = parseHookOutput(JSON.stringify({ decision: 'maybe' }))
    expect(parsed?.decision).toBeUndefined()
  })

  it('extracts PreToolUse hookSpecificOutput', () => {
    const parsed = parseHookOutput(JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: 'unsafe',
        updatedInput: { x: 1 },
        additionalContext: 'hint',
      },
    }))
    expect(parsed?.hookSpecificOutput).toEqual({
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: 'unsafe',
      updatedInput: { x: 1 },
      additionalContext: 'hint',
    })
  })

  it('extracts PostToolUse hookSpecificOutput', () => {
    const parsed = parseHookOutput(JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PostToolUse',
        additionalContext: 'post hint',
      },
    }))
    expect(parsed?.hookSpecificOutput).toEqual({
      hookEventName: 'PostToolUse',
      additionalContext: 'post hint',
    })
  })

  it('rejects unknown hookSpecificOutput.hookEventName', () => {
    const parsed = parseHookOutput(JSON.stringify({
      hookSpecificOutput: { hookEventName: 'Mystery', additionalContext: 'x' },
    }))
    expect(parsed?.hookSpecificOutput).toBeUndefined()
  })

  it('rejects non-string permissionDecisionReason', () => {
    const parsed = parseHookOutput(JSON.stringify({
      hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecisionReason: 42 },
    }))
    const specific = parsed?.hookSpecificOutput
    if (specific && 'permissionDecisionReason' in specific) {
      expect(specific.permissionDecisionReason).toBeUndefined()
    } else {
      expect(specific).toBeDefined()
    }
  })

  it('rejects non-object updatedInput', () => {
    const parsed = parseHookOutput(JSON.stringify({
      hookSpecificOutput: { hookEventName: 'PreToolUse', updatedInput: [1, 2] },
    }))
    const specific = parsed?.hookSpecificOutput
    if (specific && 'updatedInput' in specific) {
      expect(specific.updatedInput).toBeUndefined()
    } else {
      expect(specific).toBeDefined()
    }
  })
})

describe('isPreToolUseInput', () => {
  it('returns true for PreToolUse input', () => {
    const input = {
      session_id: 's',
      cwd: '/tmp',
      hook_event_name: 'PreToolUse' as const,
      tool_name: 'Bash',
      tool_input: {},
      tool_use_id: 'id',
    }
    expect(isPreToolUseInput(input)).toBe(true)
  })

  it('returns false for other events', () => {
    const input = {
      session_id: 's',
      cwd: '/tmp',
      hook_event_name: 'PostToolUse' as const,
      tool_name: 'Bash',
      tool_input: {},
      tool_result: { content: '', is_error: false },
      tool_use_id: 'id',
    }
    expect(isPreToolUseInput(input)).toBe(false)
  })
})
