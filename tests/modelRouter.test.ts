import { describe, it, expect } from 'vitest'
import { ModelRouter, routerFromSingleModel, type ModelProfile } from '../src/core/model/modelRouter.js'

const profile = (id: string, model: string, caps: Partial<ModelProfile['capabilities']> & { roles?: string[] }, available = true): ModelProfile => ({
  id, provider: 'p', model, available,
  capabilities: { reasoning: 0.5, coding: 0.5, contextWindow: 128_000, toolCalling: 0.7, speed: 0.5, cost: 0.5, ...caps },
  roles: caps.roles ?? ['main'],
})

const STRONG = profile('front', 'sonnet', { reasoning: 0.95, coding: 0.9, cost: 0.2, roles: ['main'] })
const CHEAP = profile('cheap', 'haiku', { reasoning: 0.5, coding: 0.6, cost: 0.95, speed: 0.95, roles: ['main', 'cheap'] })
const LONG = profile('long', 'long-ctx', { reasoning: 0.8, coding: 0.8, contextWindow: 1_000_000, cost: 0.4, roles: ['main', 'long-context'] })

describe('ModelRouter (Phase 2)', () => {
  it('manual override always wins and is sticky', () => {
    const r = new ModelRouter([STRONG, CHEAP])
    r.setManualOverride('haiku')
    const d = r.route({ userGoal: 'redesign the architecture' })
    expect(d.selectedModel).toBe('haiku')
    expect(d.reasonCodes).toContain('manual-override')
    // sticky: a later trivial task still uses the override
    expect(r.route({ userGoal: 'list files' }).selectedModel).toBe('haiku')
    r.setManualOverride(null)
    expect(r.route({ userGoal: 'list files' }).selectedModel).not.toBe('haiku')
  })

  it('routes a complex architecture task to the strong-reasoning model', () => {
    const r = new ModelRouter([STRONG, CHEAP])
    const d = r.route({ userGoal: 'refactor the core architecture and migrate data', needsArchitecture: true })
    expect(d.selectedModel).toBe('sonnet')
    expect(d.estimatedComplexity).toBeGreaterThan(0.5)
    expect(d.reasonCodes).toContain('architecture-signal')
  })

  it('routes a trivial task toward the cheap model under budget pressure', () => {
    const r = new ModelRouter([STRONG, CHEAP])
    const d = r.route({ userGoal: 'list the files in src', budgetRemaining: 0.1 })
    // cheap should win: trivial (low complexity) + budget pressure favours cost
    expect(d.selectedModel).toBe('haiku')
    expect(d.reasonCodes).toContain('budget-pressure')
  })

  it('prefers a long-context profile when context usage is high', () => {
    const r = new ModelRouter([STRONG, LONG])
    const d = r.route({ userGoal: 'continue', contextUsageRatio: 0.92 })
    expect(d.selectedModel).toBe('long-ctx')
    expect(d.reasonCodes).toContain('long-context-need')
  })

  it('falls back along the chain and never returns the failed model', () => {
    const r = new ModelRouter([STRONG, CHEAP, LONG])
    const d = r.route({ userGoal: 'fix the bug' })
    expect(d.fallbackChain).not.toContain(d.selectedModel)
    expect(r.nextFallback(d.selectedModel)).toBe(d.fallbackChain[0])
    // exhausted chain
    expect(r.nextFallback(d.fallbackChain[d.fallbackChain.length - 1])).toBeNull()
  })

  it('penalises an unhealthy profile using recorded call stats', () => {
    const weak = profile('weak', 'weak-model', { reasoning: 0.95, coding: 0.95, cost: 0.9 })
    const r = new ModelRouter([weak, STRONG])
    // make 'weak' fail often (4 failures + 1 success)
    r.recordCall('weak', true, 2000, null)
    for (let i = 0; i < 4; i++) r.recordCall('weak', false, 2000, null)
    const d = r.route({ userGoal: 'hard architecture refactor', needsArchitecture: true })
    expect(d.selectedModel).not.toBe('weak-model')
    expect(d.reasonCodes.some((c) => c.startsWith('unhealthy'))).toBe(true)
  })

  it('single-profile router degrades gracefully and still respects override', () => {
    const r = routerFromSingleModel('MiniMax-M3', 'minimax')
    expect(r.route({ userGoal: 'anything' }).selectedModel).toBe('MiniMax-M3')
    expect(r.route({ userGoal: 'anything' }).reasonCodes).toContain('single-profile')
    r.setManualOverride('other')
    expect(r.route({ userGoal: 'x' }).selectedModel).toBe('other')
  })

  it('disabled routing still picks a model and reports routing-disabled', () => {
    const r = new ModelRouter([STRONG, CHEAP], { enabled: false })
    const d = r.route({ userGoal: 'complex architecture' })
    expect(d.reasonCodes).toContain('routing-disabled')
    expect(d.selectedModel).toBeTruthy()
  })

  it('every decision carries reasonCodes, confidence, complexity, fallbackChain', () => {
    const r = new ModelRouter([STRONG, CHEAP])
    const d = r.route({ userGoal: 'do something', repoFileCount: 800, filesTouched: 7 })
    expect(d.reasonCodes.length).toBeGreaterThan(0)
    expect(d.confidence).toBeGreaterThan(0)
    expect(d.estimatedComplexity).toBeGreaterThan(0)
    expect(Array.isArray(d.fallbackChain)).toBe(true)
    expect(r.getLastDecision()).toBe(d)
  })
})
