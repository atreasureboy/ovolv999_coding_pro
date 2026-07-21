/**
 * TerminationPolicy — the single authority on whether the run loop
 * should continue, stop, or abort.
 *
 * Consolidates the termination checks that were previously inline in
 * the check_abort state handler. This is a PURE function — no side
 * effects, no I/O. The caller (Coordinator) is responsible for
 * emitting the appropriate state-machine event based on the decision.
 *
 * Decision priority (first match wins):
 *   1. Hard abort (user pressed Ctrl+C / engine.abort())
 *   2. Soft abort (user pressed Esc / engine.softAbort())
 *   3. Max iterations exceeded
 *   4. Continue
 */

export type TerminationDecision =
  | { kind: 'continue' }
  | { kind: 'hard_abort' }
  | { kind: 'soft_abort' }
  | { kind: 'max_iterations'; maxIterations: number }

export function checkTermination(params: {
  hardAborted: boolean
  softAborted: boolean
  iteration: number
  maxIterations: number
}): TerminationDecision {
  if (params.hardAborted) return { kind: 'hard_abort' }
  if (params.softAborted) return { kind: 'soft_abort' }
  if (params.iteration > params.maxIterations) {
    return { kind: 'max_iterations', maxIterations: params.maxIterations }
  }
  return { kind: 'continue' }
}
