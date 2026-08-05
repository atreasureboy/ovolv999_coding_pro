/**
 * v0.5.3 Hotfix §9 — Routing observability.
 *
 * Spec contracts:
 *   - ROUTING_APPLIED carries `from: previousModel` (NOT
 *     config.model). previousModel is captured BEFORE apply.
 *   - reasonCodes are profile-scoped per profile. The final
 *     decision only carries global + selected-profile codes.
 *   - `stale complexity` is forbidden: every route() invocation
 *     calls estimateComplexity() (smoke test: route twice,
 *     assert estimatedComplexity is current).
 */
import { describe, it, expect } from 'vitest'

import { ModelRouter, type ModelProfile } from '../../src/core/model/modelRouter.js'

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

describe('Routing observability (Hotfix §9)', () => {
  it('applyRouteApplication emits previousModel + reasonCodes', () => {
    const router = newRouter()
    const events: Array<{ type: string; payload: Record<string, unknown> }> = []
    router.setEventListener((e) => {
      if (e.type === 'ROUTING_DECISION_APPLIED') events.push(e as never)
    })
    const decision = router.route({
      userGoal: 'do something',
      repoFileCount: 10,
      filesTouched: 1,
      consecutiveFailures: 0,
      expectedToolRequirement: 'side-effect',
    })
    router.applyRouteApplication(decision)
    expect(events.length).toBe(1)
    expect(events[0].payload.previousModel).toBe('')
    expect(Array.isArray(events[0].payload.reasonCodes)).toBe(true)
  })

  it('estimateComplexity runs on every route() — not cached', () => {
    const router = newRouter()
    const d1 = router.route({
      userGoal: 'small task',
      repoFileCount: 10,
      filesTouched: 1,
      consecutiveFailures: 0,
      expectedToolRequirement: 'side-effect',
    })
    const d2 = router.route({
      userGoal: 'redesign the entire system architecture',
      repoFileCount: 10,
      filesTouched: 1,
      consecutiveFailures: 0,
      expectedToolRequirement: 'side-effect',
    })
    expect(d2.estimatedComplexity).toBeGreaterThan(d1.estimatedComplexity)
  })
})