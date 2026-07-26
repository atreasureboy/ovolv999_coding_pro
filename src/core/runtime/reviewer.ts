/**
 * Final Reviewer (v0.3.5) — taskKind-aware deterministic post-run review.
 *
 * Decides completed / partial / blocked from structured state, NOT from
 * the model's self-report. Uses the SAME taskKind as CompletionContract
 * so they always agree.
 *
 * Pure → unit-testable.
 */

export type ReviewVerdict = 'completed' | 'partial' | 'blocked' | 'failed'
export type TaskKind = 'informational' | 'analysis' | 'mutation'

export interface ReviewInput {
  taskKind: TaskKind
  goalPresent: boolean
  changedFiles: string[]
  verificationExecuted: boolean
  verificationPassed: boolean
  unhandledFailures: number
  unresolvedBlockers: number
  /** Criteria with status not 'satisfied' or 'waived'. */
  unsatisfiedCriteria: string[]
  /** Criteria with stale evidence (revision mismatch). */
  staleEvidence: string[]
  /** Heuristic: files changed far exceeding a reasonable scope. */
  scopeExcessive: boolean
}

export interface ReviewResult {
  verdict: ReviewVerdict
  taskKind: TaskKind
  satisfiedCriteria: string[]
  unsatisfiedCriteria: string[]
  staleEvidence: string[]
  verificationSummary: string
  residualRisks: string[]
  findings: string[]
}

export function reviewRun(input: ReviewInput): ReviewResult {
  const findings: string[] = []
  const residualRisks: string[] = []

  // Hard blockers first — apply to ALL taskKinds.
  if (input.unhandledFailures > 0) {
    findings.push(`${input.unhandledFailures} unhandled failure(s)`)
  }
  if (input.verificationExecuted && !input.verificationPassed) {
    findings.push('verification failed')
  }
  if (input.unresolvedBlockers > 0) {
    findings.push(`${input.unresolvedBlockers} unresolved blocker(s)`)
  }
  if (findings.length > 0) {
    return {
      verdict: 'blocked',
      taskKind: input.taskKind,
      satisfiedCriteria: [],
      unsatisfiedCriteria: input.unsatisfiedCriteria,
      staleEvidence: input.staleEvidence,
      verificationSummary: input.verificationExecuted
        ? (input.verificationPassed ? 'passed' : 'failed')
        : 'not executed',
      residualRisks: findings,
      findings,
    }
  }

  // Stale evidence is a hard blocker for mutation.
  if (input.staleEvidence.length > 0) {
    findings.push(`${input.staleEvidence.length} stale evidence item(s): ${input.staleEvidence.join(', ')}`)
    return {
      verdict: 'partial',
      taskKind: input.taskKind,
      satisfiedCriteria: [],
      unsatisfiedCriteria: input.unsatisfiedCriteria,
      staleEvidence: input.staleEvidence,
      verificationSummary: 'stale',
      residualRisks: findings,
      findings,
    }
  }

  // Acceptance gaps.
  if (input.unsatisfiedCriteria.length > 0) {
    findings.push(`${input.unsatisfiedCriteria.length} acceptance criteria unmet: ${input.unsatisfiedCriteria.join(', ')}`)
    return {
      verdict: 'partial',
      taskKind: input.taskKind,
      satisfiedCriteria: [],
      unsatisfiedCriteria: input.unsatisfiedCriteria,
      staleEvidence: [],
      verificationSummary: input.verificationExecuted
        ? (input.verificationPassed ? 'passed' : 'not passed')
        : 'not executed',
      residualRisks: findings,
      findings,
    }
  }

  // TaskKind-specific completion logic.
  if (input.taskKind === 'informational') {
    // Informational: needs output, not changes or verification.
    return {
      verdict: 'completed',
      taskKind: input.taskKind,
      satisfiedCriteria: [],
      unsatisfiedCriteria: [],
      staleEvidence: [],
      verificationSummary: 'not required',
      residualRisks: [],
      findings,
    }
  }

  if (input.taskKind === 'analysis') {
    // Analysis: needs evidence of analysis work, not file changes.
    return {
      verdict: 'completed',
      taskKind: input.taskKind,
      satisfiedCriteria: [],
      unsatisfiedCriteria: [],
      staleEvidence: [],
      verificationSummary: 'not required for analysis',
      residualRisks: [],
      findings,
    }
  }

  // mutation: requires changes + verification.
  if (input.changedFiles.length === 0) {
    findings.push('mutation task produced no file changes')
    return {
      verdict: 'partial',
      taskKind: input.taskKind,
      satisfiedCriteria: [],
      unsatisfiedCriteria: [],
      staleEvidence: [],
      verificationSummary: 'not executed',
      residualRisks: findings,
      findings,
    }
  }
  if (!input.verificationExecuted) {
    findings.push('mutation task with file changes but no verification executed')
    return {
      verdict: 'partial',
      taskKind: input.taskKind,
      satisfiedCriteria: [],
      unsatisfiedCriteria: [],
      staleEvidence: [],
      verificationSummary: 'not executed',
      residualRisks: findings,
      findings,
    }
  }

  // Excessive scope flags for review but doesn't block.
  if (input.scopeExcessive) {
    residualRisks.push(`scope looks excessive (${input.changedFiles.length} files) — verify necessity`)
  }

  return {
    verdict: 'completed',
    taskKind: input.taskKind,
    satisfiedCriteria: [],
    unsatisfiedCriteria: [],
    staleEvidence: [],
    verificationSummary: input.verificationPassed ? 'passed' : 'executed',
    residualRisks,
    findings,
  }
}
