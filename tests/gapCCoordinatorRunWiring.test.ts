/**
 * GAP-C: turn + loop ExecutionRun wiring.
 *
 * Verifies:
 *  - When `executionRunLogDir` is set, each `engine.runTurn()` mints
 *    a `kind='turn'` run in the registry and walks it through
 *    queued → preparing → running → succeeded/failed/cancelled.
 *  - When `executionRunLogDir` is NOT set, behaviour is byte-for-byte
 *    pre-GAP-C (no run mints, no event writes).
 *  - `runLoop()` mints a parent `kind='loop'` run.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { tmpdir } from 'os'
import { mkdtempSync, rmSync, mkdirSync } from 'fs'
import { join } from 'path'
import { ExecutionEngine } from '../src/core/engine.js'
import type { EngineConfig, Tool } from '../src/core/types.js'
import type { Renderer } from '../src/ui/renderer.js'

// ── Queue-based fake OpenAI (mirrors runtime3/coordinatorContinuation) ──
type Queued = { k: 's'; s: AsyncIterable<unknown> } | { k: 'e'; e: Error }
class FakeOpenAI {
  createCalls = 0
  private q: Queued[] = []
  chat = {
    completions: {
      create: (_p: Record<string, unknown>, o: { signal: AbortSignal }) => {
        this.createCalls++
        const n = this.q[this.createCalls - 1] ?? { k: 'e' as const, e: new Error('parked') }
        return new Promise<AsyncIterable<unknown>>((res, rej) => {
          if (o.signal.aborted) { rej(new Error('aborted')); return }
          o.signal.addEventListener('abort', () => rej(new Error('aborted')), { once: true })
          if (n.k === 's') res(n.s); else rej(n.e)
        })
      },
    },
  }
  push(s: AsyncIterable<unknown>) { this.q.push({ k: 's', s }) }
  pushError(e: Error) { this.q.push({ k: 'e', e }) }
}

async function* stopStream(text: string): AsyncIterable<unknown> {
  await Promise.resolve()
  yield {
    choices: [{ delta: { content: text }, index: 0, finish_reason: 'stop' }],
    usage: { prompt_tokens: 1, completion_tokens: Math.ceil(text.length / 4) },
  }
}

function fakeRenderer(): Renderer {
  const r: Record<string, (...args: unknown[]) => void> = {}
  for (const k of [
    'banner', 'raw', 'info', 'warn', 'error', 'success',
    'startSpinner', 'stopSpinner',
    'beginAssistantText', 'endAssistantText', 'streamToken',
    'assistantMessage', 'userMessage', 'toolCall', 'toolStart',
    'toolResult', 'compactStart', 'compactDone', 'contextWarning',
    'cost', 'compactionNotice', 'turnEnd', 'planModeHeader',
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

function makeEngine(logDir?: string, tools: Tool[] = []) {
  const c = new FakeOpenAI()
  const cfg = logDir ? baseConfig({ extraTools: tools, executionRunLogDir: logDir }) : baseConfig({ extraTools: tools })
  const e = new ExecutionEngine(cfg, fakeRenderer(), c as unknown as never)
  return { c, e }
}

let tmp = ''
beforeEach(() => { tmp = mkdtempSync(`${tmpdir()}/gapC-`) })
afterEach(() => { rmSync(tmp, { recursive: true, force: true }) })

// ─────────────────────────────────────────────────────────────────────
// GAP-C.1: a successful turn mints kind='turn' run → succeeded
// ─────────────────────────────────────────────────────────────────────
describe('GAP-C.1: successful turn records run lifecycle', () => {
  it('creates a kind=turn run and transitions to succeeded on stop_sequence', async () => {
    const logDir = join(tmp, 'logs')
    const { c, e } = makeEngine(logDir)
    c.push(stopStream('hi'))
    const result = await e.runTurn('hello', [])
    expect(result.result.reason).toBe('stop_sequence')

    const registry = e.getRunRegistry()
    const turnRuns = registry.list({ kind: 'turn' })
    expect(turnRuns.length).toBe(1)
    expect(turnRuns[0].status).toBe('succeeded')
    expect(turnRuns[0].phase).toBe('completed')
    expect(turnRuns[0].workspace.cwd).toBe('/tmp')
    // goal is the user message headline (truncated)
    expect(turnRuns[0].goal).toBe('hello')
  })

  it('transitions to failed when the stream errors', async () => {
    const logDir = join(tmp, 'logs')
    const { c, e } = makeEngine(logDir)
    c.pushError(new Error('upstream 500'))
    const result = await e.runTurn('hello', [])
    expect(result.result.reason).toBe('error')

    const registry = e.getRunRegistry()
    const turnRuns = registry.list({ kind: 'turn' })
    expect(turnRuns.length).toBe(1)
    expect(turnRuns[0].status).toBe('failed')
    // Error field captures the failure message — either the engine's
    // default (result.output) or a generic 'turn failed' fallback.
    expect(turnRuns[0].error).toMatch(/upstream 500|turn failed/)
  })
})

// ─────────────────────────────────────────────────────────────────────
// GAP-C.2: no registry when executionRunLogDir is unset → back-compat
// ─────────────────────────────────────────────────────────────────────
describe('GAP-C.2: registry always present (runtime invariants P0-1)', () => {
  it('exposes a registry even without executionRunLogDir and runs the turn', async () => {
    const { c, e } = makeEngine()
    c.push(stopStream('hi'))
    const result = await e.runTurn('hello', [])
    expect(result.result.reason).toBe('stop_sequence')
    // runtime invariants P0-1: registry is ALWAYS present; only the EventStore
    // (persistence) is optional.
    expect(e.getRunRegistry()).toBeDefined()
    expect(e.getRunEventBus()).toBeDefined()
  })
})

// ─────────────────────────────────────────────────────────────────────
// GAP-C.3: runLoop() mints a kind='loop' parent run
// ─────────────────────────────────────────────────────────────────────
describe('GAP-C.3: runLoop mints kind=loop parent run', () => {
  it('creates a kind=loop run and transitions succeeded when a resumed checkpoint records success (ADR-007)', async () => {
    const logDir = join(tmp, 'logs')
    const loopDir = join(tmp, '.loop')
    mkdirSync(loopDir, { recursive: true })
    // Write the autonomous-loop files required by runLoop.
    const { writeFileSync } = await import('fs')
    writeFileSync(join(loopDir, 'GOAL.md'), 'Prove the loop works\n')
    writeFileSync(join(loopDir, 'ACCEPTANCE.md'), '')
    writeFileSync(join(loopDir, 'STATE.md'), 'idle')
    // ADR-007: completion is recorded in the checkpoint, not in a forgeable
    // flag. A phase='succeeded' checkpoint (as left by finishLoopRun, or by
    // a crash between checkpoint save and flag write) must short-circuit a
    // resumed loop straight to success — no iterations, no LLM calls.
    writeFileSync(join(loopDir, 'checkpoint.json'), JSON.stringify({
      schemaVersion: 2, sequence: 9, taskId: 'Prove the loop works', branch: 'detached',
      worktree: tmp, iteration: 2, phase: 'succeeded', runId: 'prior-run',
      passedQualityGates: ['typecheck', 'lint', 'test', 'build'],
      goalHash: 'irrelevant', acceptanceHash: 'irrelevant',
      changedFiles: [], consecutiveNoProgress: 0,
      consecutiveProviderFailures: 0,
      createdAt: '2026-07-28T00:00:00.000Z', updatedAt: '2026-07-28T00:00:00.000Z',
    }, null, 2) + '\n')

    const { c, e } = makeEngine(logDir)
    const { runLoop } = await import('../src/core/loopEngine.js')
    // The loop engine takes its own LoopConfig; pass the loopDir we set up.
    await runLoop(e, fakeRenderer(), {
      cwd: tmp,
      loopDir,
      maxIters: 3,
    })

    const registry = e.getRunRegistry()
    const loopRuns = registry.list({ kind: 'loop' })
    expect(loopRuns.length).toBe(1)
    expect(loopRuns[0].status).toBe('succeeded')
    // c was never called: loop exits before the first LLM turn.
    expect(c.createCalls).toBe(0)
  })

  it('rejects a legacy/forged plaintext DONE.flag and refuses to complete (ADR-007)', async () => {
    // Three loop iterations, each spawning git + quality-gate probes —
    // comfortably under a minute, well over the 5s default on Windows.
    const logDir = join(tmp, 'logs')
    const loopDir = join(tmp, '.loop')
    mkdirSync(loopDir, { recursive: true })
    const { writeFileSync, existsSync, readFileSync } = await import('fs')
    writeFileSync(join(loopDir, 'GOAL.md'), 'Prove the loop works\n')
    writeFileSync(join(loopDir, 'ACCEPTANCE.md'), '')
    writeFileSync(join(loopDir, 'STATE.md'), 'idle')
    // The pre-ADR-007 forgery: a model-written flag containing the magic
    // substring. The old substring check accepted this; the binding
    // verification must rename it and keep looping.
    writeFileSync(join(loopDir, 'DONE.flag'), 'DRIVER_VERIFIED pre-set\n')

    const { c, e } = makeEngine(logDir)
    const { runLoop } = await import('../src/core/loopEngine.js')
    await runLoop(e, fakeRenderer(), {
      cwd: tmp,
      loopDir,
      maxIters: 3,
    })

    // The flag was rejected as evidence, not honored.
    expect(existsSync(join(loopDir, 'DONE.flag'))).toBe(false)
    expect(existsSync(join(loopDir, 'DONE.flag.rejected'))).toBe(true)
    expect(readFileSync(join(loopDir, 'DONE.flag.rejected'), 'utf8')).toContain('DRIVER_VERIFIED pre-set')
    // The loop ran its iterations (all failing to complete) instead of
    // exiting succeeded on the forged flag.
    const loopRuns = e.getRunRegistry().list({ kind: 'loop' })
    expect(loopRuns.length).toBe(1)
    expect(loopRuns[0].status).not.toBe('succeeded')
    expect(c.createCalls).toBe(3)
  }, 60_000)
})

// ─────────────────────────────────────────────────────────────────────
// GAP-C.4: parentRunId threading (P1-2 fix + P2-7 coverage)
//
// Before the P1-2 fix, engine.runTurn() accepted no parentRunId, so a
// loop's child turns — and every grandchild Agent/Worker run — were
// orphans (parentRunId=undefined), breaking the hierarchical Run tree.
// This verifies the per-turn parentRunId override reaches the turn run.
// ─────────────────────────────────────────────────────────────────────
describe('GAP-C.4: runTurn threads parentRunId into the turn run', () => {
  it('sets the turn run parentRunId from the opts override', async () => {
    const logDir = join(tmp, 'logs')
    const { c, e } = makeEngine(logDir)
    c.push(stopStream('hi'))
    await e.runTurn('hello', [], undefined, { parentRunId: 'loop-parent-42' })

    const registry = e.getRunRegistry()
    const turnRuns = registry.list({ kind: 'turn' })
    expect(turnRuns.length).toBe(1)
    expect(turnRuns[0].parentRunId).toBe('loop-parent-42')
  })

  it('omits parentRunId when no override is given (back-compat)', async () => {
    const logDir = join(tmp, 'logs')
    const { c, e } = makeEngine(logDir)
    c.push(stopStream('hi'))
    await e.runTurn('hello', [])

    const turnRuns = e.getRunRegistry().list({ kind: 'turn' })
    expect(turnRuns.length).toBe(1)
    expect(turnRuns[0].parentRunId).toBeUndefined()
  })
})
