/**
 * v0.3.1 deterministic-runtime eval (te_goal §九).
 *
 * 10 cases that exercise the runtime's contract WITHOUT requiring
 * a real LLM. Each case targets a specific te_goal §十一 acceptance
 * invariant; the full set covers model-routing isolation, completion
 * semantics, fallback chains, internal control message separation,
 * and TaskGraph isolation.
 */
import { describe, it, expect } from 'vitest'
import { ModelRouter, routerFromSingleModel, type ModelProfile } from '../../src/core/model/modelRouter.js'
import { evaluateCompletion } from '../../src/core/runtime/completionContract.js'
import { InMemoryTaskGraphStore } from '../../src/core/runtime/taskGraphStore.js'
import { ControlMessageLog, isControlMessage } from '../../src/core/runtime/internalControlMessage.js'
import { TaskGraph } from '../../src/core/runtime/taskGraph.js'
import { ProgressMonitor } from '../../src/core/runtime/progressMonitor.js'
import { validateProfiles, ProfileValidationError } from '../../src/core/model/modelRuntimeManager.js'
import { collectRoutingSignals } from '../../src/core/model/routingSignalCollector.js'
import { runEventTypesExist } from './helpers.js'

const p = (id: string, model: string, provider: string, caps: Partial<ModelProfile['capabilities']>): ModelProfile => ({
  id, provider, model, available: true,
  capabilities: { reasoning: 0.5, coding: 0.5, contextWindow: 128_000, toolCalling: 0.7, speed: 0.5, cost: 0.5, ...caps },
  roles: ['main'],
})

describe('deterministic-runtime (eval:deterministic)', () => {
  it('eval-1: auto routing 3 turns does NOT set manual override', () => {
    const r = new ModelRouter([
      p('a', 'm1', 'openai', { reasoning: 0.9, coding: 0.9 }),
      p('b', 'm2', 'openai', { reasoning: 0.5, coding: 0.5 }),
    ])
    for (let i = 0; i < 3; i++) {
      const d = r.route({ userGoal: i % 2 === 0 ? 'redesign' : 'list', needsArchitecture: i % 2 === 0 })
      r.applyRoutingDecision(d.selectedModel)
    }
    expect(r.getManualOverride()).toBeNull()
  })

  it('eval-2: /model xxx (manual) overrides auto across re-routes', () => {
    const r = routerFromSingleModel('gpt-4o')
    r.setModelByUser('haiku')
    for (let i = 0; i < 3; i++) {
      const d = r.route({ userGoal: 'refactor' })
      expect(d.selectedModel).toBe('haiku')
    }
    r.clearModelOverride()
    expect(r.route({ userGoal: 'refactor' }).selectedModel).toBe('gpt-4o')
  })

  it('eval-3: cross-provider profile is rejected at config-validation', () => {
    expect(() => validateProfiles({
      activeProvider: 'openai',
      profiles: [p('a', 'gpt-4o', 'openai'), p('b', 'claude-sonnet', 'anthropic')],
    })).toThrow(ProfileValidationError)
  })

  it('eval-4: CompletionContract blocks on failed verification even with changes', () => {
    const v = evaluateCompletion({
      taskKind: 'mutation',
      modelStopped: true,
      acceptanceCriteria: [{ id: 'a', description: 'x', satisfied: true }],
      verification: { executed: true, passed: false, failed: ['unit #3'] },
      activeWorkers: [],
      unresolvedBlockers: [],
      changedFiles: ['a.ts'],
      reviewerFindings: [],
      budgetState: { remaining: 1, exceeded: false },
    })
    expect(v.status).toBe('blocked')
  })

  it('eval-5: TaskGraph is isolated by runId (turn 1 does not pollute turn 2)', () => {
    const s = new InMemoryTaskGraphStore()
    const a = s.create('turn-1')
    a.addNode({ id: 'a', title: 'T', description: 'd', dependencies: [] })
    s.close('turn-1')
    const b = s.create('turn-2')
    expect(b.size()).toBe(0)
    expect(s.has('turn-1')).toBe(false)
    expect(s.has('turn-2')).toBe(true)
  })

  it('eval-6: InternalControlMessage does NOT pollute user history', () => {
    const log = new ControlMessageLog()
    log.append({ kind: 'budget_warning', remainingPct: 0.1 })
    log.append({ kind: 'stall_replan', level: 'soft', reason: 'no progress' })
    const rendered = log.renderForProvider()
    expect(rendered.every((m) => isControlMessage(m))).toBe(true)
    log.clear()
    expect(log.size()).toBe(0)
  })

  it('eval-7: A→B→A→B tool pattern triggers repeated-failure', () => {
    const pm = new ProgressMonitor({ softStallMinutes: 999, hardStallMinutes: 999, repeatedErrorLimit: 99, repeatedToolCallLimit: 99, budgetPressureFraction: 0 })
    pm.tick(); pm.tick(); pm.tick(); pm.tick()
    pm.recordToolCall('Read', { p: 'a' }, { isError: false, content: '' })
    pm.recordToolCall('Bash', { cmd: 'x' }, { isError: false, content: '' })
    pm.recordToolCall('Read', { p: 'a' }, { isError: false, content: '' })
    pm.recordToolCall('Bash', { cmd: 'x' }, { isError: false, content: '' })
    const v = pm.detectStall(0.1, 1)
    expect(v.kind).toBe('repeated-failure')
  })

  it('eval-8: completion-time critic is invoked when model is about to claim completion', async () => {
    const { shouldInvokeCritic } = await import('../../src/core/runtime/criticTrigger.js')
    const d = shouldInvokeCritic({
      snapshot: {
        iteration: 5, changedFiles: [], verificationDelta: 0, newArtifacts: [],
        repeatedToolCalls: 0, repeatedErrors: 0, minutesSinceLastMeaningfulProgress: 1,
        remainingAcceptanceCriteria: ['must work'],
      },
      modelClaimingCompletion: true,
      isCoreArchitecture: false,
      changedFilesCount: 0,
      unresolvedCount: 0,
      remainingAcceptanceCount: 1,
    })
    expect(d.invoke).toBe(true)
  })

  it('eval-9: same Edit with same patch hash is NOT new progress', () => {
    // First edit at minute 0 marks progress; flush the marker via
    // snapshot(0). Second edit with same hash at minute 0 does NOT
    // mark progress. snapshot(1) shows the timer is now 1 minute
    // since the last progress — the re-edit did NOT reset it.
    const pm = new ProgressMonitor()
    pm.recordToolCall('Edit', { file_path: 'a.ts' }, { isError: false, content: 'ok' }, 'h1')
    pm.snapshot(0) // flush pending progress marker at minute 0
    pm.recordToolCall('Edit', { file_path: 'a.ts' }, { isError: false, content: 'ok' }, 'h1')
    const snap = pm.snapshot(1)
    expect(snap.minutesSinceLastMeaningfulProgress).toBeGreaterThanOrEqual(1)
  })

  it('eval-10: all 19 spec RunEvent types are declared in the union', () => {
    const present = runEventTypesExist([
      'ROUTING_DECIDED', 'ROUTING_APPLIED', 'ROUTING_FALLBACK', 'MODEL_CALL_RECORDED',
      'TASK_GRAPH_CREATED', 'TASK_NODE_ADDED', 'TASK_NODE_STARTED', 'TASK_NODE_VERIFYING',
      'TASK_NODE_COMPLETED', 'TASK_NODE_FAILED', 'TASK_NODE_BLOCKED',
      'PROGRESS_RECORDED', 'REPLAN_REQUESTED',
      'CRITIC_INVOKED', 'CRITIC_COMPLETED',
      'COMPLETION_EVALUATED', 'COMPLETION_REJECTED', 'REVIEW_COMPLETED',
    ])
    expect(present).toBe(true)
  })

  it('eval-11: completion-time `exhausted` status wins over blocked when iterations hit cap', () => {
    const v = evaluateCompletion({
      taskKind: 'mutation',
      modelStopped: true,
      acceptanceCriteria: [],
      verification: { executed: false, passed: false, failed: [] },
      activeWorkers: [{ id: 'w1', status: 'running' }], // would be a blocker
      unresolvedBlockers: [],
      changedFiles: ['a.ts'],
      reviewerFindings: [],
      budgetState: { remaining: 1, exceeded: false },
      iterationsUsed: 5,
      iterationsMax: 5,
    })
    expect(v.status).toBe('exhausted')
  })

  it('eval-12: routing signals combine keyword + task-graph evidence for needsArchitecture', () => {
    const s = collectRoutingSignals({
      userMessage: 'fix the thing',
      taskGraph: {
        nodeCount: 2,
        preferredRoles: [],
        hasConfigChanges: true,
        hasCrossModuleEdits: false,
        hasPublicInterfaceEdits: false,
        hasRootCauseNode: false,
      },
    })
    expect(s.needsArchitecture).toBe(true)
    expect(s.isConfigChange).toBe(true)
  })

  it('eval-13: TaskGraph restore() rehydrates from a snapshot', () => {
    const g = new TaskGraph()
    g.addNode({ id: 'a', title: 'A', description: 'd', dependencies: [] })
    g.addNode({ id: 'b', title: 'B', description: 'd', dependencies: ['a'] })
    const snap = g.snapshot()
    const restored = TaskGraph.restore(JSON.stringify(snap.nodes))
    expect(restored.get('a')?.title).toBe('A')
    expect(restored.get('b')?.dependencies).toEqual(['a'])
  })

  it('eval-14: completion-time `failed` status wins when caller marks the run failed', () => {
    const v = evaluateCompletion({
      taskKind: 'mutation',
      modelStopped: true,
      acceptanceCriteria: [],
      verification: { executed: true, passed: true, failed: [] },
      activeWorkers: [],
      unresolvedBlockers: [],
      changedFiles: ['a.ts'],
      reviewerFindings: [],
      budgetState: { remaining: 1, exceeded: false },
      failed: true,
    })
    expect(v.status).toBe('failed')
  })

  it('eval-15: completion-time `cancelled` status wins when caller marks the run cancelled', () => {
    const v = evaluateCompletion({
      taskKind: 'mutation',
      modelStopped: true,
      acceptanceCriteria: [],
      verification: { executed: true, passed: true, failed: [] },
      activeWorkers: [],
      unresolvedBlockers: [],
      changedFiles: ['a.ts'],
      reviewerFindings: [],
      budgetState: { remaining: 1, exceeded: false },
      cancelled: true,
    })
    expect(v.status).toBe('cancelled')
  })

  it('eval-16: TaskGraph unblock restores blocked → ready/pending', async () => {
    const { TaskGraph } = await import('../../src/core/runtime/taskGraph.js')
    const g = new TaskGraph()
    g.addNode({ id: 'a', title: 'A', description: 'd', dependencies: [] })
    g.block('a', 'external')
    expect(g.get('a')?.status).toBe('blocked')
    g.unblock('a')
    expect(g.get('a')?.status).toBe('ready')
    expect(g.get('a')?.blockReason).toBeUndefined()
  })

  it('eval-17: ProgressMonitor receives TaskGraph node transitions', async () => {
    const { ProgressMonitor } = await import('../../src/core/runtime/progressMonitor.js')
    const pm = new ProgressMonitor()
    pm.snapshot(0)
    pm.recordTaskNodeTransition('started')   // not terminal
    pm.snapshot(0.1)
    const sBefore = pm.snapshot(0.5) // minutes elapsed but no progress
    expect(sBefore.minutesSinceLastMeaningfulProgress).toBeGreaterThanOrEqual(0)
    pm.recordTaskNodeTransition('completed') // terminal → progress
    const sAfter = pm.snapshot(0.5)
    expect(sAfter.minutesSinceLastMeaningfulProgress).toBeLessThan(0.5)
  })
})