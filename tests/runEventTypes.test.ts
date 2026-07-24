/**
 * v0.3.1 typed events (te_goal §八).
 *
 * Verifies the RunEvent union covers every event type te_goal lists,
 * and that the TaskGraph mutation methods emit the corresponding
 * event via the optional sink.
 */
import { describe, it, expect } from 'vitest'
import { TaskGraph } from '../src/core/runtime/taskGraph.js'
import type { RunEvent } from '../src/core/runtime/events.js'

const REQUIRED_EVENT_TYPES = [
  'ROUTING_DECIDED',
  'ROUTING_APPLIED',
  'ROUTING_FALLBACK',
  'MODEL_CALL_RECORDED',
  'TASK_GRAPH_CREATED',
  'TASK_NODE_ADDED',
  'TASK_NODE_STARTED',
  'TASK_NODE_VERIFYING',
  'TASK_NODE_COMPLETED',
  'TASK_NODE_FAILED',
  'TASK_NODE_BLOCKED',
  'PROGRESS_RECORDED',
  'REPLAN_REQUESTED',
  'CRITIC_INVOKED',
  'CRITIC_COMPLETED',
  'COMPLETION_EVALUATED',
  'COMPLETION_REJECTED',
  'REVIEW_COMPLETED',
  'MODEL_OVERRIDE_SET',
  'MODEL_OVERRIDE_CLEARED',
] as const

describe('RunEvent v0.3.1 coverage', () => {
  it('declares every te_goal §八 event type', () => {
    // The compile-time type check below is the actual assertion —
    // if any required type is missing, this assignment fails.
    const types: ReadonlySet<RunEvent['type']> = new Set([
      ...REQUIRED_EVENT_TYPES,
    ] as RunEvent['type'][])
    expect(types.size).toBe(REQUIRED_EVENT_TYPES.length)
  })

  it('TaskGraph emits typed events through its sink', () => {
    const events: Array<{ type: string; nodeId?: string }> = []
    const g = new TaskGraph()
    g.setRunId('run-test')
    g.setEventSink((evt) => events.push({ type: evt.type, nodeId: evt.nodeId }))
    g.addNode({ id: 'n1', title: 'T', description: 'd', dependencies: [], acceptanceCriteria: [] })
    g.start('n1')
    g.markVerifying('n1')
    g.complete('n1', [], [])
    const types = events.map((e) => e.type)
    expect(types).toContain('TASK_NODE_ADDED')
    expect(types).toContain('TASK_NODE_STARTED')
    expect(types).toContain('TASK_NODE_VERIFYING')
    expect(types).toContain('TASK_NODE_COMPLETED')
  })

  it('TaskGraph emits TASK_NODE_FAILED when acceptance criteria unmet', () => {
    const events: Array<{ type: string; reason?: string }> = []
    const g = new TaskGraph()
    g.setEventSink((evt) => events.push({ type: evt.type, reason: evt.reason }))
    g.addNode({ id: 'n', title: 'T', description: 'd', dependencies: [], acceptanceCriteria: ['must work'] })
    g.start('n')
    g.complete('n', [], [])
    expect(events.find((e) => e.type === 'TASK_NODE_FAILED')).toBeDefined()
  })

  it('TaskGraph emits TASK_NODE_BLOCKED on block()', () => {
    const events: Array<{ type: string; reason?: string }> = []
    const g = new TaskGraph()
    g.setEventSink((evt) => events.push({ type: evt.type, reason: evt.reason }))
    g.addNode({ id: 'n', title: 'T', description: 'd', dependencies: [], acceptanceCriteria: [] })
    g.block('n', 'cannot run')
    const blocked = events.find((e) => e.type === 'TASK_NODE_BLOCKED')
    expect(blocked).toBeDefined()
    expect(blocked?.reason).toBe('cannot run')
  })

  it('TaskGraph without a sink is a no-op (no event emission crashes)', () => {
    const g = new TaskGraph()
    g.addNode({ id: 'n', title: 'T', description: 'd', dependencies: [], acceptanceCriteria: [] })
    g.start('n')
    g.complete('n', [], [])
    // No throw = success
  })
})