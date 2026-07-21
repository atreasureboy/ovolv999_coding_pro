/**
 * P0-3 regression: AgentTool false success on verification failure.
 *
 * Invariant (fi_goal.md §P0-3): a sub-agent that "succeeds" (engine
 * reason !== 'error') but leaves the workspace with failing
 * typecheck/lint/test MUST propagate as isError: true to the parent.
 * Otherwise the parent has no structured signal and must parse the
 * natural-language "[Verify Gate] ✗" blob to discover the failure.
 *
 * Pre-fix: AgentTool returned isError:false unconditionally when the
 * child engine finished without throwing, regardless of verify-gate
 * outcome. The verify result was stuffed into the content string but
 * the boolean signal lied.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

import { AgentTool } from '../src/tools/agent.js'
import type { EngineConfig } from '../src/core/types.js'
import type { Renderer } from '../src/ui/renderer.js'

// ── Harness ────────────────────────────────────────────────────────────────

function fakeRenderer(): Renderer & { __calls: { kind: string; args: unknown[] }[] } {
  const calls: { kind: string; args: unknown[] }[] = []
  const r: Record<string, unknown> = { __calls: calls }
  for (const k of [
    'banner', 'info', 'warn', 'error', 'success',
    'startSpinner', 'stopSpinner',
    'beginAssistantText', 'endAssistantText', 'streamToken',
    'toolStart', 'toolResult',
    'compactStart', 'compactDone', 'contextWarning',
    'agentStart', 'agentDone', 'agentSummary', 'agentHeartbeat',
  ]) {
    r[k] = (...a: unknown[]) => { calls.push({ kind: k, args: a }) }
  }
  return r as unknown as Renderer & { __calls: typeof calls }
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

/** Build a child engine stub that "succeeds" with a given output. */
function successChildEngine(output = 'I did the work.') {
  return {
    runTurn: () => Promise.resolve({
      result: { output, reason: 'stop_sequence' as const },
      newHistory: [],
    }),
    abort: () => undefined,
    dispose: () => undefined,
  }
}

/** Build a child engine stub whose runTurn returns reason='error'. */
function errorChildEngine() {
  return {
    runTurn: () => Promise.resolve({
      result: { output: 'failed mid-run', reason: 'error' as const },
      newHistory: [],
    }),
    abort: () => undefined,
    dispose: () => undefined,
  }
}

let tmpRoot = ''
beforeEach(() => { tmpRoot = mkdtempSync(`${tmpdir()}/p0-3-`) })
afterEach(() => { rmSync(tmpRoot, { recursive: true, force: true }) })

/** Write a package.json whose `test` script is guaranteed to fail. */
function writeFailingPackageJson(dir: string): void {
  writeFileSync(
    join(dir, 'package.json'),
    JSON.stringify({
      name: 'p0-3-fixture',
      scripts: { test: 'node -e "process.exit(2)"' },
    }, null, 2),
  )
}

/** Write a package.json whose `test` script passes. */
function writePassingPackageJson(dir: string): void {
  writeFileSync(
    join(dir, 'package.json'),
    JSON.stringify({
      name: 'p0-3-fixture',
      scripts: { test: 'node -e "process.exit(0)"' },
    }, null, 2),
  )
}

// ─────────────────────────────────────────────────────────────────────
// P0-3.A: success path is unchanged (no regression)
// ─────────────────────────────────────────────────────────────────────
describe('P0-3.A: AgentTool success path', () => {
  it('returns isError:false when the child succeeds and verify passes', async () => {
    writePassingPackageJson(tmpRoot)
    const parentConfig = baseConfig({
      cwd: tmpRoot,
      agentFactory: () => successChildEngine(),
    })
    const tool = new AgentTool({
      factory: () => successChildEngine(),
      parentConfig,
      parentRenderer: fakeRenderer(),
    })
    const out = await tool.execute(
      { description: 'work', prompt: 'do it', subagent_type: 'general-purpose', verify: true },
      { cwd: tmpRoot, permissionMode: 'auto' },
    )
    expect(out.isError).toBe(false)
    expect(out.content).toContain('work')
  })

  it('returns isError:false when verify is omitted (default off)', async () => {
    const parentConfig = baseConfig({
      cwd: tmpRoot,
      agentFactory: () => successChildEngine(),
    })
    const tool = new AgentTool({
      factory: () => successChildEngine(),
      parentConfig,
      parentRenderer: fakeRenderer(),
    })
    const out = await tool.execute(
      { description: 'work', prompt: 'do it', subagent_type: 'general-purpose' },
      { cwd: tmpRoot, permissionMode: 'auto' },
    )
    expect(out.isError).toBe(false)
  })
})

// ─────────────────────────────────────────────────────────────────────
// P0-3.B: verify-gate failure now propagates as isError:true
// ─────────────────────────────────────────────────────────────────────
describe('P0-3.B: AgentTool verify-gate failure propagates isError:true', () => {
  it('returns isError:true when child succeeded but verify failed', async () => {
    writeFailingPackageJson(tmpRoot)
    const parentConfig = baseConfig({
      cwd: tmpRoot,
      agentFactory: () => successChildEngine(),
    })
    const tool = new AgentTool({
      factory: () => successChildEngine(),
      parentConfig,
      parentRenderer: fakeRenderer(),
    })
    const out = await tool.execute(
      { description: 'broken-work', prompt: 'do it', subagent_type: 'general-purpose', verify: true },
      { cwd: tmpRoot, permissionMode: 'auto' },
    )
    // CRITICAL INVARIANT: the parent now sees a structured failure
    // signal — it does NOT have to parse the "[Verify Gate] ✗"
    // natural-language blob inside content.
    expect(out.isError).toBe(true)
    expect(out.content).toContain('[Verify Gate] ✗')
  })

  it('does NOT run verify or mark isError when planMode is active', async () => {
    writeFailingPackageJson(tmpRoot)
    const parentConfig = baseConfig({
      cwd: tmpRoot,
      agentFactory: () => successChildEngine(),
    })
    const tool = new AgentTool({
      factory: () => successChildEngine(),
      parentConfig,
      parentRenderer: fakeRenderer(),
    })
    const out = await tool.execute(
      {
        description: 'plan-only',
        prompt: 'read only',
        subagent_type: 'general-purpose',
        verify: true,
        // agent_config overrides the preset; identity.planMode=true
        // marks this as a read-only delegation, so verify is skipped.
        agent_config: { identity: { systemPrompt: 'plan-only agent', planMode: true } },
      },
      { cwd: tmpRoot, permissionMode: 'auto' },
    )
    // Plan-mode agents are read-only — verify gate is intentionally
    // skipped (no mutations to verify against).
    expect(out.isError).toBe(false)
    expect(out.content).not.toContain('[Verify Gate]')
  })
})

// ─────────────────────────────────────────────────────────────────────
// P0-3.C: engine-error path still surfaces isError:true
// ─────────────────────────────────────────────────────────────────────
describe('P0-3.C: AgentTool engine-error path', () => {
  it('returns isError:true when child engine returned reason="error"', async () => {
    const parentConfig = baseConfig({
      cwd: tmpRoot,
      agentFactory: () => errorChildEngine(),
    })
    const tool = new AgentTool({
      factory: () => errorChildEngine(),
      parentConfig,
      parentRenderer: fakeRenderer(),
    })
    const out = await tool.execute(
      { description: 'boom', prompt: 'do it', subagent_type: 'general-purpose', verify: true },
      { cwd: tmpRoot, permissionMode: 'auto' },
    )
    expect(out.isError).toBe(true)
  })
})

// ─────────────────────────────────────────────────────────────────────
// P0-3.D: structured propagation — content includes machine-readable marker
// ─────────────────────────────────────────────────────────────────────
describe('P0-3.D: AgentTool result content surfaces failure marker', () => {
  it('verify failure content contains the canonical "[Verify Gate] ✗" sentinel', async () => {
    writeFailingPackageJson(tmpRoot)
    const parentConfig = baseConfig({
      cwd: tmpRoot,
      agentFactory: () => successChildEngine(),
    })
    const tool = new AgentTool({
      factory: () => successChildEngine(),
      parentConfig,
      parentRenderer: fakeRenderer(),
    })
    const out = await tool.execute(
      { description: 'marker-test', prompt: 'do it', subagent_type: 'general-purpose', verify: true },
      { cwd: tmpRoot, permissionMode: 'auto' },
    )
    // The parent LLM only sees content (isError isn't threaded into
    // the tool message today — that's a separate Phase 5 fix). At
    // minimum the canonical sentinel must be present so a careful
    // parent can detect the failure even without structured isError.
    expect(out.content).toContain('[Verify Gate] ✗')
  })
})
