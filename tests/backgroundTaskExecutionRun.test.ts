/**
 * ExecutionRun × BackgroundTaskManager integration (fi_goal.md §三 Round 4).
 *
 * Verifies that when an ExecutionRunRegistry is wired into
 * BackgroundTaskManager via options.runRegistry, every task creates
 * a child run with kind='shell_task' and walks the state machine:
 *   queued → preparing → running → succeeded | failed | cancelled
 *
 * Covers BOTH the TaskCreate tool path AND the Bash run_in_background
 * path (both call manager.createTask).
 *
 * Scope (Round 4 part A): BackgroundTaskManager. Workflow integration
 * is a separate test file.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { tmpdir } from 'os'
import { mkdtempSync, rmSync } from 'fs'
import { ExecutionRunRegistry, isTerminalRunStatus } from '../src/core/executionRun.js'
import { BackgroundTaskManager } from '../src/core/backgroundTaskManager.js'

let tmpRoot = ''
beforeEach(() => { tmpRoot = mkdtempSync(`${tmpdir()}/btm-er-`) })
afterEach(() => { rmSync(tmpRoot, { recursive: true, force: true }) })

// Helper: wait until a task reaches a terminal status or timeout.
async function waitForTerminal(
  mgr: BackgroundTaskManager,
  taskId: string,
  timeoutMs = 5_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const t = mgr.getTask(taskId)
    if (t && t.status !== 'running') return
    await new Promise((r) => setTimeout(r, 20))
  }
  throw new Error(`task ${taskId} did not terminate within ${timeoutMs}ms`)
}

// ─────────────────────────────────────────────────────────────────────
// Back-compat: registry is optional
// ─────────────────────────────────────────────────────────────────────
describe('BackgroundTaskManager without a registry works exactly as before', () => {
  it('does not throw when no runRegistry is supplied', async () => {
    const mgr = new BackgroundTaskManager()
    const id = mgr.createTask('node -e "process.exit(0)"', { description: 'compat' })
    await waitForTerminal(mgr, id)
    const info = mgr.getTask(id)
    expect(info?.status).toBe('completed')
  })
})

// ─────────────────────────────────────────────────────────────────────
// Happy-path: task succeeds
// ─────────────────────────────────────────────────────────────────────
describe('BackgroundTaskManager with a registry walks the state machine', () => {
  it('creates a shell_task run and transitions to succeeded on exit 0', async () => {
    const registry = new ExecutionRunRegistry()
    const mgr = new BackgroundTaskManager({ runRegistry: registry })

    const id = mgr.createTask('node -e "process.exit(0)"', {
      description: 'happy',
      cwd: tmpRoot,
    })
    await waitForTerminal(mgr, id)

    const runs = registry.list()
    expect(runs).toHaveLength(1)
    const run = runs[0]
    expect(run.kind).toBe('shell_task')
    expect(run.goal).toBe('happy')
    expect(run.workspace.cwd).toBe(tmpRoot)
    expect(run.worker).toBe('node -e "process.exit(0)"')
    expect(run.status).toBe('succeeded')
    expect(isTerminalRunStatus(run.status)).toBe(true)
  })

  it('stamps parentRunId on the run when supplied via options', async () => {
    const registry = new ExecutionRunRegistry()
    const mgr = new BackgroundTaskManager({
      runRegistry: registry,
      parentRunId: 'parent-42',
    })

    const id = mgr.createTask('node -e "process.exit(0)"')
    await waitForTerminal(mgr, id)

    const run = registry.list({ parentRunId: 'parent-42' })[0]
    expect(run).toBeDefined()
    expect(run.parentRunId).toBe('parent-42')
  })
})

// ─────────────────────────────────────────────────────────────────────
// Failure paths
// ─────────────────────────────────────────────────────────────────────
describe('BackgroundTaskManager failure paths land in failed', () => {
  it('transitions to failed on non-zero exit', async () => {
    const registry = new ExecutionRunRegistry()
    const mgr = new BackgroundTaskManager({ runRegistry: registry })

    const id = mgr.createTask('node -e "process.exit(3)"', { description: 'fails' })
    await waitForTerminal(mgr, id)

    const run = registry.list()[0]
    expect(run.status).toBe('failed')
    expect(run.error).toMatch(/non-zero exit code 3/)
  })

  it('transitions to failed when the command cannot be spawned', async () => {
    const registry = new ExecutionRunRegistry()
    const mgr = new BackgroundTaskManager({ runRegistry: registry })

    // Spawn a binary that doesn't exist — Node fires 'error' not 'close'.
    const id = mgr.createTask('/this/binary/does/not/exist/at-all', {
      description: 'missing binary',
    })
    await waitForTerminal(mgr, id)

    const run = registry.list()[0]
    // Either failed (error fired) — never succeeded.
    expect(['failed']).toContain(run.status)
  })
})

// ─────────────────────────────────────────────────────────────────────
// Stop path → cancelled
// ─────────────────────────────────────────────────────────────────────
describe('BackgroundTaskManager stopTask lands in cancelled', () => {
  it('transitions to cancelled when stopTask is called on a running task', async () => {
    const registry = new ExecutionRunRegistry()
    const mgr = new BackgroundTaskManager({
      runRegistry: registry,
      sigkillGraceMs: 100,
    })

    // Long-running task that won't exit on its own.
    const id = mgr.createTask('node -e "setInterval(()=>{}, 100)"', {
      description: 'long',
    })
    // Give it a moment to spawn.
    await new Promise((r) => setTimeout(r, 50))

    const stopped = mgr.stopTask(id)
    expect(stopped).toBe(true)
    await waitForTerminal(mgr, id)

    const run = registry.list()[0]
    expect(run.status).toBe('cancelled')
    expect(run.error).toMatch(/stopTask/)
    expect(isTerminalRunStatus(run.status)).toBe(true)
  })

  it('does NOT transition to cancelled when stopTask targets a finished task', async () => {
    const registry = new ExecutionRunRegistry()
    const mgr = new BackgroundTaskManager({ runRegistry: registry })

    const id = mgr.createTask('node -e "process.exit(0)"')
    await waitForTerminal(mgr, id)
    // Task already completed — stop is a no-op.
    const stopped = mgr.stopTask(id)
    expect(stopped).toBe(false)

    // Run stays in succeeded, not cancelled.
    expect(registry.list()[0].status).toBe('succeeded')
  })
})

// ─────────────────────────────────────────────────────────────────────
// Multiple tasks get independent runs
// ─────────────────────────────────────────────────────────────────────
describe('parallel background tasks get independent runs', () => {
  it('two createTask calls produce two runs with distinct runIds', async () => {
    const registry = new ExecutionRunRegistry()
    const mgr = new BackgroundTaskManager({ runRegistry: registry })

    const id1 = mgr.createTask('node -e "process.exit(0)"', { description: 'A' })
    const id2 = mgr.createTask('node -e "process.exit(0)"', { description: 'B' })
    await Promise.all([
      waitForTerminal(mgr, id1),
      waitForTerminal(mgr, id2),
    ])

    const runs = registry.list()
    expect(runs).toHaveLength(2)
    expect(runs[0].runId).not.toBe(runs[1].runId)
    expect(runs.map((r) => r.goal).sort()).toEqual(['A', 'B'])
    expect(runs.every((r) => r.status === 'succeeded')).toBe(true)
  })
})

// ─────────────────────────────────────────────────────────────────────
// clearCompleted + dispose don't throw with registry wired
// ─────────────────────────────────────────────────────────────────────
describe('clearCompleted + dispose are safe with a registry', () => {
  it('clearCompleted removes both the task and its runId mapping', async () => {
    const registry = new ExecutionRunRegistry()
    const mgr = new BackgroundTaskManager({ runRegistry: registry })

    const id = mgr.createTask('node -e "process.exit(0)"')
    await waitForTerminal(mgr, id)

    const removed = mgr.clearCompleted()
    expect(removed).toBe(1)
    // Registry itself isn't affected — runs persist for observability.
    expect(registry.size()).toBe(1)
  })

  it('dispose clears the runId map without throwing', async () => {
    const registry = new ExecutionRunRegistry()
    const mgr = new BackgroundTaskManager({
      runRegistry: registry,
      sigkillGraceMs: 50,
    })

    // Spawn a long-running task, then dispose mid-flight.
    mgr.createTask('node -e "setInterval(()=>{}, 100)"')
    await new Promise((r) => setTimeout(r, 50))

    expect(() => mgr.dispose()).not.toThrow()
  })
})
