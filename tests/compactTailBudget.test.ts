import { describe, it, expect } from 'vitest'
import {
  computeSafeSplitPoint,
  extendTailToTokenBudget,
  estimateTokens,
  maybeCompact,
} from '../src/core/compact.js'
import type { OpenAIMessage } from '../src/core/types.js'

/**
 * Round 39 (opencode tail-budget): the verbatim tail of a compaction is
 * anchored at a TOKEN budget on top of the message-count floor — tiny
 * tails get extended backward so recent context survives summarization,
 * while every intermediate boundary stays API-safe.
 */

function chat(role: 'user' | 'assistant', content: string): OpenAIMessage {
  return { role, content }
}

describe('extendTailToTokenBudget', () => {
  it('extends the tail when the last 8 messages are tiny', () => {
    const messages: OpenAIMessage[] = []
    for (let i = 0; i < 30; i++) {
      messages.push(chat('user', `message number ${i} ${'x'.repeat(1200)}`))
      messages.push(chat('assistant', `reply number ${i} ${'y'.repeat(1200)}`))
    }
    // Replace the tail with 1-liners.
    for (let i = messages.length - 8; i < messages.length; i++) {
      messages[i] = chat('user', 'ok')
    }
    messages[messages.length - 1] = chat('assistant', 'done')

    const base = computeSafeSplitPoint(messages)
    expect(base).toBe(messages.length - 8)

    const extended = extendTailToTokenBudget(messages, base)
    expect(extended).toBeLessThan(base)
    // Tail now meets the budget (or ran out of safe boundaries).
    expect(estimateTokens(messages.slice(extended))).toBeGreaterThanOrEqual(8_000)
  })

  it('leaves the split alone when the tail already carries enough tokens', () => {
    const messages: OpenAIMessage[] = []
    for (let i = 0; i < 12; i++) {
      messages.push(chat('user', `u${i} ${'x'.repeat(4000)}`))
      messages.push(chat('assistant', `a${i} ${'y'.repeat(4000)}`))
    }
    const base = computeSafeSplitPoint(messages)
    expect(extendTailToTokenBudget(messages, base)).toBe(base)
  })

  it('never crosses an unsafe boundary (tool groups stay intact)', () => {
    const messages: OpenAIMessage[] = [
      chat('user', 'start'),
      { role: 'assistant', content: null, tool_calls: [{ id: 't1', type: 'function', function: { name: 'Bash', arguments: '{}' } }] },
      { role: 'tool', tool_call_id: 't1', content: 'result' },
      ...Array.from({ length: 20 }, (_, i) => chat(i % 2 === 0 ? 'user' : 'assistant', 'short')),
    ]
    const base = computeSafeSplitPoint(messages)
    const extended = extendTailToTokenBudget(messages, base)
    // Re-slicing at the extended point must still be API-safe: the first
    // kept message is never an orphan tool row / tool_call assistant.
    const kept = messages.slice(extended)
    expect(['user', 'assistant']).toContain(kept[0].role)
    if (kept[0].role === 'assistant' && kept[0].tool_calls?.length) {
      const ids = new Set(kept[0].tool_calls.map((tc) => tc.id))
      for (const m of kept) {
        if (m.role === 'tool' && m.tool_call_id) ids.delete(m.tool_call_id)
      }
      expect(ids.size).toBe(0)
    }
  })
})

describe('maybeCompact tail budget integration', () => {
  it('preserves more than the message-count floor when the tail is tiny', async () => {
    const messages: OpenAIMessage[] = []
    for (let i = 0; i < 20; i++) {
      messages.push(chat('user', `user turn ${i} ${'x'.repeat(300)}`))
      messages.push(chat('assistant', `assistant turn ${i} ${'y'.repeat(300)}`))
    }
    for (let i = messages.length - 8; i < messages.length; i++) {
      messages[i] = chat('user', 'k')
    }
    messages[messages.length - 1] = chat('assistant', 'k')

    const summarizeCalls: string[] = []
    const client = {
      chat: {
        completions: {
          create: async (req: { messages: Array<{ role: string; content: string }> }) => {
            summarizeCalls.push(req.messages[1]?.content ?? '')
            return {
              choices: [{ message: { content: '## Summary\n- did things' } }],
            }
          },
        },
      },
    } as never

    const result = await maybeCompact(client, 'test-model', messages)
    expect(result.compacted).toBe(true)
    // Tail = everything after the summary message.
    const tailLength = result.messages.length - 1
    expect(tailLength).toBeGreaterThan(8)
    // The summarized portion shrank accordingly.
    expect(summarizeCalls[0]).toBeDefined()
    expect(summarizeCalls[0].length).toBeLessThan(
      messages.slice(0, messages.length - tailLength)
        .map((m) => (typeof m.content === 'string' ? m.content : ''))
        .join('\n').length + 1000,
    )
  })
})
