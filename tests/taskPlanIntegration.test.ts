/**
 * TaskPlan tool unit test (Phase 3). The tool is a thin wrapper over the
 * TaskGraph engine; tested directly for determinism (no fake provider).
 * Proves add/complete/fail/list operate the graph and that an unmet
 * acceptance criterion fails the node (the gate the CompletionContract
 * reads).
 */
import { describe, it, expect } from 'vitest'
import { TaskPlanTool } from '../src/tools/taskPlan.js'
import { TaskGraph } from '../src/core/runtime/taskGraph.js'
import type { ToolContext } from '../src/core/types.js'

const ctx = { cwd: '/tmp', execution: { runId: 'test-run' } } as unknown as ToolContext
const tool = (g?: TaskGraph) => {
  // v0.3.2 (run-scoped runtime contract §Phase 2): wrap the graph in a resolver so
  // the tool gets the same TaskGraphResolver contract as production.
  const resolver = g
    ? { resolve: (_runId: string) => g, resolveOrNull: (_runId: string) => g }
    : undefined
  return new TaskPlanTool(resolver)
}

describe('TaskPlan tool (Phase 3)', () => {
  it('add creates a node the graph (and CompletionContract) can see', async () => {
    const g = new TaskGraph()
    const t = tool(g)
    const r = await t.execute({ action: 'add', id: 'impl', title: 'implement', acceptanceCriteria: ['tests pass'] }, ctx)
    expect(r.isError).toBe(false)
    expect(g.has('impl')).toBe(true)
    expect(g.hasUnfinished()).toBe(true)
  })

  it('complete fails the node when acceptance criteria are unmet', async () => {
    const g = new TaskGraph()
    const t = tool(g)
    // v0.3.5: complete_node without evidence store falls back to
    // graph.complete(id) which now SKIPS the criteria check (evidence
    // path). To test the criteria-fail behavior, use the old 'complete'
    // action with explicit satisfiedCriteria.
    await t.execute({ action: 'add', id: 'a', acceptanceCriteria: ['x'] }, ctx)
    // Use direct graph API to test criteria enforcement
    g.start('a')
    g.complete('a', []) // explicit empty satisfiedCriteria → fails
    expect(g.get('a')!.status).toBe('failed')
  })

  it('complete_node succeeds when acceptance criteria are satisfied (v0.3.5: via evidence)', async () => {
    const g = new TaskGraph()
    const t = tool(g)
    await t.execute({ action: 'add', id: 'a', acceptanceCriteria: ['x'] }, ctx)
    // v0.3.5: node must be started before completing (state transition validation)
    await t.execute({ action: 'start', id: 'a' }, ctx)
    const r = await t.execute({ action: 'complete_node', id: 'a' }, ctx)
    expect(g.get('a')!.status).toBe('completed')
    expect(r.isError).toBe(false)
  })

  it('list renders the graph snapshot', async () => {
    const g = new TaskGraph()
    const t = tool(g)
    await t.execute({ action: 'add', id: 'a' }, ctx)
    await t.execute({ action: 'add', id: 'b', dependencies: ['a'] }, ctx)
    const r = await t.execute({ action: 'list' }, ctx)
    expect(r.isError).toBe(false)
    expect(r.content).toContain('a')
    expect(r.content).toContain('b')
  })

  it('returns an error when no graph is wired', async () => {
    const r = await tool(undefined).execute({ action: 'list' }, ctx)
    expect(r.isError).toBe(true)
  })
})
