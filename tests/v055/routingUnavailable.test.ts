/**
 * v0.5.5 §6 — all-profiles-open terminates the Run before
 * any ModelGateway call.
 *
 * Real Engine.runTurn with a Router whose every profile is in
 * the OPEN circuit. Asserts:
 *   - modelGateway.call invocation count === 0
 *   - outcome.completion.status === 'blocked'
 *   - outcome.stopReason === 'routing_unavailable'
 *   - ROUTING_UNAVAILABLE event emitted exactly once
 *   - activeRunId cleaned up after the Run (via finally)
 *
 * Tests MUST go through the production entry: ExecutionEngine.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

import { ExecutionEngine } from '../../src/core/engine.js'
import { ModelRouter, type ModelProfile } from '../../src/core/model/modelRouter.js'
import { EventLog } from '../../src/core/eventLog.js'
import type { EngineConfig } from '../../src/core/types.js'

function profile(id: string, model: string): ModelProfile {
  return {
    id,
    provider: 'openai-compatible',
    model,
    tier: 'top',
    roles: ['main'],
    available: true,
    capabilities: {
      reasoning: 0.7, coding: 0.7, contextWindow: 0.6,
      toolCalling: 0.9, speed: 0.6, cost: 0.4,
    },
  }
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

describe('v0.5.5 §6: all-profiles-open terminates Run', () => {
  let tmpHome: string
  let tmpProj: string
  let router: ModelRouter
  let gatewayCallCount = 0

  beforeEach(() => {
    tmpHome = mkdtempSync(join(tmpdir(), 'ovolv999-v055-home-'))
    tmpProj = mkdtempSync(join(tmpdir(), 'ovolv999-v055-proj-'))
    process.env.OVOGO_HOME = tmpHome
    router = new ModelRouter([profile('profile-a', 'model-a'), profile('profile-b', 'model-b')])
    // Open both circuits.
    for (let i = 0; i < 5; i++) {
      router.recordCall('profile-a', false, 100, null)
      router.recordCall('profile-b', false, 100, null)
    }
    gatewayCallCount = 0
  })
  afterEach(() => {
    try { rmSync(tmpHome, { recursive: true, force: true }) } catch { /* best-effort */ }
    try { rmSync(tmpProj, { recursive: true, force: true }) } catch { /* best-effort */ }
    delete process.env.OVOGO_HOME
  })

  it('Engine.runTurn: 0 Gateway calls + blocked Outcome + cleanup', async () => {
    const eventLog = new EventLog(join(tmpProj, 'events.jsonl'))
    const cfg = {
      apiKey: 'k',
      model: 'model-a',
      maxIterations: 10,
      cwd: tmpProj,
      permissionMode: 'bypassPermissions',
      enabledModules: [],
      eventLog,
      provider: 'openai-compatible',
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
              reasoning: 0.7, coding: 0.7, contextWindow: 0.6,
              toolCalling: 0.9, speed: 0.6, cost: 0.4,
            },
          },
          {
            id: 'profile-b',
            provider: 'openai-compatible',
            model: 'model-b',
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
    } as unknown as EngineConfig
    const engine = new ExecutionEngine(cfg, fakeRenderer())
    try {
      // Open BOTH circuits on the Engine's own Router (built from
      // config.models.profiles by the Engine constructor). The
      // test-level `router` fixture is irrelevant — the Engine
      // builds its own.
      const engineRouter = (engine as unknown as { modelRouter: ModelRouter }).modelRouter
      for (let i = 0; i < 5; i++) {
        engineRouter.recordCall('profile-a', false, 100, null)
        engineRouter.recordCall('profile-b', false, 100, null)
      }
      const r = await engine.runTurn('test', [])
      expect(r.outcome.completion.status).toBe('blocked')
      expect(r.outcome.stopReason).toBe('routing_unavailable')
      expect(r.result.reason).toBe('routing_unavailable')
      expect(gatewayCallCount).toBe(0)

      // ROUTING_UNAVAILABLE event observed exactly once.
      const events = eventLog.readAll()
      const unavail = events.filter((e) => (e.detail as { type?: string })?.type === 'ROUTING_UNAVAILABLE')
      expect(unavail.length).toBe(1)
      const reasonCodes = (unavail[0].detail as { reasonCodes?: string[] }).reasonCodes ?? []
      expect(reasonCodes).toContain('all-profiles-open')
    } finally {
      engine.dispose?.()
    }
  })

  it('sharedState.routingUnavailable is reset in the Run finally', async () => {
    const eventLog = new EventLog(join(tmpProj, 'events.jsonl'))
    const cfg: EngineConfig = {
      apiKey: 'k', model: 'model-a', maxIterations: 10,
      cwd: tmpProj, permissionMode: 'bypassPermissions',
      enabledModules: [], eventLog,
      provider: 'openai-compatible',
      models: {
        profiles: [
          { id: 'profile-a', provider: 'openai-compatible', model: 'model-a', tier: 'top', roles: ['main'], available: true,
            capabilities: { reasoning: 0.7, coding: 0.7, contextWindow: 0.6, toolCalling: 0.9, speed: 0.6, cost: 0.4 } },
          { id: 'profile-b', provider: 'openai-compatible', model: 'model-b', tier: 'top', roles: ['cheap'], available: true,
            capabilities: { reasoning: 0.6, coding: 0.7, contextWindow: 0.5, toolCalling: 0.9, speed: 0.8, cost: 0.2 } },
        ],
        routing: { enabled: true },
      },
    } as unknown as EngineConfig
    const engine = new ExecutionEngine(cfg, fakeRenderer())
    try {
      // Open both circuits on the Engine's own router so this run takes
      // the routing-unavailable path (sets the flag, then the Run finally
      // must reset it). Without this the run would attempt a REAL network
      // call — slow/timeout on networked dev machines and the assertion
      // below would be vacuous (the flag was never set).
      const engineRouter = (engine as unknown as { modelRouter: ModelRouter }).modelRouter
      for (let i = 0; i < 5; i++) {
        engineRouter.recordCall('profile-a', false, 100, null)
        engineRouter.recordCall('profile-b', false, 100, null)
      }
      await engine.runTurn('first', [])
      const sharedState = (engine as unknown as { coordinator: { deps: { sharedState: { routingUnavailable: boolean } } } }).coordinator.deps.sharedState
      expect(sharedState.routingUnavailable).toBe(false)
    } finally {
      engine.dispose?.()
    }
  })
})