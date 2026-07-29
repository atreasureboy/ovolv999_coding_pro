/**
 * v0.4.1 WS5 — RunEventEmitter → UIStore model bridge.
 *
 * The StatusBar must track the model that ACTUALLY answers, so every
 * routing/fallback/hop event folds into setModel (last write wins) and
 * PROFILE_RESOLVED drives the chip. disconnect() must fully detach.
 *
 * v0.4.1 WS8: the bridge also folds MODEL_ATTEMPT_STARTED into
 * store.apiAttempts (attemptId is 0-based → count = id + 1), reset on
 * PROFILE_RESOLVED, so the Ink error card reports the turn's REAL model
 * call count instead of a fabricated string.
 */
import { describe, expect, it } from 'vitest'
import { UIStore } from '../../src/ui/ink/store.js'
import { RunEventEmitter } from '../../src/core/runtime/events.js'
import { wireModelBridge } from '../../src/ui/ink/modelBridge.js'

describe('modelBridge — events → UIStore', () => {
  it('routing / fallback / changed / attempt-succeeded all drive setModel, last write wins', () => {
    const store = new UIStore()
    store.setBanner('1.0.0', 'startup-model')
    const emitter = new RunEventEmitter()
    const bridge = wireModelBridge(store, emitter)

    emitter.emit({ type: 'ROUTING_APPLIED', from: 'startup-model', to: 'routed-model', reasonCodes: [] })
    expect(store.getState().banner?.model).toBe('routed-model')

    emitter.emit({ type: 'ROUTING_FALLBACK', from: 'routed-model', to: 'fallback-model', error: 'provider down' })
    expect(store.getState().banner?.model).toBe('fallback-model')

    emitter.emit({ type: 'MODEL_CHANGED', from: 'fallback-model', to: 'changed-model' })
    expect(store.getState().banner?.model).toBe('changed-model')

    // The strongest truth — the model that produced tokens — overrides all.
    emitter.emit({ type: 'MODEL_ATTEMPT_SUCCEEDED', model: 'answered-model', attemptId: 2, latencyMs: 10 })
    expect(store.getState().banner?.model).toBe('answered-model')

    bridge.disconnect()
    emitter.emit({ type: 'MODEL_CHANGED', from: 'answered-model', to: 'post-exit-model' })
    expect(store.getState().banner?.model).toBe('answered-model')
  })

  it('PROFILE_RESOLVED drives the profile chip; disconnect stops updates', () => {
    const store = new UIStore()
    const emitter = new RunEventEmitter()
    const bridge = wireModelBridge(store, emitter)

    expect(store.getState().profile).toBeNull()
    emitter.emit({ type: 'PROFILE_RESOLVED', profile: 'fast', source: 'intent', modules: ['memory', 'workspace'] })
    expect(store.getState().profile).toBe('fast')

    emitter.emit({ type: 'PROFILE_RESOLVED', profile: 'standard', source: 'default', modules: ['memory', 'critic', 'workspace', 'reflection'] })
    expect(store.getState().profile).toBe('standard')

    bridge.disconnect()
    emitter.emit({ type: 'PROFILE_RESOLVED', profile: 'deep', source: 'detected', modules: [] })
    expect(store.getState().profile).toBe('standard')
  })

  it('setModel before any banner exists is a safe no-op (never throws)', () => {
    const store = new UIStore()
    const emitter = new RunEventEmitter()
    const bridge = wireModelBridge(store, emitter)
    expect(() => emitter.emit({ type: 'MODEL_CHANGED', from: 'a', to: 'b' })).not.toThrow()
    expect(store.getState().banner).toBeNull()
    bridge.disconnect()
  })

  it('MODEL_ATTEMPT_STARTED counts attempts (attemptId+1); PROFILE_RESOLVED resets per turn', () => {
    const store = new UIStore()
    const emitter = new RunEventEmitter()
    const bridge = wireModelBridge(store, emitter)

    expect(store.getState().apiAttempts).toBe(0)

    // attemptId is the 0-based per-run call index — count = id + 1.
    emitter.emit({ type: 'MODEL_ATTEMPT_STARTED', model: 'gpt-4o', attemptId: 0 })
    expect(store.getState().apiAttempts).toBe(1)
    emitter.emit({ type: 'MODEL_ATTEMPT_STARTED', model: 'gpt-4o', attemptId: 1 })
    expect(store.getState().apiAttempts).toBe(2)

    // Next turn: PROFILE_RESOLVED fires once before boot → counter resets,
    // so a stale count from the previous turn never leaks into a new card.
    emitter.emit({ type: 'PROFILE_RESOLVED', profile: 'standard', source: 'default', modules: [] })
    expect(store.getState().apiAttempts).toBe(0)

    // disconnect stops counting entirely.
    bridge.disconnect()
    emitter.emit({ type: 'MODEL_ATTEMPT_STARTED', model: 'gpt-4o', attemptId: 0 })
    expect(store.getState().apiAttempts).toBe(0)
  })

  it('disconnect is idempotent', () => {
    const store = new UIStore()
    const emitter = new RunEventEmitter()
    const bridge = wireModelBridge(store, emitter)
    expect(() => { bridge.disconnect(); bridge.disconnect() }).not.toThrow()
  })
})
