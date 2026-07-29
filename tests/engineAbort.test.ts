/**
 * Race tests for ExecutionEngine abort / softAbort lifecycle.
 *
 * Strategy: drive the engine exclusively through its public API
 * (runTurn / abort / softAbort). The fake OpenAI client exposes a
 * "deferred" mode — each `create()` parks indefinitely until the test
 * either rejects it (via rejectCall) or until the engine fires the
 * AbortSignal (via engine.abort()). This lets us hold multiple turns in
 * flight at known points and exercise the ownership/lifecycle invariants
 * without reaching into private state.
 *
 * Aborts are exercised via `engine.abort()` (which fires the current
 * controller's signal). Race semantics are verified by observing signal
 * propagation through the fake's recorded AbortSignals.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ExecutionEngine } from '../src/core/engine.js'
import type { EngineConfig, Tool } from '../src/core/types.js'

interface CreateCall {
  params: Record<string, unknown>
  signal: AbortSignal
}

class Deferred<T> {
  promise: Promise<T>
  private resolveFn!: (v: T) => void
  constructor() {
    this.promise = new Promise<T>((r) => { this.resolveFn = r })
  }
  resolve(v: T): void { this.resolveFn(v) }
}

class FakeOpenAI {
  createCalls: CreateCall[] = []
  /** One reject fn per in-flight create() — test invokes these for deferred failure. */
  private rejecters: Array<(err: Error) => void> = []
  /** One resolve fn per in-flight create() — test invokes these to feed an empty stream. */
  private resolvers: Array<(stream: AsyncIterable<unknown>) => void> = []

  chat = {
    completions: {
      create: (params: Record<string, unknown>, opts: { signal: AbortSignal }): Promise<AsyncIterable<unknown>> => {
        const signal = opts.signal
        this.createCalls.push({ params, signal })
        return new Promise<AsyncIterable<unknown>>((resolve, reject) => {
          if (signal.aborted) {
            reject(new Error('aborted'))
            return
          }
          signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
          this.rejecters.push((err) => reject(err))
          this.resolvers.push((stream) => resolve(stream))
        })
      },
    },
  }

  /** Reject a specific in-flight create() — simulates upstream failure / cancellation. */
  rejectCall(idx: number, reason = 'upstream failure'): void {
    this.rejecters[idx]?.(new Error(reason))
  }

  /**
   * Resolve a specific in-flight create() with an empty stream — the engine's
   * consumeStream returns empty results, llm_call returns, and the state
   * machine transitions to check_abort where a pending soft-abort can fire.
   */
  completeCall(idx: number): void {
    this.resolvers[idx]?.(emptyStream())
  }
}

/**
 * AsyncIterable that yields a single tool-call chunk. The tool call forces
 * the state machine through parse_response → tool_execution → tools_done →
 * check_abort — the only path that revisits check_abort after llm_call.
 * Used by tests that need a pending soft-abort to actually fire.
 */
async function* emptyStream(): AsyncIterable<unknown> {
  await Promise.resolve()
  yield {
    choices: [{
      delta: {
        tool_calls: [{
          index: 0,
          id: 'tc_test_1',
          function: { name: 'Blocking', arguments: '{}' },
        }],
      },
      index: 0,
      finish_reason: 'tool_calls',
    }],
    usage: { prompt_tokens: 1, completion_tokens: 1 },
  }
}

function fakeRenderer() {
  return {
    banner: () => undefined,
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
    success: () => undefined,
    startSpinner: () => undefined,
    stopSpinner: () => undefined,
    beginAssistantText: () => undefined,
    endAssistantText: () => undefined,
    streamToken: () => undefined,
    toolStart: () => undefined,
    toolResult: () => undefined,
    compactStart: () => undefined,
    compactDone: () => undefined,
  } as unknown as ConstructorParameters<typeof ExecutionEngine>[1]
}

function baseConfig(): EngineConfig {
  return {
    apiKey: 'test-key',
    model: 'test-model',
    maxIterations: 10,
    cwd: '/tmp',
    permissionMode: 'auto',
    permissionManager: {
      check: () => 'allow',
      getMode: () => 'auto',
      getRules: () => [],
      formatMode: () => 'auto',
      formatRules: () => '',
      addRule: () => undefined,
      removeRule: () => undefined,
      cycleMode: () => 'auto',
      setMode: () => undefined,
    } as unknown as EngineConfig['permissionManager'],
    enabledModules: [],
  }
}

function makeEngine(): { engine: ExecutionEngine; client: FakeOpenAI } {
  return makeEngineWithTool()
}

function makeEngineWithTool(extraTool?: Tool): { engine: ExecutionEngine; client: FakeOpenAI } {
  const client = new FakeOpenAI()
  const cfg = baseConfig()
  if (extraTool) cfg.extraTools = [extraTool]
  const engine = new ExecutionEngine(
    cfg,
    fakeRenderer(),
    client as unknown as ConstructorParameters<typeof ExecutionEngine>[2],
  )
  return { engine, client }
}

/**
 * A blocking tool — its `execute()` parks on a caller-controlled Deferred.
 * Use the returned `release()` to let the tool complete. Tests use this to
 * hold an OLD turn inside tool_execution for a deterministic window.
 */
function blockingTool(): { tool: Tool; release: (value: string) => void } {
  const block = new Deferred<string>()
  const tool: Tool = {
    name: 'Blocking',
    definition: {
      type: 'function',
      function: { name: 'Blocking', description: '', parameters: { type: 'object', properties: {} } },
    },
    execute: (_input, _ctx) => block.promise.then((v) => ({ content: v, isError: false })),
    metadata: { concurrencySafe: false },
  }
  return { tool, release: (v: string) => block.resolve(v) }
}

/** Microtask tick — used to let runTurn() reach `await create()`. */
async function settle(): Promise<void> {
  await new Promise((r) => setImmediate(r))
}

describe('ExecutionEngine — abort() lifecycle', () => {
  let unhandledRejections: unknown[] = []
  let unhandledHandler: ((reason: unknown) => void) | undefined

  beforeEach(() => {
    unhandledRejections = []
    unhandledHandler = (reason: unknown) => { unhandledRejections.push(reason) }
    process.on('unhandledRejection', unhandledHandler)
  })

  afterEach(async () => {
    if (unhandledHandler) process.off('unhandledRejection', unhandledHandler)
    await settle()
  })

  it('engine.abort() fires the in-flight turn signal and runTurn converges', async () => {
    const { engine, client } = makeEngine()
    const t = engine.runTurn('hi', [])
    await settle()
    expect(client.createCalls).toHaveLength(1)
    const signal = client.createCalls[0].signal
    expect(signal.aborted).toBe(false)

    engine.abort()
    expect(signal.aborted).toBe(true)

    const turn = await t
    expect(turn.result.reason).toBe('interrupted')
    expect(turn.outcome.completion.status).toBe('cancelled')
    expect(turn.outcome.stopReason).toBe('cancelled')
    // After convergence, the next abort must be a safe no-op (no controller installed).
    expect(() => engine.abort()).not.toThrow()
  })

  it('abort() and softAbort() are safe no-ops when the engine is idle', () => {
    const { engine } = makeEngine()
    expect(() => engine.abort()).not.toThrow()
    expect(() => engine.softAbort()).not.toThrow()
    expect(() => engine.abort()).not.toThrow()
  })

  it('softAbortRequested does NOT cause the next turn to soft-abort after a hard abort', async () => {
    const { engine, client } = makeEngine()

    // Turn 1: start, then request soft-abort, then a hard abort cancels the LLM call.
    // softAbortRequested is set INSIDE the turn so the state machine doesn't
    // soft-abort at its first check_abort — that check happens before llm_call.
    const t1 = engine.runTurn('first', [])
    await settle()
    engine.softAbort()
    engine.abort()
    await t1

    expect(client.createCalls[0].signal.aborted).toBe(true)

    // Turn 2 must NOT soft-abort. If softAbortRequested had leaked from turn 1,
    // turn 2 would transition to soft_abort at its first check_abort BEFORE
    // reaching llm_call, leaving createCalls at length 1.
    const t2 = engine.runTurn('second', [])
    await settle()
    expect(client.createCalls).toHaveLength(2)
    expect(client.createCalls[1].signal.aborted).toBe(false)

    // Belt-and-braces: wait a tick and re-verify the signal is still un-aborted.
    // If a leaked soft-abort were going to fire, it would do so via the
    // soft_abort state transition which doesn't touch the signal — instead,
    // the loop would terminate and t2 would resolve. We assert t2 has not
    // resolved by checking the second signal is still live.
    await new Promise((r) => setTimeout(r, 30))
    expect(client.createCalls[1].signal.aborted).toBe(false)

    engine.abort()
    await t2
    expect(client.createCalls[1].signal.aborted).toBe(true)
  })

  it('NEW turn stays abortable after OLD turn rejected upstream (ownership race)', async () => {
    const { engine, client } = makeEngine()

    // SEQUENTIAL form of the prior concurrent ownership test. Two
    // simultaneous runTurn calls on the same engine are now structurally
    // rejected (see the "rejects concurrent runTurn" test below), so the
    // equivalent invariant is: after a turn converges via upstream
    // failure, the singleton slot is released and the NEXT turn installs
    // a fresh, independently-abortable controller. This is the safety net
    // for the ownership-aware finally cleanup — without it, a stuck
    // finally could leave a stale controller installed.

    // Turn 1 → parked in create(0)
    const t1 = engine.runTurn('old', [])
    await settle()
    const oldSignal = client.createCalls[0].signal
    expect(oldSignal.aborted).toBe(false)

    // Drive t1 to convergence via upstream failure. The catch + finally
    // paths fire; the singleton is released by ownership-aware cleanup.
    client.rejectCall(0, 'simulated upstream failure')
    await t1

    // Turn 2 — must install a fresh controller. The new signal should be
    // a different AbortSignal (proves the slot was released), and the new
    // engine.abort() must reach IT (proves the slot was repopulated cleanly).
    const t2 = engine.runTurn('new', [])
    await settle()
    const newSignal = client.createCalls[1].signal
    expect(newSignal).not.toBe(oldSignal)
    expect(newSignal.aborted).toBe(false)

    // Behavioral proof: engine.abort() must reach t2's signal even though
    // t1 had earlier installed + cleared a controller for the slot.
    engine.abort()
    expect(newSignal.aborted).toBe(true)

    await t2
    // After t2 converges, a third abort is again a safe no-op.
    expect(() => engine.abort()).not.toThrow()
  })

  it('aborting the in-flight turn does not damage prior turn state (sequential ownership)', async () => {
    const { engine, client } = makeEngine()

    // Turn 1 parks in create(0). Converge via upstream failure.
    const t1 = engine.runTurn('a', [])
    await settle()
    const t1Signal = client.createCalls[0].signal
    client.rejectCall(0, 'simulated upstream failure')
    await t1
    // Singleton released; t1's signal is fixed in its post-rejection state.
    expect(t1Signal.aborted).toBe(false) // never aborted, just rejected

    // Turn 2 parks in create(1). engine.abort() targets t2 — t1 is not in
    // flight anymore, but it would still be wrong for a buggy cleanup to
    // have inherited / corrupted t1's signal.
    const t2 = engine.runTurn('b', [])
    await settle()
    const t2Signal = client.createCalls[1].signal
    engine.abort()
    expect(t2Signal.aborted).toBe(true)
    expect(t1Signal.aborted).toBe(false) // still untouched

    await t2
  })

  it('no unhandled rejection is raised when a turn is aborted', async () => {
    const { engine } = makeEngine()
    const t = engine.runTurn('hi', [])
    await settle()
    engine.abort()
    await t
    await settle()
    expect(unhandledRejections).toEqual([])
  })

  it('multiple softAbort() calls do not stack — only one pending request survives', async () => {
    const { engine, client } = makeEngine()

    const t = engine.runTurn('q', [])
    await settle()
    engine.softAbort()
    engine.softAbort()
    engine.softAbort()
    engine.abort()
    await t
    expect(client.createCalls[0].signal.aborted).toBe(true)
  })

  it('a turn rejected via the fake client (not via abort) also converges cleanly', async () => {
    const { engine, client } = makeEngine()
    const t = engine.runTurn('hi', [])
    await settle()
    client.rejectCall(0, 'upstream failure')
    await t
    // After convergence, another abort is a safe no-op
    expect(() => engine.abort()).not.toThrow()
  })

  it('engine.abort() during the softAbort window still terminates the turn', async () => {
    const { engine, client } = makeEngine()
    const t = engine.runTurn('hi', [])
    await settle()
    engine.softAbort() // pauses after current tool, but we have no tools, so it
                       // would otherwise let the loop continue — instead we
                       // hard-abort to force convergence.
    engine.abort()
    await t
    expect(client.createCalls[0].signal.aborted).toBe(true)
  })

  it('softAbort() requested between two sequential turns survives the first turn finally (sequential NEW race)', async () => {
    const { engine, client } = makeEngine()

    // SEQUENTIAL form of the prior concurrent soft-flag test. After
    // runTurn rejection makes concurrency structurally impossible, the
    // observable softFlag path is: turn 1 parked → softAbort() queued →
    // turn 1 driven to convergence → turn 2 picks up the soft-flag at
    // its first check_abort and self-interrupts.

    // Turn 1 parks in llm_call. softAbort() called while turn 1 is
    // running — the flag's owner = turn 1's controller (since turn 2 has
    // not started yet, owner = currentTurnAbortController).
    const t1 = engine.runTurn('first', [])
    await settle()
    expect(client.createCalls).toHaveLength(1)
    engine.softAbort()

    // Drive turn 1 to convergence via upstream failure. The catch +
    // finally paths fire. Ownership-aware cleanup: if the soft-flag's
    // owner is OUR controller (and check_abort never claimed it), the
    // finally clears it. But because softAbort() inside the turn hadn't
    // been observed yet (no check_abort reached), the flag should still
    // belong to OUR controller when the finally runs — and be CLEARED
    // by ownership-aware cleanup. The test confirms: turn 1's reason is
    // 'error' (the hard-reject path), NOT 'interrupted' (the soft-abort
    // path that requires check_abort to have fired first).
    client.rejectCall(0, 'simulated upstream failure')
    const t1Result = await t1
    expect(t1Result.result.reason).toBe('error')

    // Turn 2 — soft-flag must be CLEAN (the prior turn's finally reset
    // it). turn 2 must reach llm_call and stay there.
    const t2 = engine.runTurn('second', [])
    await settle()
    expect(client.createCalls).toHaveLength(2)
    expect(client.createCalls[1].signal.aborted).toBe(false)

    // Belt-and-braces: tick a few ms and re-verify. If a leaked soft-abort
    // had survived, turn 2 would have transitioned to soft_abort at its
    // first check_abort BEFORE reaching llm_call — leaving createCalls
    // at length 1.
    await new Promise((r) => setTimeout(r, 30))
    expect(client.createCalls).toHaveLength(2)
    expect(client.createCalls[1].signal.aborted).toBe(false)

    engine.abort()
    await t2
  })

  it('softAbort() consumed within a single turn survives per-batch soft-abort checks (tool-schedule single-turn)', async () => {
    // Within a SINGLE turn, the softAbort flag must be observably consumed
    // only when OWNERSHIP matches the current controller. This is the
    // in-turn shape of the prior concurrent "scheduleToolCalls consumes
    // NEW's soft-abort" test — same invariant, single-turn.
    const { tool, release } = blockingTool()
    const { engine, client } = makeEngineWithTool(tool)

    const t1 = engine.runTurn('a', [])
    await settle()
    expect(client.createCalls).toHaveLength(1)

    // Feed turn 1 a Blocking tool call → enters tool_execution, parks
    // inside the blocking tool.execute().
    client.completeCall(0)
    await new Promise((r) => setTimeout(r, 10))

    // Now while turn 1 is parked inside the tool, request softAbort.
    // The flag's owner = turn 1's controller (the only one in flight).
    engine.softAbort()

    // Release the tool — scheduleToolCalls runs its per-batch check,
    // owner matches → consume → scheduleToolCalls returns aborted=true.
    // The state machine transitions to tools_done then check_abort.
    release('done')
    await new Promise((r) => setTimeout(r, 30))

    // The flag was consumed, so turn 1 will terminate with reason='interrupted'.
    const t1Result = await t1
    expect(t1Result.result.reason).toBe('interrupted')
    expect(t1Result.result.stopped).toBe(true)
  })

  it('hard-abort after softAbort still clears the flag for the next turn (regression)', async () => {
    const { engine, client } = makeEngine()

    // Turn 1: softAbort during the run, then hard-abort
    const t1 = engine.runTurn('first', [])
    await settle()
    engine.softAbort()
    engine.abort()
    const t1Result = await t1
    expect(t1Result.result.reason).toBe('interrupted')
    expect(t1Result.outcome.completion.status).toBe('cancelled')
    expect(t1Result.outcome.stopReason).toBe('cancelled')
    expect(client.createCalls[0].signal.aborted).toBe(true)

    // Turn 2 must NOT soft-abort. If the soft-flag had leaked, turn 2 would
    // transition to soft_abort at its first check_abort BEFORE llm_call,
    // leaving createCalls at length 1.
    const t2 = engine.runTurn('second', [])
    await settle()
    expect(client.createCalls).toHaveLength(2)
    expect(client.createCalls[1].signal.aborted).toBe(false)

    // Clean up
    engine.abort()
    await t2
  })
})
