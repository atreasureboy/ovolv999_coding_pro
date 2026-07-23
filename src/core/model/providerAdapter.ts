/**
 * ProviderAdapter (six_goal Phase 1) — the single abstraction that owns
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

export type ProviderId = string

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
  readonly providerId: string
  private _streamUsageSupported = true

  constructor(
    private readonly client: OpenAI,
    providerId = 'openai-compatible',
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
    const { model, systemPrompt, messages, tools, temperature, maxOutputTokens, signal } = req
    const baseBody = {
      model,
      messages: [
        { role: 'system' as const, content: systemPrompt },
        ...messages,
      ],
      tools: tools.length > 0 ? tools : undefined,
      tool_choice: tools.length > 0 ? ('auto' as const) : undefined,
      temperature: temperature ?? 0,
      max_tokens: maxOutputTokens,
      stream: true as const,
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
 * Select a ProviderAdapter for the given config. Today everything is
 * OpenAI-compatible (OpenAI, MiniMax via /v1, OpenRouter, Ollama, …);
 * the factory is the extension point for native Anthropic / Gemini
 * adapters. `providerId` is surfaced for logging/diagnostics.
 */
export interface ProviderAdapterConfig {
  provider?: string
  client: OpenAI
}

export function createProviderAdapter(cfg: ProviderAdapterConfig): ProviderAdapter {
  const pid = (cfg.provider ?? 'openai-compatible').toLowerCase()
  // All currently-supported providers speak the OpenAI Chat Completions
  // shape. When a native adapter lands (e.g. anthropic-messages), branch
  // here on pid/baseURL.
  return new OpenAICompatibleAdapter(cfg.client, pid)
}
