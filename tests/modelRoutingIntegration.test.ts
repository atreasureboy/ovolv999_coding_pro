/**
 * Phase 2 main-path integration: per-turn adaptive model routing.
 * Proves the engine actually SWITCHES models based on goal complexity
 * (multi-profile config, no manual override). Uses the real
 * ExecutionEngine + RuntimeCoordinator + ModelRouter.
 */
import { describe, it, expect } from 'vitest'
import { ExecutionEngine } from '../src/core/engine.js'
import type { EngineConfig } from '../src/core/types.js'
import type { Renderer } from '../src/ui/renderer.js'

class FakeOpenAI {
  createCalls = 0
  chat = { completions: { create: (_p: Record<string, unknown>, o: { signal: AbortSignal }) => {
    this.createCalls++
    return new Promise<AsyncIterable<unknown>>((res, rej) => {
      if (o.signal.aborted) { rej(new Error('aborted')); return }
      o.signal.addEventListener('abort', () => rej(new Error('aborted')), { once: true })
      res((async function* () {
        await Promise.resolve()
        yield { choices: [{ index: 0, delta: { content: 'ok' }, finish_reason: null }] }
        yield { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 5, completion_tokens: 2 } }
      })())
    })
  } } }
}

function fakeRenderer(): Renderer {
  const r: Record<string, (...args: unknown[]) => void> = {}
  for (const k of ['banner', 'raw', 'info', 'warn', 'error', 'success', 'startSpinner', 'stopSpinner', 'beginAssistantText', 'endAssistantText', 'streamToken', 'streamReasoning', 'assistantMessage', 'userMessage', 'toolCall', 'toolStart', 'toolResult', 'compactStart', 'compactDone', 'contextWarning', 'cost', 'compactionNotice', 'turnEnd', 'planModeHeader', 'agentStart', 'agentDone', 'agentSummary', 'agentHeartbeat']) r[k] = () => {}
  return r as unknown as Renderer
}

const PROFILES = {
  profiles: [
    { id: 'cheap', provider: 'openai', model: 'haiku', capabilities: { reasoning: 0.4, coding: 0.5, contextWindow: 200_000, toolCalling: 0.7, speed: 0.95, cost: 0.95 }, roles: ['main', 'cheap'], available: true },
    { id: 'strong', provider: 'openai', model: 'sonnet', capabilities: { reasoning: 0.95, coding: 0.95, contextWindow: 200_000, toolCalling: 0.9, speed: 0.5, cost: 0.2 }, roles: ['main'], available: true },
  ],
  routing: { enabled: true },
}

function makeEngine(initialModel: string, models?: EngineConfig['models']): { e: ExecutionEngine; fake: FakeOpenAI } {
  const fake = new FakeOpenAI()
  const cfg: EngineConfig = {
    model: initialModel, apiKey: 'k', maxIterations: 5, cwd: '/tmp',
    permissionMode: 'auto', permissionManager: undefined, enabledModules: [],
    models,
  }
  return { e: new ExecutionEngine(cfg, fakeRenderer(), fake as unknown as never), fake }
}

describe('ModelRouter main-path integration (Phase 2)', () => {
  it('routes a complex architecture task to the strong model', async () => {
    const { e } = makeEngine('haiku', PROFILES) // starts on the cheap model
    expect(e.getModel()).toBe('haiku')
    await e.runTurn('Refactor the core architecture and migrate all data off the legacy schema.', [])
    // architecture signal → high complexity → strong model wins
    expect(e.getModel()).toBe('sonnet')
    const d = e.getModelRouter().getLastDecision()!
    expect(d.selectedModel).toBe('sonnet')
    expect(d.reasonCodes).toContain('architecture-signal')
  })

  it('leaves a trivial task on the cheap model', async () => {
    const { e } = makeEngine('haiku', PROFILES)
    await e.runTurn('list the files', [])
    expect(e.getModel()).toBe('haiku')
  })

  it('manual override beats auto-routing', async () => {
    const { e } = makeEngine('haiku', PROFILES)
    e.getModelRouter().setManualOverride('haiku') // pin to cheap
    await e.runTurn('refactor the whole architecture now', [])
    expect(e.getModel()).toBe('haiku') // override held
  })

  it('routing disabled keeps the initial model', async () => {
    const { e } = makeEngine('haiku', { profiles: PROFILES.profiles, routing: { enabled: false } })
    await e.runTurn('refactor the whole architecture now', [])
    expect(e.getModel()).toBe('haiku')
  })

  it('v0.3.1: auto-routing does NOT create a manual override (stays re-routable)', async () => {
    const { e } = makeEngine('haiku', PROFILES)
    await e.runTurn('refactor the architecture', [])
    expect(e.getModel()).toBe('sonnet') // routed to strong
    // CRITICAL: no manual override set — next turn can re-route
    expect(e.getModelRouter().getManualOverride()).toBeNull()
    // A trivial follow-up re-routes to cheap (override not sticky)
    await e.runTurn('list files', [])
    expect(e.getModel()).toBe('haiku')
    expect(e.getModelRouter().getManualOverride()).toBeNull()
  })

  it('v0.3.1: clearModelOverride restores auto-routing after manual pin', async () => {
    const { e } = makeEngine('haiku', PROFILES)
    e.setModelByUser('sonnet') // manual pin
    expect(e.getModelRouter().getManualOverride()).toBe('sonnet')
    await e.runTurn('list files', [])
    expect(e.getModel()).toBe('sonnet') // override held
    e.clearModelOverride()
    expect(e.getModelRouter().getManualOverride()).toBeNull()
    await e.runTurn('list files', [])
    expect(e.getModel()).toBe('haiku') // auto-routing restored
  })
})
