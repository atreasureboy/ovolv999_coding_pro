/**
 * CompletionContract (eight_goal Phase 4 §六 + te_goal §四).
 *
 * A task must NOT be marked completed just because the model said so.
 * This pure gate checks the structured conditions the run actually
 * satisfies, returning a verdict the coordinator uses INSTEAD of
 * trusting `finish_reason: stop_sequence` as proof of done.
 *
 *   completed    — every acceptance criterion met + verification ran +
 *                  no running children + no unhandled failures
 *   partial      — most criteria met but some remain / unverifiable
 *   blocked      — a hard blocker exists (failed verification that was
 *                  not resolved, or a stalled child) — NOT completable
 *   failed       — terminal provider/engine failure; retry requires
 *                  fresh run
 *   cancelled    — user/system cancelled; no further work
 *   exhausted    — iteration ceiling hit; verdict is "ran out of
 *                  budget, not done"
 *   incomplete   — acceptance not satisfied and not blocked (keep going)
 *
 * v0.3.1 (te_goal §四): the six required statuses are now all produced.
 * `unsatisfiedAcceptance: 0` hardcoding (the previous bug) is replaced
 * by `satisfiedCriteria` flowing from TaskGraph + caller-supplied
 * evidence. Reviewer findings are folded into the verdict.
 */

export type CompletionStatus =
  | 'completed'
  | 'partial'
  | 'blocked'
  | 'failed'
  | 'cancelled'
  | 'exhausted'
  | 'incomplete'

export interface AcceptanceCriterion {
  /** Stable id so the caller can mark a criterion satisfied without
   *  re-passing the entire list. */
  id?: string
  description: string
  satisfied?: boolean
}

export interface VerificationState {
  executed: boolean
  passed: boolean
  failed: string[]
}

export interface WorkerSummary {
  id: string
  status: 'pending' | 'running' | 'completed' | 'failed' | 'cancelled'
}

export interface TaskGraphNodeSummary {
  id: string
  status: 'pending' | 'ready' | 'running' | 'verifying' | 'completed' | 'failed' | 'blocked' | 'cancelled'
}

export interface TaskGraphSnapshotLite {
  nodes: TaskGraphNodeSummary[]
}

export interface BudgetState {
  remaining: number
  exceeded: boolean
}

export interface CompletionInput {
  /** v0.3.1 (te_goal §四): task kind drives what "done" means. */
  taskKind: 'informational' | 'analysis' | 'mutation'
  /** True if the model reached stop_sequence / length / max_iterations. */
  modelStopped: boolean
  /** User-stated acceptance criteria (from WorkingState / goal / TaskGraph). */
  acceptanceCriteria: AcceptanceCriterion[]
  /** Verification state — execution + pass/fail + named failures. */
  verification: VerificationState
  /** Snapshot of the TaskGraph so unresolved nodes can block completion. */
  taskGraph?: TaskGraphSnapshotLite
  /** Workers / sub-agents still in a non-terminal state. */
  activeWorkers: WorkerSummary[]
  /** Hard blockers the user / system has flagged. */
  unresolvedBlockers: string[]
  /** Files actually changed this run (must be non-empty to claim work done). */
  changedFiles: string[]
  /** Findings from the deterministic Reviewer (each must be addressed). */
  reviewerFindings: string[]
  /** Token / cost budget state. */
  budgetState: BudgetState
  /** When the coordinator knows the iteration limit was hit. */
  iterationsUsed?: number
  iterationsMax?: number
  /** True if the run was cancelled (user interrupt or system). */
  cancelled?: boolean
  /** True if the run failed for a non-blocker reason (engine error). */
  failed?: boolean
}

export type CompletionVerdict =
  | { status: 'completed'; evidence: string[]; residualRisks: string[] }
  | { status: 'partial'; evidence: string[]; remaining: string[]; residualRisks: string[] }
  | { status: 'blocked'; blockers: string[] }
  | { status: 'failed'; reason: string; evidence: string[] }
  | { status: 'cancelled'; reason: string }
  | { status: 'exhausted'; reason: string; iterationsUsed: number; iterationsMax: number }
  | { status: 'incomplete'; remaining: string[] }

/**
 * Evaluate the completion contract. Pure — given the input, returns the
 * strictest verdict the evidence supports. The coordinator MUST consult
 * this before transitioning a run to 'succeeded'.
 */
export function evaluateCompletion(input: CompletionInput): CompletionVerdict {
  const evidence: string[] = []
  const residual: string[] = []

  if (input.changedFiles.length > 0) {
    evidence.push(`${input.changedFiles.length} file(s) changed: ${input.changedFiles.slice(0, 5).join(', ')}${input.changedFiles.length > 5 ? '…' : ''}`)
  }

  // ── cancelled is terminal regardless of evidence ─────────────────
  if (input.cancelled) {
    return { status: 'cancelled', reason: input.unresolvedBlockers[0] ?? 'user/system cancelled' }
  }

  // ── failed is terminal regardless of evidence ────────────────────
  if (input.failed) {
    return {
      status: 'failed',
      reason: input.unresolvedBlockers[0] ?? 'engine/provider failure',
      evidence,
    }
  }

  // ── exhausted: iteration ceiling reached ────────────────────────
  if (
    input.iterationsUsed !== undefined
    && input.iterationsMax !== undefined
    && input.iterationsUsed >= input.iterationsMax
  ) {
    return {
      status: 'exhausted',
      reason: `hit iteration limit (${input.iterationsUsed}/${input.iterationsMax})`,
      iterationsUsed: input.iterationsUsed,
      iterationsMax: input.iterationsMax,
    }
  }

  // ── compute unsatisfied criteria from the typed list ────────────
  const criteria = input.acceptanceCriteria
  const satisfiedSet = new Set(criteria.filter((c) => c.satisfied === true).map((c) => c.id ?? c.description))
  const unsatisfied = criteria.filter((c) => !satisfiedSet.has(c.id ?? c.description))
  if (satisfiedSet.size > 0) {
    evidence.push(`${satisfiedSet.size}/${criteria.length} acceptance criteria met`)
  }

  // ── hard blockers ───────────────────────────────────────────────
  const blockers: string[] = []
  if (input.activeWorkers.some((w) => w.status === 'running' || w.status === 'pending')) {
    blockers.push(`${input.activeWorkers.filter((w) => w.status === 'running' || w.status === 'pending').length} worker(s) still running`)
  }
  if (input.unresolvedBlockers.length > 0) {
    blockers.push(...input.unresolvedBlockers)
  }
  if (input.taskGraph && input.taskGraph.nodes.some((n) =>
    n.status === 'pending' || n.status === 'ready' || n.status === 'running' || n.status === 'verifying')) {
    blockers.push('TaskGraph has unfinished nodes')
  }
  if (input.budgetState.exceeded) {
    blockers.push('budget exceeded')
  }
  if (input.verification.executed && !input.verification.passed) {
    blockers.push('verification executed but FAILED — resolve before completing')
  }
  if (blockers.length > 0) return { status: 'blocked', blockers }

  // ── informational Q&A: no file changes required ─────────────────
  if (input.taskKind === 'informational') {
    if (criteria.length === 0 || unsatisfied.length === 0) {
      return { status: 'completed', evidence, residualRisks: residual }
    }
    return { status: 'partial', evidence, remaining: unsatisfied.map((u) => u.description), residualRisks: residual }
  }

  // ── analysis: requires evidence but not patch ────────────────────
  if (input.taskKind === 'analysis') {
    if (criteria.length === 0) {
      if (input.changedFiles.length === 0 && satisfiedSet.size === 0) {
        residual.push('no analysis output produced')
        return { status: 'incomplete', remaining: ['produce an analysis artefact'] }
      }
      return { status: 'completed', evidence, residualRisks: residual }
    }
    if (unsatisfied.length === 0) {
      return { status: 'completed', evidence, residualRisks: residual }
    }
    if (input.changedFiles.length === 0) {
      return { status: 'incomplete', remaining: unsatisfied.map((u) => u.description) }
    }
    return { status: 'partial', evidence, remaining: unsatisfied.map((u) => u.description), residualRisks: residual }
  }

  // ── mutation: requires changes + satisfied acceptance ───────────
  if (criteria.length === 0) {
    if (input.verification.executed && !input.verification.passed) {
      return { status: 'blocked', blockers: ['verification failed (no acceptance criteria declared)'] }
    }
    if (input.changedFiles.length === 0 && satisfiedSet.size === 0) {
      residual.push('no acceptance criteria declared and no changes produced — cannot evidence completion')
      return { status: 'incomplete', remaining: ['produce a verifiable change or declare acceptance criteria'] }
    }
    return { status: 'completed', evidence, residualRisks: residual }
  }

  if (unsatisfied.length === 0) {
    if (input.verification.executed && !input.verification.passed) {
      return { status: 'blocked', blockers: ['all criteria claimed but verification failed'] }
    }
    if (!input.verification.executed) {
      residual.push('acceptance met but verification was not executed')
    }
    // Reviewer findings do NOT block completed (per te_goal §四 — they
    // are warnings surfaced via /trace + /why, not hard blockers).
    // They are appended to residualRisks so /why can show them.
    if (input.reviewerFindings.length > 0) {
      residual.push(...input.reviewerFindings)
    }
    return { status: 'completed', evidence, residualRisks: residual }
  }

  // Reviewer findings make the verdict partial even if changes happened.
  if (input.reviewerFindings.length > 0) {
    residual.push(...input.reviewerFindings)
  }

  if (input.changedFiles.length === 0) {
    return { status: 'incomplete', remaining: unsatisfied.map((u) => u.description) }
  }
  return {
    status: 'partial',
    evidence,
    remaining: unsatisfied.map((u) => u.description),
    residualRisks: residual,
  }
}