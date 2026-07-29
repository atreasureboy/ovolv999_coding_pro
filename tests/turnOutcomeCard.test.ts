/**
 * v0.4.1 WS5 — outcome card must name the model that ACTUALLY answered.
 *
 * After a fallback chain A→B, opts.model (startup config) still says A,
 * but the card must say B. Precedence: last SUCCEEDED attempt → last
 * attempt of any kind → caller fallback. Never fabricated.
 */
import { describe, expect, it } from 'vitest'
import { formatOutcomeCardText, effectiveModelFor } from '../src/ui/turnOutcomeCard.js'
import type { ModelCallAttempt, TurnOutcome } from '../src/core/runtime/turnOutcome.js'

function attempt(model: string, status: ModelCallAttempt['status']): ModelCallAttempt {
  return { profileId: 'p', model, provider: 'openai', startedAt: 0, endedAt: 1, status }
}

function outcome(modelAttempts: ModelCallAttempt[]): TurnOutcome {
  return {
    runId: 'run-1',
    stopReason: 'stop_sequence',
    completion: { status: 'completed', reasons: [], evidence: [], requiredNextActions: [] },
    output: 'done',
    changedFiles: [],
    artifacts: [],
    verification: { executed: false, passed: false, failed: [] },
    modelAttempts,
    stopped: false,
    reason: 'completed',
  }
}

describe('effectiveModelFor', () => {
  it('prefers the last SUCCEEDED attempt after a fallback chain', () => {
    const o = outcome([attempt('model-a', 'failed'), attempt('model-b', 'succeeded')])
    expect(effectiveModelFor(o, 'startup')).toBe('model-b')
  })

  it('prefers the LATER of multiple successes', () => {
    const o = outcome([attempt('model-a', 'succeeded'), attempt('model-b', 'succeeded')])
    expect(effectiveModelFor(o, 'startup')).toBe('model-b')
  })

  it('falls back to the last attempt of any kind when nothing succeeded', () => {
    const o = outcome([attempt('model-a', 'rate_limited'), attempt('model-b', 'timed_out')])
    expect(effectiveModelFor(o, 'startup')).toBe('model-b')
  })

  it('uses the caller fallback when there are no attempts', () => {
    expect(effectiveModelFor(outcome([]), 'startup')).toBe('startup')
    expect(effectiveModelFor({ modelAttempts: undefined }, 'startup')).toBe('startup')
  })
})

describe('formatOutcomeCardText', () => {
  it('the fallback card shows B, not the startup model A', () => {
    const o = outcome([attempt('model-a', 'unavailable'), attempt('model-b', 'succeeded')])
    const card = formatOutcomeCardText({ outcome: o, elapsedSec: '1.2', model: 'model-a' })
    expect(card).toContain('Model: model-b')
    expect(card).not.toContain('Model: model-a')
  })

  it('shows the startup model when no attempt data exists', () => {
    const card = formatOutcomeCardText({ outcome: outcome([]), elapsedSec: '1.2', model: 'startup-model' })
    expect(card).toContain('Model: startup-model')
  })
})
