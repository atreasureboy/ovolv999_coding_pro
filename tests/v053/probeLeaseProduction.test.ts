/**
 * v0.5.3 Final (P1-3): the Router's tryAcquireProbe / finishProbe
 * pair is wired into Coordinator.callLLM. The half-open state must
 * carry exactly one in-flight probe — concurrent callers fall
 * through to the fallback path.
 *
 * These tests exercise the Router's lease in isolation (no Engine);
 * the wiring in Coordinator.callLLM calls the same API.
 */
import { describe, it, expect } from 'vitest'
import { ModelRouter, type ModelProfile } from '../../src/core/model/modelRouter.js'

describe('Router.tryAcquireProbe / finishProbe — production wiring (P1-3)', () => {
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
    // Force half-open: bypass the wall-clock cooldown by manually
    // transitioning.
    r['circuitStates'].set('p1', 'half-open')

    expect(r.tryAcquireProbe('p1')).toBe(true)
    expect(r.tryAcquireProbe('p1')).toBe(false) // concurrent
    expect(r.tryAcquireProbe('p1')).toBe(false) // still concurrent
  })

  it('finishProbe(true) closes the circuit and releases the lease', () => {
    const r = newRouter()
    openCircuit(r)
    r['circuitStates'].set('p1', 'half-open')

    expect(r.tryAcquireProbe('p1')).toBe(true)
    r.finishProbe('p1', true)

    expect(r.getProfileCircuitState('p1')).toBe('closed')
    // After release, a fresh acquire succeeds.
    expect(r.tryAcquireProbe('p1')).toBe(false) // closed == no acquire
    expect(r.getProbeInFlight().size).toBe(0)
  })

  it('finishProbe(false) re-opens the circuit and releases the lease', () => {
    const r = newRouter()
    openCircuit(r)
    r['circuitStates'].set('p1', 'half-open')

    expect(r.tryAcquireProbe('p1')).toBe(true)
    r.finishProbe('p1', false)

    expect(r.getProfileCircuitState('p1')).toBe('open')
    expect(r.getProbeInFlight().size).toBe(0)
    // Concurrent acquire after re-open is rejected (still no lease).
    expect(r.tryAcquireProbe('p1')).toBe(false)
  })

  it('CLOSED and OPEN profiles reject probe acquisition outright', () => {
    const r = newRouter()
    expect(r.tryAcquireProbe('p1')).toBe(false) // closed — nothing to probe
    openCircuit(r)
    expect(r.tryAcquireProbe('p1')).toBe(false) // open — wait for cooldown
  })
})
