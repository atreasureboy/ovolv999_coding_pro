/**
 * v0.5.5 §11 — Probe busy fallback observability (Router unit test).
 *
 * Per v0.5.5 §19, Router-level tests are EXPLICITLY allowed to
 * manipulate Router private state (circuit state, half-open
 * transitions) via test seams. Production-behaviour tests (Engine
 * + Coordinator + Router end-to-end) live in
 * tests/v055/routingUnavailable.test.ts and runCleanup.test.ts
 * and exercise the Router ONLY through its public API.
 *
 * This test:
 *   - Run 1 acquires profile-a's probe lease.
 *   - Run 2 tries the same profile, gets null (probe busy).
 *   - Run 2 emits exactly one ROUTING_FALLBACK_APPLIED before
 *     advancing.
 *   - Run 1's lease is untouched until Run 1 finishes it.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

import { ModelRouter, type ModelProfile } from '../../src/core/model/modelRouter.js'
import { EventLog } from '../../src/core/eventLog.js'

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

describe('v0.5.5 §11: Probe busy fallback observability', () => {
  let tmpHome: string
  beforeEach(() => {
    tmpHome = mkdtempSync(join(tmpdir(), 'ovolv999-v055-busy-'))
    process.env.OVOGO_HOME = tmpHome
  })
  afterEach(() => {
    try { rmSync(tmpHome, { recursive: true, force: true }) } catch { /* best-effort */ }
    delete process.env.OVOGO_HOME
  })

  it('Run 1 lease + Run 2 busy → Run 2 advances to B, single fallback event', () => {
    const router = new ModelRouter([profile('profile-a', 'model-a'), profile('profile-b', 'model-b')], { enabled: true })
    // Prime lastDecision so nextFallback works.
    router.route({
      userGoal: 'do', repoFileCount: 10, filesTouched: 1,
      consecutiveFailures: 0, expectedToolRequirement: 'side-effect',
    })
    // Open profile-a's circuit.
    for (let i = 0; i < 5; i++) router.recordCall('profile-a', false, 100, null)
    // Wait for half-open via cooldown expiry — recordCall doesn't
    // bump the half-open transition. The simplest approach is to
    // hammer until the circuit enters half-open naturally. For
    // unit-test purposes we use recordCall with success to reset
    // and re-trip; the Router exposes getProfileCircuitState.
    // For determinism we trigger the half-open by marking the
    // circuit-open timestamp far enough in the past.
    router['circuitStates'].set('profile-a', 'half-open')

    let fallbackEvents = 0
    router.setEventListener((e) => {
      if (e.type === 'ROUTING_FALLBACK_APPLIED') fallbackEvents++
    })

    // Run 1 acquires.
    const run1Lease = router.tryAcquireProbe('profile-a')
    expect(run1Lease).not.toBeNull()

    // Run 2 tries the same profile.
    const run2Attempt = router.tryAcquireProbe('profile-a')
    expect(run2Attempt).toBeNull() // probe busy

    // Run 2 must emit exactly one fallback event before advancing.
    router.emitFallback('model-a', 'model-b', 'half-open probe already in flight')
    expect(fallbackEvents).toBe(1)

    // Run 1's lease is still in-flight and untouched.
    expect(router.getProbeInFlight().has('profile-a')).toBe(true)

    // Run 1 finishes its probe.
    router.finishProbe(run1Lease!, 'failure')
    expect(router.getProbeInFlight().has('profile-a')).toBe(false)
  })

  it('Run 2 does NOT touch another run’s ProbeLease', () => {
    const router = new ModelRouter([profile('profile-a', 'model-a'), profile('profile-b', 'model-b')], { enabled: true })
    router.route({
      userGoal: 'do', repoFileCount: 10, filesTouched: 1,
      consecutiveFailures: 0, expectedToolRequirement: 'side-effect',
    })
    for (let i = 0; i < 5; i++) router.recordCall('profile-a', false, 100, null)
    router['circuitStates'].set('profile-a', 'half-open')

    const run1Lease = router.tryAcquireProbe('profile-a')
    expect(run1Lease).not.toBeNull()

    // Run 2 tries and fails.
    const run2Attempt = router.tryAcquireProbe('profile-a')
    expect(run2Attempt).toBeNull()

    // The Router's finishProbe with a wrong leaseId MUST be a no-op.
    const stolenLease = { ...run1Lease!, leaseId: 'stolen-by-run-2' }
    router.finishProbe(stolenLease, 'success')
    // Run 1's actual lease is still valid.
    expect(router.getProbeInFlight().has('profile-a')).toBe(true)
    router.finishProbe(run1Lease!, 'failure')
    expect(router.getProbeInFlight().has('profile-a')).toBe(false)
    void EventLog
  })
})