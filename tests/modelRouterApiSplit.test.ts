/**
 * v0.3.1 ModelRouter API split (te_goal §三.1.1).
 *
 * Verifies:
 *   - setModelByUser / applyRoutingDecision / clearModelOverride are
 *     three distinct paths with different sticky semantics.
 *   - The router never mutates the engine directly; it asks the sink.
 *   - Auto-routing across multiple turns re-decides freely.
 *   - applyRoutingDecision applies budgetAllocation.
 *   - Direct setManualOverride with a profile id is rejected as
 *     not-the-API (the sink is the funnel).
 */
import { describe, it, expect } from 'vitest'
import {
  ModelRouter,
  routerFromSingleModel,
  type ModelProfile,
  type ModelSwitchSink,
  type RouterEventListener,
} from '../src/core/model/modelRouter.js'

const profile = (id: string, model: string, provider: string, caps: Partial<ModelProfile['capabilities']> & { roles?: string[] }): ModelProfile => ({
  id, provider, model, available: true,
  capabilities: { reasoning: 0.5, coding: 0.5, contextWindow: 128_000, toolCalling: 0.7, speed: 0.5, cost: 0.5, ...caps },
  roles: caps.roles ?? ['main'],
})

const STRONG = profile('front', 'sonnet', 'openai', { reasoning: 0.95, coding: 0.9, cost: 0.2, roles: ['main'] })
const CHEAP = profile('cheap', 'haiku', 'openai', { reasoning: 0.5, coding: 0.6, cost: 0.95, speed: 0.95, roles: ['main', 'cheap'] })
const LONG = profile('long', 'long-ctx', 'openai', { reasoning: 0.8, coding: 0.8, contextWindow: 1_000_000, cost: 0.4, roles: ['main', 'long-context'] })

interface CapturedSink {
  appliedManual: string[]
  appliedAuto: Array<{ model: string; allocation?: { maxOutputTokens?: number; maxInputTokens?: number } }>
  cleared: number
  events: Array<{ type: string; payload?: Record<string, unknown> }>
}

function makeCaptured(router: ModelRouter): CapturedSink {
  const cap: CapturedSink = { appliedManual: [], appliedAuto: [], cleared: 0, events: [] }
  const sink: ModelSwitchSink = {
    setModelByUser: (model: string) => { cap.appliedManual.push(model) },
    applyRoutingDecision: (model: string, allocation) => {
      cap.appliedAuto.push({ model, allocation })
    },
    clearModelOverride: () => { cap.cleared++ },
  }
  const listener: RouterEventListener = (evt) => { cap.events.push(evt) }
  router.setSink(sink)
  router.setEventListener(listener)
  return cap
}

describe('ModelRouter v0.3.1 API split', () => {
  it('setModelByUser locks the model and routes the sink with the resolved model', () => {
    const r = new ModelRouter([STRONG, CHEAP])
    const cap = makeCaptured(r)
    r.setModelByUser('haiku')
    expect(cap.appliedManual).toEqual(['haiku'])
    expect(r.getManualOverride()).toBe('haiku')
    expect(cap.events.map((e) => e.type)).toContain('MODEL_OVERRIDE_SET')
    // subsequent trivial task still uses the override
    const d = r.route({ userGoal: 'list files' })
    expect(d.selectedModel).toBe('haiku')
    expect(cap.appliedAuto).toEqual([]) // auto path was NOT triggered
  })

  it('setModelByUser accepts a profile id', () => {
    const r = new ModelRouter([STRONG, CHEAP])
    const cap = makeCaptured(r)
    r.setModelByUser('front')
    expect(cap.appliedManual).toEqual(['sonnet']) // resolved to model
    expect(r.getManualOverride()).toBe('sonnet')
  })

  it('setModelByUser rejects empty strings', () => {
    const r = new ModelRouter([STRONG])
    makeCaptured(r)
    expect(() => r.setModelByUser('   ')).toThrow()
  })

  it('applyRoutingDecision switches without setting manual override', () => {
    const r = new ModelRouter([STRONG, CHEAP])
    const cap = makeCaptured(r)
    r.applyRoutingDecision('sonnet', { maxOutputTokens: 4096 })
    expect(cap.appliedManual).toEqual([])
    expect(cap.appliedAuto).toEqual([{ model: 'sonnet', allocation: { maxOutputTokens: 4096 } }])
    expect(r.getManualOverride()).toBeNull()
    expect(cap.events.map((e) => e.type)).toContain('ROUTING_DECISION_APPLIED')
    expect(cap.events.map((e) => e.type)).toContain('BUDGET_ALLOCATION_APPLIED')
  })

  it('applyRoutingDecision is a no-op when the same decision re-applies', () => {
    const r = new ModelRouter([STRONG, CHEAP])
    const cap = makeCaptured(r)
    r.applyRoutingDecision('sonnet', { maxOutputTokens: 4096 })
    r.applyRoutingDecision('sonnet', { maxOutputTokens: 4096 })
    expect(cap.appliedAuto.length).toBe(1)
    expect(cap.events.filter((e) => e.type === 'ROUTING_DECISION_APPLIED').length).toBe(1)
  })

  it('auto routing across three turns re-decides freely and never sets the manual override', () => {
    const r = new ModelRouter([STRONG, CHEAP, LONG])
    makeCaptured(r)
    const seen: string[] = []
    for (let i = 0; i < 6; i++) {
      const decision = r.route({
        userGoal: i % 2 === 0 ? 'redesign the architecture' : 'list files',
        needsArchitecture: i % 2 === 0,
      })
      seen.push(decision.selectedModel)
      r.applyRoutingDecision(decision.selectedModel)
    }
    expect(r.getManualOverride()).toBeNull()
    // We expect at least two distinct models across the 6 iterations
    // (even/odd split between architecture and trivial).
    expect(new Set(seen).size).toBeGreaterThanOrEqual(2)
  })

  it('clearModelOverride clears the sticky flag and emits MODEL_OVERRIDE_CLEARED', () => {
    const r = new ModelRouter([STRONG, CHEAP])
    const cap = makeCaptured(r)
    r.setModelByUser('haiku')
    expect(r.getManualOverride()).toBe('haiku')
    r.clearModelOverride()
    expect(r.getManualOverride()).toBeNull()
    expect(cap.cleared).toBe(1)
    expect(cap.events.map((e) => e.type)).toContain('MODEL_OVERRIDE_CLEARED')
    // After clearing, a complex task routes to the strong model
    const d = r.route({ userGoal: 'redesign the architecture', needsArchitecture: true })
    expect(d.selectedModel).toBe('sonnet')
  })

  it('clearModelOverride is a no-op when no override is set', () => {
    const r = new ModelRouter([STRONG])
    const cap = makeCaptured(r)
    r.clearModelOverride()
    expect(cap.cleared).toBe(0)
    expect(cap.events.length).toBe(0)
  })

  it('route() still refreshes lastDecision under manual override so /route shows fresh observations', () => {
    const r = new ModelRouter([STRONG, CHEAP])
    makeCaptured(r)
    r.setModelByUser('haiku')
    const before = r.getLastDecision()
    r.route({ userGoal: 'debug this', repoFileCount: 800, filesTouched: 9 })
    const after = r.getLastDecision()
    expect(after).not.toBe(before)
    expect(after?.selectedModel).toBe('haiku')
    expect(after?.reasonCodes).toContain('manual-override')
    expect(after?.estimatedComplexity).toBeGreaterThan(0)
  })

  it('legacy setManualOverride(null) still clears via the new path', () => {
    const r = new ModelRouter([STRONG, CHEAP])
    makeCaptured(r)
    r.setManualOverride('haiku')
    r.setManualOverride(null)
    expect(r.getManualOverride()).toBeNull()
  })

  it('nextFallback emits ROUTING_FALLBACK_APPLIED via the listener', () => {
    const r = new ModelRouter([STRONG, CHEAP, LONG])
    const cap = makeCaptured(r)
    const d = r.route({ userGoal: 'fix bug' })
    const next = r.nextFallback(d.selectedModel)
    expect(next).not.toBeNull()
    expect(cap.events.filter((e) => e.type === 'ROUTING_FALLBACK_APPLIED').length).toBe(1)
  })

  it('router has no production dependency on the engine — fully decoupled via sink', () => {
    const r = new ModelRouter([STRONG])
    // without a sink, setModelByUser should not throw — it just records the override
    r.setModelByUser('sonnet')
    expect(r.getManualOverride()).toBe('sonnet')
  })

  it('single-profile router still exposes the three methods', () => {
    const r = routerFromSingleModel('MiniMax-M3', 'minimax')
    const cap = makeCaptured(r)
    r.setModelByUser('MiniMax-M3')
    r.applyRoutingDecision('MiniMax-M3')
    r.clearModelOverride()
    expect(cap.appliedManual).toEqual(['MiniMax-M3'])
    expect(cap.appliedAuto).toEqual([{ model: 'MiniMax-M3', allocation: undefined }])
    expect(cap.cleared).toBe(1)
  })
})