/**
 * v0.5.3 Final (P1-3) + v0.5.3 Hotfix §7: the Router's
 * tryAcquireProbe / finishProbe pair is wired into
 * Coordinator.callLLM. The half-open state must carry exactly one
 * in-flight probe — concurrent callers fall through to the
 * fallback path.
 *
 * These tests exercise the Router's lease in isolation (no Engine);
 * the wiring in Coordinator.callLLM calls the same API.
 */
import { describe, it, expect } from 'vitest'
import { ModelRouter, type ModelProfile } from '../../src/core/model/modelRouter.js'

describe('Router.tryAcquireProbe / finishProbe — production wiring (P1-3 + Hotfix §7)', () => {
  const profile = (id: string, model: string, roles = ['cheap']): ModelProfile => ({
    id,
    provider: 'openai-compatible',
    model,
    tier: 'top',
    roles,
    available: true,
    capabilities: {
      reasoning: 0.6, coding: 0.6, contextWindow: 0.5,
      toolCalling: 0.8, speed: 0.8, cost: 0.3,
    },
  })

  function newRouter(): ModelRouter {
    return new ModelRouter([profile('p1', 'model-a')], { enabled: true })
  }

  function openCircuit(r: ModelRouter, id = 'p1') {
    for (let i = 0; i < 5; i++) {
      r.recordCall(id, false, 100, null)
    }
  }

  it('first caller acquires the probe; second concurrent caller is rejected', () => {
    const r = newRouter()
    openCircuit(r)
    r['circuitStates'].set('p1', 'half-open')

    const a1 = r.tryAcquireProbe('p1')
    expect(a1).not.toBeNull()
    expect(r.tryAcquireProbe('p1')).toBeNull()
    expect(r.tryAcquireProbe('p1')).toBeNull()
  })

  it('finishProbe(success) closes the circuit and releases the lease', () => {
    const r = newRouter()
    openCircuit(r)
    r['circuitStates'].set('p1', 'half-open')

    const acquired = r.tryAcquireProbe('p1')
    expect(acquired).not.toBeNull()
    r.finishProbe(acquired!, 'success')

    expect(r.getProfileCircuitState('p1')).toBe('closed')
    expect(r.getProbeInFlight().size).toBe(0)
  })

  it('finishProbe(failure) re-opens the circuit and releases the lease', () => {
    const r = newRouter()
    openCircuit(r)
    r['circuitStates'].set('p1', 'half-open')

    const acquired = r.tryAcquireProbe('p1')
    expect(acquired).not.toBeNull()
    r.finishProbe(acquired!, 'failure')

    expect(r.getProfileCircuitState('p1')).toBe('open')
    expect(r.getProbeInFlight().size).toBe(0)
    expect(r.tryAcquireProbe('p1')).toBeNull() // still no lease
  })

  it('CLOSED and OPEN profiles reject probe acquisition outright', () => {
    const r = newRouter()
    expect(r.tryAcquireProbe('p1')).toBeNull() // closed
    openCircuit(r)
    expect(r.tryAcquireProbe('p1')).toBeNull() // open
  })

  it('an expired lease is evicted lazily and the profile becomes probeable again', () => {
    const r = newRouter()
    openCircuit(r)
    r['circuitStates'].set('p1', 'half-open')

    const stale = r.tryAcquireProbe('p1')
    expect(stale).not.toBeNull()
    // Simulate a caller that died without finishProbe (hung call past
    // the turn-level deadline the TTL bounds).
    ;(stale as { acquiredAt: number }).acquiredAt = Date.now() - 11 * 60 * 1000

    const fresh = r.tryAcquireProbe('p1')
    expect(fresh).not.toBeNull()
    expect(fresh!.leaseId).not.toBe(stale!.leaseId)
  })

  it('a late finishProbe from the evicted caller cannot clobber the replacement lease', () => {
    const r = newRouter()
    openCircuit(r)
    r['circuitStates'].set('p1', 'half-open')

    const stale = r.tryAcquireProbe('p1')!
    ;(stale as { acquiredAt: number }).acquiredAt = Date.now() - 11 * 60 * 1000
    const fresh = r.tryAcquireProbe('p1')!
    expect(fresh.leaseId).not.toBe(stale.leaseId)

    // The dead caller finally settles and reports success — it must NOT
    // close the circuit or release the replacement's slot.
    r.finishProbe(stale, 'success')
    expect(r.getProfileCircuitState('p1')).toBe('half-open')
    expect(r.getProbeInFlight().has('p1')).toBe(true)

    // The live probe still owns the lease and drives the verdict.
    r.finishProbe(fresh, 'success')
    expect(r.getProfileCircuitState('p1')).toBe('closed')
  })
})