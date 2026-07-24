/**
 * v0.3.1 TaskGraphStore (te_goal §五).
 *
 * Verifies:
 *   - create / get / restore / close / list / has
 *   - per-runId isolation: turn 1's nodes do NOT pollute turn 2
 *   - close(runA) does NOT affect runB
 *   - restore(runId, snapshot) rehydrates a graph from a snapshot
 *   - pruneTerminal drops graphs whose nodes are all terminal
 */
import { describe, it, expect } from 'vitest'
import { InMemoryTaskGraphStore } from '../src/core/runtime/taskGraphStore.js'
import { TaskGraph } from '../src/core/runtime/taskGraph.js'

describe('TaskGraphStore v0.3.1', () => {
  it('creates and retrieves a per-runId graph', () => {
    const s = new InMemoryTaskGraphStore()
    const a = s.create('run-a')
    a.addNode({ id: 'n1', title: 'A1', description: 'desc', dependencies: [] })
    expect(s.get('run-a')).toBe(a)
    expect(s.has('run-b')).toBe(false)
    expect(s.list()).toEqual(['run-a'])
  })

  it('rejects duplicate create on the same runId', () => {
    const s = new InMemoryTaskGraphStore()
    s.create('run-a')
    expect(() => s.create('run-a')).toThrow(/already exists/)
  })

  it('isolates graphs across runIds', () => {
    const s = new InMemoryTaskGraphStore()
    const a = s.create('run-a')
    const b = s.create('run-b')
    a.addNode({ id: 'na', title: 'A', description: 'x', dependencies: [] })
    b.addNode({ id: 'nb', title: 'B', description: 'y', dependencies: [] })
    expect(a.list().map((n) => n.id)).toEqual(['na'])
    expect(b.list().map((n) => n.id)).toEqual(['nb'])
  })

  it('close(runA) does not affect runB', () => {
    const s = new InMemoryTaskGraphStore()
    s.create('run-a')
    s.create('run-b')
    s.close('run-a')
    expect(s.has('run-a')).toBe(false)
    expect(s.has('run-b')).toBe(true)
  })

  it('restore rehydrates a graph from a snapshot', () => {
    const s = new InMemoryTaskGraphStore()
    const original = new TaskGraph()
    original.addNode({ id: 'n1', title: 'task', description: 'd', dependencies: [] })
    original.addNode({ id: 'n2', title: 'task2', description: 'd2', dependencies: ['n1'] })
    const snap = original.snapshot()
    const restored = s.restore('run-x', snap)
    expect(restored.size()).toBe(2)
    expect(restored.get('n1')?.title).toBe('task')
    expect(restored.get('n2')?.dependencies).toEqual(['n1'])
  })

  it('pruneTerminal drops done graphs but keeps active ones', () => {
    const s = new InMemoryTaskGraphStore()
    const a = s.create('run-a')
    a.addNode({ id: 'n', title: 't', description: 'd', dependencies: [] })
    a.start('n')
    a.complete('n', [], [])
    expect(a.isDone()).toBe(true)
    const b = s.create('run-b')
    b.addNode({ id: 'n', title: 't', description: 'd', dependencies: [] })
    // b's node is pending, not terminal
    const removed = s.pruneTerminal()
    expect(removed).toEqual(['run-a'])
    expect(s.has('run-a')).toBe(false)
    expect(s.has('run-b')).toBe(true)
  })

  it('list returns runIds in insertion order', () => {
    const s = new InMemoryTaskGraphStore()
    s.create('a')
    s.create('b')
    s.create('c')
    expect(s.list()).toEqual(['a', 'b', 'c'])
    s.close('b')
    expect(s.list()).toEqual(['a', 'c'])
  })
})