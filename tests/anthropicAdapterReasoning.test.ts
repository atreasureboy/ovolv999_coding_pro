/**
 * Round 42 normalized reasoning options ride every ProviderStreamRequest.
 * The OpenAI-compatible adapter translates them per flavor, but the
 * Anthropic adapter dropped `req.reasoning` on the floor — extended
 * thinking was reachable only through the raw providerOptions.thinkingBudget
 * escape hatch, so config.reasoning silently did nothing on this transport.
 *
 * The adapter must translate the anthropic-thinking flavor, clamp the
 * budget to the request's max_tokens (the API rejects budget >= max_tokens)
 * and force temperature 1 (thinking is incompatible with sampling).
 */
import { describe, it, expect } from 'vitest'
import { AnthropicAdapter } from '../src/core/model/anthropicAdapter.js'
import type { ProviderStreamRequest } from '../src/core/model/providerAdapter.js'

function captureParams(): { adapter: AnthropicAdapter; params: () => Record<string, unknown> } {
  let captured: Record<string, unknown> | undefined
  const adapter = new AnthropicAdapter({ apiKey: 'test-key' })
  ;(adapter as unknown as { client: unknown }).client = {
    messages: {
      stream: (p: Record<string, unknown>) => {
        captured = p
        return {
          controller: { abort: () => {} },
          async *[Symbol.asyncIterator]() {
            yield { type: 'message_stop' }
          },
        }
      },
    },
  }
  return { adapter, params: () => captured! }
}

function makeRequest(reasoning: ProviderStreamRequest['reasoning'], maxOutputTokens?: number): ProviderStreamRequest {
  return {
    model: 'claude-test',
    systemPrompt: '',
    messages: [{ role: 'user', content: 'hi' }],
    tools: [],
    maxOutputTokens: maxOutputTokens ?? 64_000,
    signal: new AbortController().signal,
    reasoning,
  }
}

describe('AnthropicAdapter normalized reasoning translation', () => {
  it('enables thinking from reasoning.budgetTokens and forces temperature 1', async () => {
    const { adapter, params } = captureParams()
    await adapter.stream(makeRequest({ effort: 'medium', budgetTokens: 8_192 }))
    expect(params().thinking).toEqual({ type: 'enabled', budget_tokens: 8_192 })
    expect(params().temperature).toBe(1)
  })

  it('falls back to the default budget when only effort is set', async () => {
    const { adapter, params } = captureParams()
    await adapter.stream(makeRequest({ effort: 'high' }))
    expect(params().thinking).toEqual({ type: 'enabled', budget_tokens: 10_240 })
    expect(params().temperature).toBe(1)
  })

  it('clamps the budget below max_tokens instead of sending a guaranteed 400', async () => {
    const { adapter, params } = captureParams()
    await adapter.stream(makeRequest({ effort: 'high', budgetTokens: 20_000 }, 8_192))
    const thinking = params().thinking as { type: string; budget_tokens: number }
    expect(thinking.type).toBe('enabled')
    expect(thinking.budget_tokens).toBeLessThan(8_192)
  })

  it('skips thinking entirely when the output budget cannot fit the floor', async () => {
    const { adapter, params } = captureParams()
    await adapter.stream(makeRequest({ effort: 'high' }, 1_024))
    expect(params().thinking).toBeUndefined()
    // Temperature must keep the caller's value when thinking is off.
    expect(params().temperature).toBeUndefined()
  })

  it('enabled:false keeps thinking off and the caller temperature intact', async () => {
    const { adapter, params } = captureParams()
    await adapter.stream(makeRequest({ effort: 'high', enabled: false }))
    expect(params().thinking).toBeUndefined()
    expect(params().temperature).toBeUndefined()
  })

  it('an explicit providerOptions.thinkingBudget stays the manual override', async () => {
    const { adapter, params } = captureParams()
    const req = makeRequest({ effort: 'high', budgetTokens: 8_192 }) as ProviderStreamRequest & {
      providerOptions?: { thinkingBudget: number }
    }
    req.providerOptions = { thinkingBudget: 4_096 }
    await adapter.stream(req)
    expect(params().thinking).toEqual({ type: 'enabled', budget_tokens: 4_096 })
  })
})
