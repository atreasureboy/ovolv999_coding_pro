/**
 * v0.5.3 (P1.8): Router per-profile failure attribution.
 *
 * Profile A fails N times → A's circuit opens → Profile B remains
 * selectable. Profile A's failures do NOT penalize Profile B's
 * score.
 */
import { describe, it, expect } from 'vitest'
import { ModelRouter } from '../../src/core/model/modelRouter.js'

function makeRouter(): ModelRouter {
  return new ModelRouter(
    [
      { id: 'A', provider: 'fake', model: 'A-model', capabilities: { reasoning: 0.9, coding: 0.9, contextWindow: 100000, toolCalling: 0.9, speed: 0.5, cost: 0.4 }, roles: ['main'], available: true },
      { id: 'B', provider: 'fake', model: 'B-model', capabilities: { reasoning: 0.7, coding: 0.7, contextWindow: 100000, toolCalling: 0.7, speed: 0.7, cost: 0.7 }, roles: ['main'], available: true },
    ],
    { enabled: true },
  )
}

describe('Router per-profile failure (P1.8)', () => {
  it('Profile A consecutive failures open A\'s circuit; B stays selectable', () => {
    const router = makeRouter()
    // 5 failures = CIRCUIT_OPEN_THRESHOLD
    for (let i = 0; i < 5; i++) {
      router.recordCall('A', false, 100, null)
    }
    expect(router.getProfileCircuitState('A')).toBe('open')
    expect(router.getProfileCircuitState('B')).toBe('closed')
    expect(router.isProfileAvailable('A')).toBe(false)
    expect(router.isProfileAvailable('B')).toBe(true)
  })

  it('a successful call closes the per-profile circuit', () => {
    const router = makeRouter()
    for (let i = 0; i < 5; i++) router.recordCall('A', false, 100, null)
    expect(router.getProfileCircuitState('A')).toBe('open')
    router.recordCall('A', true, 100, null)
    expect(router.getProfileCircuitState('A')).toBe('closed')
  })

  it('route() excludes profiles whose circuit is open', () => {
    const router = makeRouter()
    for (let i = 0; i < 5; i++) router.recordCall('A', false, 100, null)
    const d = router.route({
      userGoal: 'test',
      filesTouched: 1,
      consecutiveFailures: 0,
      contextUsageRatio: 0.1,
      budgetRemaining: 1,
      role: 'main',
      needsArchitecture: false,
      providerHealth: [],
      expectedToolRequirement: 'mixed',
      affectsPublicInterface: false,
      isCrossModule: false,
      isConfigChange: false,
      requiresRootCause: false,
      estimatedImpactFiles: 1,
      taskGraphScale: 1,
    })
    // A is open, B is the only available profile → B must win.
    expect(d.selectedProfile).toBe('B')
    expect(d.selectedModel).toBe('B-model')
  })
})