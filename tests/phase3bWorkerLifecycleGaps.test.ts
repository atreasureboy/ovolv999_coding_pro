/**
 * Phase 3b (five_goal §六 GAP 5.1-5.6):
 *
 * Tests the NEW lifecycle capabilities added on top of phase3WorkerLifecycle:
 *   GAP 5.1 — capture/wait/send/stop resolve via runId (not input.session)
 *   GAP 5.2 — wait(runId) adapter method blocks until terminal
 *   GAP 5.3 — status()/collect() write-back 'lost' to registry
 *   GAP 5.4 — reattach(runId, descriptor) preserves original runId
 *   GAP 5.5 — 'lost' in RunStatus union + VALID_TRANSITIONS + event mapping
 *   GAP 5.6 — TASK_FAILED sentinel in prompt + waitFor + event transition
 */

import { describe, it, expect } from 'vitest'
import { ClaudeCodeTool } from '../src/tools/claudeCode.js'
import { ExecutionRunRegistry, isTerminalRunStatus, canTransition } from '../src/core/executionRun.js'
import {
  buildClaudeWorkerPrompt,
  taskDonePattern,
  taskFailedPattern,
} from '../src/core/claudeCodeWorkerManager.js'

// ── Fake manager ──────────────────────────────────────────────────

function makeFakeManager(opts: {
  exists?: Set<string>
  captureOutput?: string
  waitResult?: { matched: boolean; matchKind?: 'done' | 'failed'; failureReason?: string; output: string; aborted?: boolean }
} = {}) {
  const exists = opts.exists ?? new Set<string>(['s1', 's2'])
  const calls = {
    stopped: new Set<string>(),
    captured: [] as string[],
    sent: [] as Array<[string, string]>,
  }
  return {
    calls,
    manager: {
      async sessionExists(s: string) { return exists.has(s) && !calls.stopped.has(s) },
      async send(s: string, t: string) { calls.sent.push([s, t]) },
      async start() { return { session: 's1', created: true, syncedEnv: [] } },
      async runTask() { return { session: 's1', created: true, syncedEnv: [], taskId: 't1' } },
      async capture(s: string, _n?: number) { calls.captured.push(s); return opts.captureOutput ?? 'pane output' },
      async waitFor() { return opts.waitResult ?? { matched: true, matchKind: 'done' as const, output: 'done' } },
      async list() { return [...exists] },
      async stop(s: string) { calls.stopped.add(s); return { stopped: true } },
    },
  }
}

type ToolResultLike = { content: string; isError?: boolean; runId?: string; sessionId?: string; status?: string; detached?: boolean }

// ── GAP 5.5: 'lost' in RunStatus ──────────────────────────────────

describe('GAP 5.5: RunStatus includes lost', () => {
  it('canTransition allows waiting → lost', () => {
    expect(canTransition('waiting', 'lost')).toBe(true)
  })

  it('canTransition allows running → lost', () => {
    expect(canTransition('running', 'lost')).toBe(true)
  })

  it('canTransition allows verifying → lost', () => {
    expect(canTransition('verifying', 'lost')).toBe(true)
  })

  it('canTransition disallows lost → running (terminal)', () => {
    expect(canTransition('lost', 'running')).toBe(false)
  })

  it('isTerminalRunStatus(true) for lost', () => {
    expect(isTerminalRunStatus('lost')).toBe(true)
  })

  it('registry.transition to lost succeeds from waiting', () => {
    const registry = new ExecutionRunRegistry()
    const run = registry.create({ kind: 'external_worker', goal: 'g', workspace: { cwd: '/r' } })
    registry.transition(run.runId, 'preparing')
    registry.transition(run.runId, 'running')
    registry.transition(run.runId, 'waiting')
    registry.transition(run.runId, 'lost', { error: 'pane disappeared' })
    expect(registry.get(run.runId)!.status).toBe('lost')
    expect(isTerminalRunStatus(registry.get(run.runId)!.status)).toBe(true)
  })
})

// ── GAP 5.3: status() writes back 'lost' to registry ──────────────

describe('GAP 5.3: async worker death updates the Run', () => {
  it('status() transitions run to lost when pane disappears', async () => {
    const { manager, calls } = makeFakeManager()
    const registry = new ExecutionRunRegistry()
    const t = new ClaudeCodeTool(manager as never, registry)

    const out = await t.execute(
      { action: 'run', task: 'X' },
      { cwd: '/r' } as never,
    ) as ToolResultLike

    // Run is non-terminal (waiting/detached).
    expect(isTerminalRunStatus(registry.get(out.runId!)!.status)).toBe(false)

    // Kill the pane out-of-band.
    calls.stopped.add('s1')

    const st = await t.status(out.runId!)
    expect(st).toBe('lost')
    // Registry was updated — no longer stuck in 'waiting'.
    expect(registry.get(out.runId!)!.status).toBe('lost')
    expect(isTerminalRunStatus(registry.get(out.runId!)!.status)).toBe(true)
  })

  it('collect() reflects lost when pane is gone and registry non-terminal', async () => {
    const { manager, calls } = makeFakeManager()
    const registry = new ExecutionRunRegistry()
    const t = new ClaudeCodeTool(manager as never, registry)

    const out = await t.execute(
      { action: 'run', task: 'X' },
      { cwd: '/r' } as never,
    ) as ToolResultLike

    calls.stopped.add('s1')

    const result = await t.collect(out.runId!)
    // collect() calls status() internally which writes back 'lost'.
    expect(result.status).toBe('lost')
    expect(registry.get(out.runId!)!.status).toBe('lost')
  })
})

// ── GAP 5.4: reattach preserves original runId ────────────────────

describe('GAP 5.4: reattach preserves original runId', () => {
  it('reattach(runId, descriptor) returns handle with the SAME runId', async () => {
    const { manager } = makeFakeManager()
    const t = new ClaudeCodeTool(manager as never)
    const handle = await t.reattach('my-original-run', { type: 'tmux', sessionId: 's1' })
    expect(handle).not.toBeNull()
    expect(handle!.runId).toBe('my-original-run')
    // The runId→session mapping is established so subsequent steer/status resolve.
    expect(await t.steer('my-original-run', 'hi')).toBe(true)
  })

  it('reattach returns null when pane is gone', async () => {
    const { manager } = makeFakeManager({ exists: new Set() })
    const t = new ClaudeCodeTool(manager as never)
    expect(await t.reattach('orig', { type: 'tmux', sessionId: 'gone' })).toBeNull()
  })
})

// ── GAP 5.1: capture/wait/send/stop resolve via runId ─────────────

describe('GAP 5.1: tool actions resolve via runId', () => {
  it('capture with runId resolves to the correct session', async () => {
    const { manager, calls } = makeFakeManager()
    const registry = new ExecutionRunRegistry()
    const t = new ClaudeCodeTool(manager as never, registry)

    const out = await t.execute(
      { action: 'run', task: 'X' },
      { cwd: '/r' } as never,
    ) as ToolResultLike

    calls.captured.length = 0
    const result = await t.execute(
      { action: 'capture', runId: out.runId },
      { cwd: '/r' } as never,
    )
    expect(result.isError).toBeFalsy()
    expect(calls.captured).toEqual(['s1'])
  })

  it('send with runId resolves to the correct session', async () => {
    const { manager, calls } = makeFakeManager()
    const registry = new ExecutionRunRegistry()
    const t = new ClaudeCodeTool(manager as never, registry)

    const out = await t.execute(
      { action: 'run', task: 'X' },
      { cwd: '/r' } as never,
    ) as ToolResultLike

    calls.sent.length = 0
    await t.execute(
      { action: 'send', runId: out.runId, text: 'follow-up' },
      { cwd: '/r' } as never,
    )
    expect(calls.sent).toEqual([['s1', 'follow-up']])
  })

  it('stop with runId cleans up mapping and transitions to cancelled', async () => {
    const { manager } = makeFakeManager()
    const registry = new ExecutionRunRegistry()
    const t = new ClaudeCodeTool(manager as never, registry)

    const out = await t.execute(
      { action: 'run', task: 'X' },
      { cwd: '/r' } as never,
    ) as ToolResultLike

    await t.execute(
      { action: 'stop', runId: out.runId },
      { cwd: '/r' } as never,
    )

    expect(registry.get(out.runId!)!.status).toBe('cancelled')
    // Mapping is cleaned up — steer fails.
    expect(await t.steer(out.runId!, 'x')).toBe(false)
  })
})

// ── GAP 5.2: wait(runId) adapter method ───────────────────────────

describe('GAP 5.2: wait(runId) adapter method', () => {
  it('wait(runId) blocks and transitions to succeeded on match', async () => {
    const { manager } = makeFakeManager({
      waitResult: { matched: true, matchKind: 'done', output: 'task output' },
    })
    const registry = new ExecutionRunRegistry()
    const t = new ClaudeCodeTool(manager as never, registry)

    const handle = await t.start({ goal: 'g' }, { cwd: '/r' })

    const result = await t.wait(handle.runId, { timeoutMs: 5000 })
    expect(result.status).toBe('succeeded')
    expect(registry.get(handle.runId)!.status).toBe('succeeded')
  })

  it('wait(runId) transitions to failed on TASK_FAILED match', async () => {
    const { manager } = makeFakeManager({
      waitResult: { matched: true, matchKind: 'failed', failureReason: 'tests broke', output: 'fail output' },
    })
    const registry = new ExecutionRunRegistry()
    const t = new ClaudeCodeTool(manager as never, registry)

    const handle = await t.start({ goal: 'g' }, { cwd: '/r' })

    const result = await t.wait(handle.runId, { timeoutMs: 5000 })
    expect(result.status).toBe('failed')
    expect(registry.get(handle.runId)!.status).toBe('failed')
  })

  it('wait(runId) transitions to timed_out on no match', async () => {
    const { manager } = makeFakeManager({
      waitResult: { matched: false, output: '' },
    })
    const registry = new ExecutionRunRegistry()
    const t = new ClaudeCodeTool(manager as never, registry)

    const handle = await t.start({ goal: 'g' }, { cwd: '/r' })

    const result = await t.wait(handle.runId, { timeoutMs: 5000 })
    expect(result.status).toBe('failed')
    expect(registry.get(handle.runId)!.status).toBe('timed_out')
  })

  it('wait(unknownRunId) returns unknown without throwing', async () => {
    const { manager } = makeFakeManager()
    const t = new ClaudeCodeTool(manager as never)
    const result = await t.wait('never-existed')
    expect(result.status).toBe('unknown')
  })
})

// ── GAP 5.6: TASK_FAILED sentinel ─────────────────────────────────

describe('GAP 5.6: TASK_FAILED sentinel', () => {
  it('buildClaudeWorkerPrompt includes [TASK_FAILED <id>]', () => {
    const prompt = buildClaudeWorkerPrompt('task', undefined, 'my-id')
    expect(prompt).toContain('[TASK_FAILED my-id reason=<short description>]')
  })

  it('taskFailedPattern matches [TASK_FAILED <id> reason=...]', () => {
    const pat = new RegExp(taskFailedPattern('abc-123'), 'm')
    expect(pat.test('[TASK_FAILED abc-123 reason=tests failed]')).toBe(true)
    expect(pat.test('[TASK_FAILED other-id reason=x]')).toBe(false)
    expect(pat.test('[TASK_DONE abc-123]')).toBe(false)
  })

  it('taskFailedPattern does not match success sentinel', () => {
    const pat = new RegExp(taskFailedPattern('id-1'), 'm')
    expect(pat.test('[TASK_DONE id-1]')).toBe(false)
  })

  it('run() with wait:true transitions to failed on TASK_FAILED', async () => {
    const { manager } = makeFakeManager({
      waitResult: { matched: true, matchKind: 'failed', failureReason: 'compile error', output: 'fail' },
    })
    const registry = new ExecutionRunRegistry()
    const t = new ClaudeCodeTool(manager as never, registry)

    const out = await t.execute(
      { action: 'run', task: 'X', wait: true },
      { cwd: '/r' } as never,
    ) as ToolResultLike

    expect(out.isError).toBe(true)
    expect(out.content).toContain('TASK_FAILED')
    expect(registry.get(out.runId!)!.status).toBe('failed')
  })
})
