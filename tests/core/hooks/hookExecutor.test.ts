import { describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { executeHookCommand, executeHooksParallel } from '../../../src/core/hooks/hookExecutor.js'
import { parseHookOutput, HOOK_EVENTS, sampleHookInput } from '../../../src/core/hooks/hookProtocol.js'
import { dispatchSlashCommand } from '../../../src/commands/index.js'
import '../../../src/commands/builtin.js'

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

describe('sampleHookInput — payload per protocol event', () => {
  it('builds a discriminant-valid payload for all 9 events', () => {
    for (const event of HOOK_EVENTS) {
      const input = sampleHookInput(event, '/tmp/x', 's1', 'Write')
      expect(input.hook_event_name).toBe(event)
      expect(input.session_id).toBe('s1')
      expect(input.cwd).toBe('/tmp/x')
    }
  })

  it('carries tool context on tool events', () => {
    const pre = sampleHookInput('PreToolUse', '/tmp', 's1', 'Write')
    expect(pre).toMatchObject({ tool_name: 'Write', tool_input: {}, tool_use_id: 's1' })
    const post = sampleHookInput('PostToolUse', '/tmp', 's1', 'Write')
    if (!('tool_result' in post)) throw new Error('PostToolUse payload lost tool_result')
    expect(post.tool_result).toEqual({ content: 'hooks-test', is_error: false })
  })

  it('carries reason/trigger on session events', () => {
    expect(sampleHookInput('SessionEnd', '/tmp')).toMatchObject({ reason: 'hooks-test' })
    expect(sampleHookInput('Stop', '/tmp')).toMatchObject({ reason: 'hooks-test' })
    expect(sampleHookInput('PreCompact', '/tmp')).toMatchObject({ trigger: 'manual' })
    expect(sampleHookInput('PostCompact', '/tmp')).toMatchObject({ trigger: 'manual' })
  })

  it('SessionEnd payload flows through executeHookCommand as a HookInput member', async () => {
    // SessionEnd/Stop/PreCompact/PostCompact were previously absent from the
    // HookInput union — the widened union must reach the executor unchanged.
    const dir = mkdtempSync(join(tmpdir(), 'hook-stdin-'))
    const sink = join(dir, 'stdin.json')
    const cmd = `node -e "const fs=require('fs');let d='';process.stdin.on('data',c=>d+=c).on('end',()=>fs.writeFileSync('${sink}',d))"`
    const result = await executeHookCommand(
      { type: 'command', command: cmd },
      sampleHookInput('SessionEnd', '/tmp', 's1'),
      { timeoutMs: 5000 },
    )
    expect(result.ok).toBe(true)
    const delivered = JSON.parse(readFileSync(sink, 'utf8')) as { hook_event_name: string; reason: string; session_id: string }
    expect(delivered.hook_event_name).toBe('SessionEnd')
    expect(delivered.reason).toBe('hooks-test')
    expect(delivered.session_id).toBe('s1')
    rmSync(dir, { recursive: true, force: true })
  })
})

describe('/hooks test — event validation', () => {
  const ctx = { cwd: tmpdir(), history: [], setHistory: () => {}, runPrompt: () => {} } as unknown as Parameters<typeof dispatchSlashCommand>[1]

  it('rejects an unknown event name', async () => {
    const r = await dispatchSlashCommand('/hooks test NotAnEvent', ctx)
    if (!r || r.type !== 'text') throw new Error('expected text result')
    expect(r.value).toContain('Unknown hook event')
    expect(r.value).toContain('SessionEnd')
  })

  it('reports unconfigured events honestly', async () => {
    const r = await dispatchSlashCommand('/hooks test SessionEnd', ctx)
    if (!r || r.type !== 'text') throw new Error('expected text result')
    expect(r.value).toContain('No hooks configured for SessionEnd')
  })
})
