/**
 * GAP-K: WorkerAdapter.steer() + run.steered event wiring.
 *
 * Verifies:
 *  - ClaudeCodeTool implements WorkerAdapter.
 *  - steer() resolves the tmux session for the given runId and
 *    delegates to manager.send().
 *  - steer() returns false for unknown / terminal runs.
 *  - successful steer calls the optional onSteered hook (which the
 *    host wires to ExecutionRunEventBus.emitSteered).
 *  - AgentTool implements WorkerAdapter (queued semantics).
 */

import { describe, it, expect } from 'vitest'
import { ClaudeCodeTool } from '../src/tools/claudeCode.js'
import { AgentTool } from '../src/tools/agent.js'
import { ExecutionRunRegistry } from '../src/core/executionRun.js'
import type { WorkerAdapter } from '../src/core/workerAdapter.js'

// ── Stubs ──────────────────────────────────────────────────────────────

interface ManagerCalls { send: Array<[string, string]>; sessionExists: Set<string> }

function makeFakeManager(opts: { exists?: Set<string>; throwOnSend?: boolean } = {}) {
  const exists = opts.exists ?? new Set<string>(['s1'])
  const calls: ManagerCalls = { send: [], sessionExists: exists }
  return {
    calls,
    manager: {
      // ClaudeCodeWorkerManager shape used by steer().
      async sessionExists(s: string) { return exists.has(s) },
      async send(s: string, t: string) {
        calls.send.push([s, t])
        if (opts.throwOnSend) throw new Error('send failed')
      },
      // Other methods are unused for steer() — stubbed for type compat.
      async start() { return { session: 's1', created: true, syncedEnv: [] } },
      async runTask() { return { session: 's1', created: true, syncedEnv: [], taskId: 't1' } },
      async capture() { return '' },
      async waitFor() { return { matched: true, aborted: false, output: '' } },
      async list() { return [] },
      async stop() { return { stopped: true } },
    },
  }
}

// ─────────────────────────────────────────────────────────────────────
// ClaudeCodeTool.steer()
// ─────────────────────────────────────────────────────────────────────
describe('GAP-K: ClaudeCodeTool.steer()', () => {
  it('ClaudeCodeTool implements WorkerAdapter', () => {
    const t = new ClaudeCodeTool()
    expect(t.workerKind).toBe('claude-code')
    expect(typeof t.steer).toBe('function')
  })

  it('returns false when the runId is unknown', async () => {
    const { manager } = makeFakeManager()
    const t = new ClaudeCodeTool(manager as never)
    expect(await t.steer('unknown', 'do X')).toBe(false)
  })

  it('returns false and skips send when the run is terminal', async () => {
    const { calls, manager } = makeFakeManager()
    const registry = new ExecutionRunRegistry()
    const t = new ClaudeCodeTool(manager as never, registry)
    // Manually plant a runId→session mapping (normally populated by run())
    // and create a terminal run in the registry.
    const run = registry.create({
      kind: 'external_worker', goal: 'g', workspace: { cwd: '/r' },
    })
    registry.transition(run.runId, 'preparing')
    registry.transition(run.runId, 'running')
    registry.transition(run.runId, 'succeeded')
    // Inject mapping via private field — simulate what run() would do.
    ;(t as unknown as { runSessions: Map<string, string> })
      .runSessions.set(run.runId, 's1')

    expect(await t.steer(run.runId, 'follow-up')).toBe(false)
    expect(calls.send).toEqual([])
  })

  it('delivers to manager.send() and returns true for an active run', async () => {
    const { calls, manager } = makeFakeManager()
    const registry = new ExecutionRunRegistry()
    const t = new ClaudeCodeTool(manager as never, registry)
    const run = registry.create({
      kind: 'external_worker', goal: 'g', workspace: { cwd: '/r' },
    })
    registry.transition(run.runId, 'preparing')
    registry.transition(run.runId, 'running')
    ;(t as unknown as { runSessions: Map<string, string> })
      .runSessions.set(run.runId, 's1')

    expect(await t.steer(run.runId, 'switch to tests')).toBe(true)
    expect(calls.send).toEqual([['s1', 'switch to tests']])
  })

  it('invokes the onSteered hook on successful delivery', async () => {
    const { manager } = makeFakeManager()
    const registry = new ExecutionRunRegistry()
    const steered: Array<{ runId: string; instruction: string }> = []
    const t = new ClaudeCodeTool(
      manager as never,
      registry,
      undefined,
      (runId, instruction) => steered.push({ runId, instruction }),
    )
    const run = registry.create({
      kind: 'external_worker', goal: 'g', workspace: { cwd: '/r' },
    })
    registry.transition(run.runId, 'preparing')
    registry.transition(run.runId, 'running')
    ;(t as unknown as { runSessions: Map<string, string> })
      .runSessions.set(run.runId, 's1')

    await t.steer(run.runId, 'inject')
    expect(steered).toEqual([{ runId: run.runId, instruction: 'inject' }])
  })

  it('returns false when manager.send throws (without invoking onSteered)', async () => {
    const { manager } = makeFakeManager({ throwOnSend: true })
    const registry = new ExecutionRunRegistry()
    let steered = 0
    const t = new ClaudeCodeTool(
      manager as never,
      registry,
      undefined,
      () => { steered++ },
    )
    const run = registry.create({
      kind: 'external_worker', goal: 'g', workspace: { cwd: '/r' },
    })
    registry.transition(run.runId, 'preparing')
    registry.transition(run.runId, 'running')
    ;(t as unknown as { runSessions: Map<string, string> })
      .runSessions.set(run.runId, 's1')

    expect(await t.steer(run.runId, 'x')).toBe(false)
    expect(steered).toBe(0)
  })

  it('returns false when sessionExists is false (pane gone)', async () => {
    const { manager } = makeFakeManager({ exists: new Set() })
    const registry = new ExecutionRunRegistry()
    const t = new ClaudeCodeTool(manager as never, registry)
    const run = registry.create({
      kind: 'external_worker', goal: 'g', workspace: { cwd: '/r' },
    })
    registry.transition(run.runId, 'preparing')
    registry.transition(run.runId, 'running')
    ;(t as unknown as { runSessions: Map<string, string> })
      .runSessions.set(run.runId, 's1')

    expect(await t.steer(run.runId, 'x')).toBe(false)
  })
})

// ─────────────────────────────────────────────────────────────────────
// AgentTool.steer()
// ─────────────────────────────────────────────────────────────────────
describe('GAP-K: AgentTool.steer()', () => {
  it('AgentTool implements WorkerAdapter', () => {
    const t = new AgentTool()
    expect(t.workerKind).toBe('agent')
    expect(typeof t.steer).toBe('function')
  })

  it('queues the instruction for an active run and returns true', async () => {
    const registry = new ExecutionRunRegistry()
    const t = new AgentTool({ factory: (() => ({})) as never, parentConfig: {} as never, parentRenderer: null, runRegistry: registry })
    const run = registry.create({
      kind: 'agent', goal: 'g', workspace: { cwd: '/r' },
    })
    registry.transition(run.runId, 'preparing')
    registry.transition(run.runId, 'running')

    expect(await t.steer(run.runId, 'rethink approach')).toBe(true)
    expect(t._drainSteerQueue(run.runId)).toBe('rethink approach')
    // Drain twice → second drain returns undefined (queue emptied)
    expect(t._drainSteerQueue(run.runId)).toBeUndefined()
  })

  it('returns false for a terminal run', async () => {
    const registry = new ExecutionRunRegistry()
    const t = new AgentTool({ factory: (() => ({})) as never, parentConfig: {} as never, parentRenderer: null, runRegistry: registry })
    const run = registry.create({
      kind: 'agent', goal: 'g', workspace: { cwd: '/r' },
    })
    registry.transition(run.runId, 'preparing')
    registry.transition(run.runId, 'running')
    registry.transition(run.runId, 'succeeded')

    expect(await t.steer(run.runId, 'x')).toBe(false)
  })

  it('invokes the onSteered hook on queue', async () => {
    const registry = new ExecutionRunRegistry()
    const steered: string[] = []
    const t = new AgentTool({
      factory: (() => ({})) as never,
      parentConfig: {} as never,
      parentRenderer: null,
      runRegistry: registry,
      onSteered: (_id, instr) => steered.push(instr),
    })
    const run = registry.create({
      kind: 'agent', goal: 'g', workspace: { cwd: '/r' },
    })
    registry.transition(run.runId, 'preparing')
    registry.transition(run.runId, 'running')
    await t.steer(run.runId, 'go faster')
    expect(steered).toEqual(['go faster'])
  })
})

// ─────────────────────────────────────────────────────────────────────
// Cross-check: WorkerAdapter contract
// ─────────────────────────────────────────────────────────────────────
describe('GAP-K: WorkerAdapter contract', () => {
  it('both adapters can be assigned to a WorkerAdapter variable', () => {
    const a: WorkerAdapter = new ClaudeCodeTool()
    const b: WorkerAdapter = new AgentTool()
    expect(a.workerKind).toBe('claude-code')
    expect(b.workerKind).toBe('agent')
  })
})
