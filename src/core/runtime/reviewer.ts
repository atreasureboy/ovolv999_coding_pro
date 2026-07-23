/**
 * Final Reviewer (eight_goal Phase 5 §七) — a deterministic post-run
 * review that decides completed / partial / blocked from structured
 * state, NOT from the model's self-report. Complements the
 * CompletionContract (which gates the live Run status); the Reviewer
 * produces an explainable verdict for /trace + the run summary.
 *
 * Checks: did verification pass, are there unhandled failures, were
 * changes produced, are there unresolved blockers, did the change scope
 * look excessive vs the goal. Pure → unit-testable.
 */

export type ReviewVerdict = 'completed' | 'partial' | 'blocked'

export interface ReviewInput {
  goalPresent: boolean
  changedFiles: string[]
  verificationExecuted: boolean
  verificationPassed: boolean
  unhandledFailures: number
  unresolvedBlockers: number
  /** Declared acceptance criteria still unsatisfied. */
  unsatisfiedAcceptance: number
  /** Heuristic: files changed far exceeding a reasonable scope for the goal. */
  scopeExcessive: boolean
}

export interface ReviewResult {
  verdict: ReviewVerdict
  findings: string[]
}

export function reviewRun(input: ReviewInput): ReviewResult {
  const findings: string[] = []

  // Hard blockers first.
  if (input.unhandledFailures > 0) findings.push(`${input.unhandledFailures} unhandled failure(s)`)
  if (input.verificationExecuted && !input.verificationPassed) findings.push('verification failed')
  if (input.unresolvedBlockers > 0) findings.push(`${input.unresolvedBlockers} unresolved blocker(s)`)
  if (findings.length > 0) {
    return { verdict: 'blocked', findings }
  }

  // Acceptance gaps with real changes → partial.
  if (input.unsatisfiedAcceptance > 0) {
    findings.push(`${input.unsatisfiedAcceptance} acceptance criterion/criteria unmet`)
    return { verdict: 'partial', findings }
  }

  // No changes and no goal → can't evidence completion.
  if (input.changedFiles.length === 0 && input.goalPresent) {
    findings.push('no changes produced for a stated goal')
    return { verdict: 'partial', findings }
  }

  // Excessive scope flags for review but doesn't block.
  if (input.scopeExcessive) findings.push(`scope looks excessive (${input.changedFiles.length} files) — verify necessity`)
  if (!input.verificationExecuted) findings.push('verification was not executed')

  return { verdict: 'completed', findings }
}
