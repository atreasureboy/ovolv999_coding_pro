import { describe, it, expect } from 'vitest'
import { TaskGraph } from '../src/core/runtime/taskGraph.js'

const node = (id: string, extra: Partial<Parameters<TaskGraph['addNode']>[0]> = {}) =>
  ({ id, title: id, description: '', dependencies: [], acceptanceCriteria: [], ...extra })

describe('TaskGraph (Phase 3)', () => {
  it('a node is ready only when all dependencies are completed', () => {
    const g = new TaskGraph()
    g.addNode(node('a'))
    g.addNode(node('b', { dependencies: ['a'] }))
    expect(g.readyNodes().map((n) => n.id)).toEqual(['a'])
    g.start('a'); g.complete('a')
    expect(g.readyNodes().map((n) => n.id)).toEqual(['b'])
  })

  it('parallelGroups separates nodes with conflicting resource claims', () => {
    const g = new TaskGraph()
    g.addNode(node('a', { resourceClaims: ['file:x.ts'] }))
    g.addNode(node('b', { resourceClaims: ['file:x.ts'] })) // conflicts with a
    g.addNode(node('c', { resourceClaims: ['file:y.ts'] })) // independent
    const groups = g.parallelGroups().map((grp) => grp.map((n) => n.id).sort())
    // a and b share file:x.ts → different groups; c joins one of them
    expect(groups).toHaveLength(2)
    const all = groups.flat()
    expect(all.sort()).toEqual(['a', 'b', 'c'])
    // a and b must NOT be in the same group
    const groupOf = (id: string) => groups.findIndex((grp) => grp.includes(id))
    expect(groupOf('a')).not.toBe(groupOf('b'))
  })

  it('complete() fails the node when acceptance criteria are unmet', () => {
    const g = new TaskGraph()
    g.addNode(node('a', { acceptanceCriteria: ['tests pass', 'lint clean'] }))
    g.start('a')
    g.complete('a', ['tests pass']) // lint clean missing
    expect(g.get('a')!.status).toBe('failed')
    expect(g.get('a')!.failReason).toMatch(/lint clean/)
  })

  it('complete() succeeds when all acceptance criteria are satisfied', () => {
    const g = new TaskGraph()
    g.addNode(node('a', { acceptanceCriteria: ['x'] }))
    g.start('a')
    g.complete('a', ['x'], ['patch.diff'])
    expect(g.get('a')!.status).toBe('completed')
    expect(g.get('a')!.artifacts).toContain('patch.diff')
  })

  it('retry() re-queues a failed node up to maxAttempts, then blocks', () => {
    const g = new TaskGraph()
    g.addNode(node('a', { retryPolicy: { maxAttempts: 2 } }))
    g.start('a'); g.fail('a', 'boom')       // attempt 1
    g.retry('a')                            // back to pending
    g.start('a'); g.fail('a', 'boom again') // attempt 2
    g.retry('a')                            // exhausted → blocked
    expect(g.get('a')!.status).toBe('blocked')
    expect(g.get('a')!.blockReason).toMatch(/exhausted/)
  })

  it('isDone() only when every node is terminal; hasUnfinished() gates completion', () => {
    const g = new TaskGraph()
    g.addNode(node('a')); g.addNode(node('b'))
    expect(g.isDone()).toBe(false)
    expect(g.hasUnfinished()).toBe(true)
    g.start('a'); g.complete('a')
    expect(g.isDone()).toBe(false) // b still pending
    g.start('b'); g.complete('b')
    expect(g.isDone()).toBe(true)
    expect(g.hasUnfinished()).toBe(false)
  })

  it('rejects a dependency cycle at addNode', () => {
    const g = new TaskGraph()
    g.addNode(node('a', { dependencies: ['b'] }))
    g.addNode(node('b', { dependencies: ['c'] }))
    expect(() => g.addNode(node('c', { dependencies: ['a'] }))).toThrow(/cycle/)
  })

  it('serialise + restore round-trips the graph (event-log recovery)', () => {
    const g = new TaskGraph()
    g.addNode(node('a', { acceptanceCriteria: ['x'] }))
    g.addNode(node('b', { dependencies: ['a'] }))
    g.start('a'); g.complete('a', ['x'])
    const json = g.serialize()
    const g2 = TaskGraph.restore(json)
    expect(g2.list().map((n) => n.id).sort()).toEqual(['a', 'b'])
    expect(g2.get('a')!.status).toBe('completed')
    expect(g2.readyNodes().map((n) => n.id)).toEqual(['b']) // b now ready
  })

  it('hasHardFailures() detects unresolved failed/blocked nodes', () => {
    const g = new TaskGraph()
    g.addNode(node('a'))
    g.start('a'); g.fail('a', 'x')
    expect(g.hasHardFailures()).toBe(true)
    g.get('a')!.status = 'completed'
    expect(g.hasHardFailures()).toBe(false)
  })

  it('snapshot() reports correct counts', () => {
    const g = new TaskGraph()
    g.addNode(node('a')); g.addNode(node('b', { dependencies: ['a'] })); g.addNode(node('c'))
    g.start('a')
    const s = g.snapshot().summary
    expect(s).toMatchObject({ total: 3, running: 1, ready: 1, pending: 1 })
    expect(s.done).toBe(false)
  })
})
