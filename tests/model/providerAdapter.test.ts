import { describe, expect, it } from 'vitest'
import OpenAI from 'openai'
import {
  createProviderAdapter,
  OpenAICompatibleAdapter,
  StubProviderAdapter,
} from '../../src/core/model/providerAdapter.js'
import { AnthropicAdapter } from '../../src/core/model/anthropicAdapter.js'
import { OpenAIResponsesAdapter } from '../../src/core/model/responsesAdapter.js'

function makeClient(): OpenAI {
  return new OpenAI({ apiKey: 'test-key' })
}

describe('createProviderAdapter', () => {
  it('returns OpenAICompatibleAdapter by default', () => {
    const adapter = createProviderAdapter({ client: makeClient() })
    expect(adapter).toBeInstanceOf(OpenAICompatibleAdapter)
    expect(adapter.providerId).toBe('openai-compatible')
  })

  it('uses explicit provider id when given', () => {
    const adapter = createProviderAdapter({ provider: 'minimax', client: makeClient() })
    expect(adapter.providerId).toBe('minimax')
  })

  it('uses the native Responses adapter only when explicitly enabled for OpenAI', () => {
    const adapter = createProviderAdapter({ provider: 'openai', apiMode: 'responses', client: makeClient() })
    expect(adapter).toBeInstanceOf(OpenAIResponsesAdapter)
  })

  it('returns AnthropicAdapter for provider=anthropic', () => {
    const adapter = createProviderAdapter({ provider: 'anthropic', client: makeClient() })
    expect(adapter).toBeInstanceOf(AnthropicAdapter)
    expect(adapter.providerId).toBe('anthropic')
  })

  it('returns StubProviderAdapter for bedrock', () => {
    const adapter = createProviderAdapter({ provider: 'bedrock', client: makeClient() })
    expect(adapter).toBeInstanceOf(StubProviderAdapter)
    expect(adapter.providerId).toBe('bedrock')
  })

  it('returns StubProviderAdapter for vertex', () => {
    const adapter = createProviderAdapter({ provider: 'vertex', client: makeClient() })
    expect(adapter).toBeInstanceOf(StubProviderAdapter)
    expect(adapter.providerId).toBe('vertex')
  })

  it('returns StubProviderAdapter for foundry', () => {
    const adapter = createProviderAdapter({ provider: 'foundry', client: makeClient() })
    expect(adapter).toBeInstanceOf(StubProviderAdapter)
    expect(adapter.providerId).toBe('foundry')
  })
})

describe('StubProviderAdapter', () => {
  it('rejects .stream() with honest error', async () => {
    const adapter = new StubProviderAdapter('bedrock')
    await expect(adapter.stream()).rejects.toThrow(/bedrock.*not wired/)
  })

  it('reports streamUsageSupported=false', () => {
    const adapter = new StubProviderAdapter('vertex')
    expect(adapter.streamUsageSupported).toBe(false)
  })

  it('marks stream usage unsupported (no-op)', () => {
    const adapter = new StubProviderAdapter('foundry')
    adapter.markStreamUsageUnsupported()
    expect(adapter.streamUsageSupported).toBe(false)
  })

  it('resets stream usage latch (no-op)', () => {
    const adapter = new StubProviderAdapter('foundry')
    adapter.resetStreamUsageLatch()
    expect(adapter.streamUsageSupported).toBe(false)
  })
})
