import { describe, it, expect } from 'vitest'
import {
  transitionQueryState,
  isTerminal,
  createBudgetTracker,
  checkTokenBudget,
  getBudgetContinuationMessage,
  type QueryState,
  type QueryEvent,
} from '../src/core/queryStateMachine.js'

// ── transitionQueryState: boot ──────────────────────────────────────────────

describe('transitionQueryState — boot', () => {
  it('transitions boot → check_abort(1) on booted', () => {
    const next = transitionQueryState({ kind: 'boot' }, { type: 'booted' })
    expect(next).toEqual({ kind: 'check_abort', iteration: 1 })
  })

  it('ignores non-booted events from boot', () => {
    const next = transitionQueryState({ kind: 'boot' }, { type: 'continue' })
    expect(next).toEqual({ kind: 'boot' })
  })
})

// ── transitionQueryState: check_abort ───────────────────────────────────────

describe('transitionQueryState — check_abort', () => {
  const state: QueryState = { kind: 'check_abort', iteration: 3 }

  it('hard_abort → complete(error)', () => {
    const next = transitionQueryState(state, { type: 'hard_abort', output: 'done' })
    expect(next).toEqual({ kind: 'complete', reason: 'error', output: 'done' })
  })

  it('soft_abort → complete(interrupted)', () => {
    const next = transitionQueryState(state, { type: 'soft_abort', output: 'partial' })
    expect(next).toEqual({ kind: 'complete', reason: 'interrupted', output: 'partial' })
  })

  it('max_iterations → complete(max_iterations)', () => {
    const next = transitionQueryState(state, { type: 'max_iterations', output: 'final' })
    expect(next).toEqual({ kind: 'complete', reason: 'max_iterations', output: 'final' })
  })

  it('error → complete(error)', () => {
    const next = transitionQueryState(state, { type: 'error', output: 'boom' })
    expect(next).toEqual({ kind: 'complete', reason: 'error', output: 'boom' })
  })

  it('continue → budget_check (preserves iteration)', () => {
    const next = transitionQueryState(state, { type: 'continue' })
    expect(next).toEqual({ kind: 'budget_check', iteration: 3 })
  })
})

// ── transitionQueryState: budget_check / module_iteration ───────────────────

describe('transitionQueryState — budget_check & module_iteration', () => {
  it('budget_check + continue → module_iteration', () => {
    const next = transitionQueryState(
      { kind: 'budget_check', iteration: 2 },
      { type: 'continue' },
    )
    expect(next).toEqual({ kind: 'module_iteration', iteration: 2 })
  })

  it('module_iteration + continue → llm_call', () => {
    const next = transitionQueryState(
      { kind: 'module_iteration', iteration: 2 },
      { type: 'continue' },
    )
    expect(next).toEqual({ kind: 'llm_call', iteration: 2 })
  })
})

// ── transitionQueryState: llm_call ──────────────────────────────────────────

describe('transitionQueryState — llm_call', () => {
  const state: QueryState = { kind: 'llm_call', iteration: 1 }

  it('llm_done with stop finishReason → continuation_check', () => {
    const next = transitionQueryState(state, {
      type: 'llm_done',
      finishReason: 'stop',
      hasToolCalls: false,
      output: 'hello',
    })
    expect(next).toEqual({ kind: 'continuation_check', iteration: 1, output: 'hello' })
  })

  it('llm_done with no tool calls → continuation_check (even if finishReason != stop)', () => {
    const next = transitionQueryState(state, {
      type: 'llm_done',
      finishReason: 'length',
      hasToolCalls: false,
      output: 'text',
    })
    expect(next.kind).toBe('continuation_check')
  })

  it('llm_done with tool calls → parse_response', () => {
    const next = transitionQueryState(state, {
      type: 'llm_done',
      finishReason: 'tool_calls',
      hasToolCalls: true,
      output: '',
    })
    expect(next).toEqual({ kind: 'parse_response', iteration: 1 })
  })

  it('hard_abort during llm_call → complete(error)', () => {
    const next = transitionQueryState(state, { type: 'hard_abort', output: 'x' })
    expect(next).toEqual({ kind: 'complete', reason: 'error', output: 'x' })
  })

  it('error during llm_call → complete(error)', () => {
    const next = transitionQueryState(state, { type: 'error', output: 'fail' })
    expect(next).toEqual({ kind: 'complete', reason: 'error', output: 'fail' })
  })
})

// ── transitionQueryState: continuation_check ────────────────────────────────

describe('transitionQueryState — continuation_check', () => {
  const state: QueryState = { kind: 'continuation_check', iteration: 2, output: 'result' }

  it('continue → llm_call (same iteration, for nudge re-entry)', () => {
    const next = transitionQueryState(state, { type: 'continue' })
    expect(next).toEqual({ kind: 'llm_call', iteration: 2 })
  })

  it('stop → complete(stop_sequence) with preserved output', () => {
    const next = transitionQueryState(state, { type: 'stop' })
    expect(next).toEqual({ kind: 'complete', reason: 'stop_sequence', output: 'result' })
  })

  it('hard_abort → complete(error)', () => {
    const next = transitionQueryState(state, { type: 'hard_abort', output: 'aborted' })
    expect(next).toEqual({ kind: 'complete', reason: 'error', output: 'aborted' })
  })

  it('soft_abort → complete(stop_sequence) with soft_abort output', () => {
    const next = transitionQueryState(state, { type: 'soft_abort', output: 'soft' })
    expect(next).toEqual({ kind: 'complete', reason: 'stop_sequence', output: 'soft' })
  })
})

// ── transitionQueryState: parse_response / tool_execution ───────────────────

describe('transitionQueryState — parse_response & tool_execution', () => {
  it('parse_response + continue → tool_execution', () => {
    const next = transitionQueryState(
      { kind: 'parse_response', iteration: 1 },
      { type: 'continue' },
    )
    expect(next).toEqual({ kind: 'tool_execution', iteration: 1 })
  })

  it('tool_execution + tools_done(not aborted) → check_abort(next iteration)', () => {
    const next = transitionQueryState(
      { kind: 'tool_execution', iteration: 1 },
      { type: 'tools_done', aborted: false, hardAborted: false, output: '' },
    )
    expect(next).toEqual({ kind: 'check_abort', iteration: 2 })
  })

  it('tool_execution + tools_done(soft aborted) → complete(interrupted)', () => {
    const next = transitionQueryState(
      { kind: 'tool_execution', iteration: 3 },
      { type: 'tools_done', aborted: true, hardAborted: false, output: 'partial' },
    )
    expect(next).toEqual({ kind: 'complete', reason: 'interrupted', output: 'partial' })
  })

  it('tool_execution + tools_done(hard aborted) → complete(error)', () => {
    const next = transitionQueryState(
      { kind: 'tool_execution', iteration: 3 },
      { type: 'tools_done', aborted: true, hardAborted: true, output: 'partial' },
    )
    expect(next).toEqual({ kind: 'complete', reason: 'error', output: 'partial' })
  })
})

// ── transitionQueryState: complete (terminal) ───────────────────────────────

describe('transitionQueryState — complete is terminal', () => {
  const terminal: QueryState = { kind: 'complete', reason: 'stop_sequence', output: 'done' }

  it('ignores all events', () => {
    const events: QueryEvent[] = [
      { type: 'continue' },
      { type: 'stop' },
      { type: 'booted' },
      { type: 'hard_abort', output: 'x' },
    ]
    for (const evt of events) {
      expect(transitionQueryState(terminal, evt)).toBe(terminal)
    }
  })
})

// ── isTerminal ──────────────────────────────────────────────────────────────

describe('isTerminal', () => {
  it('returns true for complete states', () => {
    expect(isTerminal({ kind: 'complete', reason: 'error', output: '' })).toBe(true)
    expect(isTerminal({ kind: 'complete', reason: 'stop_sequence', output: '' })).toBe(true)
    expect(isTerminal({ kind: 'complete', reason: 'max_iterations', output: '' })).toBe(true)
    expect(isTerminal({ kind: 'complete', reason: 'interrupted', output: '' })).toBe(true)
  })

  it('returns false for non-complete states', () => {
    expect(isTerminal({ kind: 'boot' })).toBe(false)
    expect(isTerminal({ kind: 'check_abort', iteration: 1 })).toBe(false)
    expect(isTerminal({ kind: 'llm_call', iteration: 1 })).toBe(false)
    expect(isTerminal({ kind: 'continuation_check', iteration: 1, output: '' })).toBe(false)
  })
})

// ── Full lifecycle simulation ───────────────────────────────────────────────

describe('full lifecycle simulation', () => {
  it('simulates a normal turn: boot → ... → complete(stop_sequence)', () => {
    let s: QueryState = { kind: 'boot' }
    s = transitionQueryState(s, { type: 'booted' })            // check_abort(1)
    s = transitionQueryState(s, { type: 'continue' })           // budget_check
    s = transitionQueryState(s, { type: 'continue' })           // module_iteration
    s = transitionQueryState(s, { type: 'continue' })           // llm_call
    s = transitionQueryState(s, {
      type: 'llm_done', finishReason: 'stop', hasToolCalls: false, output: 'answer',
    })                                                          // continuation_check
    s = transitionQueryState(s, { type: 'stop' })               // complete(stop_sequence)

    expect(s).toEqual({ kind: 'complete', reason: 'stop_sequence', output: 'answer' })
    expect(isTerminal(s)).toBe(true)
  })

  it('simulates a tool-calling turn: boot → ... → tool → next iteration → stop', () => {
    let s: QueryState = { kind: 'boot' }
    s = transitionQueryState(s, { type: 'booted' })             // check_abort(1)
    s = transitionQueryState(s, { type: 'continue' })            // budget_check(1)
    s = transitionQueryState(s, { type: 'continue' })            // module_iteration(1)
    s = transitionQueryState(s, { type: 'continue' })            // llm_call(1)
    s = transitionQueryState(s, {
      type: 'llm_done', finishReason: 'tool_calls', hasToolCalls: true, output: '',
    })                                                          // parse_response(1)
    s = transitionQueryState(s, { type: 'continue' })            // tool_execution(1)
    s = transitionQueryState(s, {
      type: 'tools_done', aborted: false, hardAborted: false, output: '',
    })                                                          // check_abort(2)
    s = transitionQueryState(s, { type: 'continue' })            // budget_check(2)
    s = transitionQueryState(s, { type: 'continue' })            // module_iteration(2)
    s = transitionQueryState(s, { type: 'continue' })            // llm_call(2)
    s = transitionQueryState(s, {
      type: 'llm_done', finishReason: 'stop', hasToolCalls: false, output: 'final',
    })                                                          // continuation_check(2)
    s = transitionQueryState(s, { type: 'stop' })               // complete(stop_sequence)

    expect(s).toEqual({ kind: 'complete', reason: 'stop_sequence', output: 'final' })
  })

  // Regression: parse_response + continue → tool_execution (not stuck)
  // The engine driver MUST emit 'continue' from parse_response, not 'tools_done'.
  // Emitting 'tools_done' from parse_response stays in parse_response (infinite loop).
  it('parse_response emits continue → tool_execution, NOT tools_done (regression)', () => {
    let s: QueryState = { kind: 'parse_response', iteration: 1 }

    // Correct: continue → tool_execution
    s = transitionQueryState(s, { type: 'continue' })
    expect(s.kind).toBe('tool_execution')

    // Bug regression: tools_done from parse_response does NOT advance (stays stuck)
    let s2: QueryState = { kind: 'parse_response', iteration: 1 }
    s2 = transitionQueryState(s2, { type: 'tools_done', aborted: false, hardAborted: false, output: '' })
    expect(s2.kind).toBe('parse_response') // stuck — driver must use 'continue' first
  })

  it('simulates max_iterations: iterations increment then hit ceiling', () => {
    let s: QueryState = { kind: 'boot' }
    s = transitionQueryState(s, { type: 'booted' })             // check_abort(1)

    // Simulate maxIterations = 2: run 2 full iterations then hit ceiling
    for (let i = 0; i < 2; i++) {
      s = transitionQueryState(s, { type: 'continue' })          // budget_check
      s = transitionQueryState(s, { type: 'continue' })          // module_iteration
      s = transitionQueryState(s, { type: 'continue' })          // llm_call
      s = transitionQueryState(s, {
        type: 'llm_done', finishReason: 'tool_calls', hasToolCalls: true, output: '',
      })                                                        // parse_response
      s = transitionQueryState(s, { type: 'continue' })          // tool_execution
      s = transitionQueryState(s, {
        type: 'tools_done', aborted: false, hardAborted: false, output: '',
      })                                                        // check_abort(next)
    }
    // Now at check_abort(3) — driver detects iteration 3 > maxIterations 2
    expect(s.kind).toBe('check_abort')
    if (s.kind === 'check_abort') expect(s.iteration).toBe(3)
    s = transitionQueryState(s, { type: 'max_iterations', output: 'partial' })
    expect(s).toEqual({ kind: 'complete', reason: 'max_iterations', output: 'partial' })
  })
})

// ── BudgetTracker ───────────────────────────────────────────────────────────

describe('createBudgetTracker', () => {
  it('creates a tracker with zeroed state', () => {
    const t = createBudgetTracker()
    expect(t.continuationCount).toBe(0)
    expect(t.lastDeltaTokens).toBe(0)
    expect(t.lastGlobalTurnTokens).toBe(0)
    expect(typeof t.startedAt).toBe('number')
  })
})

// ── checkTokenBudget ────────────────────────────────────────────────────────

describe('checkTokenBudget', () => {
  it('returns stop(null) when budget is null', () => {
    const tracker = createBudgetTracker()
    const decision = checkTokenBudget(tracker, null, 1000)
    expect(decision.action).toBe('stop')
    if (decision.action === 'stop') expect(decision.completionEvent).toBeNull()
  })

  it('returns stop(null) when budget is 0', () => {
    const tracker = createBudgetTracker()
    const decision = checkTokenBudget(tracker, 0, 1000)
    expect(decision.action).toBe('stop')
  })

  it('returns stop(null) when budget is negative', () => {
    const tracker = createBudgetTracker()
    const decision = checkTokenBudget(tracker, -100, 1000)
    expect(decision.action).toBe('stop')
  })

  it('returns continue when under 90% budget and no diminishing returns', () => {
    const tracker = createBudgetTracker()
    const decision = checkTokenBudget(tracker, 10000, 1000)
    expect(decision.action).toBe('continue')
    if (decision.action === 'continue') {
      expect(decision.continuationCount).toBe(1)
      expect(decision.turnTokens).toBe(1000)
      expect(decision.budget).toBe(10000)
      expect(decision.nudgeMessage).toContain('10%')
      expect(decision.nudgeMessage).toContain('continue')
    }
  })

  it('increments continuationCount on each continue', () => {
    const tracker = createBudgetTracker()
    const d1 = checkTokenBudget(tracker, 10000, 1000)
    expect(d1.action).toBe('continue')
    if (d1.action === 'continue') expect(d1.continuationCount).toBe(1)

    const d2 = checkTokenBudget(tracker, 10000, 2000)
    expect(d2.action).toBe('continue')
    if (d2.action === 'continue') expect(d2.continuationCount).toBe(2)
  })

  it('returns stop when turnTokens >= 90% of budget', () => {
    const tracker = createBudgetTracker()
    // 9000 / 10000 = 90% — at threshold, should stop (not strictly less than)
    const decision = checkTokenBudget(tracker, 10000, 9000)
    expect(decision.action).toBe('stop')
  })

  it('returns stop with completionEvent after continuations', () => {
    const tracker = createBudgetTracker()
    checkTokenBudget(tracker, 10000, 1000)  // continue #1
    checkTokenBudget(tracker, 10000, 2000)  // continue #2
    // Now at 90% — stop with completionEvent (continuationCount > 0)
    const decision = checkTokenBudget(tracker, 10000, 9000)
    expect(decision.action).toBe('stop')
    if (decision.action === 'stop') {
      expect(decision.completionEvent).not.toBeNull()
      if (decision.completionEvent) {
        expect(decision.completionEvent.continuationCount).toBe(2)
        expect(decision.completionEvent.diminishingReturns).toBe(false)
        expect(decision.completionEvent.turnTokens).toBe(9000)
        expect(decision.completionEvent.budget).toBe(10000)
      }
    }
  })

  it('detects diminishing returns after 3+ continuations with small deltas', () => {
    const tracker = createBudgetTracker()
    const budget = 100000
    // 3 continuations with large deltas (not diminishing)
    checkTokenBudget(tracker, budget, 10000)   // continue #1, delta 10000
    checkTokenBudget(tracker, budget, 25000)   // continue #2, delta 15000
    checkTokenBudget(tracker, budget, 40000)   // continue #3, delta 15000
    // 4th: continuationCount is now 3, delta = 41000 - 40000 = 1000 > 500, not diminishing
    const d4 = checkTokenBudget(tracker, budget, 41000)
    expect(d4.action).toBe('continue') // delta 1000 > 500 threshold

    // 5th: continuationCount 4, delta = 41100 - 41000 = 100 < 500, lastDelta 1000 >= 500
    // isDiminishing requires BOTH delta < 500 AND lastDelta < 500. lastDelta=1000 so not yet.
    const d5 = checkTokenBudget(tracker, budget, 41100)
    // delta=100 < 500 but lastDelta=1000, so not diminishing → continue (still under 90%)
    expect(d5.action).toBe('continue')

    // 6th: continuationCount 5, delta = 41150 - 41100 = 50 < 500, lastDelta = 100 < 500 → diminishing!
    const d6 = checkTokenBudget(tracker, budget, 41150)
    expect(d6.action).toBe('stop')
    if (d6.action === 'stop' && d6.completionEvent) {
      expect(d6.completionEvent.diminishingReturns).toBe(true)
      expect(d6.completionEvent.continuationCount).toBe(5)
    }
  })

  it('returns stop(null) with no prior continuations when at threshold', () => {
    const tracker = createBudgetTracker()
    // No prior continuations, immediately at 90% → stop(null)
    const decision = checkTokenBudget(tracker, 10000, 9000)
    expect(decision.action).toBe('stop')
    if (decision.action === 'stop') {
      expect(decision.completionEvent).toBeNull()
    }
  })

  it('mutates the tracker on continue decisions', () => {
    const tracker = createBudgetTracker()
    checkTokenBudget(tracker, 10000, 1000)
    expect(tracker.continuationCount).toBe(1)
    expect(tracker.lastGlobalTurnTokens).toBe(1000)
    expect(tracker.lastDeltaTokens).toBe(1000)

    checkTokenBudget(tracker, 10000, 3000)
    expect(tracker.continuationCount).toBe(2)
    expect(tracker.lastGlobalTurnTokens).toBe(3000)
    expect(tracker.lastDeltaTokens).toBe(2000)
  })
})

// ── getBudgetContinuationMessage ────────────────────────────────────────────

describe('getBudgetContinuationMessage', () => {
  it('includes percentage, tokens, and budget', () => {
    const msg = getBudgetContinuationMessage(25, 2500, 10000)
    expect(msg).toContain('25%')
    expect(msg).toContain('2500')
    expect(msg).toContain('10000')
    expect(msg).toContain('continue')
  })

  it('contains a clear instruction to continue', () => {
    const msg = getBudgetContinuationMessage(50, 5000, 10000)
    expect(msg.toLowerCase()).toContain('continue')
  })
})
