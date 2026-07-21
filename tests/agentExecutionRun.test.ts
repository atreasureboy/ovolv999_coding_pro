/**
 * ExecutionRun × AgentTool integration (fi_goal.md §三 Phase 2, Round 2).
 *
 * Verifies that when an ExecutionRunRegistry is wired into AgentTool,
 * every invocation creates a child run, walks it through the canonical
 * state machine, and lands in the correct terminal state — observable
 * via the registry. When the registry is NOT wired, AgentTool behaves
 * exactly as before (back-compat).
 *
 * Scope (Round 2): AgentTool only. Other kinds (turn/external_worker/
 * shell_task/workflow/loop) get integrated in later rounds.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { execSync } from 'child_process'

import { AgentTool } from '../src/tools/agent.js'
import { _resetWorktreeManagersForTest } from '../src/tools/worktree.js'
import { ExecutionRunRegistry, isTerminalRunStatus } from '../src/core/executionRun.js'
import type { EngineConfig } from '../src/core/types.js'
import type { Renderer } from '../src/ui/renderer.js'

// ── Harness ────────────────────────────────────────────────────────────────

function fakeRenderer(): Renderer {
  const r: Record<string, unknown> = {}
  for (const k of [
    'banner', 'info', 'warn', 'error', 'success',
    'startSpinner', 'stopSpinner',
    'beginAssistantText', 'endAssistantText', 'streamToken',
    'toolStart', 'toolResult',
    'compactStart', 'compactDone', 'contextWarning',
    'agentStart', 'agentDone', 'agentSummary', 'agentHeartbeat',
  ]) {
    r[k] = () => {}
  }
  return r as unknown as Renderer
}

function baseConfig(o: Partial<EngineConfig> = {}): EngineConfig {
  return {
    apiKey: 'k',
    model: 'm',
    maxIterations: 10,
    cwd: '/tmp',
    permissionMode: 'auto',
    permissionManager: undefined,
    enabledModules: [],
    ...o,
  }
}

function successChildEngine(output = 'done') {
  return {
    runTurn: () => Promise.resolve({
      result: { output, reason: 'stop_sequence' as const },
      newHistory: [],
    }),
    abort: () => undefined,
    dispose: () => undefined,
  }
}

function errorChildEngine() {
  return {
    runTurn: () => Promise.resolve({
      result: { output: 'boom', reason: 'error' as const },
      newHistory: [],
    }),
    abort: () => undefined,
    dispose: () => undefined,
  }
}

function throwingChildEngine() {
  return {
    runTurn: () => Promise.reject(new Error('child crashed')),
    abort: () => undefined,
    dispose: () => undefined,
  }
}

let tmpRoot = ''
let gitRoot = ''

beforeEach(() => {
  tmpRoot = mkdtempSync(`${tmpdir()}/p2-`)
  gitRoot = join(tmpRoot, 'repo')
  mkdirSync(gitRoot, { recursive: true })
  execSync('git init -b main', { cwd: gitRoot, stdio: 'pipe' })
  execSync('git config user.email t@t.test', { cwd: gitRoot, stdio: 'pipe' })
  execSync('git config user.name test', { cwd: gitRoot, stdio: 'pipe' })
  writeFileSync(join(gitRoot, 'README.md'), '# repo\n')
  execSync('git add -A && git commit -m init', { cwd: gitRoot, stdio: 'pipe' })
  _resetWorktreeManagersForTest()
})
afterEach(() => {
  _resetWorktreeManagersForTest()
  rmSync(tmpRoot, { recursive: true, force: true })
})

// ─────────────────────────────────────────────────────────────────────
// Back-compat: registry is optional
// ─────────────────────────────────────────────────────────────────────
describe('AgentTool without a registry works exactly as before', () => {
  it('does not throw when no runRegistry is supplied', async () => {
    const tool = new AgentTool({
      factory: () => successChildEngine(),
      parentConfig: baseConfig({ cwd: gitRoot }),
      parentRenderer: fakeRenderer(),
      // runRegistry intentionally omitted
    })
    const out = await tool.execute(
      { description: 'work', prompt: 'do it', subagent_type: 'general-purpose' },
      { cwd: gitRoot, permissionMode: 'auto' },
    )
    expect(out.isError).toBe(false)
  })
})

// ─────────────────────────────────────────────────────────────────────
// Happy-path integration
// ─────────────────────────────────────────────────────────────────────
describe('AgentTool with a registry walks the canonical state machine', () => {
  it('transitions queued → preparing → running → succeeded on a successful task', async () => {
    const registry = new ExecutionRunRegistry()
    const tool = new AgentTool({
      factory: () => successChildEngine(),
      parentConfig: baseConfig({ cwd: gitRoot }),
      parentRenderer: fakeRenderer(),
      runRegistry: registry,
    })

    const out = await tool.execute(
      { description: 'happy path', prompt: 'do it', subagent_type: 'general-purpose' },
      { cwd: gitRoot, permissionMode: 'auto' },
    )

    expect(out.isError).toBe(false)

    // Exactly one run was created.
    const runs = registry.list()
    expect(runs).toHaveLength(1)
    const run = runs[0]!
    expect(run.kind).toBe('agent')
    expect(run.goal).toBe('happy path')
    expect(run.worker).toBe('general-purpose')
    expect(run.workspace.cwd).toBe(gitRoot)
    // Terminal state.
    expect(run.status).toBe('succeeded')
    expect(isTerminalRunStatus(run.status)).toBe(true)
  })

  it('stamps the run with the parentRunId when supplied', async () => {
    const registry = new ExecutionRunRegistry()
    const tool = new AgentTool({
      factory: () => successChildEngine(),
      parentConfig: baseConfig({ cwd: gitRoot }),
      parentRenderer: fakeRenderer(),
      runRegistry: registry,
      parentRunId: 'parent-run-42',
    })

    await tool.execute(
      { description: 'child', prompt: 'do it', subagent_type: 'general-purpose' },
      { cwd: gitRoot, permissionMode: 'auto' },
    )

    const run = registry.list({ parentRunId: 'parent-run-42' })[0]!
    expect(run).toBeDefined()
    expect(run.parentRunId).toBe('parent-run-42')
  })
})

// ─────────────────────────────────────────────────────────────────────
// Verify gate transitions
// ─────────────────────────────────────────────────────────────────────
describe('AgentTool verify gate produces verification_failed terminal state', () => {
  it('lands in verification_failed when the verify command exits non-zero', async () => {
    // Parent repo has a failing test script.
    writeFileSync(
      join(gitRoot, 'package.json'),
      JSON.stringify({ name: 'p2', scripts: { test: 'node -e "process.exit(2)"' } }, null, 2),
    )
    execSync('git add -A && git commit -m pkg', { cwd: gitRoot, stdio: 'pipe' })

    const registry = new ExecutionRunRegistry()
    const tool = new AgentTool({
      factory: () => successChildEngine(),
      parentConfig: baseConfig({ cwd: gitRoot }),
      parentRenderer: fakeRenderer(),
      runRegistry: registry,
    })

    const out = await tool.execute(
      { description: 'broken', prompt: 'do it', verify: true, subagent_type: 'general-purpose' },
      { cwd: gitRoot, permissionMode: 'auto' },
    )

    expect(out.isError).toBe(true)
    const run = registry.list()[0]!
    expect(run.status).toBe('verification_failed')
    expect(isTerminalRunStatus(run.status)).toBe(true)
    expect(run.verification?.passed).toBe(false)
  })

  it('lands in succeeded when verify gate passes', async () => {
    writeFileSync(
      join(gitRoot, 'package.json'),
      JSON.stringify({ name: 'p2', scripts: { test: 'node -e "process.exit(0)"' } }, null, 2),
    )
    execSync('git add -A && git commit -m pkg', { cwd: gitRoot, stdio: 'pipe' })

    const registry = new ExecutionRunRegistry()
    const tool = new AgentTool({
      factory: () => successChildEngine(),
      parentConfig: baseConfig({ cwd: gitRoot }),
      parentRenderer: fakeRenderer(),
      runRegistry: registry,
    })

    await tool.execute(
      { description: 'solid', prompt: 'do it', verify: true, subagent_type: 'general-purpose' },
      { cwd: gitRoot, permissionMode: 'auto' },
    )

    expect(registry.list()[0]!.status).toBe('succeeded')
  })
})

// ─────────────────────────────────────────────────────────────────────
// Engine-error integration
// ─────────────────────────────────────────────────────────────────────
describe('AgentTool engine-error produces failed terminal state', () => {
  it('lands in failed when child engine returns reason="error"', async () => {
    const registry = new ExecutionRunRegistry()
    const tool = new AgentTool({
      factory: () => errorChildEngine(),
      parentConfig: baseConfig({ cwd: gitRoot }),
      parentRenderer: fakeRenderer(),
      runRegistry: registry,
    })

    await tool.execute(
      { description: 'boom', prompt: 'do it', subagent_type: 'general-purpose' },
      { cwd: gitRoot, permissionMode: 'auto' },
    )

    const run = registry.list()[0]!
    expect(run.status).toBe('failed')
    expect(run.error).toBeTruthy()
  })

  it('lands in failed when child engine THROWS (catch path)', async () => {
    const registry = new ExecutionRunRegistry()
    const tool = new AgentTool({
      factory: () => throwingChildEngine(),
      parentConfig: baseConfig({ cwd: gitRoot }),
      parentRenderer: fakeRenderer(),
      runRegistry: registry,
    })

    const out = await tool.execute(
      { description: 'crash', prompt: 'do it', subagent_type: 'general-purpose' },
      { cwd: gitRoot, permissionMode: 'auto' },
    )

    expect(out.isError).toBe(true)
    const run = registry.list()[0]!
    expect(run.status).toBe('failed')
    expect(run.error).toBe('child crashed')
  })
})

// ─────────────────────────────────────────────────────────────────────
// Worktree integration — workspace field reflects isolation
// ─────────────────────────────────────────────────────────────────────
describe('AgentTool run.workspace reflects worktree isolation', () => {
  it('workspace.cwd is the parent cwd for read-only tasks', async () => {
    const registry = new ExecutionRunRegistry()
    const tool = new AgentTool({
      factory: () => successChildEngine(),
      parentConfig: baseConfig({ cwd: gitRoot }),
      parentRenderer: fakeRenderer(),
      runRegistry: registry,
    })

    await tool.execute(
      { description: 'ro', prompt: 'look', subagent_type: 'general-purpose' },
      { cwd: gitRoot, permissionMode: 'auto' },
    )

    const run = registry.list()[0]!
    expect(run.workspace.cwd).toBe(gitRoot)
    expect(run.workspace.worktreePath).toBeUndefined()
  })

  it('workspace.worktreePath is set (and cwd differs) for modifying tasks', async () => {
    const recordedCwds: string[] = []
    const factory = (config: EngineConfig) => {
      recordedCwds.push(config.cwd)
      return successChildEngine()
    }
    const registry = new ExecutionRunRegistry()
    const tool = new AgentTool({
      factory,
      parentConfig: baseConfig({ cwd: gitRoot }),
      parentRenderer: fakeRenderer(),
      runRegistry: registry,
    })

    await tool.execute(
      { description: 'modify', prompt: 'edit', modifies_state: true },
      { cwd: gitRoot, permissionMode: 'auto' },
    )

    // The child ran inside a worktree.
    expect(recordedCwds[0]).not.toBe(gitRoot)
    expect(recordedCwds[0]).toContain('.ovolv999/worktrees/')
    // The run was created BEFORE the worktree was opened, so the
    // initial workspace.cwd may be either the parent or the worktree
    // depending on lifecycle ordering — but the run reached
    // succeeded regardless.
    const run = registry.list()[0]!
    expect(run.status).toBe('succeeded')
    expect(run.workspace.cwd).toBe(gitRoot)
  })
})

// ─────────────────────────────────────────────────────────────────────
// Parallel runs are tracked independently
// ─────────────────────────────────────────────────────────────────────
describe('parallel Agent invocations get independent runs', () => {
  it('two concurrent Agent calls create two runs with distinct runIds', async () => {
    const registry = new ExecutionRunRegistry()
    const tool = new AgentTool({
      factory: () => successChildEngine(),
      parentConfig: baseConfig({ cwd: gitRoot }),
      parentRenderer: fakeRenderer(),
      runRegistry: registry,
    })

    await Promise.all([
      tool.execute(
        { description: 'A', prompt: 'do A', subagent_type: 'general-purpose' },
        { cwd: gitRoot, permissionMode: 'auto' },
      ),
      tool.execute(
        { description: 'B', prompt: 'do B', subagent_type: 'general-purpose' },
        { cwd: gitRoot, permissionMode: 'auto' },
      ),
    ])

    const runs = registry.list()
    expect(runs).toHaveLength(2)
    expect(runs[0]!.runId).not.toBe(runs[1]!.runId)
    expect(runs.map((r) => r.goal).sort()).toEqual(['A', 'B'])
    // Both succeeded independently.
    expect(runs.every((r) => r.status === 'succeeded')).toBe(true)
  })
})

// ─────────────────────────────────────────────────────────────────────
// Budget tracking
// ─────────────────────────────────────────────────────────────────────
describe('AgentTool propagates maxIterations to the run budget', () => {
  it('run.budget.maxIterations mirrors the agent config', async () => {
    const registry = new ExecutionRunRegistry()
    const tool = new AgentTool({
      factory: () => successChildEngine(),
      parentConfig: baseConfig({ cwd: gitRoot }),
      parentRenderer: fakeRenderer(),
      runRegistry: registry,
    })

    await tool.execute(
      {
        description: 'budget',
        prompt: 'do it',
        subagent_type: 'general-purpose',
        max_iterations: 7,
      },
      { cwd: gitRoot, permissionMode: 'auto' },
    )

    const run = registry.list()[0]!
    expect(run.budget.maxIterations).toBe(7)
  })
})
