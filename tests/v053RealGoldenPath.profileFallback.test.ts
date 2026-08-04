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
    const cfg = baseConfig({
      baseURL: fx.baseURL,
      cwd: tmpProj,
      provider: 'openai-compatible',
      permissionMode: 'bypassPermissions',
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
      // We intentionally do NOT dispose; the engine is needed for
      // subsequent turns.
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
      console.log('routing events:', seen.filter((e) => e.type === 'ROUTING_FALLBACK_APPLIED').length)
      try {
        // eslint-disable-next-line no-console
        console.log('event log:', JSON.stringify(cfg.eventLog?.readAll?.() ?? [], null, 2))
      } catch {}
    }

    // (1) The fixture saw BOTH model-a and model-b on the wire —
    //     this is the entire point of the test. We previously
    //     asserted model-b was reached but in fact the engine only
    //     ever called model-a (fake Golden Path).
    const seenA = fx.requests.some((r) => r.model === 'model-a')
    const seenB = fx.requests.some((r) => r.model === 'model-b')
    expect(seenA).toBe(true)
    expect(seenB).toBe(true)

    // (2) At least one model-a attempt FAILED and at least one
    //     model-b attempt SUCCEEDED — both went through the real
    //     ModelGateway.attempt chain, not the fake recordCall path.
    expect(outcome.modelAttempts.some((a) => a.model === 'model-a' && a.status === 'failed')).toBe(true)
    expect(outcome.modelAttempts.some((a) => a.model === 'model-b' && a.status === 'succeeded')).toBe(true)

    // (3) The Router's internal ROUTING_FALLBACK_APPLIED event is
    //     fired into the Router's own listener (not the Engine's
    //     RunEventEmitter). The behaviour contract is observable
    //     through the modelAttempts array: at least one failed
    //     model-a attempt AND at least one succeeded model-b
    //     attempt prove the Router actually advanced from A to B.
    //     The previous fake test injected emitFallback by hand —
    //     that path is not reached from Coordinator onProviderError.
    void seen

    // (4) The Write tool executed via the real ToolScheduler →
    //     ToolExecutor chain. The side effect is observable on disk.
    const filePath = join(tmpProj, 'b.txt')
    expect(existsSync(filePath)).toBe(true)
    expect(outcome.changedFiles).toContain('b.txt')

    // (5) The completion is at least not 'cancelled'/'exhausted' —
    //     it landed either 'completed' OR 'partial' (CompletionContract
    //     correctly demoted because no Bash verification followed).
    //     Both are valid; 'failed' (engine threw) is not.
    expect(['completed', 'partial']).toContain(outcome.completion.status)
    } finally {
      process.chdir(originalCwd)
    }
  }, TIMEOUT)
})
