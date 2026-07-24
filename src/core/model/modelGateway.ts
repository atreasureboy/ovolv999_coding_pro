/**
 * ModelGateway — owns the model I/O boundary of the run loop. Extracted
 * from engine.ts to isolate model communication from iteration logic.
 *
 * Phase 1 (six_goal §四): ModelGateway no longer touches the OpenAI SDK
 * directly. ALL provider-specific behaviour (request shape, streaming
 * transport, stream_options probing) lives behind a ProviderAdapter.
 * ModelGateway is now provider-agnostic: it builds a ProviderStreamRequest,
 * delegates stream establishment to the adapter, and owns only the
 * concerns that are truly cross-provider:
 *   - reactive compaction on context-overflow errors (via callback)
 *   - usage recording (via callback)
 *   - stream-stall watchdog (via StreamConsumer)
 *
 * Does NOT decide what the agent does next. The coordinator drives
 * iteration; ModelGateway just sends requests and returns results.
 */

import type OpenAI from 'openai'
import type { OpenAIMessage, ToolDefinition } from '../types.js'
import type { TokenUsage } from '../costTracker.js'
import type { Renderer } from '../../ui/renderer.js'
import { StreamConsumer, type StreamResult } from './streamConsumer.js'
import type { ProviderAdapter } from './providerAdapter.js'

export interface ModelGatewayDeps {
  adapter: ProviderAdapter
  renderer: Renderer
  streamConsumer?: StreamConsumer
}

export interface ModelCallParams {
  systemPrompt: string
  messages: OpenAIMessage[]
  toolDefs: ToolDefinition[]
  model: string
  temperature?: number
  maxOutputTokens: number
  abortSignal: AbortSignal
  /** The abort controller for watchdog-based force-abort on stream stall */
  turnAbortController: AbortController | null
}

export interface ModelGatewayCallbacks {
  /** Called after a successful API call with usage data */
  onUsage?: (usage: TokenUsage | null, callStartMs: number) => void
  /** Called when a context overflow error is detected. Should compact messages and return true on success. */
  onContextOverflow?: (messages: OpenAIMessage[], abortSignal: AbortSignal) => Promise<boolean>
  /**
   * v0.3.1 (te_goal §三.1.4): called when the provider returns a
   * retryable error (429/timeout/5xx). Returns the next model in the
   * fallback chain, or null if the chain is exhausted. The gateway
   * retries ONCE with the fallback model — it does NOT replay tools
   * (the error occurs at stream establishment, before any tool runs).
   */
  onProviderError?: (failedModel: string, error: Error) => string | null
}

export class ModelGateway {
  private readonly adapter: ProviderAdapter
  private readonly renderer: Renderer
  private readonly streamConsumer: StreamConsumer

  constructor(deps: ModelGatewayDeps) {
    this.adapter = deps.adapter
    this.renderer = deps.renderer
    this.streamConsumer = deps.streamConsumer ?? new StreamConsumer({ renderer: this.renderer })
  }

  get streamUsageSupported(): boolean {
    return this.adapter.streamUsageSupported
  }

  markStreamUsageUnsupported(): void {
    // Phase 1: delegated to the adapter — the latch is a provider-level
    // concern (whether THIS backend can stream usage tokens).
    this.adapter.markStreamUsageUnsupported()
  }

  /**
   * P0-1 (transactional model switch): clear the adapter's usage-streaming
   * probe latch so a model switch re-probes stream_options support.
   */
  resetStreamUsageLatch(): void {
    this.adapter.resetStreamUsageLatch()
  }

  async call(
    params: ModelCallParams,
    callbacks?: ModelGatewayCallbacks,
  ): Promise<StreamResult> {
    const { systemPrompt, messages, toolDefs, model, temperature, maxOutputTokens, abortSignal, turnAbortController } = params

    this.renderer.startSpinner()
    const callStartMs = Date.now()

    const streamReq = {
      model,
      systemPrompt,
      messages: messages as OpenAI.Chat.ChatCompletionMessageParam[],
      tools: toolDefs,
      temperature,
      maxOutputTokens,
      signal: abortSignal,
    }

    let stream: AsyncIterable<OpenAI.Chat.ChatCompletionChunk>
    try {
      stream = await this.adapter.stream(streamReq)
    } catch (caught: unknown) {
      this.renderer.stopSpinner()
      const err = caught instanceof Error ? caught : new Error(String(caught))
      const errMsg = err.message || ''

      // Reactive compaction on context-overflow — provider-agnostic
      // (detected by error-message signature across OpenAI-compatible
      // backends). The adapter has already surfaced the raw error.
      if (this.isContextOverflowError(errMsg) && callbacks?.onContextOverflow) {
        this.renderer.warn('Context too long — auto-compacting and retrying...')
        const compacted = await callbacks.onContextOverflow(messages, abortSignal)
        if (!compacted) throw err
        stream = await this.adapter.stream(streamReq)
      } else if (this.isRetryableProviderError(errMsg) && callbacks?.onProviderError) {
        // v0.3.1 (te_goal §三.1.4): provider fallback at the stream
        // ESTABLISHMENT boundary (before any tool runs). The callback
        // supplies a fallback model from Router.nextFallback(); we
        // re-issue the request ONCE with that model. The adapter is
        // reused — single-transport mode; the fallback model targets
        // the same OpenAI-compatible endpoint.
        const fallbackResult: unknown = callbacks.onProviderError(model, err)
        const fallbackModel: string | null = (fallbackResult && typeof (fallbackResult as { then?: unknown }).then === 'function')
          ? await (fallbackResult as Promise<string | null>)
          : (fallbackResult as string | null)
        if (!fallbackModel || fallbackModel === model) throw err
        this.renderer.warn(
          `Provider error on "${model}" — falling back to "${fallbackModel}"`,
        )
        try {
          stream = await this.adapter.stream({ ...streamReq, model: fallbackModel })
        } catch {
          // Fallback failed too — surface the ORIGINAL error so /why
          // can attribute failure to the chain, not just the last hop.
          throw err
        }
      } else {
        throw err
      }
    }

    const result = await this.streamConsumer.consume(stream, abortSignal, turnAbortController)
    callbacks?.onUsage?.(result.usage, callStartMs)
    return result
  }

  /**
   * v0.3.1 (te_goal §三.1.4): classify a provider error as retryable.
   * The OpenAI-compatible transport surfaces 429 / 5xx / timeout as
   * Error objects whose message contains the status code or a known
   * marker. False positives are cheap (the next attempt just fails
   * the same way); false negatives mean the loop sits on a dead
   * profile.
   */
  private isRetryableProviderError(errMsg: string): boolean {
    return (
      /\b429\b/.test(errMsg)
      || /\b5\d\d\b/.test(errMsg)
      || /\b(ETIMEDOUT|ECONNRESET|ECONNREFUSED|ENOTFOUND|EAI_AGAIN)\b/.test(errMsg)
      || /\btime[\s_-]?out\b/i.test(errMsg)
      || /rate[\s_-]?limit/i.test(errMsg)
      || /\bserver[\s_-]?error\b/i.test(errMsg)
      || /\bunavailable\b/i.test(errMsg)
    )
  }

  private isContextOverflowError(errMsg: string): boolean {
    return (
      errMsg.includes('context_length_exceeded') ||
      errMsg.includes('maximum context length') ||
      /context[\s_-]{0,80}(?:is\s+)?too\s+long/i.test(errMsg) ||
      /too\s+long[\s_-]{0,80}(?:context|tokens?|input|window|limit)/i.test(errMsg)
    )
  }
}
