/**
 * v0.5.3 (P1.7): TaskImpact real entry via TaskPlan tool.
 * v0.5.3 Final (task 1): round-trip test — every schema enum value
 * must be parseable, and every parser-accepted value must appear in
 * the schema.
 */
import { describe, it, expect } from 'vitest'
import { TaskPlanTool } from '../../src/tools/taskPlan.js'
import { TaskGraph } from '../../src/core/runtime/taskGraph.js'
import type { ToolContext } from '../../src/core/types.js'
import { TASK_IMPACT_SCOPES } from '../../src/core/taskImpact.js'

function makeTool(graph: TaskGraph): TaskPlanTool {
  const tool = new TaskPlanTool()
  ;(tool as unknown as { resolver: { resolve: (runId: string) => TaskGraph } }).resolver = {
    resolve: () => graph,
  }
  return tool
}

const testCtx: ToolContext = {
  cwd: '/tmp',
  permissionMode: 'default',
  execution: {
  runId: 'test-run',
  workspaceId: 'ws',
  workspacePath: '/tmp',
  signal: new AbortController().signal,
  model: 'fake',
},
}

describe('TaskPlan impact entry (P1.7)', () => {
  it('accepts a fully-specified impact payload', async () => {
    const g = new TaskGraph()
    const tool = makeTool(g)
    const r = await tool.execute({
      action: 'add',
      id: 'edit-api',
      title: 'Edit the public API',
      impact_scope: 'cross-module',
      affects_public_interface: true,
      changes_configuration: false,
      requires_root_cause: false,
      estimated_files: 4,
    }, testCtx)
    expect(r.isError).toBeFalsy()
    const node = g.get('edit-api')
    expect(node).toBeDefined()
    expect(node!.impact).toEqual({
      scope: 'cross-module',
      affectsPublicInterface: true,
      changesConfiguration: false,
      requiresRootCause: false,
      estimatedFiles: 4,
    })
  })

  it('rejects illegal impact_scope', async () => {
    const g = new TaskGraph()
    const tool = makeTool(g)
    const r = await tool.execute({
      action: 'add',
      id: 'n1',
      impact_scope: 'galaxy',
    }, testCtx)
    expect(r.isError).toBe(true)
    expect(r.content).toMatch(/impact_scope.*invalid/)
    expect(g.get('n1')).toBeUndefined()
  })

  it('rejects non-boolean affects_public_interface', async () => {
    const g = new TaskGraph()
    const tool = makeTool(g)
    const r = await tool.execute({
      action: 'add',
      id: 'n1',
      impact_scope: 'local',
      affects_public_interface: 'yes',
    }, testCtx)
    expect(r.isError).toBe(true)
    expect(r.content).toMatch(/affects_public_interface/)
  })

  it('rejects negative estimated_files', async () => {
    const g = new TaskGraph()
    const tool = makeTool(g)
    const r = await tool.execute({
      action: 'add',
      id: 'n1',
      impact_scope: 'local',
      estimated_files: -3,
    }, testCtx)
    expect(r.isError).toBe(true)
    expect(r.content).toMatch(/estimated_files/)
  })

  it('legacy path: no impact fields → impact is undefined', async () => {
    const g = new TaskGraph()
    const tool = makeTool(g)
    await tool.execute({ action: 'add', id: 'n1' }, testCtx)
    expect(g.get('n1')!.impact).toBeUndefined()
  })

  it('update path validates impact changes', async () => {
    const g = new TaskGraph()
    const tool = makeTool(g)
    await tool.execute({ action: 'add', id: 'n1', impact_scope: 'local' }, testCtx)
    const r = await tool.execute({
      action: 'update',
      id: 'n1',
      impact_scope: 'cross-module',
      affects_public_interface: true,
    }, testCtx)
    expect(r.isError).toBeFalsy()
    expect(g.get('n1')!.impact!.scope).toBe('cross-module')
    expect(g.get('n1')!.impact!.affectsPublicInterface).toBe(true)
  })

  // v0.5.3 (P0-4): the model sees the TaskImpact fields in the LLM-
  // visible tool schema. Previously the fields only existed on the
  // in-memory node + the parser; the model had no path to set them.
  // This test asserts the schema actually exposes every field, with
  // the correct types. If anyone removes these from
  // TaskPlanTool.definition, this test fails immediately.
  it('LLM-visible schema exposes all TaskImpact fields', () => {
    const inst = new TaskPlanTool()
    const props = (inst.definition.function.parameters.properties as Record<string, { type?: string; enum?: unknown[]; minimum?: number }>)
    expect(props.impact_scope).toBeDefined()
    expect(props.impact_scope.type).toBe('string')
    // v0.5.3 Final: enum must MATCH TASK_IMPACT_SCOPES exactly.
    expect(props.impact_scope.enum).toEqual([...TASK_IMPACT_SCOPES])
    expect(props.affects_public_interface).toBeDefined()
    expect(props.affects_public_interface.type).toBe('boolean')
    expect(props.changes_configuration).toBeDefined()
    expect(props.changes_configuration.type).toBe('boolean')
    expect(props.requires_root_cause).toBeDefined()
    expect(props.requires_root_cause.type).toBe('boolean')
    expect(props.estimated_files).toBeDefined()
    expect(props.estimated_files.type).toBe('number')
    expect(props.estimated_files.minimum).toBe(0)
  })
})

// v0.5.3 Final (task 1): Round-trip — schema enum ↔ parser enum.
// Any drift between what the LLM can send and what the parser
// accepts is a contract bug. We read BOTH sides and assert set
// equality in BOTH directions.
describe('TaskImpact schema ↔ parser round-trip', () => {
  it('every schema enum value parses and writes', async () => {
    const inst = new TaskPlanTool()
    const schemaEnum = (inst.definition.function.parameters.properties as Record<string, { enum?: string[] }>)
      .impact_scope.enum ?? []
    const g = new TaskGraph()
    ;(inst as unknown as { resolver: { resolve: (runId: string) => TaskGraph } }).resolver = { resolve: () => g }
    for (const scope of schemaEnum) {
      const r = await inst.execute({
        action: 'add',
        id: `node-${scope}`,
        impact_scope: scope,
      }, {
        cwd: '/tmp',
        permissionMode: 'default',
        execution: {
          runId: 'round-trip',
          workspaceId: 'ws',
          workspacePath: '/tmp',
          signal: new AbortController().signal,
          model: 'fake',
        },
      })
      expect(r.isError).toBeFalsy()
      expect(g.get(`node-${scope}`)!.impact).toBeDefined()
      expect(g.get(`node-${scope}`)!.impact!.scope).toBe(scope)
    }
  })

  it('every TASK_IMPACT_SCOPES value appears in the schema enum', () => {
    const inst = new TaskPlanTool()
    const schemaEnum = (inst.definition.function.parameters.properties as Record<string, { enum?: string[] }>)
      .impact_scope.enum ?? []
    for (const scope of TASK_IMPACT_SCOPES) {
      expect(schemaEnum).toContain(scope)
    }
  })

  it('estimated_files schema allows 0 and rejects negative', async () => {
    const g = new TaskGraph()
    const tool = new TaskPlanTool()
    ;(tool as unknown as { resolver: { resolve: (runId: string) => TaskGraph } }).resolver = { resolve: () => g }
    const ctx = {
      cwd: '/tmp',
      permissionMode: 'default',
      execution: {
        runId: 'rt',
        workspaceId: 'ws',
        workspacePath: '/tmp',
        signal: new AbortController().signal,
        model: 'fake',
      },
    } as const
    const r0 = await tool.execute({ action: 'add', id: 'n0', impact_scope: 'local', estimated_files: 0 }, ctx)
    expect(r0.isError).toBeFalsy()
    expect(g.get('n0')!.impact!.estimatedFiles).toBe(0)
    const rNeg = await tool.execute({ action: 'add', id: 'nneg', impact_scope: 'local', estimated_files: -1 }, ctx)
    expect(rNeg.isError).toBe(true)
  })
})