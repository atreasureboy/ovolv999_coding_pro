/**
 * v0.5.3 Hotfix §8 — structured RouteApplication.
 *
 * Three discriminated outcomes:
 *   - applied     — previous model changed
 *   - unchanged   — already current
 *   - unavailable — no profile available (all circuits open)
 *
 * Coordinator MUST handle unavailable explicitly (emit
 * ROUTING_UNAVAILABLE, Outcome.status=blocked/failed, API-class
 * exit) — never best-effort swallow.
 */
import { describe, it, expect } from 'vitest'

import { ModelRouter, type ModelProfile, type RoutingDecision } from '../../src/core/model/modelRouter.js'

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

function newRouter(): ModelRouter {
  return new ModelRouter([
    profile('profile-a', 'model-a'),
    profile('profile-b', 'model-b'),
  ])
}

describe('RouteApplication (Hotfix §8)', () => {
  it('first application → applied, previousModel is empty', () => {
    const router = newRouter()
    const decision: RoutingDecision = {
      selectedModel: 'model-a',
      selectedProfile: 'profile-a',
      reasonCodes: [],
      confidence: 0.9,
      estimatedComplexity: 0.3,
      fallbackChain: ['model-b'],
      budgetAllocation: {},
    }
    const result = router.applyRouteApplication(decision)
    expect(result.kind).toBe('applied')
    if (result.kind === 'applied') {
      expect(result.previousModel).toBe('')
      expect(result.decision.selectedModel).toBe('model-a')
    }
  })

  it('second application with same model → unchanged', () => {
    const router = newRouter()
    const decision: RoutingDecision = {
      selectedModel: 'model-a',
      selectedProfile: 'profile-a',
      reasonCodes: [],
      confidence: 0.9,
      estimatedComplexity: 0.3,
      fallbackChain: ['model-b'],
      budgetAllocation: {},
    }
    router.applyRouteApplication(decision)
    const second = router.applyRouteApplication(decision)
    expect(second.kind).toBe('unchanged')
  })

  it('unavailable decision (selectedModel empty) → unavailable kind', () => {
    const router = newRouter()
    const decision: RoutingDecision = {
      selectedModel: '',
      selectedProfile: '',
      reasonCodes: ['all-profiles-open'],
      confidence: 0,
      estimatedComplexity: 0,
      fallbackChain: [],
      budgetAllocation: {},
    }
    const result = router.applyRouteApplication(decision)
    expect(result.kind).toBe('unavailable')
    if (result.kind === 'unavailable') {
      expect(result.decision.reasonCodes).toContain('all-profiles-open')
    }
  })

  it('all profiles open → route() returns unavailable decision', () => {
    const router = newRouter()
    // Open both circuits by repeated failures.
    for (let i = 0; i < 5; i++) {
      router.recordCall('profile-a', false, 100, null)
      router.recordCall('profile-b', false, 100, null)
    }
    const decision = router.route({
      userGoal: 'do something',
      repoFileCount: 10,
      filesTouched: 1,
      consecutiveFailures: 0,
      expectedToolRequirement: 'side-effect',
    })
    expect(decision.selectedModel).toBe('')
    expect(decision.reasonCodes).toContain('all-profiles-open')
    const result = router.applyRouteApplication(decision)
    expect(result.kind).toBe('unavailable')
  })
})