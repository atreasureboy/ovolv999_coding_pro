/**
 * completion_rejected ICM was dead wiring: the verdict is appended to the
 * per-run ControlMessageLog AFTER the state machine loop exits, but the
 * log's only render point is the top of each llm_call INSIDE the loop —
 * and the log is fresh per run. The rejection never reached any provider.
 *
 * Fix: carry a rejected verdict into the next run's log (a resumed run
 * sees its own verdict, a follow-up turn sees the last closed run's).
 * Regression: turn 1 stops prematurely (mutation task, zero changes →
 * blocked) → turn 2's first provider call must open with the rejection.
 */
import { describe, it, expect } from 'vitest'
import OpenAI from 'openai'
import { ExecutionEngine } from '../src/core/engine.js'
import { completionRejection } from '../src/core/runtime/coordinator.js'
import { InMemoryRunScopedRuntimeContextStore } from '../src/core/runtime/runScopedContext.js'

function fakeRenderer() {
  return {
    info: () => {}, warn: () => {}, error: () => {},
    success: () => {}, banner: () => {},
    startSpinner: () => {}, stopSpinner: () => {},
    beginAssistantText: () => {}, endAssistantText: () => {},
    streamToken: () => {}, toolStart: () => {}, toolResult: () => {},
    compactStart: () => {}, compactDone: () => {}, contextWarning: () => {},
  } as never
}

/** Client that just stops with text every call and records each call's
 *  messages so the test can inspect what the provider actually saw. */
function recordingClient() {
  const calls: OpenAI.Chat.ChatCompletionMessageParam[][] = []
  return {
    calls,
    chat: {
      completions: {
        create: async (params: { messages: OpenAI.Chat.ChatCompletionMessageParam[] }) => {
          calls.push([...params.messages])
          const chunks = [
            { choices: [{ delta: { role: 'assistant' }, index: 0 }] },
            { choices: [{ delta: { content: 'Understood.' }, index: 0 }] },
          ]
          return {
            [Symbol.asyncIterator]: () => {
              let i = 0
              return {
                next: async () => (i < chunks.length ? { value: chunks[i++], done: false } : { value: undefined as never, done: true }),
              }
            },
          }
        },
      },
    },
  }
}

function makeEngine(client: unknown) {
  return new ExecutionEngine({
    apiKey: 'test',
    model: 'gpt-4o',
    baseURL: 'https://api.example.com/v1',
    maxIterations: 10,
    cwd: '/tmp',
    permissionMode: 'bypassPermissions',
    enabledModules: [],
  } as never, fakeRenderer(), client as unknown as OpenAI)
}

function rejectionSeenIn(calls: OpenAI.Chat.ChatCompletionMessageParam[][]): boolean {
  return calls.some((msgs) => msgs.some((m) =>
    m.role === 'system' && typeof m.content === 'string'
    && m.content.startsWith('[runtime control · completion_rejected'),
  ))
}

describe('completion_rejected seed across runs', () => {
  it('a rejected stop in turn 1 reaches the provider in turn 2', async () => {
    const client = recordingClient()
    const engine = makeEngine(client)
    // Turn 1: mutation intent, no files changed → the contract blocks the
    // stop (anti-fake-success: mutation without evidence is not complete).
    const t1 = await engine.runTurn('fix the bug in src/foo.ts', [])
    expect(t1.outcome.completion.status).toBe('blocked')
    expect(client.calls.length).toBeGreaterThanOrEqual(1)
    // The rejection must NOT have leaked into turn 1's own calls — the
    // append happens after the loop, so turn 1 never rendered it.
    expect(rejectionSeenIn(client.calls)).toBe(false)
    const turn1CallCount = client.calls.length

    // Turn 2 on the SAME engine: fresh per-run log, seeded from the last
    // closed run's verdict. The very first provider call must open with it.
    await engine.runTurn('say hello', [])
    expect(client.calls.length).toBeGreaterThan(turn1CallCount)
    const turn2Start = turn1CallCount
    expect(rejectionSeenIn([client.calls[turn2Start]])).toBe(true)
    const seeded = client.calls[turn2Start].find((m) =>
      m.role === 'system' && typeof m.content === 'string'
      && m.content.startsWith('[runtime control · completion_rejected'),
    )
    expect(seeded).toBeDefined()
    expect(String(seeded!.content)).toContain('NOT accepted')
  })

  it('turn after a COMPLETED run carries no rejection seed', async () => {
    const client = recordingClient()
    const engine = makeEngine(client)
    // Informational task, no criteria → verdict completed.
    const t1 = await engine.runTurn('say hello', [])
    expect(t1.outcome.completion.status).toBe('completed')
    await engine.runTurn('say hello again', [])
    expect(rejectionSeenIn(client.calls)).toBe(false)
  })
})

describe('completionRejection payload extraction', () => {
  it('carries the outstanding work for stop-rejection statuses', () => {
    expect(completionRejection({ status: 'blocked', blockers: ['tests fail'] }))
      .toEqual({ verdict: 'blocked', blockers: ['tests fail'] })
    expect(completionRejection({ status: 'partial', evidence: [], remaining: ['write docs'], residualRisks: [] }))
      .toEqual({ verdict: 'partial', blockers: ['write docs'] })
    expect(completionRejection({ status: 'incomplete', remaining: ['migrate b'] }))
      .toEqual({ verdict: 'incomplete', blockers: ['migrate b'] })
  })

  it('returns null for run-termination statuses that are not rejected stops', () => {
    expect(completionRejection({ status: 'completed', evidence: ['a'], residualRisks: [] })).toBeNull()
    expect(completionRejection({ status: 'cancelled', reason: 'user cancelled' })).toBeNull()
    expect(completionRejection({ status: 'failed', reason: 'provider down', evidence: [] })).toBeNull()
    expect(completionRejection({ status: 'exhausted', reason: 'ceiling', iterationsUsed: 5, iterationsMax: 5 })).toBeNull()
  })
})

describe('store.getLastClosed', () => {
  it('tracks the most recently closed context', () => {
    const store = new InMemoryRunScopedRuntimeContextStore()
    const identity = { inputCwd: '/tmp', canonicalRoot: '/tmp', projectKey: 'x', binding: {} as never } as never
    expect(store.getLastClosed()).toBeUndefined()
    const a = store.create('run-a', { taskKind: 'informational', projectIdentity: identity })
    store.close('run-a')
    expect(store.getLastClosed()).toBe(a)
    const b = store.create('run-b', { taskKind: 'informational', projectIdentity: identity })
    expect(store.getLastClosed()).toBe(a)
    store.close('run-b')
    expect(store.getLastClosed()).toBe(b)
  })
})
