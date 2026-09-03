/**
 * Gateway recovery contract (runtime truth contract §三.1.4): compaction and
 * provider fallback fire only at the stream ESTABLISHMENT boundary — i.e.
 * only when `adapter.stream()` itself rejects.
 *
 * The Anthropic adapter returned an async generator whose body ran lazily,
 * so every transport error (401/429/5xx/overloaded/ECONNREFUSED) surfaced
 * on first pull — after the gateway had declared establishment. Recovery
 * was unreachable on this transport. `stream()` must pull the first chunk
 * eagerly so establishment errors reject the factory promise.
 */

import { describe, it, expect } from 'vitest'
import { AnthropicAdapter } from '../src/core/model/anthropicAdapter.js'
import type { ProviderStreamRequest } from '../src/core/model/providerAdapter.js'

function makeRequest(): ProviderStreamRequest {
  return {
    model: 'claude-test',
    systemPrompt: '',
    messages: [{ role: 'user', content: 'hi' }],
    tools: [],
    maxOutputTokens: 128,
    signal: new AbortController().signal,
  }
}

/** A stand-in for the SDK's MessageStream that fails on first pull. */
function failingSdkStream(error: string): unknown {
  return {
    controller: { abort: () => {} },
    [Symbol.asyncIterator]() {
      return (async function* () {
        throw new Error(error)
        // biome-ignore lint/style/noUselessLoneBlockStatements: generator must not yield
      })()
    },
  }
}

function adapterWithSdkStream(sdkStream: unknown): AnthropicAdapter {
  const adapter = new AnthropicAdapter({ apiKey: 'test-key' })
  ;(adapter as unknown as { client: unknown }).client = {
    messages: { stream: () => sdkStream },
  }
  return adapter
}

describe('AnthropicAdapter eager stream establishment', () => {
  it('rejects stream() itself when the transport fails before the first event', async () => {
    const adapter = adapterWithSdkStream(failingSdkStream('429 rate_limit_error'))
    await expect(adapter.stream(makeRequest())).rejects.toThrow('429')
  })

  it('surfaces establishment errors before any chunk is consumed', async () => {
    const adapter = adapterWithSdkStream(failingSdkStream('connect ECONNREFUSED api.anthropic.com'))
    let established = false
    const attempt = adapter.stream(makeRequest()).then(() => { established = true })
    await expect(attempt).rejects.toThrow('ECONNREFUSED')
    expect(established).toBe(false)
  })

  it('does not lose the first chunk across the eager pull', async () => {
    const events = [
      { type: 'message_start', message: { id: 'msg_1', usage: { input_tokens: 1, output_tokens: 1 } } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'hello' } },
      { type: 'message_stop' },
    ]
    const sdkStream = {
      controller: { abort: () => {} },
      async *[Symbol.asyncIterator]() {
        for (const e of events) yield e
      },
    }
    const adapter = adapterWithSdkStream(sdkStream)
    const stream = await adapter.stream(makeRequest())
    const chunks = []
    for await (const chunk of stream) chunks.push(chunk)
    // The 'hello' text delta must survive — the gateway consumes only the
    // rewrapped iterable, unaware of the establishment pull.
    const serialized = JSON.stringify(chunks)
    expect(serialized).toContain('hello')
  })
})
