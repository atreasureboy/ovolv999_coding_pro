/**
 * Query State Machine — explicit state-driven engine loop
 *
 * Inspired by Claude Code's query/transitions.ts + query/tokenBudget.ts design:
 *   - Explicit states replace an inline imperative while-loop
 *   - A pure reducer (state, event) → state is fully unit-testable
 *   - BudgetTracker adds continuation nudging + diminishing-returns detection
 *
 * The ExecutionEngine.runTurn() loop drives this state machine:
 *   boot → check_abort → budget_check → module_iteration → llm_call →
 *   continuation_check → (llm_call | complete) · parse_response →
 *   tool_execution → check_abort (next iteration) ... → complete
 *
 * Design notes:
 *   - The reducer is PURE — no side effects. The engine driver interprets each
 *     state and emits the next event. This makes the transition logic trivial
 *     to unit-test without mocking the LLM, tools, or modules.
 *   - `continuation_check` is always entered when the LLM stops (finish_reason=stop
 *     with no tool calls). When continuation is disabled (default), the driver
 *     immediately emits 'stop' → complete. When enabled, the BudgetTracker decides
 *     whether to nudge the model to keep producing or to stop.
 */

import type { TurnResult } from './types.js'

// ── States ───────────────────────────────────────────────────────────────────

export type QueryState =
  | { kind: 'boot' }
  | { kind: 'check_abort'; iteration: number }
  | { kind: 'budget_check'; iteration: number }
  | { kind: 'module_iteration'; iteration: number }
  | { kind: 'llm_call'; iteration: number }
  | { kind: 'continuation_check'; iteration: number; output: string }
  | { kind: 'parse_response'; iteration: number }
  | { kind: 'tool_execution'; iteration: number }
  | { kind: 'complete'; reason: TurnResult['reason']; output: string }

// ── Events ───────────────────────────────────────────────────────────────────

export type QueryEvent =
  | { type: 'booted' }
  | { type: 'continue' }
  | { type: 'stop' }
  | { type: 'hard_abort'; output: string }
  | { type: 'soft_abort'; output: string }
  | { type: 'max_iterations'; output: string }
  | { type: 'llm_done'; finishReason: string | null; hasToolCalls: boolean; output: string }
  | { type: 'tools_done'; aborted: boolean; hardAborted: boolean; output: string }
  | { type: 'error'; output: string }

// ── Reducer (pure) ───────────────────────────────────────────────────────────

/**
 * Pure state transition function. Given the current state and an event,
 * returns the next state. No side effects — fully deterministic & testable.
 */
export function transitionQueryState(state: QueryState, event: QueryEvent): QueryState {
  switch (state.kind) {
    case 'boot':
      if (event.type === 'booted') return { kind: 'check_abort', iteration: 1 }
      return state

    case 'check_abort': {
      if (event.type === 'hard_abort')
        return { kind: 'complete', reason: 'error', output: event.output }
      if (event.type === 'soft_abort')
        return { kind: 'complete', reason: 'interrupted', output: event.output }
      if (event.type === 'max_iterations')
        return { kind: 'complete', reason: 'max_iterations', output: event.output }
      if (event.type === 'error')
        return { kind: 'complete', reason: 'error', output: event.output }
      if (event.type === 'continue')
        return { kind: 'budget_check', iteration: state.iteration }
      return state
    }

    case 'budget_check':
      if (event.type === 'continue')
        return { kind: 'module_iteration', iteration: state.iteration }
      return state

    case 'module_iteration':
      if (event.type === 'continue')
        return { kind: 'llm_call', iteration: state.iteration }
      return state

    case 'llm_call': {
      if (event.type === 'hard_abort')
        return { kind: 'complete', reason: 'error', output: event.output }
      if (event.type === 'error')
        return { kind: 'complete', reason: 'error', output: event.output }
      if (event.type === 'llm_done') {
        const stopped = event.finishReason === 'stop' || !event.hasToolCalls
        if (stopped)
          return { kind: 'continuation_check', iteration: state.iteration, output: event.output }
        return { kind: 'parse_response', iteration: state.iteration }
      }
      return state
    }

    case 'continuation_check':
      if (event.type === 'continue')
        return { kind: 'llm_call', iteration: state.iteration }
      if (event.type === 'hard_abort')
        return { kind: 'complete', reason: 'error', output: event.output }
      // 'stop' or any other event → complete
      return {
        kind: 'complete',
        reason: 'stop_sequence',
        output: event.type === 'soft_abort' ? event.output : state.output,
      }

    case 'parse_response':
      if (event.type === 'continue')
        return { kind: 'tool_execution', iteration: state.iteration }
      return state

    case 'tool_execution':
      if (event.type === 'tools_done') {
        if (event.aborted) {
          return {
            kind: 'complete',
            reason: event.hardAborted ? 'error' : 'interrupted',
            output: event.output,
          }
        }
        return { kind: 'check_abort', iteration: state.iteration + 1 }
      }
      return state

    case 'complete':
      return state // terminal — ignore all events
  }
}

/** True when the state machine has reached a terminal (complete) state. */
export function isTerminal(state: QueryState): boolean {
  return state.kind === 'complete'
}

// ── Token Budget Tracker (adapted from Claude Code query/tokenBudget.ts) ─────

const COMPLETION_THRESHOLD = 0.9
const DIMINISHING_THRESHOLD = 500

export interface BudgetTracker {
  continuationCount: number
  lastDeltaTokens: number
  lastGlobalTurnTokens: number
  startedAt: number
}

export function createBudgetTracker(): BudgetTracker {
  return {
    continuationCount: 0,
    lastDeltaTokens: 0,
    lastGlobalTurnTokens: 0,
    startedAt: Date.now(),
  }
}

export interface BudgetContinuationEvent {
  continuationCount: number
  pct: number
  turnTokens: number
  budget: number
  diminishingReturns: boolean
  durationMs: number
}

export type TokenBudgetDecision =
  | {
      action: 'continue'
      nudgeMessage: string
      continuationCount: number
      pct: number
      turnTokens: number
      budget: number
    }
  | {
      action: 'stop'
      completionEvent: BudgetContinuationEvent | null
    }

/**
 * Decide whether to nudge the model to continue producing output, or to stop.
 *
 * Ported from Claude Code's checkTokenBudget(). When the LLM returns
 * finish_reason=stop but token budget remains, this can inject a "continue"
 * nudge. Diminishing returns (3+ continuations with <500-token deltas) forces
 * a stop to avoid burning tokens on near-empty output.
 *
 * @param tracker   Mutable tracker — updated in place on 'continue' decisions
 * @param budget    Max output tokens for this turn (null/0 → always stop)
 * @param turnTokens  Total tokens produced so far in this turn
 */
export function checkTokenBudget(
  tracker: BudgetTracker,
  budget: number | null,
  turnTokens: number,
): TokenBudgetDecision {
  if (budget === null || budget <= 0) {
    return { action: 'stop', completionEvent: null }
  }

  const pct = Math.round((turnTokens / budget) * 100)
  const deltaSinceLastCheck = turnTokens - tracker.lastGlobalTurnTokens

  const isDiminishing =
    tracker.continuationCount >= 3 &&
    deltaSinceLastCheck < DIMINISHING_THRESHOLD &&
    tracker.lastDeltaTokens < DIMINISHING_THRESHOLD

  if (!isDiminishing && turnTokens < budget * COMPLETION_THRESHOLD) {
    tracker.continuationCount++
    tracker.lastDeltaTokens = deltaSinceLastCheck
    tracker.lastGlobalTurnTokens = turnTokens
    return {
      action: 'continue',
      nudgeMessage: getBudgetContinuationMessage(pct, turnTokens, budget),
      continuationCount: tracker.continuationCount,
      pct,
      turnTokens,
      budget,
    }
  }

  if (isDiminishing || tracker.continuationCount > 0) {
    return {
      action: 'stop',
      completionEvent: {
        continuationCount: tracker.continuationCount,
        pct,
        turnTokens,
        budget,
        diminishingReturns: isDiminishing,
        durationMs: Date.now() - tracker.startedAt,
      },
    }
  }

  return { action: 'stop', completionEvent: null }
}

/** Nudge message injected as a user message to prompt the model to continue. */
export function getBudgetContinuationMessage(
  pct: number,
  turnTokens: number,
  budget: number,
): string {
  return `[context budget] ${pct}% used (${turnTokens}/${budget} tokens). You still have remaining output budget — continue your work from where you left off.`
}
