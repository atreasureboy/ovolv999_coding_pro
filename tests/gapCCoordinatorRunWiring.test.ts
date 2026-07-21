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

    const registry = e.getRunRegistry()!
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

    const registry = e.getRunRegistry()!
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
describe('GAP-C.2: backward-compat when executionRunLogDir is unset', () => {
  it('does not expose a registry and still runs the turn', async () => {
    const { c, e } = makeEngine()
    c.push(stopStream('hi'))
    const result = await e.runTurn('hello', [])
    expect(result.result.reason).toBe('stop_sequence')
    expect(e.getRunRegistry()).toBeUndefined()
  })
})

// ─────────────────────────────────────────────────────────────────────
// GAP-C.3: runLoop() mints a kind='loop' parent run
// ─────────────────────────────────────────────────────────────────────
describe('GAP-C.3: runLoop mints kind=loop parent run', () => {
  it('creates a kind=loop run and transitions succeeded when DONE.flag is set', async () => {
    const logDir = join(tmp, 'logs')
    const loopDir = join(tmp, '.loop')
    mkdirSync(loopDir, { recursive: true })
    // Write the loop-kit files required by runLoop.
    const { writeFileSync } = await import('fs')
    writeFileSync(join(loopDir, 'GOAL.md'), 'Prove the loop works\n')
    writeFileSync(join(loopDir, 'ACCEPTANCE.md'), '')
    writeFileSync(join(loopDir, 'STATE.md'), 'idle')
    // Pre-create DONE.flag so the loop exits at iteration 1 immediately.
    writeFileSync(join(loopDir, 'DONE.flag'), 'pre-set\n')

    const { c, e } = makeEngine(logDir)
    // runLoop imports runLoop from the source — but the engine config
    // has cwd=/tmp. We pass our own loopDir via a config override.
    const { runLoop } = await import('../src/core/loopEngine.js')
    // The loop engine takes its own LoopConfig; pass the loopDir we set up.
    await runLoop(e, fakeRenderer(), {
      cwd: tmp,
      loopDir,
      maxIters: 3,
    })

    const registry = e.getRunRegistry()!
    const loopRuns = registry.list({ kind: 'loop' })
    expect(loopRuns.length).toBe(1)
    expect(loopRuns[0].status).toBe('succeeded')
    // c was never called: loop exits before the first LLM turn.
    expect(c.createCalls).toBe(0)
  })
})
