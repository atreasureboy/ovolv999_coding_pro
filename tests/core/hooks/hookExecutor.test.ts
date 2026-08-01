import { describe, expect, it } from 'vitest'
import { executeHookCommand, executeHooksParallel } from '../../../src/core/hooks/hookExecutor.js'
import { parseHookOutput } from '../../../src/core/hooks/hookProtocol.js'

const SLEEP_CMD = process.platform === 'win32'
  ? 'node -e "setTimeout(()=>console.log(\'{"ok":1}\'),100)"'
  : 'node -e "setTimeout(()=>console.log(\'{\\\\\'ok\\\\\':1}\'),100)"'

const ECHO_OK_CMD = process.platform === 'win32'
  ? 'node -e "console.log(JSON.stringify({hookSpecificOutput:{hookEventName:\'PreToolUse\',permissionDecision:\'deny\',permissionDecisionReason:\'unsafe\'}}))"'
  : 'node -e "console.log(JSON.stringify({hookSpecificOutput:{hookEventName:\'PreToolUse\',permissionDecision:\'deny\',permissionDecisionReason:\'unsafe\'}}))"'

const FAIL_CMD = 'node -e "process.exit(2)"'

const PRE_INPUT = {
  session_id: 'test',
  cwd: '/tmp',
  hook_event_name: 'PreToolUse' as const,
  tool_name: 'Bash',
  tool_input: { command: 'ls' },
  tool_use_id: 'tu-1',
}

describe('executeHookCommand', () => {
  it('runs a command that exits 0 and parses JSON output', async () => {
    const result = await executeHookCommand(
      { type: 'command', command: ECHO_OK_CMD },
      PRE_INPUT,
      { timeoutMs: 5000 },
    )
    expect(result.ok).toBe(true)
    expect(result.exitCode).toBe(0)
    expect(result.output?.hookSpecificOutput).toBeDefined()
    if (result.output?.hookSpecificOutput && 'permissionDecision' in result.output.hookSpecificOutput) {
      expect(result.output.hookSpecificOutput.permissionDecision).toBe('deny')
    }
  })

  it('records non-zero exit as failure', async () => {
    const result = await executeHookCommand(
      { type: 'command', command: FAIL_CMD },
      PRE_INPUT,
      { timeoutMs: 5000 },
    )
    expect(result.ok).toBe(false)
    expect(result.exitCode).toBe(2)
    expect(result.error).toContain('exit')
  })

  it('kills process on timeout', async () => {
    const result = await executeHookCommand(
      { type: 'command', command: SLEEP_CMD },
      PRE_INPUT,
      { timeoutMs: 50 },
    )
    expect(result.timedOut).toBe(true)
    expect(result.ok).toBe(false)
  })

  it('records cancelled when aborted before start', async () => {
    const controller = new AbortController()
    controller.abort()
    const result = await executeHookCommand(
      { type: 'command', command: ECHO_OK_CMD },
      PRE_INPUT,
      { signal: controller.signal },
    )
    expect(result.cancelled).toBe(true)
  })

  it('records spawn error gracefully', async () => {
    const result = await executeHookCommand(
      { type: 'command', command: '/nonexistent/path/to/binary/that/cannot/exist' },
      PRE_INPUT,
      { timeoutMs: 1000 },
    )
    expect(result.ok).toBe(false)
    expect(result.error).toBeDefined()
  })
})

describe('executeHooksParallel', () => {
  it('runs multiple hooks concurrently', async () => {
    const results = await executeHooksParallel(
      [
        { type: 'command', command: ECHO_OK_CMD },
        { type: 'command', command: ECHO_OK_CMD },
      ],
      PRE_INPUT,
      { timeoutMs: 5000 },
    )
    expect(results).toHaveLength(2)
    expect(results.every((r) => r.ok)).toBe(true)
  })
})

describe('parseHookOutput (re-export integration)', () => {
  it('parses PreToolUse specific output', () => {
    const raw = JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'allow',
        updatedInput: { x: 1 },
        additionalContext: 'a hint',
      },
    })
    const parsed = parseHookOutput(raw)
    expect(parsed?.hookSpecificOutput).toMatchObject({
      permissionDecision: 'allow',
      additionalContext: 'a hint',
    })
  })
})
