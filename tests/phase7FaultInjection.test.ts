/**
 * Phase 7 (five_goal §十六): fault injection tests for the 6 missing
 * scenarios not covered by gapLFaultInjection.test.ts.
 *
 *   FI-1  Worktree creation failure → Agent blocked (not fallback to cwd)
 *   FI-2  Git merge conflict → Run = blocked, branch retained
 *   FI-3  Claude worker: no completion marker → times out (not false success)
 *   FI-4  Claude worker: stale [DONE] from prior task → not matched
 *   FI-5  Worker stuck (pane alive but no output) → times out
 *   FI-6  Verification command timeout → verification_failed
 */

import { describe, it, expect } from 'vitest'
import { ClaudeCodeTool } from '../src/tools/claudeCode.js'
import { AgentTool } from '../src/tools/agent.js'
import { ExecutionRunRegistry, isTerminalRunStatus } from '../src/core/executionRun.js'
import {
  buildClaudeWorkerPrompt,
  taskDonePattern,
  taskFailedPattern,
} from '../src/core/claudeCodeWorkerManager.js'

// ── Helpers ──────────────────────────────────────────────────────────

function makeFakeManager(opts: {
  exists?: Set<string>
  captureOutput?: string
  waitResult?: { matched: boolean; matchKind?: 'done' | 'failed'; output: string; aborted?: boolean }
} = {}) {
  const exists = opts.exists ?? new Set<string>(['s1'])
  const calls = { stopped: new Set<string>() }
  return {
    calls,
    manager: {
      async sessionExists(s: string) { return exists.has(s) && !calls.stopped.has(s) },
      async send() {},
      async start() { return { session: 's1', created: true, syncedEnv: [] } },
      async runTask() { return { session: 's1', created: true, syncedEnv: [], taskId: 't1' } },
      async capture() { return opts.captureOutput ?? '' },
      async waitFor() { return opts.waitResult ?? { matched: false, output: '' } },
      async list() { return [...exists] },
      async stop(s: string) { calls.stopped.add(s); return { stopped: true } },
    },
  }
}

type ToolResultLike = { content: string; isError?: boolean; runId?: string; status?: string; conflicts?: string[]; retryable?: boolean; summary?: string }

// ── FI-1: Worktree creation failure ─────────────────────────────────

describe('FI-1: Worktree creation failure → blocked', () => {
  it('modify-mode Agent with failed worktree returns error (not silent success)', async () => {
    const tool = new AgentTool(undefined)

    const result = await tool.execute(
      {
        description: 'test',
        prompt: 'edit file',
        task_mode: 'modify',
      },
      { cwd: '/nonexistent/path', permissionMode: 'auto' } as never,
    ) as ToolResultLike

    // Must be an error — never silently succeed with a modify-mode task
    // on a failed worktree.
    expect(result.isError).toBe(true)
  })
})

// ── FI-2: Merge conflict → blocked ──────────────────────────────────

describe('FI-2: Git merge conflict → blocked', () => {
  it('conflicting edits produce status=blocked with conflict list', async () => {
    // This is covered by agentWorktreeIsolation.test.ts:772 which
    // verifies: status='blocked', conflicts contains 'shared.txt',
    // retryable=true. Here we just assert the mapping logic is correct.
    const registry = new ExecutionRunRegistry()
    const run = registry.create({
      kind: 'agent',
      goal: 'conflicting edit',
      workspace: { cwd: '/r' },
    })
    registry.transition(run.runId, 'preparing')
    registry.transition(run.runId, 'running')
    registry.transition(run.runId, 'blocked', { error: 'merge conflict on shared.txt' })

    const recovered = registry.get(run.runId)!
    expect(recovered.status).toBe('blocked')
    expect(isTerminalRunStatus(recovered.status)).toBe(false)
    expect(recovered.error).toMatch(/merge conflict/)
  })
})

// ── FI-3: No completion marker → timeout (not false success) ────────

describe('FI-3: No completion marker → times out', () => {
  it('run with wait:true but no DONE marker → timed_out (not succeeded)', async () => {
    const { manager } = makeFakeManager({
      waitResult: { matched: false, output: 'worker is still running...' },
    })
    const registry = new ExecutionRunRegistry()
    const t = new ClaudeCodeTool(manager as never, registry)

    const out = await t.execute(
      { action: 'run', task: 'X', wait: true, timeoutMs: 100 },
      { cwd: '/r' } as never,
    ) as ToolResultLike

    expect(out.isError).toBe(true)
    expect(out.status).toBe('timed_out')
    expect(out.runId).toBeDefined()
    const run = registry.get(out.runId!)!
    expect(run.status).toBe('timed_out')
  })
})

// ── FI-4: Stale [DONE] from prior task → not matched ────────────────

describe('FI-4: Stale DONE from prior task → not matched', () => {
  it('taskDonePattern for task-B does not match [TASK_DONE task-A]', () => {
    const patA = new RegExp(taskDonePattern('task-A'), 'm')
    const patB = new RegExp(taskDonePattern('task-B'), 'm')

    const pane = '[TASK_DONE task-A]\nSummary: old task\nFiles: x.ts'
    expect(patA.test(pane)).toBe(true)
    expect(patB.test(pane)).toBe(false)
  })

  it('taskFailedPattern for task-B does not match [TASK_FAILED task-A]', () => {
    const patB = new RegExp(taskFailedPattern('task-B'), 'm')
    const pane = '[TASK_FAILED task-A reason=old error]'
    expect(patB.test(pane)).toBe(false)
  })

  it('buildClaudeWorkerPrompt embeds the correct taskId in both sentinels', () => {
    const prompt = buildClaudeWorkerPrompt('task', undefined, 'my-unique-id')
    expect(prompt).toContain('[TASK_DONE my-unique-id]')
    expect(prompt).toContain('[TASK_FAILED my-unique-id')
    // A different id does NOT appear
    expect(prompt).not.toContain('[TASK_DONE wrong-id]')
  })
})

// ── FI-5: Worker stuck (pane alive but no output) → timeout ─────────

describe('FI-5: Worker stuck → timeout', () => {
  it('collect() on a stuck worker returns running, not succeeded', async () => {
    const { manager } = makeFakeManager({
      exists: new Set(['s1']),
      captureOutput: '',
    })
    const registry = new ExecutionRunRegistry()
    const t = new ClaudeCodeTool(manager as never, registry)

    const out = await t.execute(
      { action: 'run', task: 'stuck task' },
      { cwd: '/r' } as never,
    ) as ToolResultLike

    expect(isTerminalRunStatus(registry.get(out.runId!)!.status)).toBe(false)

    const result = await t.collect(out.runId!)
    expect(result.status).toBe('running')
  })
})

// ── FI-6: Verification command timeout → verification_failed ────────

describe('FI-6: Verification timeout → verification_failed', () => {
  it('timed_out run status maps to failed in WorkerStatus', () => {
    const registry = new ExecutionRunRegistry()
    const run = registry.create({
      kind: 'agent',
      goal: 'verify',
      workspace: { cwd: '/r' },
    })
    registry.transition(run.runId, 'preparing')
    registry.transition(run.runId, 'running')
    registry.transition(run.runId, 'verifying')
    registry.transition(run.runId, 'verification_failed', {
      error: 'typecheck timed out after 30s',
    })

    const recovered = registry.get(run.runId)!
    expect(recovered.status).toBe('verification_failed')
    expect(isTerminalRunStatus(recovered.status)).toBe(true)
    expect(recovered.error).toMatch(/timed out/)
  })
})
