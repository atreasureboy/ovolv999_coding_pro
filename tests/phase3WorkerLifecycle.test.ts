/**
 * Phase 3 (five_goal §六 P0-6, P0-8):
 *
 * P0-6: `wait:false` must NOT mark the run as 'succeeded'. A dispatched-
 *       but-unverified task is still in flight — the run stays non-
 *       terminal ('waiting') and structured fields (runId, sessionId,
 *       status:'waiting', detached:true) are returned so the host can
 *       later call wait/steer/cancel/collect with the same runId.
 *
 * P0-8: WorkerAdapter is extended with the full lifecycle:
 *       start/status/steer/cancel/collect/reattach. ClaudeCodeTool
 *       implements all of them; AgentTool provides best-effort stubs
 *       that reflect its synchronous-execution model.
 */

import { describe, it, expect } from 'vitest'
import { ClaudeCodeTool } from '../src/tools/claudeCode.js'
import { AgentTool } from '../src/tools/agent.js'
import { ExecutionRunRegistry, isTerminalRunStatus } from '../src/core/executionRun.js'
import type { WorkerAdapter, WorkerStatus } from '../src/core/workerAdapter.js'

// ── Stubs ──────────────────────────────────────────────────────────────

function makeFakeManager(opts: {
  exists?: Set<string>
  throwOnSend?: boolean
  captureOutput?: string
  stopSessions?: Set<string>
} = {}) {
  const exists = opts.exists ?? new Set<string>(['s1', 's2', 's3'])
  const calls = {
    send: [] as Array<[string, string]>,
    stopped: new Set<string>(),
    captured: new Set<string>(),
  }
  return {
    calls,
    manager: {
      async sessionExists(s: string) { return exists.has(s) && !calls.stopped.has(s) },
      async send(s: string, t: string) {
        calls.send.push([s, t])
        if (opts.throwOnSend) throw new Error('send failed')
      },
      async start() { return { session: 's1', created: true, syncedEnv: [] } },
      async runTask() { return { session: 's1', created: true, syncedEnv: [], taskId: 't1' } },
      async capture(s: string, _n?: number) {
        calls.captured.add(s)
        return opts.captureOutput ?? 'pane output'
      },
      async waitFor() { return { matched: true, aborted: false, output: 'done' } },
      async list() { return [...exists] },
      async stop(s: string) {
        calls.stopped.add(s)
        return { stopped: true }
      },
    },
  }
}

// ─────────────────────────────────────────────────────────────────────
// P0-6: wait:false → 'waiting' (NOT 'succeeded'), structured fields
// ─────────────────────────────────────────────────────────────────────
describe('P0-6: wait:false keeps the run non-terminal', () => {
  it('returns status:"waiting" + detached:true when wait is omitted', async () => {
    const { manager } = makeFakeManager()
    const registry = new ExecutionRunRegistry()
    const t = new ClaudeCodeTool(manager as never, registry)

    const out = await t.execute(
      { action: 'run', task: 'do thing' },
      { cwd: '/r' } as never,
    )

    expect(out.isError).toBe(false)
    const structured = out as typeof out & {
      runId?: string
      workerId?: string
      sessionId?: string
      status?: string
      detached?: boolean
    }
    expect(structured.runId).toBeDefined()
    expect(structured.workerId).toBe('claude-code')
    expect(structured.sessionId).toBe('s1')
    expect(structured.status).toBe('waiting')
    expect(structured.detached).toBe(true)

    // Run in the registry is non-terminal.
    const run = registry.get(structured.runId!)
    expect(run).toBeDefined()
    expect(isTerminalRunStatus(run!.status)).toBe(false)
    expect(run!.status).toBe('waiting')
  })

  it('does NOT transition to succeeded after dispatch', async () => {
    const { manager } = makeFakeManager()
    const registry = new ExecutionRunRegistry()
    const t = new ClaudeCodeTool(manager as never, registry)

    const out = await t.execute(
      { action: 'run', task: 'X' },
      { cwd: '/r' } as never,
    ) as ToolResultLike & { runId?: string }

    const run = registry.get(out.runId!)
    expect(run!.status).not.toBe('succeeded')
    expect(run!.status).not.toBe('failed')
    expect(run!.status).toBe('waiting')
  })

  it('retains the runId→session mapping so later steer/status resolve', async () => {
    const { calls, manager } = makeFakeManager()
    const registry = new ExecutionRunRegistry()
    const t = new ClaudeCodeTool(manager as never, registry)

    const out = await t.execute(
      { action: 'run', task: 'X' },
      { cwd: '/r' } as never,
    ) as ToolResultLike & { runId?: string }

    // The mapping was retained — steer() on the same runId works.
    const ok = await t.steer(out.runId!, 'follow-up')
    expect(ok).toBe(true)
    expect(calls.send).toEqual([['s1', 'follow-up']])
  })
})

// ─────────────────────────────────────────────────────────────────────
// P0-8: WorkerAdapter lifecycle on ClaudeCodeTool
// ─────────────────────────────────────────────────────────────────────
describe('P0-8: ClaudeCodeTool implements full WorkerAdapter lifecycle', () => {
  it('status() returns "running" when tmux session still exists', async () => {
    const { manager } = makeFakeManager()
    const registry = new ExecutionRunRegistry()
    const t = new ClaudeCodeTool(manager as never, registry)
    const out = await t.execute(
      { action: 'run', task: 'X' },
      { cwd: '/r' } as never,
    ) as ToolResultLike & { runId?: string }

    expect(await t.status(out.runId!)).toBe('running')
  })

  it('status() returns "lost" when tmux session disappeared', async () => {
    const { manager, calls } = makeFakeManager()
    const registry = new ExecutionRunRegistry()
    const t = new ClaudeCodeTool(manager as never, registry)
    const out = await t.execute(
      { action: 'run', task: 'X' },
      { cwd: '/r' } as never,
    ) as ToolResultLike & { runId?: string }

    // Kill the pane out-of-band — registry still says 'waiting'.
    calls.stopped.add('s1')
    expect(await t.status(out.runId!)).toBe('lost')
    // GAP 5.3: status() must now write back to the registry.
    expect(registry.get(out.runId!)!.status).toBe('lost')
  })

  it('status() returns "unknown" for untracked runId', async () => {
    const { manager } = makeFakeManager()
    const t = new ClaudeCodeTool(manager as never)
    expect(await t.status('never-existed')).toBe('unknown')
  })

  it('cancel() stops the tmux session and transitions run to cancelled', async () => {
    const { manager, calls } = makeFakeManager()
    const registry = new ExecutionRunRegistry()
    const t = new ClaudeCodeTool(manager as never, registry)
    const out = await t.execute(
      { action: 'run', task: 'X' },
      { cwd: '/r' } as never,
    ) as ToolResultLike & { runId?: string }

    await t.cancel(out.runId!, 'test reason')

    expect(calls.stopped.has('s1')).toBe(true)
    const run = registry.get(out.runId!)
    expect(run!.status).toBe('cancelled')
    // Subsequent steer() on the cancelled run fails (mapping dropped).
    expect(await t.steer(out.runId!, 'X')).toBe(false)
  })

  it('collect() returns status:"running" when worker still in flight', async () => {
    const { manager } = makeFakeManager()
    const registry = new ExecutionRunRegistry()
    const t = new ClaudeCodeTool(manager as never, registry)
    const out = await t.execute(
      { action: 'run', task: 'X' },
      { cwd: '/r' } as never,
    ) as ToolResultLike & { runId?: string }

    const result = await t.collect(out.runId!)
    expect(result.status).toBe('running')
  })

  it('collect() harvests output and artifacts after terminal', async () => {
    const { manager } = makeFakeManager({ captureOutput: 'final pane contents' })
    const registry = new ExecutionRunRegistry()
    const t = new ClaudeCodeTool(manager as never, registry)
    const out = await t.execute(
      { action: 'run', task: 'X' },
      { cwd: '/r' } as never,
    ) as ToolResultLike & { runId?: string }

    // Manually transition through verifying→succeeded to simulate completion.
    registry.transition(out.runId!, 'verifying')
    registry.transition(out.runId!, 'succeeded')

    const result = await t.collect(out.runId!)
    expect(result.status).toBe('succeeded')
    expect(result.output).toBe('final pane contents')
    expect(result.artifacts?.[0]?.kind).toBe('log')
  })

  it('reattach() returns null when tmux session is gone', async () => {
    const { manager } = makeFakeManager({ exists: new Set() })
    const t = new ClaudeCodeTool(manager as never)
    const handle = await t.reattach!('orig-run-id', { type: 'tmux', sessionId: 'gone' })
    expect(handle).toBeNull()
  })

  it('reattach() returns a handle with the ORIGINAL runId when tmux session still exists', async () => {
    const { manager } = makeFakeManager()
    const t = new ClaudeCodeTool(manager as never)
    const handle = await t.reattach!('orig-run-id', { type: 'tmux', sessionId: 's1' })
    expect(handle).not.toBeNull()
    expect(handle!.runId).toBe('orig-run-id')
    expect(handle!.workerKind).toBe('claude-code')
    expect(handle!.descriptor.type).toBe('tmux')
    expect(handle!.descriptor.sessionId).toBe('s1')
    // The original runId can be steered.
    expect(await t.steer(handle!.runId, 'hi')).toBe(true)
  })

  it('start() launches a worker via the adapter protocol', async () => {
    const { manager } = makeFakeManager()
    const registry = new ExecutionRunRegistry()
    const t = new ClaudeCodeTool(manager as never, registry)

    const handle = await t.start({ goal: 'via adapter' }, { cwd: '/r' })
    expect(handle.workerKind).toBe('claude-code')
    expect(handle.descriptor.type).toBe('tmux')
    expect(handle.descriptor.sessionId).toBeDefined()
    // Run is in the registry, non-terminal.
    const run = registry.get(handle.runId)
    expect(run).toBeDefined()
    expect(isTerminalRunStatus(run!.status)).toBe(false)
  })
})

// ─────────────────────────────────────────────────────────────────────
// P0-8: AgentTool provides best-effort WorkerAdapter stubs
// ─────────────────────────────────────────────────────────────────────
describe('P0-8: AgentTool provides WorkerAdapter stubs', () => {
  // Helper: build an AgentTool without full wiring — we only exercise
  // the WorkerAdapter stubs (status/cancel/etc.) which never touch
  // the wiring fields.
  function makeStubAgent(): AgentTool {
    return new AgentTool(undefined)
  }

  it('status() reflects registry state', async () => {
    const registry = new ExecutionRunRegistry()
    const t = makeStubAgent()
    ;(t as unknown as { runRegistry: ExecutionRunRegistry }).runRegistry = registry
    const run = registry.create({
      kind: 'agent', goal: 'g', workspace: { cwd: '/r' },
    })
    registry.transition(run.runId, 'preparing')
    registry.transition(run.runId, 'running')
    expect(await t.status(run.runId)).toBe('running')
    registry.transition(run.runId, 'succeeded')
    expect(await t.status(run.runId)).toBe('succeeded')
  })

  it('status() returns "unknown" when no registry wired', async () => {
    const t = makeStubAgent()
    expect(await t.status('whatever')).toBe('unknown')
  })

  it('start() rejects — synchronous children only', async () => {
    const t = makeStubAgent()
    await expect(t.start({ goal: 'x' })).rejects.toThrow(/not supported/)
  })

  it('reattach() always returns null — children do not survive restart', async () => {
    const t = makeStubAgent()
    expect(await t.reattach!('whatever', { type: 'internal' })).toBeNull()
  })

  it('cancel() transitions the registry and clears steer queue', async () => {
    const registry = new ExecutionRunRegistry()
    const t = makeStubAgent()
    ;(t as unknown as { runRegistry: ExecutionRunRegistry }).runRegistry = registry
    const run = registry.create({
      kind: 'agent', goal: 'g', workspace: { cwd: '/r' },
    })
    registry.transition(run.runId, 'preparing')
    registry.transition(run.runId, 'running')

    await t.cancel(run.runId, 'testing')
    expect(registry.get(run.runId)!.status).toBe('cancelled')
  })
})

// Helper re-export to satisfy the local ToolResult typing above.
type ToolResultLike = { content: string; isError?: boolean; runId?: string; workerId?: string; sessionId?: string; status?: string; detached?: boolean }
