/**
 * TurnOutcome (v0.3.4, durable supervisor contract §Phase 1).
 *
 * The single canonical result shape for a turn. Replaces the legacy
 * TurnResult `{ stopped, reason, output }` with a structured outcome
 * that carries the CompletionVerdict, model call attempts, changed
 * files, artifacts and verification state.
 *
 * Every consumer (CLI, Hook, Module, AgentTool, Loop, Eval, Registry)
 * reads from the same `completion.status` field — no more guessing
 * success from `reason === 'stop_sequence'`.
 */

export type CompletionStatus =
  | 'completed'
  | 'partial'
  | 'blocked'
  | 'failed'
  | 'cancelled'
  | 'exhausted'

export type StopReason =
  | 'stop_sequence'
  | 'length'
  | 'max_iterations'
  | 'cancelled'
  | 'error'

export interface CompletionEvidence {
  type: string
  detail: string
}

export interface VerificationState {
  executed: boolean
  passed: boolean
  failed: string[]
}

export interface ModelCallAttempt {
  profileId: string
  model: string
  provider: string
  startedAt: number
  endedAt: number
  status: 'succeeded' | 'rate_limited' | 'timed_out' | 'unavailable' | 'invalid_request' | 'context_limit' | 'unsupported' | 'failed'
  usage?: { inputTokens: number; outputTokens: number }
  estimatedCost?: number
  error?: string
}

export interface TurnOutcome {
  runId: string
  stopReason: StopReason
  completion: {
    status: CompletionStatus
    reasons: string[]
    evidence: CompletionEvidence[]
    requiredNextActions: string[]
  }
  output: string
  changedFiles: string[]
  artifacts: string[]
  taskGraph?: unknown
  workerReferences?: Array<{ runId: string; status: string }>
  verification: VerificationState
  modelAttempts: ModelCallAttempt[]

  // Deprecated compat fields — derived FROM completion, never read by new code.
  /** @deprecated use completion.status */
  stopped: boolean
  /** @deprecated use completion.status */
  reason: string
}

export function isCompleted(outcome: TurnOutcome): boolean {
  return outcome.completion.status === 'completed'
}

export function isTerminal(outcome: TurnOutcome): boolean {
  return ['completed', 'failed', 'cancelled', 'exhausted'].includes(outcome.completion.status)
}

export function shouldContinue(outcome: TurnOutcome): boolean {
  return outcome.completion.status === 'partial' || outcome.completion.status === 'blocked'
}
