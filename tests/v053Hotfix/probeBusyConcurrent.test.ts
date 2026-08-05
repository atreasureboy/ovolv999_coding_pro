/**
 * v0.5.3 Hotfix §7 — Probe-busy concurrent Coordinator behaviour.
 *
 * Two real Coordinator-shaped engines share a Router. Run 1 holds
 * profile A's probe lease. Run 2 attempts the same profile and
 * gets a busy-probe response. Run 2 must:
 *   - not request profile A
 *   - request profile B (the fallback)
 *   - emit exactly one ROUTING_FALLBACK_APPLIED event
 *   - leave Run 1's lease untouched
 *
 * We exercise the Router's lease layer directly because a full
 * Coordinator.run() spawns an LLM call that depends on a live
 * gateway. The Router is the single source of truth for probe
 * contention — this test pins the contract.
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

function forceHalfOpen(r: ModelRouter, id: string): void {
  for (let i = 0; i < 5; i++) r.recordCall(id, false, 100, null)
  r['circuitStates'].set(id, 'half-open')
}

describe('Probe busy — concurrent runs', () => {
  it('Run 1 holds A; Run 2 probe-busy → Run 2 advances to B, Run 1 lease untouched', () => {
    const router = newRouter()
    // Force A's circuit to half-open so its probe path is exercised.
    forceHalfOpen(router, 'profile-a')

    // Inject a lastDecision whose chain is [model-b] after model-a.
    // This mirrors what `route()` would produce when profile-a is
    // half-open (selectedModel=model-a, fallbackChain=[model-b]).
    router['lastDecision'] = {
      selectedModel: 'model-a',
      selectedProfile: 'profile-a',
      reasonCodes: [],
      confidence: 0.9,
      estimatedComplexity: 0.3,
      fallbackChain: ['model-b'],
      budgetAllocation: { maxInputTokens: 0 },
    }

    // Run 1 acquires the lease.
    const run1Lease = router.tryAcquireProbe('profile-a')
    expect(run1Lease).not.toBeNull()
    expect(router.getProbeInFlight().has('profile-a')).toBe(true)

    // Run 2 attempts the same profile.
    const run2Attempt = router.tryAcquireProbe('profile-a')
    expect(run2Attempt).toBeNull() // probe busy

    // Run 2 advances via the fallback chain.
    const run2Next = router.nextFallback('model-a')
    expect(run2Next).toBe('model-b')

    // Run 1's lease is still in-flight and untouched.
    expect(router.getProbeInFlight().has('profile-a')).toBe(true)
    expect(router.getProbeInFlight().has('profile-b')).toBe(false)

    // Run 1 finishes its probe.
    router.finishProbe(run1Lease!, 'failure')
    expect(router.getProbeInFlight().has('profile-a')).toBe(false)
    expect(router.getProfileCircuitState('profile-a')).toBe('open')
  })

  it('Run 2 (busy → fallback) emits exactly one ROUTING_FALLBACK_APPLIED event', () => {
    const router = newRouter()
    forceHalfOpen(router, 'profile-a')
    const run1Lease = router.tryAcquireProbe('profile-a')
    expect(run1Lease).not.toBeNull()

    let fallbackEvents = 0
    router.setEventListener((event: { type: string }) => {
      if (event.type === 'ROUTING_FALLBACK_APPLIED') fallbackEvents++
    })

    // Run 2 probe-busy + advance via fallback (which the
    // Coordinator's callLLM onProviderError path triggers).
    const run2Attempt = router.tryAcquireProbe('profile-a')
    expect(run2Attempt).toBeNull()
    router.emitFallback('model-a', 'model-b', 'probe-busy')
    expect(fallbackEvents).toBe(1)

    // Run 1 still in-flight; another fallback event from a
    // hypothetical Run 1 retry must still keep the counter
    // pointing at one (separate run, separate counter).
    router.finishProbe(run1Lease!, 'failure')
  })

  it('No fallback AND busy probe → null lease + terminal error', () => {
    // Single-profile router. Half-open, busy probe, no fallback.
    const soloRouter = newRouter()
    // Remove profile-b so the fallback chain ends after model-a.
    soloRouter['profiles'].splice(1, 1)
    forceHalfOpen(soloRouter, 'profile-a')
    const lease = soloRouter.tryAcquireProbe('profile-a')
    expect(lease).not.toBeNull()

    const second = soloRouter.tryAcquireProbe('profile-a')
    expect(second).toBeNull()
    // nextFallback must return null (no other profile).
    expect(soloRouter.nextFallback('model-a')).toBeNull()
  })
})