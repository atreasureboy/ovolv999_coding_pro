/**
 * ModelGateway — owns the model I/O boundary of the run loop. Extracted
 * from engine.ts to isolate model communication from iteration logic.
 *
 * Phase 1 (provider-runtime contract §四): ModelGateway no longer touches the OpenAI SDK
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
import type { RendererInterface } from '../types.js'
import { StreamConsumer, type StreamResult } from './streamConsumer.js'
import type { ProviderAdapter, ProviderId } from './providerAdapter.js'
import type { ReasoningRequestOptions } from './reasoningTransform.js'
import { withReasoningNormalization } from './providerAdapter.js'
import type { EventLog } from '../eventLog.js'

export interface ModelGatewayDeps {
  adapter: ProviderAdapter
  renderer: RendererInterface
  streamConsumer?: StreamConsumer
  /**
   * v0.4.1 C1 (callId truth): forwarded to the default StreamConsumer so
   * stream-protocol anomalies (e.g. multiple missing tool_call ids) are
   * recorded structurally. Ignored when `streamConsumer` is injected.
   */
  eventLog?: EventLog
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
  /**
   * Round 42: normalized reasoning options — translated into
   * provider-specific body keys by the adapter (flavor-aware; unknown
   * models add nothing). Optional: absent = provider defaults.
   */
  reasoning?: ReasoningRequestOptions
}

export interface ModelGatewayCallbacks {
  /** Called after a successful API call with usage data */
  onUsage?: (usage: TokenUsage | null, callStartMs: number) => void
  /** Called when a context overflow error is detected. Should compact messages and return true on success. */
  onContextOverflow?: (messages: OpenAIMessage[], abortSignal: AbortSignal) => Promise<boolean>
  /**
   * v0.3.1 (runtime truth contract §三.1.4): called when the provider returns a
   * retryable error (429/timeout/5xx). Returns the next model in the
   * fallback chain, or null if the chain is exhausted. The gateway
   * retries ONCE with the fallback model — it does NOT replay tools
   * (the error occurs at stream establishment, before any tool runs).
   */
  onProviderError?: (failedModel: string, error: Error) => string | null
}

export interface ProviderAttempt {
  model: string
  provider: string
  success: boolean
  error?: string
  latencyMs: number
  usage: TokenUsage | null
}

export type ModelGatewayResult = StreamResult & { attempts: ProviderAttempt[] }

export class ModelGatewayError extends Error {
  constructor(message: string, public readonly attempts: ProviderAttempt[]) {
    super(message)
    this.name = 'ModelGatewayError'
  }
}

export class ModelGateway {
  // Mutable: Round 35 cross-provider switching swaps the adapter in place
  // (transactionally from Engine.rebindTransport) so the gateway follows
  // the active provider without rebuilding the whole engine.
  private adapter: ProviderAdapter
  private readonly renderer: RendererInterface
  private readonly streamConsumer: StreamConsumer

  constructor(deps: ModelGatewayDeps) {
    this.adapter = deps.adapter
    this.renderer = deps.renderer
    this.streamConsumer = deps.streamConsumer ?? new StreamConsumer({ renderer: this.renderer, eventLog: deps.eventLog })
  }

  get streamUsageSupported(): boolean {
    return this.adapter.streamUsageSupported
  }

  /** Active transport id (for diagnostics after a cross-provider switch). */
  get providerId(): ProviderId {
    return this.adapter.providerId
  }

  /**
   * Swap the active transport adapter. Returns the PREVIOUS adapter so the
   * caller can roll back on a failed cross-provider switch. The new
   * adapter arrives with a fresh usage-streaming probe latch.
   */
  swapAdapter(adapter: ProviderAdapter): ProviderAdapter {
    const prev = this.adapter
    this.adapter = adapter
    return prev
  }

  /** Restore a previously swapped adapter (rollback path). */
  restoreAdapter(adapter: ProviderAdapter): void {
    this.adapter = adapter
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
  ): Promise<ModelGatewayResult> {
    const { systemPrompt, messages, toolDefs, model, temperature, maxOutputTokens, abortSignal, turnAbortController } = params

    this.renderer.startSpinner()
    const callStartMs = Date.now()
    const attempts: ProviderAttempt[] = []
    let activeModel = model
    let attemptStartMs = callStartMs

    const streamReq = {
      model,
      systemPrompt,
      messages: messages as OpenAI.Chat.ChatCompletionMessageParam[],
      tools: toolDefs,
      temperature,
      maxOutputTokens,
      signal: abortSignal,
      // Round 42: normalized reasoning options — the adapter translates.
      reasoning: params.reasoning,
      provider: this.adapter.providerId,
    }

    let stream: AsyncIterable<OpenAI.Chat.ChatCompletionChunk>
    try {
      stream = withReasoningNormalization(await this.adapter.stream(streamReq))
    } catch (caught: unknown) {
      this.renderer.stopSpinner()
      const err = caught instanceof Error ? caught : new Error(String(caught))
      const errMsg = err.message || ''
      attempts.push({
        model,
        provider: this.adapter.providerId,
        success: false,
        error: errMsg,
        latencyMs: Date.now() - attemptStartMs,
        usage: null,
      })

      // Reactive compaction on context-overflow — provider-agnostic
      // (detected by error-message signature across OpenAI-compatible
      // backends). The adapter has already surfaced the raw error.
      if (this.isContextOverflowError(errMsg) && callbacks?.onContextOverflow) {
        this.renderer.warn('Context too long — auto-compacting and retrying...')
        const compacted = await callbacks.onContextOverflow(messages, abortSignal)
        if (!compacted) throw new ModelGatewayError(err.message, attempts)
        attemptStartMs = Date.now()
        try {
          stream = await this.adapter.stream(streamReq)
        } catch (retryCaught) {
          const retryError = retryCaught instanceof Error ? retryCaught : new Error(String(retryCaught))
          attempts.push({
            model,
            provider: this.adapter.providerId,
            success: false,
            error: retryError.message,
            latencyMs: Date.now() - attemptStartMs,
            usage: null,
          })
          throw new ModelGatewayError(retryError.message, attempts)
        }
      } else if (this.isRetryableProviderError(errMsg) && callbacks?.onProviderError) {
        // v0.3.1 (runtime truth contract §三.1.4): provider fallback at the stream
        // ESTABLISHMENT boundary (before any tool runs). The callback
        // supplies a fallback model from Router.nextFallback(); we
        // re-issue the request ONCE with that model. The adapter is
        // reused — single-transport mode; the fallback model targets
        // the same OpenAI-compatible endpoint.
        const fallbackResult: unknown = callbacks.onProviderError(model, err)
        const fallbackModel: string | null = (fallbackResult && typeof (fallbackResult as { then?: unknown }).then === 'function')
          ? await (fallbackResult as Promise<string | null>)
          : (fallbackResult as string | null)
        if (!fallbackModel || fallbackModel === model) throw new ModelGatewayError(err.message, attempts)
        this.renderer.warn(
          `Provider error on "${model}" — falling back to "${fallbackModel}"`,
        )
        activeModel = fallbackModel
        attemptStartMs = Date.now()
        try {
          stream = await this.adapter.stream({ ...streamReq, model: fallbackModel })
        } catch (fallbackCaught) {
          const fallbackError = fallbackCaught instanceof Error ? fallbackCaught : new Error(String(fallbackCaught))
          attempts.push({
            model: fallbackModel,
            provider: this.adapter.providerId,
            success: false,
            error: fallbackError.message,
            latencyMs: Date.now() - attemptStartMs,
            usage: null,
          })
          throw new ModelGatewayError(err.message, attempts)
        }
      } else {
        throw new ModelGatewayError(err.message, attempts)
      }
    }

    let result: StreamResult
    try {
      result = await this.streamConsumer.consume(stream, abortSignal, turnAbortController)
    } catch (consumeCaught) {
      const consumeError = consumeCaught instanceof Error ? consumeCaught : new Error(String(consumeCaught))
      attempts.push({
        model: activeModel,
        provider: this.adapter.providerId,
        success: false,
        error: consumeError.message,
        latencyMs: Date.now() - attemptStartMs,
        usage: null,
      })
      throw new ModelGatewayError(consumeError.message, attempts)
    }
    attempts.push({
      model: activeModel,
      provider: this.adapter.providerId,
      success: true,
      latencyMs: Date.now() - attemptStartMs,
      usage: result.usage,
    })
    callbacks?.onUsage?.(result.usage, attemptStartMs)
    return { ...result, attempts }
  }

  /**
   * v0.3.1 (runtime truth contract §三.1.4): classify a provider error as retryable.
   * The OpenAI-compatible transport surfaces 429 / 5xx / timeout as
   * Error objects whose message contains the status code or a known
   * marker. False positives are cheap (the next attempt just fails
   * the same way); false negatives mean the loop sits on a dead
   * profile.
   * R7 fix: exported as public helper so the coordinator can reuse
   * the same regex set. Without this, the gateway would retry a
   * profile the coordinator classified as non-retryable.
   */
  isRetryableProviderError(errMsg: string): boolean {
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
