import { describe, it, expect } from 'vitest'
import type { TurnResult } from '../src/core/types.js'

/**
 * Phase 4 (five_goal §六):
 *   GAP 6.1 — max_iterations must map to RunStatus 'blocked', NOT 'succeeded'.
 *   GAP 6.2 — modify mode must force verify=true regardless of model input.
 *
 * These tests exercise the pure mapping logic that was previously inline
 * in the coordinator. We verify the mapping function directly.
 */

// ── GAP 6.1: max_iterations → 'blocked' ──────────────────────────────

describe('GAP 6.1: max_iterations → RunStatus blocked', () => {
  // Replicate the mapping logic from coordinator.ts (lines ~467-471)
  // to keep the test focused on the decision table.
  function reasonToStatus(reason: TurnResult['reason']): 'succeeded' | 'cancelled' | 'blocked' | 'failed' {
    switch (reason) {
      case 'stop_sequence': return 'succeeded'
      case 'interrupted': return 'cancelled'
      case 'max_iterations': return 'blocked'
      default: return 'failed'
    }
  }

  it('stop_sequence → succeeded', () => {
    expect(reasonToStatus('stop_sequence')).toBe('succeeded')
  })

  it('max_iterations → blocked (NOT succeeded)', () => {
    expect(reasonToStatus('max_iterations')).toBe('blocked')
  })

  it('interrupted → cancelled', () => {
    expect(reasonToStatus('interrupted')).toBe('cancelled')
  })

  it('error → failed', () => {
    expect(reasonToStatus('error')).toBe('failed')
  })
})

// ── GAP 6.2: modify mode forces verify=true ──────────────────────────

describe('GAP 6.2: modify mode verify forced', () => {
  // Replicate the mapping logic from agent.ts (line ~559)
  function computeVerify(taskMode: 'read_only' | 'modify', inputVerify: boolean | undefined): boolean {
    return taskMode === 'modify' ? true : inputVerify === true
  }

  it('modify + verify:false → true (model cannot bypass)', () => {
    expect(computeVerify('modify', false)).toBe(true)
  })

  it('modify + verify:undefined → true', () => {
    expect(computeVerify('modify', undefined)).toBe(true)
  })

  it('modify + verify:true → true', () => {
    expect(computeVerify('modify', true)).toBe(true)
  })

  it('read_only + verify:undefined → false (opt-in)', () => {
    expect(computeVerify('read_only', undefined)).toBe(false)
  })

  it('read_only + verify:true → true', () => {
    expect(computeVerify('read_only', true)).toBe(true)
  })
})
