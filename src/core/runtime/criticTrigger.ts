/**
 * Adaptive Critic trigger (eight_goal Phase 5 §七).
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
 * on any of the eight_goal §七 risk conditions. Cheap runs (no signal)
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

/**
 * Build a structured CriticReport from the signals (deterministic — no
 * LLM call). The full LLM-critic can refine this, but the detected
 * problems + recommended actions are concretely grounded in run state,
 * not a model hallucination.
 */
export function buildCriticReport(s: CriticSignals): CriticReport {
  const problems: string[] = []
  const actions: string[] = []
  let verdict: CriticVerdict = 'continue'

  if (s.snapshot.repeatedErrors >= 3) {
    problems.push(`${s.snapshot.repeatedErrors} consecutive tool failures`)
    actions.push('stop retrying the failing command; diagnose root cause')
    verdict = 'replan'
  }
  if (s.snapshot.minutesSinceLastMeaningfulProgress >= 10) {
    problems.push(`stalled ${Math.round(s.snapshot.minutesSinceLastMeaningfulProgress)} min without meaningful progress`)
    actions.push('summarise evidence and change approach')
    if (verdict === 'continue') verdict = 'replan'
  }
  if (s.modelClaimingCompletion) {
    if (s.remainingAcceptanceCount > 0) {
      problems.push(`${s.remainingAcceptanceCount} acceptance criteria not met before claiming completion`)
      actions.push(`satisfy or explicitly mark unmet: ${s.snapshot.remainingAcceptanceCriteria.slice(0, 3).join(', ')}`)
      verdict = 'block'
    }
    if (s.snapshot.verificationDelta > 0) {
      problems.push('verification failures increased — completion unsupported')
      verdict = 'block'
    }
    if (s.changedFilesCount === 0 && s.remainingAcceptanceCount > 0) {
      problems.push('completion claimed with no changes produced')
      verdict = 'block'
    }
  }
  if (s.changedFilesCount > 20) {
    problems.push(`large change scope (${s.changedFilesCount} files) — review for necessity`)
    actions.push('review the diff for non-essential changes')
    if (verdict === 'continue') verdict = 'verify'
  }

  return {
    verdict,
    detectedProblems: problems,
    unsupportedClaims: s.modelClaimingCompletion && problems.length > 0 ? ['completion'] : [],
    missingAcceptanceCriteria: s.snapshot.remainingAcceptanceCriteria.slice(),
    recommendedActions: actions,
    confidence: problems.length > 0 ? Math.min(0.95, 0.5 + problems.length * 0.15) : 0.5,
  }
}

/**
 * Render the report as a role:system guidance nudge to inject (NOT a
 * user message). Null when the verdict is 'continue' with no problems.
 */
export function criticReportToGuidance(report: CriticReport): { role: 'system'; content: string } | null {
  if (report.verdict === 'continue' || report.detectedProblems.length === 0) return null
  const lines = [`[runtime critic · verdict: ${report.verdict}]`]
  if (report.detectedProblems.length) lines.push(`Problems: ${report.detectedProblems.join('; ')}`)
  if (report.recommendedActions.length) lines.push(`Required actions: ${report.recommendedActions.join('; ')}`)
  if (report.missingAcceptanceCriteria.length) lines.push(`Unmet acceptance: ${report.missingAcceptanceCriteria.slice(0, 5).join(', ')}`)
  return { role: 'system', content: lines.join('\n') }
}
