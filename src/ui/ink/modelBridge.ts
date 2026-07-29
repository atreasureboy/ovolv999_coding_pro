/**
 * v0.4.1 WS5 (UI model truth) — RunEventEmitter → UIStore bridge.
 *
 * The StatusBar must show the model the engine is ACTUALLY running, not
 * the startup value. Auto-routing, fallback chains and per-attempt hops
 * all emit events; the bridge folds them into store.setModel with
 * last-write-wins semantics, so after an A→B fallback the bar reads B —
 * the model that actually answered. PROFILE_RESOLVED (WS4) drives the
 * execution-profile chip.
 *
 * Extracted from runInkRepl so the mapping is unit-testable without
 * mounting Ink.
 */

import type { UIStore } from './store.js'
import type { RunEventEmitter } from '../../core/runtime/events.js'

export interface ModelBridge {
  /** Idempotent-ish: removes every subscription. Never throws. */
  disconnect(): void
}

export function wireModelBridge(store: UIStore, emitter: RunEventEmitter): ModelBridge {
  const unsubs: Array<() => void> = [
    emitter.on('ROUTING_APPLIED', (e) => { store.setModel(e.to) }),
    emitter.on('ROUTING_FALLBACK', (e) => { store.setModel(e.to) }),
    emitter.on('MODEL_CHANGED', (e) => { store.setModel(e.to) }),
    // The strongest truth: this model produced tokens for the turn.
    emitter.on('MODEL_ATTEMPT_SUCCEEDED', (e) => { store.setModel(e.model) }),
    // PROFILE_RESOLVED fires once per turn before boot — the per-turn
    // reset point for the attempt counter (v0.4.1 WS8).
    emitter.on('PROFILE_RESOLVED', (e) => {
      store.setProfile(e.profile)
      store.setApiAttempts(0)
    }),
    // attemptId is the 0-based per-run call index; count = id + 1. If the
    // turn dies mid-call, the error card reports exactly how many calls
    // the engine really attempted (v0.4.1 WS8).
    emitter.on('MODEL_ATTEMPT_STARTED', (e) => { store.setApiAttempts(e.attemptId + 1) }),
  ]
  let disconnected = false
  return {
    disconnect() {
      if (disconnected) return
      disconnected = true
      for (const unsub of unsubs) {
        try { unsub() } catch { /* best-effort — never let teardown throw */ }
      }
    },
  }
}
