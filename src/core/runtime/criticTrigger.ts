/**
 * Adaptive Critic trigger (adaptive runtime contract Phase 5 §七).
 *
 * Replaces fixed every-N-turns critic invocation with RISK-GATED
 * triggering. The fixed-interval critic wastes tokens on healthy runs
 * and stays silent during subtle stalls. This pure module inspects the
 * run's risk signals and decides whether a critic pass is warranted,
 * producing a structured CriticReport + a role:system guidance nudge
 * (never a forged user message).
 *
 * Pure + deterministic → unit-testable independently of the LLM.
 */

import type { ProgressSnapshot } from './progressMonitor.js'

export type CriticVerdict = 'continue' | 'replan' | 'verify' | 'block' | 'complete'

export interface CriticReport {
  verdict: CriticVerdict
  detectedProblems: string[]
  unsupportedClaims: string[]
  missingAcceptanceCriteria: string[]
  recommendedActions: string[]
  confidence: number
}

export interface CriticSignals {
  snapshot: ProgressSnapshot
  /** True if the model just emitted stop_sequence (about to claim done). */
  modelClaimingCompletion: boolean
  /** True if the goal involves core-architecture / root-cause work. */
  isCoreArchitecture: boolean
  /** Files changed this run (scope signal). */
  changedFilesCount: number
  /** Unresolved items from WorkingState. */
  unresolvedCount: number
  /** Remaining acceptance criteria not yet satisfied. */
  remainingAcceptanceCount: number
}

export interface CriticTriggerDecision {
  invoke: boolean
  reason: string
}

/**
 * Decide whether to invoke the critic this iteration. Returns invoke=true
 * on any of the adaptive runtime contract §七 risk conditions. Cheap runs (no signal)
 * return invoke=false → no tokens spent.
 */
export function shouldInvokeCritic(s: CriticSignals): CriticTriggerDecision {
  const reasons: string[] = []

  if (s.snapshot.repeatedErrors >= 3) reasons.push(`repeated tool failures (${s.snapshot.repeatedErrors})`)
  if (s.snapshot.minutesSinceLastMeaningfulProgress >= 10) reasons.push(`no meaningful progress for ${Math.round(s.snapshot.minutesSinceLastMeaningfulProgress)} min`)
  if (s.changedFilesCount > 20) reasons.push(`large change scope (${s.changedFilesCount} files)`)
  if (s.isCoreArchitecture && s.snapshot.iteration > 2) reasons.push('core-architecture work past early iterations')
  // The highest-value trigger: the model is about to claim done.
  if (s.modelClaimingCompletion) {
    if (s.remainingAcceptanceCount > 0) reasons.push(`completion claimed with ${s.remainingAcceptanceCount} acceptance criteria unmet`)
    if (s.snapshot.verificationDelta > 0) reasons.push('completion claimed while verification failures increased')
    if (s.unresolvedCount > 0) reasons.push(`completion claimed with ${s.unresolvedCount} unresolved items`)
    if (s.changedFilesCount === 0 && s.remainingAcceptanceCount > 0) reasons.push('completion claimed with no changes produced')
  }

  if (reasons.length === 0) return { invoke: false, reason: 'no risk signal' }
  return { invoke: true, reason: reasons.join('; ') }
}


