/**
 * v0.4.1 WS5 — same-model routing decisions must still apply the Router's
 * budgetAllocation.
 *
 * Pre-WS5, engine.routeModel() guarded the whole apply call with
 * `selectedModel !== this.config.model`, so a decision that kept the
 * current model silently dropped its maxOutputTokens allocation.
 * Now the applier always runs (switchModel is a same-model no-op, so no
 * MODEL_CHANGED noise) and only the return value depends on a real hop.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { ExecutionEngine } from '../src/core/engine.js'
import type { EngineConfig } from '../src/core/types.js'
import type { Renderer } from '../src/ui/renderer.js'
import type { RoutingDecision } from '../src/core/model/modelRouter.js'
import { SemanticMemory } from '../src/core/semanticMemory.js'
import { EpisodicMemory } from '../src/core/episodicMemory.js'

class FakeOpenAI {
  createCalls = 0
  chat = { completions: { create: (_p: Record<string, unknown>, o: { signal: AbortSignal }) => {
    this.createCalls++
    const stream = (async function* () {
      await Promise.resolve()
      yield { choices: [{ index: 0, delta: { content: 'ok' }, finish_reason: null }] }
      yield { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 5 } }
    })()
    return new Promise<AsyncIterable<unknown>>((res, rej) => {
      if (o.signal.aborted) { rej(new Error('aborted')); return }
      o.signal.addEventListener('abort', () => rej(new Error('aborted')), { once: true })
      res(stream)
    })
  } } }
}

function fakeRenderer(): Renderer {
  const r: Record<string, (...args: unknown[]) => void> = {}
  for (const k of ['banner', 'raw', 'info', 'warn', 'error', 'success', 'startSpinner', 'stopSpinner', 'beginAssistantText', 'endAssistantText', 'streamToken', 'streamReasoning', 'assistantMessage', 'userMessage', 'toolCall', 'toolStart', 'toolResult', 'compactStart', 'compactDone', 'contextWarning', 'cost', 'compactionNotice', 'turnEnd', 'planModeHeader', 'agentStart', 'agentDone', 'agentSummary', 'agentHeartbeat']) r[k] = () => {}
  return r as unknown as Renderer
}

describe('routing budget allocation on a same-model decision', () => {
  let workDir: string
  let sessionDir: string
  let fakeClient: FakeOpenAI

  beforeEach(() => {
    workDir = mkdtempSync(join(tmpdir(), 'budget-eval-'))
    sessionDir = mkdtempSync(join(tmpdir(), 'budget-session-'))
    fakeClient = new FakeOpenAI()
  })
  afterEach(() => {
    vi.restoreAllMocks()
    try { rmSync(workDir, { recursive: true, force: true }) } catch { /* best-effort */ }
    try { rmSync(sessionDir, { recursive: true, force: true }) } catch { /* best-effort */ }
  })

  function makeEngine(): ExecutionEngine {
    const config: EngineConfig = {
      model: 'gpt-4o',
      apiKey: 'test-key',
      cwd: workDir,
      maxIterations: 20,
      maxOutputTokens: 8000,
      permissionMode: 'auto',
      sessionDir,
      semanticMemory: new SemanticMemory(join(workDir, 'sem')),
      episodicMemory: new EpisodicMemory(join(workDir, 'ep')),
      enabledModules: ['memory', 'workspace'],
    }
    return new ExecutionEngine(config, fakeRenderer(), fakeClient as unknown as never)
  }

  it('same-model decision applies budgetAllocation without MODEL_CHANGED', async () => {
    const engine = makeEngine()
    const router = engine.getModelRouter()
    vi.spyOn(router, 'isRoutingEnabled').mockReturnValue(true)
    vi.spyOn(router, 'getManualOverride').mockReturnValue(null)
    const decision: RoutingDecision = {
      selectedModel: engine.getModel(), // same model
      selectedProfile: 'p',
      reasonCodes: ['budget_pressure'],
      confidence: 1,
      estimatedComplexity: 0.1,
      fallbackChain: [],
      budgetAllocation: { maxOutputTokens: 4321 },
    }
    vi.spyOn(router, 'route').mockReturnValue(decision)

    let modelChanged = 0
    engine.getEventEmitter().on('MODEL_CHANGED', () => { modelChanged++ })

    const { outcome } = await engine.runTurn('hello', [])
    expect(outcome.completion.status).toBe('completed')
    // The allocation landed even though no model hop happened.
    expect(engine.getConfig().maxOutputTokens).toBe(4321)
    // And the same-model path is SILENT — no spurious switch event.
    expect(modelChanged).toBe(0)
    expect(engine.getModel()).toBe('gpt-4o')
    engine.dispose()
  })

  it('decision without allocation leaves maxOutputTokens untouched', async () => {
    const engine = makeEngine()
    const router = engine.getModelRouter()
    vi.spyOn(router, 'isRoutingEnabled').mockReturnValue(true)
    vi.spyOn(router, 'getManualOverride').mockReturnValue(null)
    const decision: RoutingDecision = {
      selectedModel: engine.getModel(),
      selectedProfile: 'p',
      reasonCodes: [],
      confidence: 1,
      estimatedComplexity: 0.1,
      fallbackChain: [],
      budgetAllocation: {},
    }
    vi.spyOn(router, 'route').mockReturnValue(decision)

    await engine.runTurn('hello', [])
    expect(engine.getConfig().maxOutputTokens).toBe(8000)
    engine.dispose()
  })

  it('manual override short-circuits routing entirely (allocation not applied)', async () => {
    const engine = makeEngine()
    const router = engine.getModelRouter()
    vi.spyOn(router, 'isRoutingEnabled').mockReturnValue(true)
    vi.spyOn(router, 'getManualOverride').mockReturnValue('gpt-4o')
    const routeSpy = vi.spyOn(router, 'route').mockReturnValue({
      selectedModel: 'gpt-4o',
      selectedProfile: 'p',
      reasonCodes: [],
      confidence: 1,
      estimatedComplexity: 0.1,
      fallbackChain: [],
      budgetAllocation: { maxOutputTokens: 4321 },
    })

    await engine.runTurn('hello', [])
    expect(routeSpy).not.toHaveBeenCalled()
    expect(engine.getConfig().maxOutputTokens).toBe(8000)
    engine.dispose()
  })
})
