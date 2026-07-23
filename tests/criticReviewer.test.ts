import { describe, it, expect } from 'vitest'
import { shouldInvokeCritic, buildCriticReport, criticReportToGuidance, type CriticSignals } from '../src/core/runtime/criticTrigger.js'
import { reviewRun } from '../src/core/runtime/reviewer.js'
import type { ProgressSnapshot } from '../src/core/runtime/progressMonitor.js'

const snap = (over: Partial<ProgressSnapshot> = {}): ProgressSnapshot => ({
  iteration: 1, changedFiles: [], verificationDelta: 0, newArtifacts: [],
  repeatedToolCalls: 0, repeatedErrors: 0, minutesSinceLastMeaningfulProgress: 0,
  remainingAcceptanceCriteria: [], ...over,
})
const baseSignals = (over: Partial<CriticSignals> = {}): CriticSignals => ({
  snapshot: snap(), modelClaimingCompletion: false, isCoreArchitecture: false,
  changedFilesCount: 0, unresolvedCount: 0, remainingAcceptanceCount: 0, ...over,
})

describe('Adaptive Critic trigger (Phase 5)', () => {
  it('does NOT invoke on a healthy run (no tokens spent)', () => {
    const d = shouldInvokeCritic(baseSignals())
    expect(d.invoke).toBe(false)
  })

  it('invokes on repeated tool failures', () => {
    expect(shouldInvokeCritic(baseSignals({ snapshot: snap({ repeatedErrors: 3 }) })).invoke).toBe(true)
  })

  it('invokes on a stall', () => {
    expect(shouldInvokeCritic(baseSignals({ snapshot: snap({ minutesSinceLastMeaningfulProgress: 15 }) })).invoke).toBe(true)
  })

  it('invokes when completion is claimed with unmet acceptance criteria', () => {
    const d = shouldInvokeCritic(baseSignals({ modelClaimingCompletion: true, remainingAcceptanceCount: 2 }))
    expect(d.invoke).toBe(true)
    expect(d.reason).toMatch(/acceptance criteria unmet/)
  })

  it('invokes when completion is claimed with no changes produced', () => {
    expect(shouldInvokeCritic(baseSignals({ modelClaimingCompletion: true, remainingAcceptanceCount: 1, changedFilesCount: 0 })).invoke).toBe(true)
  })

  it('buildCriticReport returns block verdict when completion is unsupported', () => {
    const r = buildCriticReport(baseSignals({ modelClaimingCompletion: true, remainingAcceptanceCount: 1 }))
    expect(r.verdict).toBe('block')
    expect(r.unsupportedClaims).toContain('completion')
    expect(r.detectedProblems.length).toBeGreaterThan(0)
  })

  it('criticReportToGuidance yields role:system (NOT user), null on clean continue', () => {
    const clean = buildCriticReport(baseSignals())
    expect(criticReportToGuidance(clean)).toBeNull()
    const block = buildCriticReport(baseSignals({ modelClaimingCompletion: true, remainingAcceptanceCount: 1 }))
    const msg = criticReportToGuidance(block)!
    expect(msg.role).toBe('system')
    expect(msg.content).toMatch(/verdict: block/)
  })
})

describe('Final Reviewer (Phase 5)', () => {
  it('blocks on unhandled failures / failed verification / unresolved blockers', () => {
    expect(reviewRun({ goalPresent: true, changedFiles: ['a'], verificationExecuted: true, verificationPassed: false, unhandledFailures: 0, unresolvedBlockers: 0, unsatisfiedAcceptance: 0, scopeExcessive: false }).verdict).toBe('blocked')
    expect(reviewRun({ goalPresent: true, changedFiles: ['a'], verificationExecuted: false, verificationPassed: false, unhandledFailures: 2, unresolvedBlockers: 0, unsatisfiedAcceptance: 0, scopeExcessive: false }).verdict).toBe('blocked')
    expect(reviewRun({ goalPresent: true, changedFiles: ['a'], verificationExecuted: true, verificationPassed: true, unhandledFailures: 0, unresolvedBlockers: 1, unsatisfiedAcceptance: 0, scopeExcessive: false }).verdict).toBe('blocked')
  })

  it('partial when acceptance unmet but no hard blocker', () => {
    const r = reviewRun({ goalPresent: true, changedFiles: ['a'], verificationExecuted: true, verificationPassed: true, unhandledFailures: 0, unresolvedBlockers: 0, unsatisfiedAcceptance: 2, scopeExcessive: false })
    expect(r.verdict).toBe('partial')
  })

  it('completed when verification passed + no gaps', () => {
    const r = reviewRun({ goalPresent: true, changedFiles: ['a'], verificationExecuted: true, verificationPassed: true, unhandledFailures: 0, unresolvedBlockers: 0, unsatisfiedAcceptance: 0, scopeExcessive: false })
    expect(r.verdict).toBe('completed')
  })

  it('flags excessive scope without blocking', () => {
    const r = reviewRun({ goalPresent: true, changedFiles: Array.from({ length: 30 }, (_, i) => `f${i}`), verificationExecuted: true, verificationPassed: true, unhandledFailures: 0, unresolvedBlockers: 0, unsatisfiedAcceptance: 0, scopeExcessive: true })
    expect(r.verdict).toBe('completed')
    expect(r.findings.some((f) => f.includes('excessive'))).toBe(true)
  })
})
