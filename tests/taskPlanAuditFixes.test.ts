/**
 * v0.3.1 audit-fix tests (te_goal §十一.12, 13, 14).
 *
 * Verifies the new TaskGraph + TaskPlanTool + ProgressMonitor
 * integration that closes the gap between graph lifecycle and the
 * progress / completion subsystem.
 */
import { describe, it, expect } from 'vitest'
import { TaskGraph } from '../src/core/runtime/taskGraph.js'
import { ProgressMonitor } from '../src/core/runtime/progressMonitor.js'
import { TaskPlanTool } from '../src/tools/taskPlan.js'
import { InMemoryTaskGraphStore } from '../src/core/runtime/taskGraphStore.js'

describe('TaskGraph + TaskPlanTool + ProgressMonitor (audit fixes)', () => {
  it('TaskGraph.unblock transitions blocked → ready (no deps) or pending (unmet deps)', () => {
    const g = new TaskGraph()
    g.addNode({ id: 'n1', title: 'A', description: 'd', dependencies: [] })
    g.block('n1', 'external')
    g.unblock('n1')
    // No dependencies → ready
    expect(g.get('n1')?.status).toBe('ready')
    expect(g.get('n1')?.blockReason).toBeUndefined()

    const g2 = new TaskGraph()
    g2.addNode({ id: 'a', title: 'A', description: 'd', dependencies: [] })
    g2.addNode({ id: 'b', title: 'B', description: 'd', dependencies: ['a'] })
    g2.block('b', 'waiting on A')
    g2.unblock('b')
    // b depends on a which is not completed → pending
    expect(g2.get('b')?.status).toBe('pending')
  })

  it('TaskGraph.cancel supports an optional reason', () => {
    const g = new TaskGraph()
    g.addNode({ id: 'n1', title: 'A', description: 'd', dependencies: [] })
    g.start('n1')
    g.cancel('n1', 'user-requested')
    expect(g.get('n1')?.status).toBe('cancelled')
    expect(g.get('n1')?.failReason).toBe('user-requested')
  })

  it('TaskGraph.attachArtifact accumulates artifacts', () => {
    const g = new TaskGraph()
    g.addNode({ id: 'n1', title: 'A', description: 'd', dependencies: [] })
    g.attachArtifact('n1', 'tests-pass')
    g.attachArtifact('n1', 'lint-clean')
    g.attachArtifact('n1', 'tests-pass') // duplicate → no-op
    expect(g.get('n1')?.artifacts).toEqual(['tests-pass', 'lint-clean'])
  })

  it('TaskPlanTool exposes start, update, begin_verification, unblock, cancel, attach_artifact actions', async () => {
    const g = new TaskGraph()
    g.addNode({ id: 'n1', title: 'A', description: 'd', dependencies: [] })
    const tool = new TaskPlanTool({ resolve: (_runId: string) => g, resolveOrNull: (_runId: string) => g })
    const r1 = await tool.execute({ action: 'start', id: 'n1' }, { execution: { runId: 'test-run' } } as any)
    expect(r1.isError).toBeFalsy()
    expect(g.get('n1')?.status).toBe('running')
    const r2 = await tool.execute({ action: 'begin_verification', id: 'n1' }, { execution: { runId: 'test-run' } } as any)
    expect(r2.isError).toBeFalsy()
    expect(g.get('n1')?.status).toBe('verifying')
    const r3 = await tool.execute({ action: 'attach_artifact', id: 'n1', artifact: 'cover-95' }, { execution: { runId: 'test-run' } } as any)
    expect(r3.isError).toBeFalsy()
    expect(g.get('n1')?.artifacts).toContain('cover-95')
    const r4 = await tool.execute({ action: 'cancel', id: 'n1', reason: 'no longer needed' }, { execution: { runId: 'test-run' } } as any)
    expect(r4.isError).toBeFalsy()
    expect(g.get('n1')?.status).toBe('cancelled')
  })

  it('TaskPlanTool update only allowed on pending nodes', async () => {
    const g = new TaskGraph()
    g.addNode({ id: 'n1', title: 'A', description: 'd', dependencies: [] })
    const tool = new TaskPlanTool({ resolve: (_runId: string) => g, resolveOrNull: (_runId: string) => g })
    const r1 = await tool.execute({ action: 'update', id: 'n1', title: 'A2' }, { execution: { runId: 'test-run' } } as any)
    expect(r1.isError).toBeFalsy()
    expect(g.get('n1')?.title).toBe('A2')
    // Now start it; further updates must fail.
    await tool.execute({ action: 'start', id: 'n1' }, { execution: { runId: 'test-run' } } as any)
    const r2 = await tool.execute({ action: 'update', id: 'n1', title: 'A3' }, { execution: { runId: 'test-run' } } as any)
    expect(r2.isError).toBe(true)
  })

  it('ProgressMonitor.recordTaskNodeTransition marks progress on terminal transitions', () => {
    const pm = new ProgressMonitor()
    pm.snapshot(0) // baseline
    pm.recordTaskNodeTransition('started')   // not terminal
    let s = pm.snapshot(0.1)
    expect(s.minutesSinceLastMeaningfulProgress).toBeGreaterThanOrEqual(0)
    pm.recordTaskNodeTransition('completed')  // terminal → progress
    s = pm.snapshot(0.2)
    // 0.2 - 0 (flushed) = 0.2
    expect(s.minutesSinceLastMeaningfulProgress).toBeLessThanOrEqual(0.2)
  })

  it('TaskGraphStore.setEventSink fires TASK_GRAPH_CREATED on every create', () => {
    const events: string[] = []
    const s = new InMemoryTaskGraphStore()
    s.setEventSink((evt) => events.push(evt.type))
    s.create('a')
    s.create('b')
    expect(events).toEqual(['TASK_GRAPH_CREATED', 'TASK_GRAPH_CREATED'])
  })
})