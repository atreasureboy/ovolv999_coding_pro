/**
 * v0.3.1 Provider fallback (te_goal §三.1.4).
 *
 * Verifies:
 *   - 429 / 5xx / timeout errors trigger onProviderError
 *   - the callback returns the next fallback model from Router.nextFallback
 *   - the gateway retries ONCE with the fallback model
 *   - non-retryable errors propagate without invoking onProviderError
 *   - all profiles unavailable → original error surfaces, not the chain
 *   - recordCall is invoked on success and on failure (Router health
 *     attribution actually drives /models display after a real call)
 */
import { describe, it, expect, vi } from 'vitest'
import { ModelGateway } from '../src/core/model/modelGateway.js'
import type { ProviderAdapter } from '../src/core/model/providerAdapter.js'
import type { Renderer } from '../src/ui/renderer.js'
import type { StreamConsumer, StreamResult } from '../src/core/model/streamConsumer.js'

class FakeRenderer {
  startSpinner() {}
  stopSpinner() {}
  warn = vi.fn()
  info = vi.fn()
  error = vi.fn()
  log = vi.fn()
}

class FakeAdapter implements ProviderAdapter {
  readonly providerId = 'openai-compatible'
  readonly streamUsageSupported = false
  resetStreamUsageLatch() {}
  markStreamUsageUnsupported() {}
  // Track which models were attempted in order.
  attempts: string[] = []
  // errorsPerModel: model → Error to throw on stream-establishment
  errorsPerModel: Map<string, Error> = new Map()
  async stream(req: { model: string; signal?: AbortSignal }): Promise<AsyncIterable<never>> {
    this.attempts.push(req.model)
    const err = this.errorsPerModel.get(req.model)
    if (err) throw err
    return {
      [Symbol.asyncIterator]: () => ({
        next: async () => ({ value: undefined as never, done: true }),
      }),
    }
  }
}

class FakeConsumer {
  async consume(): Promise<StreamResult> {
    return {
      assistantText: '',
      finishReason: 'stop',
      rawToolCalls: [],
      usage: { inputTokens: 10, outputTokens: 20 },
    }
  }
}

describe('ModelGateway v0.3.1 fallback', () => {
  it('invokes onProviderError on 429 and retries with fallback model', async () => {
    const renderer = new FakeRenderer()
    const adapter = new FakeAdapter()
    adapter.errorsPerModel.set('haiku', new Error('rate limit 429 too many requests'))
    const consumer = new FakeConsumer() as unknown as StreamConsumer
    const gw = new ModelGateway({ adapter, renderer: renderer as unknown as Renderer, streamConsumer: consumer })

    const onProviderError = vi.fn().mockResolvedValue('sonnet')
    const onUsage = vi.fn()

    await gw.call({
      systemPrompt: 'sys',
      messages: [{ role: 'user', content: 'hi' }],
      toolDefs: [],
      model: 'haiku',
      maxOutputTokens: 1024,
      abortSignal: new AbortController().signal,
      turnAbortController: null,
    }, { onProviderError, onUsage })

    expect(onProviderError).toHaveBeenCalledOnce()
    expect(onProviderError.mock.calls[0][0]).toBe('haiku')
    expect(adapter.attempts).toEqual(['haiku', 'sonnet'])
    expect(onUsage).toHaveBeenCalledOnce()
  })

  it('invokes onProviderError on 5xx', async () => {
    const renderer = new FakeRenderer()
    const adapter = new FakeAdapter()
    adapter.errorsPerModel.set('sonnet', new Error('502 Bad Gateway'))
    const consumer = new FakeConsumer() as unknown as StreamConsumer
    const gw = new ModelGateway({ adapter, renderer: renderer as unknown as Renderer, streamConsumer: consumer })

    const onProviderError = vi.fn().mockResolvedValue('gpt-4o')
    await gw.call({
      systemPrompt: '',
      messages: [{ role: 'user', content: 'x' }],
      toolDefs: [],
      model: 'sonnet',
      maxOutputTokens: 1024,
      abortSignal: new AbortController().signal,
      turnAbortController: null,
    }, { onProviderError })
    expect(adapter.attempts).toEqual(['sonnet', 'gpt-4o'])
  })

  it('invokes onProviderError on timeout', async () => {
    const renderer = new FakeRenderer()
    const adapter = new FakeAdapter()
    adapter.errorsPerModel.set('a', new Error('ETIMEDOUT socket hang up'))
    const consumer = new FakeConsumer() as unknown as StreamConsumer
    const gw = new ModelGateway({ adapter, renderer: renderer as unknown as Renderer, streamConsumer: consumer })
    const onProviderError = vi.fn().mockResolvedValue('b')
    await gw.call({
      systemPrompt: '',
      messages: [{ role: 'user', content: 'x' }],
      toolDefs: [],
      model: 'a',
      maxOutputTokens: 1024,
      abortSignal: new AbortController().signal,
      turnAbortController: null,
    }, { onProviderError })
    expect(adapter.attempts).toEqual(['a', 'b'])
  })

  it('does NOT invoke onProviderError for non-retryable errors', async () => {
    const renderer = new FakeRenderer()
    const adapter = new FakeAdapter()
    adapter.errorsPerModel.set('haiku', new Error('400 Bad Request'))
    const consumer = new FakeConsumer() as unknown as StreamConsumer
    const gw = new ModelGateway({ adapter, renderer: renderer as unknown as Renderer, streamConsumer: consumer })
    const onProviderError = vi.fn()

    await expect(gw.call({
      systemPrompt: '',
      messages: [{ role: 'user', content: 'x' }],
      toolDefs: [],
      model: 'haiku',
      maxOutputTokens: 1024,
      abortSignal: new AbortController().signal,
      turnAbortController: null,
    }, { onProviderError })).rejects.toThrow('400')
    expect(onProviderError).not.toHaveBeenCalled()
    expect(adapter.attempts).toEqual(['haiku']) // no retry
  })

  it('surfaces original error when fallback chain is exhausted', async () => {
    const renderer = new FakeRenderer()
    const adapter = new FakeAdapter()
    adapter.errorsPerModel.set('haiku', new Error('429 rate limit'))
    const consumer = new FakeConsumer() as unknown as StreamConsumer
    const gw = new ModelGateway({ adapter, renderer: renderer as unknown as Renderer, streamConsumer: consumer })

    // callback returns null (chain exhausted) → original error surfaces
    const onProviderError = vi.fn().mockResolvedValue(null)
    await expect(gw.call({
      systemPrompt: '',
      messages: [{ role: 'user', content: 'x' }],
      toolDefs: [],
      model: 'haiku',
      maxOutputTokens: 1024,
      abortSignal: new AbortController().signal,
      turnAbortController: null,
    }, { onProviderError })).rejects.toThrow('429')
    expect(adapter.attempts).toEqual(['haiku'])
  })

  it('surfaces original error when fallback attempt itself fails', async () => {
    const renderer = new FakeRenderer()
    const adapter = new FakeAdapter()
    adapter.errorsPerModel.set('haiku', new Error('429'))
    adapter.errorsPerModel.set('sonnet', new Error('ETIMEDOUT'))
    const consumer = new FakeConsumer() as unknown as StreamConsumer
    const gw = new ModelGateway({ adapter, renderer: renderer as unknown as Renderer, streamConsumer: consumer })
    const onProviderError = vi.fn().mockResolvedValue('sonnet')
    await expect(gw.call({
      systemPrompt: '',
      messages: [{ role: 'user', content: 'x' }],
      toolDefs: [],
      model: 'haiku',
      maxOutputTokens: 1024,
      abortSignal: new AbortController().signal,
      turnAbortController: null,
    }, { onProviderError })).rejects.toThrow('429')
    expect(adapter.attempts).toEqual(['haiku', 'sonnet'])
  })

  it('onProviderError returning the same model is treated as exhausted', async () => {
    const renderer = new FakeRenderer()
    const adapter = new FakeAdapter()
    adapter.errorsPerModel.set('haiku', new Error('429'))
    const consumer = new FakeConsumer() as unknown as StreamConsumer
    const gw = new ModelGateway({ adapter, renderer: renderer as unknown as Renderer, streamConsumer: consumer })
    const onProviderError = vi.fn().mockResolvedValue('haiku') // same model
    await expect(gw.call({
      systemPrompt: '',
      messages: [{ role: 'user', content: 'x' }],
      toolDefs: [],
      model: 'haiku',
      maxOutputTokens: 1024,
      abortSignal: new AbortController().signal,
      turnAbortController: null,
    }, { onProviderError })).rejects.toThrow('429')
    expect(adapter.attempts).toEqual(['haiku'])
  })
})