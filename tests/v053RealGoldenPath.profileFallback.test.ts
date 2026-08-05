/**
 * v0.5.3 Final (P0 issue): real end-to-end Profile A → Profile B
 * fallback Golden Path.
 *
 *   model-a 503  →  Router.nextFallback('model-a') = 'model-b'
 *               →  onProviderError returns 'model-b'
 *               →  Gateway.stream with model='model-b'
 *               →  Engine receives Write tool call
 *               →  Write tool writes b.txt on disk
 *               →  Router ROUTING_FALLBACK_APPLIED event fires
 *               →  outcome.completion.status = 'completed' (or
 *                   'partial' when CompletionContract correctly
 *                   demotes runs without recorded evidence)
 *
 * This replaces the previous Scenario C which only invoked the
 * Router directly without Engine + Coordinator + ModelGateway.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, existsSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

// @ts-expect-error fixture is a plain .mjs without types
import { startEchoServer } from './fixtures/openaiEchoServer.mjs'
import { ExecutionEngine } from '../src/core/engine.js'
import { EventLog } from '../src/core/eventLog.js'
import { readFileSync } from 'fs'
import type { EngineConfig } from '../src/core/types.js'

const TIMEOUT = 90_000

interface FixtureHandle {
  port: number
  baseURL: string
  close: () => Promise<void>
  requests: Array<{ model: string; stream: boolean }>
}

function baseConfig(over: Partial<EngineConfig> = {}): EngineConfig {
  return {
    apiKey: 'test-key',
    model: 'model-a',
    maxIterations: 10,
    cwd: '/tmp',
    permissionMode: 'bypassPermissions',
    enabledModules: [],
    ...over,
  } as EngineConfig
}

function fakeRenderer() {
  const r: Record<string, (...args: unknown[]) => void> = {}
  for (const k of [
    'banner','raw','info','warn','error','success','startSpinner','stopSpinner',
    'beginAssistantText','endAssistantText','streamToken','streamReasoning',
    'assistantMessage','userMessage','toolCall','toolStart','toolResult',
    'compactStart','compactDone','contextWarning','cost','compactionNotice',
    'turnEnd','planModeHeader','agentStart','agentDone','agentSummary',
    'agentHeartbeat','humanPrompt','writePrompt','closePrompt','newline',
  ]) r[k] = () => {}
  return r as never
}

describe('v0.5.3 Final — Profile A → B real end-to-end', () => {
  let fx: FixtureHandle
  let tmpHome: string
  let tmpProj: string

  beforeAll(async () => {
    fx = await startEchoServer({ mode: 'scenario-c' })
  }, TIMEOUT)

  afterAll(async () => {
    await fx.close()
  })

  beforeEach(() => {
    tmpHome = mkdtempSync(join(tmpdir(), 'ovolv999-pf-home-'))
    tmpProj = mkdtempSync(join(tmpdir(), 'ovolv999-pf-proj-'))
  })
  afterEach(() => {
    try { rmSync(tmpHome, { recursive: true, force: true }) } catch { /* best-effort */ }
    try { rmSync(tmpProj, { recursive: true, force: true }) } catch { /* best-effort */ }
  })

  it('Profile A 503 → Router.nextFallback → Gateway retries with B → Engine writes file via real chain', async () => {
    // The Write tool resolves `file_path='b.txt'` against process.cwd().
    // The Engine does not chdir, so we chdir into tmpProj BEFORE
    // starting the run.
    const originalCwd = process.cwd()
    process.chdir(tmpProj)
    try {
    const seen: Array<{ type: string; payload?: unknown }> = []
    void seen
    const eventLog = new EventLog(join(tmpProj, 'events.jsonl'))
    const cfg = baseConfig({
      baseURL: fx.baseURL,
      cwd: tmpProj,
      provider: 'openai-compatible',
      permissionMode: 'bypassPermissions',
      eventLog,
      // Two real profiles sharing the same transport. The wire-
      // level difference is the `model` field.
      models: {
        profiles: [
          {
            id: 'profile-a',
            provider: 'openai-compatible',
            model: 'model-a',
            tier: 'top',
            roles: ['main'],
            available: true,
            capabilities: {
              reasoning: 0.8, coding: 0.8, contextWindow: 0.6,
              toolCalling: 0.9, speed: 0.6, cost: 0.4,
            },
          },
          {
            id: 'profile-b',
            provider: 'openai-compatible',
            model: 'model-b',
            // profile-b is also tier:'top' so the Engine's Router
            // includes it as a fallback candidate. Both profiles
            // share a transport; what changes on the wire is the
            // `model` field.
            tier: 'top',
            roles: ['cheap'],
            available: true,
            capabilities: {
              reasoning: 0.6, coding: 0.7, contextWindow: 0.5,
              toolCalling: 0.9, speed: 0.8, cost: 0.2,
            },
          },
        ],
        routing: { enabled: true },
      },
    })

    const engine = new ExecutionEngine(cfg, fakeRenderer())

    let outcome: import('../src/core/runtime/turnOutcome.js').TurnOutcome
    try {
      const r = await engine.runTurn(
        'write b.txt with content "fallback-ok"',
        [],
      )
      outcome = r.outcome
    } finally {
      // v0.5.3 Hotfix §12: engine.dispose in finally so a
      // failed assertion still releases resources.
      engine.dispose?.()
    }

    if (process.env.DEBUG_FALLBACK) {
      // eslint-disable-next-line no-console
      console.log('fix requests:', fx.requests.map((r, i) => `${i}:${r.model}`).join(' '))
      // eslint-disable-next-line no-console
      console.log('outcome:', JSON.stringify({
        status: outcome.completion.status,
        attempts: outcome.modelAttempts.map((a) => `${a.model}:${a.status}`).join(','),
        stopReason: outcome.stopReason,
        changedFiles: outcome.changedFiles,
      }))
      // eslint-disable-next-line no-console
      console.log('event log:', JSON.stringify(eventLog.readAll(), null, 2))
    }

    // v0.5.3 Closure (P3): STRICT Golden Path. Every assertion is a
    // structural requirement; the previous `expect([0,1,2]).toContain`
    // and `expect(['completed','partial']).toContain` are GONE — a
    // real fallback Golden Path has exactly one correct outcome.
    const seenA = fx.requests.filter((r) => r.model === 'model-a')
    const seenB = fx.requests.filter((r) => r.model === 'model-b')
    void seen

    // (1) Wire shape: the FIRST request is the failed model-a.
    //     The engine may retry model-a multiple times before its
    //     circuit opens, so we only pin requests[0].model='model-a'
    //     and that EVERY model-a attempt failed (no model-a response
    //     was accepted by the engine). All accepted requests are b.
    expect(seenA.length).toBeGreaterThanOrEqual(1)
    expect(fx.requests[0].model).toBe('model-a')
    // v0.5.3 Hotfix §12 — STRUCTURAL fallback invariants:
    //   - model-a's circuit OPENS after the retry budget exhausts
    //   - All NON-model-a requests are model-b
    //   - At least 3 model-b calls (write, bash, completion)
    // The EXACT request count depends on retry-budget + circuit-
    // breaker thresholds (production defaults retry 6 times before
    // opening). The structural assertion is the same-model block
    // pattern: 0..N model-a retries → 0..N model-b.
    expect(fx.requests.every((r, i) => i < seenA.length ? r.model === 'model-a' : r.model === 'model-b')).toBe(true)
    expect(seenB.length).toBeGreaterThanOrEqual(3)

    // (2) Attempt counts: at least one model-a failure; at least
    //     three model-b successes.
    const aFailed = outcome.modelAttempts.filter(
      (a) => a.model === 'model-a' && a.status === 'failed',
    )
    expect(aFailed.length).toBeGreaterThanOrEqual(1)
    const bSucceeded = outcome.modelAttempts.filter(
      (a) => a.model === 'model-b' && a.status === 'succeeded',
    )
    expect(bSucceeded.length).toBeGreaterThanOrEqual(3)

    // (3) Router fallback EXACTLY ONCE per session-turn — the
    //     spec forbids the engine bouncing between A and B on
    //     subsequent turns within one model-b sequence.
    const router = (engine as unknown as { modelRouter?: { getRoutingFailureStats(): { totalFallbacksApplied: number } } }).modelRouter
    expect(router?.getRoutingFailureStats().totalFallbacksApplied).toBe(1)

    // (4) Side-effect tools ran EXACTLY once each: a single Write
    //     followed by a single Bash verify. Reads via the EventLog.
    const toolCalls = eventLog.readAll().filter((e) => e.type === 'tool_call')
    const writeCalls = toolCalls.filter((e) => (e as { source?: string }).source === 'Write').length
    const bashCalls = toolCalls.filter((e) => (e as { source?: string }).source === 'Bash').length
    expect(writeCalls).toBe(1)
    expect(bashCalls).toBe(1)

    // (5) b.txt exists on disk AND content is exactly what the
    //     fixture wrote ('fallback-ok').
    const filePath = join(tmpProj, 'b.txt')
    expect(existsSync(filePath)).toBe(true)
    const onDisk = readFileSync(filePath, 'utf8')
    expect(onDisk).toBe('fallback-ok')
    expect(outcome.changedFiles).toContain('b.txt')

    // (6) Verification ran AND passed (Write succeeded; Bash
    //     cat succeeded; engine recorded both).
    expect(outcome.verification.executed).toBe(true)
    expect(outcome.verification.passed).toBe(true)
    expect(outcome.verification.failed.length).toBe(0)

    // (7) Completion status: completed. NOT partial. NOT failed.
    //     NOT cancelled. Completed. Period.
    expect(outcome.completion.status).toBe('completed')
    } finally {
      process.chdir(originalCwd)
    }
  }, TIMEOUT)
})
