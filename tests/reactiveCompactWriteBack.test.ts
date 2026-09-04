/**
 * Reactive compaction on context overflow used to compact a THROWAWAY
 * array: when control messages rendered for a call, the gateway received
 * `[...controlMessages, ...messages]`, and reactiveCompact's in-place
 * mutation landed in that per-call copy. The retry succeeded (the gateway
 * held the copy), but the live loop history stayed oversized — every
 * later call re-overflowed and re-paid a summarization request, and the
 * run's real history never reflected the compaction.
 *
 * Regression: after an overflow-compacted call, the LIVE history must be
 * the compacted one (summary at the head, compacted tail, no control
 * messages) on the NEXT provider call.
 */
import { describe, it, expect } from 'vitest'
import OpenAI from 'openai'
import { ExecutionEngine } from '../src/core/engine.js'
import type { OpenAIMessage } from '../src/core/types.js'

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

/** Streams text on `stream:true` (the model path) and answers the
 *  non-streaming summarization request. Rejects with an overflow error
 *  while the pre-compaction filler head is still visible. */
function scriptedClient() {
  const streamingCalls: OpenAI.Chat.ChatCompletionMessageParam[][] = []
  let summarizations = 0
  return {
    streamingCalls,
    summarizationCount: () => summarizations,
    chat: {
      completions: {
        create: async (params: {
          stream?: boolean
          messages: OpenAI.Chat.ChatCompletionMessageParam[]
        }) => {
          if (params.stream === true) {
            streamingCalls.push([...params.messages])
            const overflow = params.messages.some(
              (m) => typeof m.content === 'string'
                && m.content.includes('FILLER_00')
                && !m.content.includes('[CONVERSATION SUMMARY'),
            )
            if (overflow) {
              throw new Error('This model\'s maximum context length is 128000 tokens. However, your messages resulted in 130000 tokens. Please reduce the length of the messages.')
            }
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
          }
          // Non-streaming create = the compaction summarizer.
          summarizations++
          return { choices: [{ message: { role: 'assistant', content: '<summary>earlier filler work compacted</summary>' } }] }
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
  }, fakeRenderer(), client as OpenAI)
}

/** Pre-compaction filler head: enough messages for maybeCompact to have
 *  something older than its KEEP_RECENT_MESSAGES window. Messages are
 *  large so the 8k-token tail-preservation budget is satisfied by the
 *  recent window alone and the split stays above the FILLER_00 head. */
function fillerHistory(): OpenAIMessage[] {
  const filler = 'x'.repeat(6000)
  const history: OpenAIMessage[] = []
  for (let i = 0; i < 10; i++) {
    history.push({ role: 'user', content: `FILLER_${String(i).padStart(2, '0')} ${filler}` })
    history.push({ role: 'assistant', content: `FILLER_ACK_${String(i).padStart(2, '0')} ${filler}` })
  }
  return history
}

describe('reactive compaction write-back', () => {
  it('lands the compacted history in the live loop, not just the retry copy', async () => {
    const client = scriptedClient()
    const engine = makeEngine(client)

    // Turn 1 seeds a control message (rejected completion) so turn 2's
    // gateway request is the per-call COPY path.
    const t1 = await engine.runTurn('fix the bug in src/foo.ts', [])
    expect(t1.outcome.completion.status).toBe('blocked')

    // Turn 2 overflows on its first call, compacts, retries successfully.
    const t2 = await engine.runTurn('continue', fillerHistory())
    expect(t2.result.reason).toBe('stop_sequence')
    expect(client.summarizationCount()).toBeGreaterThanOrEqual(1)
    // The retry call itself carried the compacted array.
    const retryCall = client.streamingCalls[client.streamingCalls.length - 1]
    expect(retryCall.some((m) => typeof m.content === 'string' && m.content.startsWith('[CONVERSATION SUMMARY'))).toBe(true)

    // WRITE-BACK: the turn's final history must BE the compacted one —
    // summary at the head, filler head gone, no control messages leaked
    // into user-visible history.
    expect(t2.newHistory.some((m) => typeof m.content === 'string' && m.content.startsWith('[CONVERSATION SUMMARY'))).toBe(true)
    expect(t2.newHistory.some((m) => typeof m.content === 'string' && m.content.includes('FILLER_00'))).toBe(false)
    expect(t2.newHistory.some((m) => typeof m.content === 'string' && m.content.startsWith('[runtime control'))).toBe(false)

    // Turn 3 (threading newHistory like the REPL does) must NOT need a
    // second compaction: its very first call already sees compacted
    // history.
    const summarizationsAfterTurn2 = client.summarizationCount()
    const callsAfterTurn2 = client.streamingCalls.length
    await engine.runTurn('say hello', t2.newHistory)
    expect(client.summarizationCount()).toBe(summarizationsAfterTurn2)
    const turn3FirstCall = client.streamingCalls[callsAfterTurn2]
    expect(turn3FirstCall.some((m) => typeof m.content === 'string' && m.content.startsWith('[CONVERSATION SUMMARY'))).toBe(true)
    expect(turn3FirstCall.some((m) => typeof m.content === 'string' && m.content.includes('FILLER_00'))).toBe(false)
    expect(turn3FirstCall.some((m) => typeof m.content === 'string' && m.content.startsWith('[runtime control'))).toBe(false)
  })
})
