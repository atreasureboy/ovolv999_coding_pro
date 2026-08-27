/**
 * ProviderAdapter (provider-runtime contract Phase 1) — the single abstraction that owns
 * provider-specific request shape and streaming establishment.
 *
 * ModelGateway delegates ALL model I/O to a ProviderAdapter. The
 * coordinator never branches on provider; the adapter hides:
 *   - request body shape (system-as-message vs top-level, tool schema)
 *   - streaming transport (OpenAI chunk array vs Anthropic SSE events)
 *   - provider quirks (stream_options.include_usage probing, etc.)
 *
 * Contract: every adapter normalises its provider's native stream into
 * OpenAI ChatCompletionChunk shape. This keeps StreamConsumer (and the
 * whole tool_call accumulation pipeline) provider-agnostic WITHOUT a
 * risky full re-typing of the stream — OpenAICompatibleAdapter is the
 * identity transform; a future AnthropicAdapter translates
 * message_start/content_block_delta SSE into the same chunk shape.
 *
 * Selection: `createProviderAdapter(config)` picks the adapter from
 * `config.provider` / baseURL. Today both 'openai' and 'minimax' route
 * through OpenAICompatibleAdapter (MiniMax M3 is served OpenAI-
 * compatible at /v1; the bin rewrites /anthropic -> /v1). Adding a new
 * provider = implement ProviderAdapter + register it in the factory.
 */

import type OpenAI from 'openai'
import type { ToolDefinition } from '../types.js'
import type { ProviderId } from '../providers.js'
import { AnthropicAdapter } from './anthropicAdapter.js'
import {
  buildReasoningParams,
  normalizeHistoryForRequest,
  extractReasoningDelta,
  type ReasoningRequestOptions,
} from './reasoningTransform.js'

export type { ProviderId }

/**
 * Provider-agnostic description of one model stream request. The adapter
 * combines `systemPrompt` + `messages` per its provider's convention.
 */
export interface ProviderStreamRequest {
  model: string
  systemPrompt: string
  messages: OpenAI.Chat.ChatCompletionMessageParam[]
  tools: ToolDefinition[]
  temperature?: number
  maxOutputTokens: number
  signal: AbortSignal
  /**
   * Round 42 (reasoning translation layer): normalized reasoning options.
   * The adapter translates them into provider-specific body keys via
   * buildReasoningParams — unknown flavors add NOTHING (a stray key is a
   * 400 on most backends).
   */
  reasoning?: ReasoningRequestOptions
  /**
   * Provider id for flavor detection (falls back to the adapter's own
   * providerId when absent).
   */
  provider?: string
}

export interface ProviderAdapter {
  /** Stable id for logging/registry (e.g. 'openai-compatible', 'anthropic'). */
  readonly providerId: ProviderId
  /**
   * Whether the provider's stream currently includes usage tokens.
   * Probed at runtime (some OpenAI-compatible backends reject
   * stream_options). ModelGateway reads this to decide whether to
   * synthesise missing usage.
   */
  readonly streamUsageSupported: boolean
  /**
   * Clear the usage-streaming probe latch. Called on model switch so a
   * move from a provider that rejects stream_options to one that
   * supports it re-probes instead of staying permanently disabled.
   */
  resetStreamUsageLatch(): void
  /**
   * Force-disable usage streaming (e.g. an out-of-band signal that the
   * backend can't supply usage). The streaming path then skips the
   * stream_options probe.
   */
  markStreamUsageUnsupported(): void
  /**
   * Establish the streaming response. Resolves to an async iterable of
   * OpenAI-shaped chunks. Throws provider errors (caller — ModelGateway
   * — handles context-overflow + retry; re-aborts propagate the signal).
   */
  stream(req: ProviderStreamRequest): Promise<AsyncIterable<OpenAI.Chat.ChatCompletionChunk>>
}

/**
 * OpenAI-compatible adapter. Wraps the OpenAI SDK client and owns the
 * request shape + the stream_options.include_usage probe/fallback that
 * previously lived inside ModelGateway. Byte-equivalent to the legacy
 * direct-SDK path so existing OpenAI / MiniMax (/v1) / OpenRouter /
 * Ollama / etc. configurations keep working unchanged.
 */
export class OpenAICompatibleAdapter implements ProviderAdapter {
  readonly providerId: ProviderId
  private _streamUsageSupported = true

  constructor(
    private readonly client: OpenAI,
    providerId: ProviderId = 'openai-compatible',
  ) {
    this.providerId = providerId
  }

  get streamUsageSupported(): boolean {
    return this._streamUsageSupported
  }

  resetStreamUsageLatch(): void {
    this._streamUsageSupported = true
  }

  markStreamUsageUnsupported(): void {
    this._streamUsageSupported = false
  }

  async stream(
    req: ProviderStreamRequest,
  ): Promise<AsyncIterable<OpenAI.Chat.ChatCompletionChunk>> {
    const { model, systemPrompt, messages, tools, temperature, maxOutputTokens, signal, reasoning } = req
    const baseBody = {
      model,
      messages: [
        { role: 'system' as const, content: systemPrompt },
        // Round 42: history reasoning normalization (strip for most
        // flavors, replay as reasoning_content for DeepSeek R1).
        ...normalizeHistoryForRequest(this.providerId, model, messages as unknown as Array<Record<string, unknown>>) as unknown as OpenAI.Chat.ChatCompletionMessageParam[],
      ],
      tools: tools.length > 0 ? tools : undefined,
      tool_choice: tools.length > 0 ? ('auto' as const) : undefined,
      temperature: temperature ?? 0,
      max_tokens: maxOutputTokens,
      stream: true as const,
      // Round 42: provider-specific reasoning keys — spread only when the
      // flavor is recognized (unknown models get nothing).
      ...buildReasoningParams(this.providerId, model, reasoning),
    }

    // Fast path: include usage streaming if the latch is on.
    if (this._streamUsageSupported) {
      try {
        return await this.client.chat.completions.create(
          { ...baseBody, stream_options: { include_usage: true } },
          { signal },
        )
      } catch (err: unknown) {
        const msg = (err as Error).message || ''
        // Provider rejects stream_options — disable the latch and retry
        // once without it. Subsequent calls skip the probe.
        if (msg.includes('stream_options') || msg.includes('stream_options is not supported')) {
          this._streamUsageSupported = false
        } else {
          throw err
        }
      }
    }

    return this.client.chat.completions.create(baseBody, { signal })
  }
}

/**
 * Wrap a raw chunk stream so reasoning deltas are normalized into
 * `delta.reasoning_content` regardless of which vendor field carried
 * them. Synchronous wrapper (returns the generator directly) so callers
 * can treat it as a drop-in stream — no extra await in the pipeline.
 */
export function withReasoningNormalization(
  stream: AsyncIterable<OpenAI.Chat.ChatCompletionChunk>,
): AsyncIterable<OpenAI.Chat.ChatCompletionChunk> {
  async function* normalized(): AsyncIterable<OpenAI.Chat.ChatCompletionChunk> {
    for await (const chunk of stream) {
      const delta = chunk.choices?.[0]?.delta as Record<string, unknown> | undefined
      const reasoning = extractReasoningDelta(delta)
      if (reasoning !== undefined) {
        // Emit a normalized copy; strip the vendor field so downstream
        // sees exactly one reasoning carrier.
        const choices = chunk.choices?.map((c) => ({
          ...c,
          delta: {
            ...((c.delta ?? {}) as Record<string, unknown>),
            reasoning_content: reasoning,
            reasoning: undefined,
            thinking: undefined,
            reasoning_details: undefined,
          },
        }))
        yield { ...chunk, choices } as unknown as OpenAI.Chat.ChatCompletionChunk
        continue
      }
      yield chunk
    }
  }
  return normalized()
}

/**
 * Select a ProviderAdapter for the given config. Today everything is
 * OpenAI-compatible (OpenAI, MiniMax via /v1, OpenRouter, Ollama, …);
 * the factory is the extension point for native Anthropic / Gemini
 * adapters. `providerId` is surfaced for logging/diagnostics.
 *
 * Phase 3: native Anthropic adapter. The factory inspects `provider`:
 *   - "anthropic" → AnthropicAdapter (uses cfg.client.apiKey as x-api-key)
 *   - everything else → OpenAICompatibleAdapter
 *
 * The Anthropic branch still accepts an OpenAI client for the apiKey
 * fallback path; new code can call `createProviderAdapter` with just
 * `{ provider: 'anthropic', client }`.
 */
export interface ProviderAdapterConfig {
  provider?: string
  client: OpenAI
}

export function createProviderAdapter(cfg: ProviderAdapterConfig): ProviderAdapter {
  const pid = (cfg.provider ?? 'openai-compatible').toLowerCase() as ProviderId
  if (pid === 'anthropic') {
    return new AnthropicAdapter({
      apiKey: cfg.client.apiKey ?? '',
      baseURL: (cfg.client.baseURL ?? 'https://api.anthropic.com').replace(/\/v1\/?$/, ''),
    })
  }
  if (pid === 'bedrock' || pid === 'vertex' || pid === 'foundry') {
    return new StubProviderAdapter(pid)
  }
  return new OpenAICompatibleAdapter(cfg.client, pid)
}

/**
 * Placeholder adapter for providers whose native support isn't wired yet.
 * Reports the gap honestly instead of silently falling back to OpenAI compat.
 * Listed explicitly so users can see which providers are roadmap items.
 */
export class StubProviderAdapter implements ProviderAdapter {
  readonly providerId: ProviderId
  private _streamUsageSupported = false

  constructor(providerId: ProviderId) {
    this.providerId = providerId
  }

  get streamUsageSupported(): boolean {
    return this._streamUsageSupported
  }

  resetStreamUsageLatch(): void {
    this._streamUsageSupported = false
  }

  markStreamUsageUnsupported(): void {
    this._streamUsageSupported = false
  }

  async stream(): Promise<AsyncIterable<never>> {
    throw new Error(
      `Provider "${this.providerId}" is not wired in this build of ovolv999. ` +
      'OpenAI-compatible providers and Anthropic are supported today; ' +
      'Bedrock / Vertex / Foundry are tracked in docs/roadmap.md (planned 0.6.0).',
    )
  }
}
