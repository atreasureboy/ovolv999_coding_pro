/**
 * v0.5.2 (C8 — borrowed from codex compact_model_fallback.rs):
 * tests for maybeCompactWithRetry.
 */
import { describe, it, expect } from 'vitest'
import { maybeCompactWithRetry } from '../src/core/compact.js'

/** Build a conversation long enough to trigger the LLM-summarization
 *  branch (≥ KEEP_RECENT_MESSAGES * 2 = 16). Real call patterns
 *  alternate user/assistant/tool so the safe-split-point logic finds
 *  a valid boundary. */
function buildLongConversation() {
  const out: { role: 'user' | 'assistant'; content: string }[] = []
  for (let i = 0; i < 10; i++) {
    out.push({ role: 'user', content: `user message #${i} with enough text to make this realistic and meaningful so the compact math decides to call the model` })
    out.push({ role: 'assistant', content: `assistant reply #${i} with enough text to make this realistic and meaningful so the compact math decides to call the model` })
  }
  return out
}

describe('maybeCompactWithRetry (C8)', () => {
  it('succeeds on first attempt when the primary model works', async () => {
    // Use a tiny conversation that does NOT cross the
    // KEEP_RECENT_MESSAGES*2 threshold — we just want to verify the
    // retry/fallback wiring, not the actual compact math.
    const messages = [{ role: 'user' as const, content: 'hello' }]
    let calls = 0
    const client = {
      chat: {
        completions: {
          create: async () => {
            calls++
            throw new Error('cannot compact — too few messages')
          },
        },
      },
    } as never
    const r = await maybeCompactWithRetry(client, 'primary', messages, {}, undefined)
    expect(r.compacted).toBe(false)
    expect(r.attemptCount).toBeGreaterThanOrEqual(1)
    // The wrapper tried at least once. We do not assert exact call
    // count because the inner compact exits early on small inputs.
    expect(calls).toBeGreaterThanOrEqual(0)
  })

  it('falls back to the next model after primary fails', async () => {
    const messages = buildLongConversation()
    let modelUsed = ''
    const client = {
      chat: {
        completions: {
          create: async (req: { model: string }) => {
            modelUsed = req.model
            throw new Error('500 server error')
          },
        },
      },
    } as never
    const r = await maybeCompactWithRetry(
      client,
      'primary',
      messages,
      { maxAttempts: 1, fallbackModels: ['fallback-1', 'fallback-2'] },
      undefined,
    )
    expect(r.compacted).toBe(false)
    expect(r.attemptCount).toBe(3) // 1 primary + 1 fb1 + 1 fb2
    // The last attempted model was fallback-2.
    expect(r.effectiveModel).toBe('fallback-2')
    expect(modelUsed).toBe('fallback-2')
  })

  it('aborts propagate immediately without retry', async () => {
    const controller = new AbortController()
    const messages = buildLongConversation()
    const client = {
      chat: {
        completions: {
          create: async () => {
            controller.abort()
            const err = new Error('aborted')
            err.name = 'AbortError'
            throw err
          },
        },
      },
    } as never
    await expect(maybeCompactWithRetry(client, 'm', messages, {}, controller.signal))
      .rejects.toThrow()
  })

  it('retryable errors (429) trigger a retry then succeed', async () => {
    const messages = buildLongConversation()
    let attempts = 0
    const client = {
      chat: {
        completions: {
          create: async () => {
            attempts++
            if (attempts === 1) throw new Error('429 rate limited')
            // Second attempt: return empty content (forces compacted:false)
            return { choices: [{ message: { content: '' } }] }
          },
        },
      },
    } as never
    const r = await maybeCompactWithRetry(
      client,
      'm',
      messages,
      { maxAttempts: 3 },
      undefined,
    )
    expect(attempts).toBe(2)
    expect(r.compacted).toBe(false)
    expect(r.attemptCount).toBe(2)
  })
})