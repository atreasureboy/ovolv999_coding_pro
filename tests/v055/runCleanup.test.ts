/**
 * v0.5.5 §16 — Run cleanup on every exit path.
 *
 * The Coordinator.run() body is wrapped in an outer try/catch/finally.
 * activeRunId, runContextStore.close(), candidateSink.close(),
 * routingUnavailable reset MUST all run regardless of which path
 * the body takes: boot failure, identity failure, router
 * unavailable, context abort.
 *
 * Tests go through the real Engine.runTurn so a failure anywhere
 * in the boot/route/state-machine pipeline exercises the finally.
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

describe('v0.5.5 §16: Run cleanup on every exit path', () => {
  let tmpHome: string
  let tmpProj: string
  beforeEach(() => {
    tmpHome = mkdtempSync(join(tmpdir(), 'ovolv999-v055-cleanup-home-'))
    tmpProj = mkdtempSync(join(tmpdir(), 'ovolv999-v055-cleanup-proj-'))
    process.env.OVOGO_HOME = tmpHome
  })
  afterEach(() => {
    try { rmSync(tmpHome, { recursive: true, force: true }) } catch { /* best-effort */ }
    try { rmSync(tmpProj, { recursive: true, force: true }) } catch { /* best-effort */ }
    delete process.env.OVOGO_HOME
  })

  it('all-profiles-open path: activeRunId cleared, routingUnavailable reset', async () => {
    const eventLog = new EventLog(join(tmpProj, 'events.jsonl'))
    const router = new ModelRouter([profile('profile-a', 'model-a'), profile('profile-b', 'model-b')], { enabled: true })
    for (let i = 0; i < 5; i++) {
      router.recordCall('profile-a', false, 100, null)
      router.recordCall('profile-b', false, 100, null)
    }
    const cfg = {
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
      await engine.runTurn('first', [])
      const sharedState = (engine as unknown as { coordinator: { deps: { sharedState: { routingUnavailable: boolean; activeRunId: string | null } } } }).coordinator.deps.sharedState
      expect(sharedState.routingUnavailable).toBe(false)
      expect(sharedState.activeRunId).toBe(null)
    } finally {
      engine.dispose?.()
    }
  })

  it('consecutive runTurn calls: each closes its own RunContext', async () => {
    const eventLog = new EventLog(join(tmpProj, 'events.jsonl'))
    const cfg = {
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
      // Run 1
      await engine.runTurn('first', [])
      let sharedState = (engine as unknown as { coordinator: { deps: { sharedState: { activeRunId: string | null; routingUnavailable: boolean } } } }).coordinator.deps.sharedState
      expect(sharedState.activeRunId).toBe(null)

      // Run 2 — opens circuits again to force unavailable, proves
      // each Run's cleanup is independent.
      const engineRouter = (engine as unknown as { modelRouter: ModelRouter }).modelRouter
      for (let i = 0; i < 5; i++) {
        engineRouter.recordCall('profile-a', false, 100, null)
        engineRouter.recordCall('profile-b', false, 100, null)
      }
      await engine.runTurn('second', [])
      sharedState = (engine as unknown as { coordinator: { deps: { sharedState: { activeRunId: string | null; routingUnavailable: boolean } } } }).coordinator.deps.sharedState
      expect(sharedState.activeRunId).toBe(null)
      expect(sharedState.routingUnavailable).toBe(false)
    } finally {
      engine.dispose?.()
    }
  })
})