/**
 * ExecutionRun × ClaudeCodeTool integration (fi_goal.md §三 Round 3).
 *
 * Verifies that when an ExecutionRunRegistry is wired into ClaudeCodeTool,
 * the `run` action creates a child run with kind='external_worker' and
 * walks it through the state machine. When the registry is NOT wired,
 * the tool behaves exactly as before (back-compat).
 *
 * Scope (Round 3): ClaudeCodeTool.run action. Other actions (start/
 * send/capture/wait/list/stop) are operational and don't create runs.
 */

import { describe, it, expect } from 'vitest'
import type { ClaudeCodeWorkerManager } from '../src/core/claudeCodeWorkerManager.js'
import { ClaudeCodeTool } from '../src/tools/claudeCode.js'
import { ExecutionRunRegistry, isTerminalRunStatus } from '../src/core/executionRun.js'
import type { ToolContext } from '../src/core/types.js'

function context(signal?: AbortSignal): ToolContext {
  return { cwd: '/repo', permissionMode: 'auto', signal }
}

function fakeManager(overrides: Partial<ClaudeCodeWorkerManager> = {}): ClaudeCodeWorkerManager {
  return {
    syncClaudeEnvironment: () => Promise.resolve([]),
    sessionExists: () => Promise.resolve(true),
    start: () => Promise.resolve({ session: 'worker-1', created: true, syncedEnv: [] }),
    send: () => Promise.resolve(),
    // Echo back the input session so tests can verify session propagation.
    runTask: (opts: { session?: string }) => Promise.resolve({
      session: opts.session ?? 'worker-1',
      created: true,
      syncedEnv: [],
      taskId: 'fake-task-id',
    }),
    capture: () => Promise.resolve('output'),
    waitFor: () => Promise.resolve({ matched: true, output: '[TASK_DONE fake-task-id]\nSummary: ok' }),
    list: () => Promise.resolve(['worker-1']),
    stop: () => Promise.resolve({ stopped: true }),
    ...overrides,
  } as unknown as ClaudeCodeWorkerManager
}

// ─────────────────────────────────────────────────────────────────────
// Back-compat: registry is optional
// ─────────────────────────────────────────────────────────────────────
describe('ClaudeCodeTool without a registry works exactly as before', () => {
  it('does not throw when no runRegistry is supplied (run + wait)', async () => {
    const tool = new ClaudeCodeTool(fakeManager())
    const out = await tool.execute(
      { action: 'run', task: 'do work', wait: true },
      context(),
    )
    expect(out.isError).toBe(false)
    expect(out.content).toContain('Completion: matched')
  })

  it('does not throw when no runRegistry is supplied (run, no wait)', async () => {
    const tool = new ClaudeCodeTool(fakeManager())
    const out = await tool.execute(
      { action: 'run', task: 'do work' },
      context(),
    )
    expect(out.isError).toBe(false)
    expect(out.content).toContain('task sent')
  })
})

// ─────────────────────────────────────────────────────────────────────
// Happy-path: run + wait → succeeded
// ─────────────────────────────────────────────────────────────────────
describe('ClaudeCodeTool.run with registry walks the state machine', () => {
  it('creates an external_worker run and transitions to succeeded on wait match', async () => {
    const registry = new ExecutionRunRegistry()
    const tool = new ClaudeCodeTool(fakeManager(), registry)

    const out = await tool.execute(
      { action: 'run', task: 'refactor x', wait: true, session: 'worker-7' },
      context(),
    )

    expect(out.isError).toBe(false)
    const runs = registry.list()
    expect(runs).toHaveLength(1)
    const run = runs[0]!
    expect(run.kind).toBe('external_worker')
    expect(run.goal).toBe('refactor x')
    expect(run.worker).toBe('worker-7')
    expect(run.workspace.cwd).toBe('/repo')
    expect(run.status).toBe('succeeded')
    expect(isTerminalRunStatus(run.status)).toBe(true)
  })

  it('stamps parentRunId on the child run when supplied', async () => {
    const registry = new ExecutionRunRegistry()
    const tool = new ClaudeCodeTool(fakeManager(), registry, 'parent-99')

    await tool.execute(
      { action: 'run', task: 'child task', wait: true },
      context(),
    )

    const run = registry.list({ parentRunId: 'parent-99' })[0]!
    expect(run).toBeDefined()
    expect(run.parentRunId).toBe('parent-99')
  })

  it('P0-6: lands in waiting (NOT succeeded) when wait is omitted — dispatch ≠ completion', async () => {
    const registry = new ExecutionRunRegistry()
    const tool = new ClaudeCodeTool(fakeManager(), registry)

    await tool.execute(
      { action: 'run', task: 'fire and forget' },
      context(),
    )

    // five_goal §六 P0-6: a dispatched-but-unverified task is NOT
    // 'succeeded'. The run stays non-terminal in 'waiting' so the
    // orchestrator can later wait/steer/cancel/collect with the
    // same runId. Marking 'succeeded' here is explicitly forbidden.
    expect(registry.list()[0]!.status).toBe('waiting')
  })
})

// ─────────────────────────────────────────────────────────────────────
// Wait outcomes → terminal states
// ─────────────────────────────────────────────────────────────────────
describe('ClaudeCodeTool.run wait outcomes map to terminal states', () => {
  it('lands in timed_out when waitFor times out without a match', async () => {
    const registry = new ExecutionRunRegistry()
    const tool = new ClaudeCodeTool(fakeManager({
      waitFor: () => Promise.resolve({ matched: false, output: 'still running...' }),
    }), registry)

    const out = await tool.execute(
      { action: 'run', task: 'slow', wait: true, timeoutMs: 50 },
      context(),
    )

    expect(out.isError).toBe(true)
    const run = registry.list()[0]!
    expect(run.status).toBe('timed_out')
    expect(isTerminalRunStatus(run.status)).toBe(true)
  })

  it('lands in cancelled when waitFor reports aborted', async () => {
    const registry = new ExecutionRunRegistry()
    const tool = new ClaudeCodeTool(fakeManager({
      waitFor: () => Promise.resolve({ matched: false, output: '', aborted: true }),
    }), registry)

    const controller = new AbortController()
    const out = await tool.execute(
      { action: 'run', task: 'cancellable', wait: true },
      context(controller.signal),
    )

    expect(out.isError).toBe(true)
    const run = registry.list()[0]!
    expect(run.status).toBe('cancelled')
    expect(isTerminalRunStatus(run.status)).toBe(true)
  })
})

// ─────────────────────────────────────────────────────────────────────
// Error path
// ─────────────────────────────────────────────────────────────────────
describe('ClaudeCodeTool.run error path lands in failed', () => {
  it('lands in failed when runTask throws', async () => {
    const registry = new ExecutionRunRegistry()
    const tool = new ClaudeCodeTool(fakeManager({
      runTask: () => Promise.reject(new Error('tmux exploded')),
    }), registry)

    // The tool's outer execute() catches the rethrown error and
    // returns isError — but the registry must already show failed.
    const out = await tool.execute(
      { action: 'run', task: 'doomed', wait: true },
      context(),
    )

    expect(out.isError).toBe(true)
    expect(out.content).toContain('tmux exploded')
    const run = registry.list()[0]!
    expect(run.status).toBe('failed')
    expect(run.error).toBe('tmux exploded')
  })

  it('lands in failed when waitFor throws', async () => {
    const registry = new ExecutionRunRegistry()
    const tool = new ClaudeCodeTool(fakeManager({
      waitFor: () => Promise.reject(new Error('regex compile failed')),
    }), registry)

    const out = await tool.execute(
      { action: 'run', task: 'x', wait: true },
      context(),
    )

    expect(out.isError).toBe(true)
    const run = registry.list()[0]!
    expect(run.status).toBe('failed')
  })
})

// ─────────────────────────────────────────────────────────────────────
// Other actions do NOT create runs
// ─────────────────────────────────────────────────────────────────────
describe('ClaudeCodeTool non-run actions do not create runs', () => {
  it('start / send / capture / wait / list / stop are no-ops on the registry', async () => {
    const registry = new ExecutionRunRegistry()
    const tool = new ClaudeCodeTool(fakeManager(), registry)

    await tool.execute({ action: 'start', session: 'worker-1' }, context())
    await tool.execute({ action: 'send', session: 'worker-1', text: 'hi' }, context())
    await tool.execute({ action: 'capture', session: 'worker-1' }, context())
    await tool.execute({ action: 'wait', session: 'worker-1' }, context())
    await tool.execute({ action: 'list' }, context())
    await tool.execute({ action: 'stop', session: 'worker-1' }, context())

    expect(registry.size()).toBe(0)
  })
})

// ─────────────────────────────────────────────────────────────────────
// Parallel runs are tracked independently
// ─────────────────────────────────────────────────────────────────────
describe('parallel ClaudeCode runs get independent runs', () => {
  it('two concurrent run actions create two runs with distinct runIds', async () => {
    const registry = new ExecutionRunRegistry()
    const tool = new ClaudeCodeTool(fakeManager(), registry)

    await Promise.all([
      tool.execute({ action: 'run', task: 'A', wait: true, session: 'wA' }, context()),
      tool.execute({ action: 'run', task: 'B', wait: true, session: 'wB' }, context()),
    ])

    const runs = registry.list()
    expect(runs).toHaveLength(2)
    expect(runs[0]!.runId).not.toBe(runs[1]!.runId)
    expect(runs.map((r) => r.goal).sort()).toEqual(['A', 'B'])
    expect(runs.every((r) => r.status === 'succeeded')).toBe(true)
  })
})
