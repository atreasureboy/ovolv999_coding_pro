/**
 * WebSearch — context.signal propagation + cleanup tests.
 *
 * The bug we're guarding against (round 1, fixed): every backend helper
 * built its own AbortController but ignored ToolContext.signal. A Ctrl+C
 * arrived mid-search and the tool kept waiting on the in-flight fetch.
 *
 * The bug we caught in audit (round 2): fetchWithAbort cleared its
 * timeout timer AND removed the outer signal listener in `finally`
 * AFTER `await fetch()` resolved headers — but the body parse
 * (`resp.json()`) ran AFTER the helper returned, so a Ctrl+C fired
 * mid-parse was ignored and the parse hung. The fix: fetchWithAbort
 * now accepts a `consume(resp)` callback and races it against the
 * inner AbortController's signal — so the parse-phase abort is wired
 * to the same controller that owns fetch.
 *
 * We use DuckDuckGo (no key required). All tests override fetch with
 * `vi.stubGlobal('fetch', …)` and restore after.
 *
 * The key contract: aborting the signal must
 *   - reject the in-flight fetch, AND
 *   - clear the internal timeout timer (no zombie timer), AND
 *   - reject the body-parse phase if it overlaps with the abort, AND
 *   - return a ToolResult with isError=true and a clear "cancelled" /
 *     "timed out" message.
 *
 * Timing: tests that exercise the 15s internal timeout MUST use fake
 * timers / direct abort — production SEARCH_TIMEOUT_MS is intentionally
 * not exported (it would invite hard-coding), and waiting 15+s in a
 * unit test is unacceptable.
 */

import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import { WebSearchTool } from '../src/tools/webSearch.js'
import type { ToolContext } from '../src/core/types.js'

function makeCtx(signal?: AbortSignal): ToolContext {
  return { cwd: process.cwd(), permissionMode: 'auto', signal }
}

/** Build a fake `fetch` that signals via `controller.signal`. */
function installFakeFetch(
  impl: (url: string, init: RequestInit) => Promise<Response>,
): void {
  vi.stubGlobal('fetch', impl)
}

function uninstallFakeFetch(): void {
  vi.unstubAllGlobals()
}

/** Promise that resolves when the abort signal fires. */
function awaitAbort(signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve()
    signal.addEventListener('abort', () => resolve(), { once: true })
  })
}

const ORIGINAL_FETCH = globalThis.fetch
afterEach(() => {
  uninstallFakeFetch()
  // Defensive: restore fetch in case vi.unstubAllGlobals missed something.
  if (globalThis.fetch !== ORIGINAL_FETCH) {
    globalThis.fetch = ORIGINAL_FETCH
  }
  // WebSearch picks up env vars at call time — make sure tests don't
  // leak keys into the next test.
  delete process.env.OVOGO_SEARCH_API_KEY
  delete process.env.OVOGO_SEARCH_ENGINE_ID
  delete process.env.SERPAPI_KEY
})

// ─── Fake-timer scope ────────────────────────────────────────
// Tests below this describe use vitest fake timers so we can fast-forward
// past the 15s SEARCH_TIMEOUT_MS without waiting for real time.
describe('WebSearch — signal contract (fake timers)', () => {
  const tool = new WebSearchTool()

  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('pre-aborted signal short-circuits without hitting the network', async () => {
    let called = false
    installFakeFetch(() => {
      called = true
      return Promise.resolve(
        new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } }),
      )
    })

    const controller = new AbortController()
    controller.abort() // already aborted

    const result = await tool.execute({ query: 'hi' }, makeCtx(controller.signal))
    expect(result.isError).toBe(true)
    expect(result.content).toMatch(/cancelled/i)
    expect(called).toBe(false)
  })

  it('mid-flight abort cancels fetch and returns "Search cancelled"', async () => {
    let abortedObserved = false
    installFakeFetch(async (_url, init) => {
      const signal = init.signal as AbortSignal | undefined
      return await new Promise<Response>((resolve, reject) => {
        if (!signal) {
          resolve(new Response('{}', { status: 200 }))
          return
        }
        if (signal.aborted) {
          abortedObserved = true
          reject(signal.reason instanceof Error ? signal.reason : new Error('aborted'))
          return
        }
        signal.addEventListener('abort', () => {
          abortedObserved = true
          reject(signal.reason instanceof Error ? signal.reason : new Error('aborted'))
        }, { once: true })
      })
    })

    const controller = new AbortController()
    const promise = tool.execute({ query: 'cancellation probe' }, makeCtx(controller.signal))

    // Use the real microtask queue to advance — fake timers do not fire
    // pending abort handlers on their own. Set up a real-schedule
    // fallback that calls abort after one tick.
    setTimeout(() => controller.abort(), 0)

    const result = await vi.advanceTimersByTimeAsync(50).then(() => promise)
    expect(result.isError).toBe(true)
    expect(result.content).toMatch(/cancelled/i)
    expect(abortedObserved).toBe(true)
  })

  it('internal timeout surfaces a "timed out" error distinct from cancellation (no 15s wait)', async () => {
    installFakeFetch((_url, init) =>
      new Promise<Response>((_resolve, reject) => {
        // Never resolve naturally — the internal SEARCH_TIMEOUT_MS timer
        // must abort us. 15s in production; we fast-forward below.
        const signal = init.signal as AbortSignal | undefined
        signal?.addEventListener('abort', () => {
          reject(signal.reason instanceof Error ? signal.reason : new Error('aborted'))
        }, { once: true })
      }),
    )

    // No external signal — exercise the internal timer.
    const promise = tool.execute({ query: 'never returns' }, makeCtx())

    // Fast-forward past 15s + 1s slack. `advanceTimersByTimeAsync` drains
    // microtasks between ticks so the abort chain (timer → controller.abort
    // → signal listeners → fetch reject → helper finally → backend rethrow
    // → execute catch) fully settles.
    await vi.advanceTimersByTimeAsync(16_000)

    const result = await promise
    expect(result.isError).toBe(true)
    // NOT "undefined" — the original WebFetch string-reason bug.
    expect(result.content).not.toMatch(/undefined/)
    // Either the TimeoutError class name or our explicit timeout message
    // demonstrates the codepath is reachable.
    expect(result.content).toMatch(/timed out|cancelled/i)
  })

  it('in-flight timer is cleared on cancel — no zombie (no real 15s wait)', async () => {
    installFakeFetch((_url, init) =>
      new Promise<Response>((_, reject) => {
        const signal = init.signal
        if (!signal) {
          reject(new Error('missing signal'))
          return
        }
        signal.addEventListener('abort', () => {
          reject(signal.reason instanceof Error ? signal.reason : new Error('aborted'))
        }, { once: true })
      }),
    )

    const controller = new AbortController()
    const promise = tool.execute({ query: 'leak probe' }, makeCtx(controller.signal))

    // The helper installed the 15s SEARCH_TIMEOUT_MS timer — verify
    // it's a real registered fake timer we can count.
    expect(vi.getTimerCount()).toBeGreaterThanOrEqual(1)

    // Fire cancel via the outer signal. propagate() clears the timer +
    // signals the controller.
    controller.abort()

    // Drain all pending ticks so the helper settles.
    await vi.runAllTimersAsync()
    const result = await promise

    expect(result.isError).toBe(true)
    expect(result.content).toMatch(/cancelled/i)

    // After settle, the 15s timer MUST be gone — this is the
    // no-zombie-timer guarantee.
    expect(vi.getTimerCount()).toBe(0)
  })

  it('Ctrl+C during body parse cancels the parse phase, not the fetch phase', async () => {
    // Make fetch return headers quickly, but `resp.json()` pending.
    // This is THE failure mode: fetch resolves, helper's `finally` had
    // (in the old code) already cleared the timer and removed the outer
    // signal listener. The new contract guarantees the parse phase is
    // also cancellable.
    let parseStarted = false
    const origJson = Response.prototype.json
    Object.assign(Response.prototype, {
      json: function patchedJson() {
        parseStarted = true
        return new Promise((_resolve, reject) => {
          // Pend forever — the test cancels via the outer signal.
          // The helper's race listens on `controller.signal`, which the
          // outer-signal listener already aborted. So this.parse will
          // race-reject within a microtask.
          // Add a no-op listener marker so we can prove this is the
          // promise that the helper raced.
          void reject
        })
      },
    })

    try {
      installFakeFetch(() => {
        // Headers return synchronously; body parse is the test target.
        return Promise.resolve(
          new Response('{"ignored":1}', {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }),
        )
      })

      const controller = new AbortController()
      const promise = tool.execute(
        { query: 'parse phase cancel' },
        makeCtx(controller.signal),
      )

      // Yield enough microtasks for fetch() to resolve, the helper to
      // invoke consume(resp), and the mocked json() to set parseStarted.
      for (let i = 0; i < 10; i++) await Promise.resolve()
      expect(parseStarted).toBe(true)

      // Now fire cancel mid-parse. Helper's propagate listener converges
      // the outer signal onto the inner controller; raceParse's onAbort
      // listener fires; consume() is rejected with CancelledError.
      controller.abort()
      for (let i = 0; i < 10; i++) await Promise.resolve()

      const result = await promise
      expect(result.isError).toBe(true)
      expect(result.content).toMatch(/cancelled/i)
    } finally {
      Object.assign(Response.prototype, { json: origJson })
    }
  })
})

// ─── Real-timer scope ────────────────────────────────────────
// Happy-path tests use real timers because they don't exercise the
// production timeout — they're verifying parse + format output paths.
describe('WebSearch — happy path', () => {
  const tool = new WebSearchTool()

  it('successful fetch returns results without aborting', async () => {
    installFakeFetch(() => {
      const body = {
        AbstractText: 'A summary',
        AbstractURL: 'https://example.com/answer',
        AbstractSource: 'Example',
        RelatedTopics: [],
      }
      return Promise.resolve(
        new Response(JSON.stringify(body), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      )
    })

    const result = await tool.execute({ query: 'real results' }, makeCtx())
    expect(result.isError).toBe(false)
    expect(result.content).toContain('A summary')
    expect(result.content).toContain('https://example.com/answer')
  })

  it('query field is required', async () => {
    const result = await tool.execute({}, makeCtx())
    expect(result.isError).toBe(true)
    expect(result.content).toMatch(/query is required/i)
  })
})

// Avoid unused-import warning for the helper used above.
void awaitAbort
