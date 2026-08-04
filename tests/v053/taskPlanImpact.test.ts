/**
 * v0.5.3 (P1.7): TaskImpact real entry via TaskPlan tool.
 */
import { describe, it, expect } from 'vitest'

import { TaskPlanTool } from '../../src/tools/taskPlan.js'
import { TaskGraph } from '../../src/core/runtime/taskGraph.js'
import type { ToolContext } from '../../src/core/types.js'

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
    const props = (inst.definition.function.parameters.properties as Record<string, { type?: string; enum?: unknown[] }>)
    expect(props.impact_scope).toBeDefined()
    expect(props.impact_scope.type).toBe('string')
    expect(props.impact_scope.enum).toEqual(
      expect.arrayContaining(['file', 'module', 'package', 'repo', 'external']),
    )
    expect(props.affects_public_interface).toBeDefined()
    expect(props.affects_public_interface.type).toBe('boolean')
    expect(props.changes_configuration).toBeDefined()
    expect(props.changes_configuration.type).toBe('boolean')
    expect(props.requires_root_cause).toBeDefined()
    expect(props.requires_root_cause.type).toBe('boolean')
    expect(props.estimated_files).toBeDefined()
    expect(props.estimated_files.type).toBe('number')
  })
})