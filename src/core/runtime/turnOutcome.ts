/**
 * TurnOutcome (v0.3.2, ele_goal §Phase 4).
 *
 * The single canonical result shape for a turn. The legacy
 * TurnResult.reason was a free-form string; v0.3.2 introduces a
 * structured outcome that includes the CompletionVerdict, the
 * model call attempts, the changed files, and the verification
 * state. CLI / Hook / Module / AgentTool / RunRegistry / Eval all
 * consume this same shape.
 */
import type { CompletionVerdict } from './completionContract.js'

export type StopReason =
  | 'stop_sequence'
  | 'length'
  | 'max_iterations'
  | 'interrupted'
  | 'error'

export interface TokenUsageSnapshot {
  inputTokens: number
  outputTokens: number
}

export interface VerificationStateSnapshot {
  executed: boolean
  passed: boolean
  failed: string[]
}

export interface ModelCallAttemptSnapshot {
  model: string
  startedAt: number
  endedAt: number
  success: boolean
  error?: string
  usage?: TokenUsageSnapshot
  retryable: boolean
}

export interface TurnOutcome {
  runId: string
  stopReason: StopReason
  /** v0.3.2: the single canonical completion semantic. */
  completion: CompletionVerdict
  output: string
  changedFiles: string[]
  verification: VerificationStateSnapshot
  artifacts: string[]
  /**
   * v0.3.2 (ele_goal §Phase 7): every model call attempt for this
   * turn. Fallback chains produce multiple entries. The cost /
   * usage of the LAST successful attempt is what gets attributed
   * to the run.
   */
  modelCalls: ModelCallAttemptSnapshot[]
}
