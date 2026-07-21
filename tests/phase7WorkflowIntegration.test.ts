/**
 * Phase 7 (five_goal.md §十一 P1-9 / P1-10 / P1-11).
 *
 * Verifies the workflow layer's integration with ExecutionRun and
 * the new async shell step:
 *
 *   P1-9  — every workflow step creates a child ExecutionRun with
 *           proper kind, parent link, resource claims, input
 *           snapshot, and terminal transition.
 *   P1-10 — shell steps run asynchronously via spawn(); honor
 *           AbortSignal (mid-flight + pre-abort), per-step timeout,
 *           stream output through a bounded buffer, and return
 *           StructuredToolResult fields incl. large-output artifacts.
 *   P1-11 — WorkflowStatus distinguishes clean success from
 *           succeeded_with_warnings; cancelled from failed.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { tmpdir } from 'os'
import { mkdtempSync, rmSync } from 'fs'
import {
  executeWorkflow,
  runShellAsync,
  type Workflow,
  type WorkflowContext,
  type WorkflowStatus,
} from '../src/core/workflow.js'
import { ExecutionRunRegistry } from '../src/core/executionRun.js'
import { isStructuredResult } from '../src/core/structuredToolResult.js'

let tmpRoot = ''
beforeEach(() => { tmpRoot = mkdtempSync(`${tmpdir()}/wf7-`) })
afterEach(() => { rmSync(tmpRoot, { recursive: true, force: true }) })

function ctx(overrides: Partial<WorkflowContext> = {}): WorkflowContext {
  return { cwd: tmpRoot, ...overrides }
}

function shellStep(name: string, command: string, extra: { continueOnError?: boolean; timeoutMs?: number } = {}): Workflow['steps'][number] {
  return { name, type: 'shell', command, ...extra }
}

function workflow(name: string, steps: Workflow['steps']): Workflow {
  return { name, description: `${name} workflow`, steps }
}

// ─────────────────────────────────────────────────────────────────────
// P1-9: per-step ExecutionRun children
// ─────────────────────────────────────────────────────────────────────
describe('P1-9: each workflow step creates a child ExecutionRun', () => {
  it('creates one workflow run + N step runs with correct parent links', async () => {
    const registry = new ExecutionRunRegistry()
    const wf = workflow('analyze', [
      shellStep('lint', 'true'),
      shellStep('test', 'true'),
      shellStep('build', 'true'),
    ])

    await executeWorkflow(wf, ctx({ runRegistry: registry, parentRunId: 'turn-1' }))

    const all = registry.list()
    const wfRuns = all.filter((r) => r.kind === 'workflow')
    const stepRuns = all.filter((r) => r.kind === 'shell_task')

    expect(wfRuns).toHaveLength(1)
    expect(wfRuns[0]!.parentRunId).toBe('turn-1')
    expect(stepRuns).toHaveLength(3)
    expect(stepRuns.every((r) => r.parentRunId === wfRuns[0]!.runId)).toBe(true)
    expect(stepRuns.map((r) => r.worker).sort()).toEqual(['build', 'lint', 'test'])
  })

  it('captures substituted command in the step run goal (input snapshot)', async () => {
    const registry = new ExecutionRunRegistry()
    const wf = workflow('sub', [
      shellStep('emit', 'echo hello-world'),
    ])

    await executeWorkflow(wf, ctx({ runRegistry: registry }))

    const stepRun = registry.list({ kind: 'shell_task' })[0]!
    expect(stepRun.goal).toContain('echo hello-world')
  })

  it('shell step runs declare directory R/W resource claims on cwd', async () => {
    const registry = new ExecutionRunRegistry()
    const wf = workflow('claim', [shellStep('s', 'true')])

    await executeWorkflow(wf, ctx({ runRegistry: registry }))

    const stepRun = registry.list({ kind: 'shell_task' })[0]!
    expect(stepRun.resources).toContainEqual({ type: 'directory', key: tmpRoot, access: 'read' })
    expect(stepRun.resources).toContainEqual({ type: 'directory', key: tmpRoot, access: 'write' })
  })

  it('shell step run lands in succeeded/failed matching step result', async () => {
    const registry = new ExecutionRunRegistry()
    const wf = workflow('mixed', [
      shellStep('ok', 'true'),
      shellStep('nope', 'false'),
    ])

    const result = await executeWorkflow(wf, ctx({ runRegistry: registry }))
    expect(result.success).toBe(false)

    const stepRuns = registry.list({ kind: 'shell_task' })
    const ok = stepRuns.find((r) => r.worker === 'ok')!
    const nope = stepRuns.find((r) => r.worker === 'nope')!
    expect(ok.status).toBe('succeeded')
    expect(nope.status).toBe('failed')
    expect(nope.error).toBeTruthy()
  })

  it('skipped step (condition not met) does NOT create a step run', async () => {
    const registry = new ExecutionRunRegistry()
    const wf = workflow('cond', [
      shellStep('fails', 'false'),                                // failure
      { name: 'on-success', type: 'shell', command: 'true', if: 'success' as const }, // skipped
    ])

    await executeWorkflow(wf, ctx({ runRegistry: registry }))

    const stepRuns = registry.list({ kind: 'shell_task' })
    // Only 'fails' ran; 'on-success' was skipped — no run created.
    expect(stepRuns).toHaveLength(1)
    expect(stepRuns[0]!.worker).toBe('fails')
  })

  it('echo/slash/prompt steps fall back to kind=workflow (no dedicated RunKind)', async () => {
    const registry = new ExecutionRunRegistry()
    const wf: Workflow = {
      name: 'mixed-types',
      steps: [
        { name: 'hello', type: 'echo', text: 'hi' },
      ],
    }

    await executeWorkflow(wf, ctx({ runRegistry: registry }))

    const stepRuns = registry.list().filter((r) => r.kind === 'workflow')
    // 1 parent workflow run + 1 echo step run (also kind=workflow).
    expect(stepRuns).toHaveLength(2)
    const echoRun = stepRuns.find((r) => r.worker === 'hello')
    expect(echoRun).toBeDefined()
  })
})

// ─────────────────────────────────────────────────────────────────────
// P1-10: asynchronous shell with abort + timeout + streaming
// ─────────────────────────────────────────────────────────────────────
describe('P1-10: runShellAsync honors abort and timeout', () => {
  it('returns success with stdout for exit 0', async () => {
    const r = await runShellAsync({
      command: 'echo hello',
      cwd: tmpRoot,
      timeoutMs: 5000,
    })
    expect(r.status).toBe('success')
    expect(r.exitCode).toBe(0)
    expect(r.stdout?.trim()).toBe('hello')
  })

  it('returns failed with stderr and exitCode for non-zero exit', async () => {
    const r = await runShellAsync({
      command: 'echo oops 1>&2 ; exit 7',
      cwd: tmpRoot,
      timeoutMs: 5000,
    })
    expect(r.status).toBe('failed')
    expect(r.exitCode).toBe(7)
    expect(r.stderr?.trim()).toBe('oops')
  })

  it('pre-abort short-circuits without spawning', async () => {
    const controller = new AbortController()
    controller.abort()
    const r = await runShellAsync({
      command: 'echo never-runs',
      cwd: tmpRoot,
      timeoutMs: 5000,
      signal: controller.signal,
    })
    expect(r.status).toBe('cancelled')
    expect(r.exitCode).toBeUndefined()
  })

  it('mid-flight abort settles as cancelled', async () => {
    const controller = new AbortController()
    const promise = runShellAsync({
      // sleep 5s in the shell so we have time to abort.
      command: 'sleep 5',
      cwd: tmpRoot,
      timeoutMs: 10_000,
      signal: controller.signal,
    })
    // Give the shell a moment to actually start.
    await new Promise((r) => setTimeout(r, 100))
    controller.abort()
    const r = await promise
    expect(r.status).toBe('cancelled')
  }, 15_000)

  it('timeout settles as timed_out with retryable=true', async () => {
    const r = await runShellAsync({
      command: 'sleep 5',
      cwd: tmpRoot,
      timeoutMs: 200,
    })
    expect(r.status).toBe('timed_out')
    expect(r.retryable).toBe(true)
  }, 5000)

  it('returns a structured result shape (status + summary)', async () => {
    const r = await runShellAsync({
      command: 'true',
      cwd: tmpRoot,
      timeoutMs: 1000,
    })
    expect(isStructuredResult(r)).toBe(true)
    expect(typeof r.summary).toBe('string')
    expect(r.summary.length).toBeGreaterThan(0)
  })

  it('streams large stdout into an ArtifactRef and replaces inline with preview', async () => {
    // Emit ~16 KiB of output (> DEFAULT_LARGE_OUTPUT_BYTES = 8 KiB).
    const r = await runShellAsync({
      command: 'yes hello | head -c 16384',
      cwd: tmpRoot,
      timeoutMs: 5000,
    })
    expect(r.status).toBe('success')
    expect(r.artifacts).toBeDefined()
    expect(r.artifacts!.length).toBeGreaterThanOrEqual(1)
    const artifact = r.artifacts!.find((a) => /stdout/.test(a.id))!
    expect(artifact).toBeDefined()
    expect(artifact.sizeBytes).toBeGreaterThanOrEqual(8 * 1024)
    // Inline stdout is now a truncated preview, not the full payload.
    expect(r.stdout!.length).toBeLessThan(16 * 1024)
    expect(r.stdout).toMatch(/truncated/)
  })

  it('never blocks the event loop (awaitable, no execSync)', async () => {
    // Two concurrent runs must overlap in time, not serialize like execSync.
    const start = Date.now()
    await Promise.all([
      runShellAsync({ command: 'sleep 0.3', cwd: tmpRoot, timeoutMs: 5000 }),
      runShellAsync({ command: 'sleep 0.3', cwd: tmpRoot, timeoutMs: 5000 }),
    ])
    const elapsed = Date.now() - start
    // If they serialized, total would be ~600ms+; concurrent is ~300ms.
    // Use 500ms as the threshold (allows for spawn overhead).
    expect(elapsed).toBeLessThan(550)
  })
})

describe('P1-10: executeWorkflow wires abort signal through to shell steps', () => {
  it('pre-aborted workflow skips every shell step and lands in cancelled', async () => {
    const registry = new ExecutionRunRegistry()
    const controller = new AbortController()
    controller.abort()
    const wf = workflow('aborted', [
      shellStep('first', 'true'),
      shellStep('second', 'true'),
    ])

    const result = await executeWorkflow(wf, ctx({
      runRegistry: registry,
      signal: controller.signal,
    }))

    expect(result.status).toBe('cancelled')
    expect(result.success).toBe(false)
    // Workflow run still lands in a terminal state.
    const wfRun = registry.list({ kind: 'workflow' })[0]!
    expect(wfRun.status).toBe('cancelled')
    // No shell step runs were created because the loop short-circuited.
    expect(registry.list({ kind: 'shell_task' })).toHaveLength(0)
  })

  it('shell step structured result is attached to StepResult', async () => {
    const wf = workflow('with-structured', [shellStep('emit', 'echo hi')])
    const result = await executeWorkflow(wf, ctx())
    expect(result.steps[0]!.structured).toBeDefined()
    expect(result.steps[0]!.structured!.status).toBe('success')
    expect(result.steps[0]!.structured!.stdout?.trim()).toBe('hi')
  })
})

// ─────────────────────────────────────────────────────────────────────
// P1-11: WorkflowStatus distinction
// ─────────────────────────────────────────────────────────────────────
describe('P1-11: WorkflowRunResult.status distinguishes outcomes', () => {
  it('clean success → status=succeeded', async () => {
    const result = await executeWorkflow(
      workflow('clean', [shellStep('a', 'true'), shellStep('b', 'true')]),
      ctx(),
    )
    expect(result.status).toBe('succeeded' as WorkflowStatus)
    expect(result.success).toBe(true)
  })

  it('hard failure → status=failed', async () => {
    const result = await executeWorkflow(
      workflow('hard', [shellStep('boom', 'false')]),
      ctx(),
    )
    expect(result.status).toBe('failed')
    expect(result.success).toBe(false)
  })

  it('continueOnError completion → status=succeeded_with_warnings (NOT equivalent to succeeded)', async () => {
    const result = await executeWorkflow(
      workflow('soft', [
        shellStep('flaky', 'false', { continueOnError: true }),
        shellStep('recovery', 'true'),
      ]),
      ctx(),
    )
    // P1-11 spec: "continueOnError 后完成的工作流不能与完全成功等价"
    expect(result.status).toBe('succeeded_with_warnings')
    expect(result.status).not.toBe('succeeded')
    // Back-compat: success boolean still true.
    expect(result.success).toBe(true)
  })

  it('mixed hard + soft failure → status=failed (hard dominates)', async () => {
    const result = await executeWorkflow(
      workflow('mixed', [
        shellStep('soft', 'false', { continueOnError: true }),
        shellStep('hard', 'false'), // no continueOnError → breaks loop
      ]),
      ctx(),
    )
    expect(result.status).toBe('failed')
    expect(result.success).toBe(false)
  })

  it('cancelled (pre-abort) → status=cancelled', async () => {
    const controller = new AbortController()
    controller.abort()
    const result = await executeWorkflow(
      workflow('cancelled', [shellStep('a', 'true')]),
      ctx({ signal: controller.signal }),
    )
    expect(result.status).toBe('cancelled')
    expect(result.success).toBe(false)
  })
})
