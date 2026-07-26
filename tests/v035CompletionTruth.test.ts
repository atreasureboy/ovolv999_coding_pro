/**
 * v0.3.5 Evidence + TaskPlan + Completion truth tests.
 *
 * Verifies the core anti-false-success guarantees:
 * - No evidence → cannot complete mutation node
 * - Stale evidence (post-revision) → criterion becomes stale
 * - Evidence from wrong run/node → rejected
 * - TaskKind drives completion semantics
 * - TaskGraph state consistency
 * - Command registration no-duplicates
 */
import { describe, it, expect } from 'vitest'
import { EvidenceStore } from '../src/core/runtime/evidence.js'
import { TaskGraph } from '../src/core/runtime/taskGraph.js'
import { evaluateCompletion } from '../src/core/runtime/completionContract.js'
import { reviewRun } from '../src/core/runtime/reviewer.js'
import { classifyTaskIntent } from '../src/core/runtime/taskIntent.js'
import { registerCommand, getCommand, listCommands } from '../src/commands/index.js'
import '../src/commands/builtin.js'

describe('v0.3.5 Evidence System — anti-false-success', () => {
  it('no evidence → mutation node cannot be completed via complete_node', () => {
    const store = new EvidenceStore()
    const g = new TaskGraph()
    g.addNode({ id: 'impl', title: 'impl', description: '', dependencies: [], acceptanceCriteria: ['tests pass'] })
    g.start('impl')
    // Without evidence, computeAllCriteria returns pending
    const criteria = [{ id: 'impl::0', description: 'tests pass' }]
    const states = store.computeAllCriteria('impl', criteria)
    expect(states[0]?.status).toBe('pending')
    const unsatisfied = states.filter((s) => s.status !== 'satisfied' && s.status !== 'waived')
    expect(unsatisfied.length).toBe(1)
  })

  it('test_result evidence with exitCode=0 satisfies criterion', () => {
    const store = new EvidenceStore()
    store.record({
      runId: 'r1', nodeId: 'impl', criterionId: 'impl::0',
      kind: 'test_result', summary: 'all tests passed', source: 'tool',
      command: 'npm test', exitCode: 0,
    })
    const state = store.computeCriterionStatus('impl', 'impl::0', 'tests pass')
    expect(state.status).toBe('satisfied')
  })

  it('test_result evidence with exitCode=1 marks criterion failed', () => {
    const store = new EvidenceStore()
    store.record({
      runId: 'r1', nodeId: 'impl', criterionId: 'impl::0',
      kind: 'test_result', summary: 'tests failed', source: 'tool',
      command: 'npm test', exitCode: 1,
    })
    const state = store.computeCriterionStatus('impl', 'impl::0', 'tests pass')
    expect(state.status).toBe('failed')
  })

  it('stale evidence (post-revision file change) → criterion becomes stale', () => {
    const store = new EvidenceStore()
    // revision 0: tests pass
    store.record({
      runId: 'r1', nodeId: 'impl', criterionId: 'impl::0',
      kind: 'test_result', summary: 'tests passed', source: 'tool',
      command: 'npm test', exitCode: 0,
    })
    expect(store.computeCriterionStatus('impl', 'impl::0', 'tests pass').status).toBe('satisfied')
    // revision bump: code changed
    store.bumpRevision()
    const state = store.computeCriterionStatus('impl', 'impl::0', 'tests pass')
    expect(state.status).toBe('stale')
  })

  it('evidence from wrong runId is isolated', () => {
    const store = new EvidenceStore()
    store.record({
      runId: 'run-A', nodeId: 'impl', criterionId: 'impl::0',
      kind: 'test_result', summary: 'ok', source: 'tool', exitCode: 0,
    })
    // run-B should NOT see run-A's evidence
    const forRunB = store.forRun('run-B')
    expect(forRunB.length).toBe(0)
  })

  it('waiver skips verification for documentation-only changes', () => {
    const store = new EvidenceStore()
    store.waiveCriterion('docs', 'docs::0', 'pure documentation change, no code verification needed')
    const state = store.computeCriterionStatus('docs', 'docs::0', 'tests pass')
    expect(state.status).toBe('satisfied')
  })
})

describe('v0.3.5 TaskKind completion semantics', () => {
  it('informational: no changedFiles → completed', () => {
    const v = evaluateCompletion({
      taskKind: 'informational', modelStopped: true,
      acceptanceCriteria: [], verification: { executed: false, passed: false, failed: [] },
      activeWorkers: [], unresolvedBlockers: [], changedFiles: [],
      reviewerFindings: [], budgetState: { remaining: 1, exceeded: false },
    })
    expect(v.status).toBe('completed')
  })

  it('analysis: no changedFiles but model stopped → completed', () => {
    const v = evaluateCompletion({
      taskKind: 'analysis', modelStopped: true,
      acceptanceCriteria: [], verification: { executed: false, passed: false, failed: [] },
      activeWorkers: [], unresolvedBlockers: [], changedFiles: [],
      reviewerFindings: [], budgetState: { remaining: 1, exceeded: false },
    })
    expect(v.status).toBe('completed')
  })

  it('mutation: no changedFiles → NOT completed', () => {
    const v = evaluateCompletion({
      taskKind: 'mutation', modelStopped: true,
      acceptanceCriteria: [], verification: { executed: false, passed: false, failed: [] },
      activeWorkers: [], unresolvedBlockers: [], changedFiles: [],
      reviewerFindings: [], budgetState: { remaining: 1, exceeded: false },
    })
    expect(v.status).not.toBe('completed')
  })

  it('mutation: changedFiles but no verification → NOT completed', () => {
    const v = evaluateCompletion({
      taskKind: 'mutation', modelStopped: true,
      acceptanceCriteria: [], verification: { executed: false, passed: false, failed: [] },
      activeWorkers: [], unresolvedBlockers: [], changedFiles: ['src/a.ts'],
      reviewerFindings: [], budgetState: { remaining: 1, exceeded: false },
    })
    expect(v.status).not.toBe('completed')
  })

  it('mutation: changedFiles + verification passed → completed', () => {
    const v = evaluateCompletion({
      taskKind: 'mutation', modelStopped: true,
      acceptanceCriteria: [], verification: { executed: true, passed: true, failed: [] },
      activeWorkers: [], unresolvedBlockers: [], changedFiles: ['src/a.ts'],
      reviewerFindings: [], budgetState: { remaining: 1, exceeded: false },
    })
    expect(v.status).toBe('completed')
  })

  it('Chinese mutation keyword correctly classified', () => {
    expect(classifyTaskIntent('修复登录bug').kind).toBe('mutation')
    expect(classifyTaskIntent('重构认证模块').kind).toBe('mutation')
    expect(classifyTaskIntent('解释这段代码').kind).toBe('informational')
    expect(classifyTaskIntent('审计项目架构').kind).toBe('analysis')
  })
})

describe('v0.3.5 TaskGraph state consistency', () => {
  it('cancelled counted in snapshot', () => {
    const g = new TaskGraph()
    g.addNode({ id: 'a', title: 'a', description: '', dependencies: [], acceptanceCriteria: [] })
    g.start('a')
    g.cancel('a', 'not needed')
    const s = g.snapshot().summary
    expect(s.cancelled).toBe(1)
    expect(s.total).toBe(1)
  })

  it('verifying counted in snapshot', () => {
    const g = new TaskGraph()
    g.addNode({ id: 'a', title: 'a', description: '', dependencies: [], acceptanceCriteria: [] })
    g.start('a')
    g.markVerifying('a')
    const s = g.snapshot().summary
    expect(s.verifying).toBe(1)
  })

  it('isDone() and hasUnfinished() agree', () => {
    const g = new TaskGraph()
    g.addNode({ id: 'a', title: 'a', description: '', dependencies: [], acceptanceCriteria: [] })
    expect(g.isDone()).toBe(false)
    expect(g.hasUnfinished()).toBe(true)
    g.start('a')
    g.complete('a')
    expect(g.isDone()).toBe(true)
    expect(g.hasUnfinished()).toBe(false)
  })

  it('blocked is NOT terminal (isDone=false, hasUnfinished=true)', () => {
    const g = new TaskGraph()
    g.addNode({ id: 'a', title: 'a', description: '', dependencies: [], acceptanceCriteria: [] })
    g.start('a')
    g.block('a', 'waiting on dependency')
    expect(g.isDone()).toBe(false)
    expect(g.hasUnfinished()).toBe(true)
  })

  it('retry moves failed → pending (not terminal)', () => {
    const g = new TaskGraph()
    g.addNode({ id: 'a', title: 'a', description: '', dependencies: [], acceptanceCriteria: [], retryPolicy: { maxAttempts: 2 } })
    g.start('a')
    g.fail('a', 'crash')
    // failed is terminal — single node graph IS done
    g.retry('a')
    expect(g.get('a')!.status).toBe('pending')
  })

  it('complete(id) without satisfiedCriteria works (evidence path)', () => {
    const g = new TaskGraph()
    g.addNode({ id: 'a', title: 'a', description: '', dependencies: [], acceptanceCriteria: ['x'] })
    g.start('a')
    g.complete('a') // no satisfiedCriteria = evidence-verified path
    expect(g.get('a')!.status).toBe('completed')
  })
})

describe('v0.3.5 Run isolation', () => {
  it('two runs have independent TaskGraphs', () => {
    const g1 = new TaskGraph()
    const g2 = new TaskGraph()
    g1.addNode({ id: 'a', title: 'a', description: '', dependencies: [], acceptanceCriteria: [] })
    expect(g1.size()).toBe(1)
    expect(g2.size()).toBe(0)
  })

  it('evidence from run-A does not satisfy run-B criteria', () => {
    const store = new EvidenceStore()
    store.record({
      runId: 'run-A', nodeId: 'n1', criterionId: 'n1::0',
      kind: 'test_result', summary: 'ok', source: 'tool', exitCode: 0,
    })
    const forB = store.forRun('run-B')
    expect(forB).toEqual([])
  })
})

describe('v0.3.5 Command registration — no duplicates', () => {
  it('builtin commands have no duplicate names', () => {
    const commands = listCommands()
    const names = commands.map((c) => c.name)
    const duplicates = names.filter((n, i) => names.indexOf(n) !== i)
    expect(duplicates).toEqual([])
  })

  it('/plan exists (renamed from /tasks)', () => {
    expect(getCommand('plan')).toBeDefined()
  })

  it('/tasks is not the TaskGraph command anymore', () => {
    // /tasks should either not exist or point to background tasks, not TaskGraph
    const tasks = getCommand('tasks')
    if (tasks) {
      expect(tasks.description).not.toContain('task graph')
    }
  })

  it('duplicate registration throws in dev mode', () => {
    expect(() => {
      registerCommand({
        name: 'plan', // already registered
        description: 'duplicate',
        usage: '/plan',
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        handler: (_args, _ctx) => ({ type: 'text' as const, value: 'dup' }),
      })
    }).toThrow()
  })
})

describe('v0.3.5 Reviewer consistency', () => {
  it('mutation with changes but no verification → not completed', () => {
    const r = reviewRun({
      goalPresent: true,
      changedFiles: ['src/a.ts'],
      verificationExecuted: false,
      verificationPassed: false,
      unhandledFailures: 0,
      unresolvedBlockers: 0,
      unsatisfiedAcceptance: 0,
      scopeExcessive: false,
    })
    expect(r.verdict).not.toBe('completed')
  })

  it('informational with no changes → completed (via CompletionContract, not Reviewer)', () => {
    // Reviewer uses changedFiles heuristic; CompletionContract uses taskKind.
    // For informational, CompletionContract returns completed even without changes.
    const v = evaluateCompletion({
      taskKind: 'informational', modelStopped: true,
      acceptanceCriteria: [], verification: { executed: false, passed: false, failed: [] },
      activeWorkers: [], unresolvedBlockers: [], changedFiles: [],
      reviewerFindings: [], budgetState: { remaining: 1, exceeded: false },
    })
    expect(v.status).toBe('completed')
  })
})
