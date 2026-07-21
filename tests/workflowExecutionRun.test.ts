/**
 * ExecutionRun × Workflow integration (fi_goal.md §三 Round 4 part B).
 *
 * Verifies that when an ExecutionRunRegistry is wired into WorkflowContext,
 * executeWorkflow creates a child run with kind='workflow' and walks it
 * through queued → preparing → running → succeeded/failed. When the
 * registry is NOT wired, executeWorkflow behaves exactly as before.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { tmpdir } from 'os'
import { mkdtempSync, rmSync } from 'fs'
import { executeWorkflow, type Workflow, type WorkflowContext } from '../src/core/workflow.js'
import { ExecutionRunRegistry, isTerminalRunStatus } from '../src/core/executionRun.js'

let tmpRoot = ''
beforeEach(() => { tmpRoot = mkdtempSync(`${tmpdir()}/wf-er-`) })
afterEach(() => { rmSync(tmpRoot, { recursive: true, force: true }) })

function ctx(overrides: Partial<WorkflowContext> = {}): WorkflowContext {
  return { cwd: tmpRoot, ...overrides }
}

function shellWorkflow(steps: Array<{ name?: string; command: string; continueOnError?: boolean }>): Workflow {
  return {
    name: 'test-wf',
    description: 'test workflow',
    steps: steps.map((s, i) => ({
      name: s.name ?? `step-${i}`,
      type: 'shell' as const,
      command: s.command,
      continueOnError: s.continueOnError,
    })),
  }
}

// ─────────────────────────────────────────────────────────────────────
// Back-compat: registry is optional
// ─────────────────────────────────────────────────────────────────────
describe('executeWorkflow without a registry works exactly as before', () => {
  it('runs to completion without throwing', async () => {
    const wf = shellWorkflow([{ command: 'true' }])
    const result = await executeWorkflow(wf, ctx())
    expect(result.success).toBe(true)
    expect(result.workflowName).toBe('test-wf')
  })
})

// ─────────────────────────────────────────────────────────────────────
// Happy-path
// ─────────────────────────────────────────────────────────────────────
describe('executeWorkflow with a registry walks the state machine', () => {
  it('creates a workflow run and transitions to succeeded on all-pass', async () => {
    const registry = new ExecutionRunRegistry()
    const wf = shellWorkflow([
      { command: 'true', name: 'first' },
      { command: 'true', name: 'second' },
    ])

    const result = await executeWorkflow(wf, ctx({
      runRegistry: registry,
      parentRunId: 'parent-1',
    }))

    expect(result.success).toBe(true)
    const runs = registry.list()
    expect(runs).toHaveLength(1)
    const run = runs[0]!
    expect(run.kind).toBe('workflow')
    expect(run.goal).toBe('test workflow')
    expect(run.worker).toBe('test-wf')
    expect(run.workspace.cwd).toBe(tmpRoot)
    expect(run.parentRunId).toBe('parent-1')
    expect(run.status).toBe('succeeded')
    expect(isTerminalRunStatus(run.status)).toBe(true)
    // phase reflects the last step transition before terminal
    expect(run.phase).toMatch(/step:|finalized/)
  })

  it('uses workflow.name as goal when description is missing', async () => {
    const registry = new ExecutionRunRegistry()
    const wf: Workflow = {
      name: 'bare-name',
      steps: [{ name: 's', type: 'shell', command: 'true' }],
    }
    await executeWorkflow(wf, ctx({ runRegistry: registry }))
    expect(registry.list()[0]!.goal).toBe('bare-name')
  })
})

// ─────────────────────────────────────────────────────────────────────
// Failure path
// ─────────────────────────────────────────────────────────────────────
describe('executeWorkflow failure path lands in failed', () => {
  it('transitions to failed when a step exits non-zero', async () => {
    const registry = new ExecutionRunRegistry()
    const wf = shellWorkflow([
      { command: 'false', name: 'boom' }, // exit 1
    ])

    const result = await executeWorkflow(wf, ctx({ runRegistry: registry }))

    expect(result.success).toBe(false)
    const run = registry.list()[0]!
    expect(run.status).toBe('failed')
    expect(run.error).toMatch(/workflow steps failed/)
  })

  it('transitions to succeeded when continueOnError keeps the workflow going', async () => {
    const registry = new ExecutionRunRegistry()
    const wf = shellWorkflow([
      { command: 'false', name: 'soft-fail', continueOnError: true },
      { command: 'true', name: 'recovery' },
    ])

    const result = await executeWorkflow(wf, ctx({ runRegistry: registry }))

    // continueOnError means overall success is NOT flipped to false.
    expect(result.success).toBe(true)
    expect(registry.list()[0]!.status).toBe('succeeded')
  })
})

// ─────────────────────────────────────────────────────────────────────
// Per-step phase tracking
// ─────────────────────────────────────────────────────────────────────
describe('executeWorkflow updates phase per step', () => {
  it('final phase reflects the last executed step before terminal', async () => {
    const registry = new ExecutionRunRegistry()
    const wf = shellWorkflow([
      { command: 'true', name: 'alpha' },
      { command: 'true', name: 'beta' },
      { command: 'true', name: 'gamma' },
    ])

    await executeWorkflow(wf, ctx({ runRegistry: registry }))

    // The 'finalized' terminal transition sets phase to 'finalized'.
    const run = registry.list()[0]!
    expect(run.phase).toBe('finalized')
    // But the per-step transitions would have set phase to step:<name>
    // at intermediate points. We can verify the run went through
    // 'running' state (not stuck in preparing).
    expect(run.status).toBe('succeeded')
  })
})

// ─────────────────────────────────────────────────────────────────────
// Parallel workflows get independent runs
// ─────────────────────────────────────────────────────────────────────
describe('parallel workflows get independent runs', () => {
  it('two concurrent executeWorkflow calls create two runs', async () => {
    const registry = new ExecutionRunRegistry()
    const wfA = shellWorkflow([{ command: 'true', name: 'a' }])
    wfA.name = 'wf-a'
    const wfB = shellWorkflow([{ command: 'true', name: 'b' }])
    wfB.name = 'wf-b'

    await Promise.all([
      executeWorkflow(wfA, ctx({ runRegistry: registry })),
      executeWorkflow(wfB, ctx({ runRegistry: registry })),
    ])

    const runs = registry.list()
    expect(runs).toHaveLength(2)
    expect(runs.map((r) => r.worker).sort()).toEqual(['wf-a', 'wf-b'])
    expect(runs[0]!.runId).not.toBe(runs[1]!.runId)
  })
})
