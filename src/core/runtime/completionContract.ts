/**
 * CompletionContract (eight_goal Phase 4 §六).
 *
 * A task must NOT be marked completed just because the model said so.
 * This pure gate checks the structured conditions the run actually
 * satisfies, returning a verdict the coordinator uses INSTEAD of
 * trusting `finish_reason: stop_sequence` as proof of done.
 *
 *   completed   — every acceptance criterion met + verification ran +
 *                 no running children + no unhandled failures
 *   partial     — most criteria met but some remain / unverifiable
 *   blocked     — a hard blocker exists (failed verification that was
 *                 not resolved, or a stalled child) — NOT completable
 *   incomplete  — acceptance not satisfied and not blocked (keep going)
 */

export interface CompletionInput {
  /** User-stated acceptance criteria (from WorkingState / goal). */
  acceptanceCriteria: string[]
  /** Criteria already satisfied (marked off during the run). */
  satisfiedCriteria: string[]
  /** True if verification (typecheck/test/build) was actually executed. */
  verificationExecuted: boolean
  /** True if the last verification passed. */
  verificationPassed: boolean
  /** Number of child Workers/sub-agents still in a non-terminal state. */
  runningChildren: number
  /** Unhandled verification failures still on the books. */
  unhandledFailures: number
  /** Files actually changed this run (must be non-empty to claim work done). */
  changedFiles: string[]
}

export type CompletionVerdict =
  | { status: 'completed'; evidence: string[]; residualRisks: string[] }
  | { status: 'partial'; evidence: string[]; remaining: string[]; residualRisks: string[] }
  | { status: 'blocked'; blockers: string[] }
  | { status: 'incomplete'; remaining: string[] }

/**
 * Evaluate the completion contract. Pure — given the input, returns the
 * strictest verdict the evidence supports. The coordinator MUST consult
 * this before transitioning a run to 'succeeded'.
 */
export function evaluateCompletion(input: CompletionInput): CompletionVerdict {
  const unsatisfied = input.acceptanceCriteria.filter((c) => !input.satisfiedCriteria.includes(c))
  const evidence: string[] = []
  const residual: string[] = []

  if (input.changedFiles.length > 0) evidence.push(`${input.changedFiles.length} file(s) changed: ${input.changedFiles.slice(0, 5).join(', ')}${input.changedFiles.length > 5 ? '…' : ''}`)
  if (input.satisfiedCriteria.length > 0) evidence.push(`${input.satisfiedCriteria.length}/${input.acceptanceCriteria.length} acceptance criteria met`)

  // Hard blockers — can never report completed/partial while present.
  const blockers: string[] = []
  if (input.runningChildren > 0) blockers.push(`${input.runningChildren} child worker(s) still running`)
  if (input.unhandledFailures > 0) blockers.push(`${input.unhandledFailures} unhandled verification failure(s)`)
  if (input.verificationExecuted && !input.verificationPassed) {
    blockers.push('verification executed but FAILED — resolve before completing')
  }
  if (blockers.length > 0) return { status: 'blocked', blockers }

  // No blocker. Distinguish completed vs partial vs incomplete.
  if (input.acceptanceCriteria.length === 0) {
    // No explicit criteria: require verification (if any ran) to pass +
    // at least one changed file or explicit satisfied mark.
    if (input.verificationExecuted && !input.verificationPassed) {
      return { status: 'blocked', blockers: ['verification failed'] }
    }
    if (input.changedFiles.length === 0 && input.satisfiedCriteria.length === 0) {
      residual.push('no acceptance criteria declared and no changes produced — cannot evidence completion')
      return { status: 'incomplete', remaining: ['produce a verifiable change or declare acceptance criteria'] }
    }
    return { status: 'completed', evidence, residualRisks: residual }
  }

  if (unsatisfied.length === 0) {
    // All criteria met. Verification must have run (or be N/A) + passed.
    if (input.verificationExecuted && !input.verificationPassed) {
      return { status: 'blocked', blockers: ['all criteria claimed but verification failed'] }
    }
    if (!input.verificationExecuted) residual.push('acceptance met but verification was not executed')
    return { status: 'completed', evidence, residualRisks: residual }
  }

  // Some criteria remain.
  if (input.changedFiles.length === 0) {
    return { status: 'incomplete', remaining: unsatisfied }
  }
  return {
    status: 'partial',
    evidence,
    remaining: unsatisfied,
    residualRisks: residual,
  }
}
