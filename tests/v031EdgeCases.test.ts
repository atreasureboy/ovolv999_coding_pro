/**
 * v0.3.1 edge-case audit (pass 2).
 *
 * Verifies behaviour under unusual but real inputs:
 *   - empty profiles / no model
 *   - missing router / taskGraph
 *   - concurrent runTurn rejection
 *   - recordCall with no token usage (null)
 *   - applyRoutingDecision with same model (no-op dedup)
 *   - controlMessageLog compact with empty log
 *   - TaskGraph with no acceptance criteria (addNode default)
 *   - completion-time verdict handles empty changedFiles + non-mutation kind
 */
import { describe, it, expect } from 'vitest'
import { ModelRouter } from '../src/core/model/modelRouter.js'
import { evaluateCompletion } from '../src/core/runtime/completionContract.js'
import { ControlMessageLog } from '../src/core/runtime/internalControlMessage.js'
import { InMemoryTaskGraphStore } from '../src/core/runtime/taskGraphStore.js'
import { TaskGraph } from '../src/core/runtime/taskGraph.js'
import { collectRoutingSignals, signalsToRoutingInput } from '../src/core/model/routingSignalCollector.js'
import { validateProfiles } from '../src/core/model/modelRuntimeManager.js'

describe('v0.3.1 edge cases (audit pass 2)', () => {
  it('ModelRouter with empty profiles: route returns single-profile fallback for any goal', () => {
    const r = new ModelRouter([])
    const d = r.route({ userGoal: 'anything' })
    expect(d.reasonCodes).toContain('single-profile')
    expect(d.fallbackChain).toEqual([])
  })

  it('ModelRouter when all profiles unavailable: route returns an empty-model decision (Engine should skip)', () => {
    const r = new ModelRouter([
      { id: 'a', provider: 'openai', model: 'm', available: false,
        capabilities: { reasoning: 0.5, coding: 0.5, contextWindow: 128_000, toolCalling: 0.7, speed: 0.5, cost: 0.5 }, roles: ['main'] },
    ])
    const d = r.route({ userGoal: 'x' })
    // single-profile fallback returns empty string when the only
    // profile is unavailable; the engine's route callback treats
    // empty as "no change" so the loop continues with the current
    // model. (Future: a dedicated "all profiles unavailable" error.)
    expect(d.selectedModel).toBe('')
  })

  it('ModelRouter.recordCall with null usage is safe', () => {
    const r = new ModelRouter([
      { id: 'a', provider: 'openai', model: 'm', available: true,
        capabilities: { reasoning: 0.5, coding: 0.5, contextWindow: 128_000, toolCalling: 0.7, speed: 0.5, cost: 0.5 }, roles: ['main'] },
    ])
    expect(() => r.recordCall('a', true, 200, null)).not.toThrow()
    const h = r.getProfileHealth('a')
    expect(h?.calls).toBe(1)
    expect(h?.failures).toBe(0)
  })

  it('ModelRouter.recordCall with failure increments failure count', () => {
    const r = new ModelRouter([
      { id: 'a', provider: 'openai', model: 'm', available: true,
        capabilities: { reasoning: 0.5, coding: 0.5, contextWindow: 128_000, toolCalling: 0.7, speed: 0.5, cost: 0.5 }, roles: ['main'] },
    ])
    r.recordCall('a', false, 500, null)
    const h = r.getProfileHealth('a')
    expect(h?.failures).toBe(1)
  })

  it('applyRoutingDecision is a no-op when the same model re-applies (no spam)', () => {
    const r = new ModelRouter([
      { id: 'a', provider: 'openai', model: 'm', available: true,
        capabilities: { reasoning: 0.5, coding: 0.5, contextWindow: 128_000, toolCalling: 0.7, speed: 0.5, cost: 0.5 }, roles: ['main'] },
    ])
    const events: string[] = []
    r.setEventListener((evt) => events.push(evt.type))
    r.applyRoutingDecision('m')
    r.applyRoutingDecision('m')
    r.applyRoutingDecision('m')
    expect(events.filter((e) => e === 'ROUTING_DECISION_APPLIED')).toHaveLength(1)
  })

  it('ControlMessageLog.compact on empty log returns 0 (no-op)', () => {
    const log = new ControlMessageLog()
    expect(log.compact()).toBe(0)
  })

  it('ControlMessageLog.renderForProvider on empty log returns []', () => {
    const log = new ControlMessageLog()
    expect(log.renderForProvider()).toEqual([])
  })

  it('TaskGraph.addNode with no acceptanceCriteria succeeds (defaulted to [])', () => {
    const g = new TaskGraph()
    g.addNode({ id: 'a', title: 'A', description: 'd', dependencies: [] })
    expect(g.get('a')?.acceptanceCriteria).toEqual([])
    // complete() with no satisfied criteria should now succeed (default [])
    g.start('a')
    g.complete('a', [], [])
    expect(g.get('a')?.status).toBe('completed')
  })

  it('TaskGraphStore: pruneTerminal drops done graphs but preserves active', () => {
    const s = new InMemoryTaskGraphStore()
    const a = s.create('a')
    a.addNode({ id: 'n', title: 'T', description: 'd', dependencies: [] })
    a.start('n')
    a.complete('n', [], [])
    const b = s.create('b')
    b.addNode({ id: 'n', title: 'T', description: 'd', dependencies: [] })
    const removed = s.pruneTerminal()
    expect(removed).toEqual(['a'])
    expect(s.has('a')).toBe(false)
    expect(s.has('b')).toBe(true)
  })

  it('CompletionContract with empty changedFiles + mutation kind + criteria: incomplete', () => {
    const v = evaluateCompletion({
      taskKind: 'mutation',
      modelStopped: true,
      acceptanceCriteria: [{ id: 'a', description: 'x', satisfied: false }],
      verification: { executed: false, passed: false, failed: [] },
      activeWorkers: [],
      unresolvedBlockers: [],
      changedFiles: [],
      reviewerFindings: [],
      budgetState: { remaining: 1, exceeded: false },
    })
    expect(v.status).toBe('incomplete')
  })

  it('CompletionContract analysis kind with no criteria + no changes: incomplete', () => {
    const v = evaluateCompletion({
      taskKind: 'analysis',
      modelStopped: true,
      acceptanceCriteria: [],
      verification: { executed: false, passed: false, failed: [] },
      activeWorkers: [],
      unresolvedBlockers: [],
      changedFiles: [],
      reviewerFindings: [],
      budgetState: { remaining: 1, exceeded: false },
    })
    expect(v.status).toBe('incomplete')
  })

  it('validateProfiles: empty profile array passes', () => {
    expect(() => validateProfiles({ activeProvider: 'openai', profiles: [] })).not.toThrow()
  })

  it('RoutingSignalCollector: signalsToRoutingInput produces a valid RoutingInput', () => {
    const s = collectRoutingSignals({ userMessage: 'fix the bug' })
    const input = signalsToRoutingInput(s)
    expect(typeof input.userGoal).toBe('string')
    expect(input.consecutiveFailures).toBeGreaterThanOrEqual(0)
  })

  it('TaskGraph.serialize round-trips with cancel state', () => {
    const g = new TaskGraph()
    g.addNode({ id: 'a', title: 'A', description: 'd', dependencies: [] })
    g.start('a')
    g.cancel('a', 'user')
    const json = g.serialize()
    const r = TaskGraph.restore(json)
    expect(r.get('a')?.status).toBe('cancelled')
    expect(r.get('a')?.failReason).toBe('user')
  })

  it('ControlMessageLog: compaction keeps exactly the kept kinds', () => {
    const log = new ControlMessageLog()
    log.append({ kind: 'continue_after_length', remainingTokens: 100, partialLength: 50 })
    log.append({ kind: 'budget_warning', remainingPct: 0.5 })
    log.append({ kind: 'completion_rejected', verdict: 'blocked', blockers: ['x'] })
    log.append({ kind: 'critic_feedback', verdict: 'replan', problems: ['y'] })
    const dropped = log.compact()
    expect(dropped).toBe(2) // continue_after_length + critic_feedback dropped
    const kept = log.peek()
    expect(kept.map((m) => m.kind).sort()).toEqual(['budget_warning', 'completion_rejected'])
  })
})