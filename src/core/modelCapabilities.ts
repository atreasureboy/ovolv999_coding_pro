/**
 * Model capability abstraction (fi_goal.md §九 Phase 8 / Round 10).
 *
 * Replaces scattered hard-coded model-name checks with a single
 * `ModelCapabilities` lookup. Every Provider Adapter is responsible
 * for translating:
 *
 *     internal unified message
 *       → provider request
 *       → provider stream event
 *       → internal unified event
 *
 * The RuntimeCoordinator must NOT contain provider-specific branches;
 * it dispatches via `ProviderAdapter` resolved from ProviderId.
 */

import type { ModelInfo, ProviderId } from './providers.js'
import { getModelInfo, MODELS } from './providers.js'

// ── ModelCapabilities (spec §九) ────────────────────────────────────────

export interface ModelCapabilities {
  /** Tool/function calling. */
  toolCalling: boolean
  /** Multiple tool calls in a single assistant turn. */
  parallelToolCalling: boolean
  /** Model emits reasoning/thinking tokens alongside content. */
  reasoningTokens: boolean
  /** Provider supports prompt-caching headers (Anthropic ephemeral,
   *  OpenAI prompt prefix caching). */
  promptCaching: boolean
  /** Provider emits incremental usage deltas during streaming
   *  (not just a final usage chunk). */
  usageStreaming: boolean
  /** Image/multimodal input. */
  imageInput: boolean
  /** Max input context window in tokens. */
  maxContext: number
  /** Max output tokens per response. */
  maxOutput: number
}

// ── Defaults by provider ────────────────────────────────────────────────

/**
 * Sensible defaults per provider for capabilities that aren't yet
 * encoded on `ModelInfo` (promptCaching, usageStreaming). These are
 * intentionally conservative — when in doubt, claim the capability
 * is unavailable so callers fall back to the safe path.
 */
const PROVIDER_DEFAULTS: Record<
  ProviderId,
  Pick<ModelCapabilities, 'promptCaching' | 'usageStreaming'>
> = {
  openai: {
    promptCaching: true, // automatic prompt prefix caching
    usageStreaming: false, // final-only by default; o-series streams
  },
  anthropic: {
    promptCaching: true, // ephemeral cache_control
    usageStreaming: true,
  },
  google: {
    promptCaching: false,
    usageStreaming: true,
  },
  xai: {
    promptCaching: false,
    usageStreaming: false,
  },
  openrouter: {
    promptCaching: false,
    usageStreaming: false,
  },
  together: {
    promptCaching: false,
    usageStreaming: false,
  },
  groq: {
    promptCaching: false,
    usageStreaming: true,
  },
  deepseek: {
    promptCaching: true, // automatic context caching
    usageStreaming: true,
  },
  ollama: {
    promptCaching: false,
    usageStreaming: true,
  },
  mistral: {
    promptCaching: false,
    usageStreaming: true,
  },
  cohere: {
    promptCaching: false,
    usageStreaming: true,
  },
  perplexity: {
    promptCaching: false,
    usageStreaming: false,
  },
  unknown: {
    promptCaching: false,
    usageStreaming: false,
  },
}

const DEFAULT_MAX_OUTPUT_TOKENS = 8_192

/**
 * Resolve the capabilities for a given model id. The lookup is
 * authoritative — RuntimeCoordinator should call this instead of
 * pattern-matching model names.
 */
export function capabilitiesForModel(model: string): ModelCapabilities {
  const info = getModelInfo(model)
  if (!info) {
    return {
      toolCalling: false,
      parallelToolCalling: false,
      reasoningTokens: false,
      promptCaching: false,
      usageStreaming: false,
      imageInput: false,
      maxContext: 128_000,
      maxOutput: DEFAULT_MAX_OUTPUT_TOKENS,
    }
  }
  return capabilitiesFromInfo(info)
}

/**
 * Same as capabilitiesForModel but for an already-resolved ModelInfo.
 * Exported so callers that already hold the info struct don't pay
 * for a second index lookup.
 */
export function capabilitiesFromInfo(info: ModelInfo): ModelCapabilities {
  const defaults = PROVIDER_DEFAULTS[info.provider] ?? PROVIDER_DEFAULTS.unknown
  return {
    toolCalling: info.supportsTools ?? false,
    parallelToolCalling: info.supportsParallelTools ?? false,
    reasoningTokens: info.supportsReasoning ?? false,
    promptCaching: defaults.promptCaching,
    usageStreaming: defaults.usageStreaming,
    imageInput: info.supportsVision ?? false,
    maxContext: info.contextWindow,
    maxOutput: info.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS,
  }
}

/**
 * Recompute the effective context budget after a model switch.
 * Used by WorkingState.assembleSystemPrompt / contextManager when
 * the active model changes mid-session.
 */
export function effectiveInputBudget(
  caps: ModelCapabilities,
  opts: { reserveForOutput?: number; reserveForWorkingState?: number } = {},
): number {
  const reserveForOutput = Math.min(
    opts.reserveForOutput ?? caps.maxOutput,
    caps.maxOutput,
  )
  const reserveForState = opts.reserveForWorkingState ?? 0
  return Math.max(0, caps.maxContext - reserveForOutput - reserveForState)
}

/**
 * List every model id currently known to the registry along with its
 * resolved capabilities. Useful for diagnostics and capability-aware
 * UI affordances.
 */
export function allCapabilities(): ReadonlyArray<{ model: string } & ModelCapabilities> {
  return MODELS.map((m) => ({ model: m.id, ...capabilitiesFromInfo(m) }))
}

// ── ProviderAdapter interface ───────────────────────────────────────────

import type { OpenAIMessage } from './types.js'

/**
 * Unified internal event shape — providers translate their native
 * stream events into these. The RuntimeCoordinator consumes the
 * unified stream and never reads provider-specific fields.
 */
export type InternalStreamEvent =
  | { kind: 'text_delta'; text: string }
  | { kind: 'tool_call_delta'; toolCallId: string; toolName: string; argsDelta: string }
  | { kind: 'tool_call_complete'; toolCallId: string; toolName: string; args: string }
  | { kind: 'reasoning_delta'; text: string }
  | { kind: 'usage'; usage: StreamUsage }
  | { kind: 'done'; finishReason?: string; usage?: StreamUsage }
  | { kind: 'error'; error: Error }

export interface StreamUsage {
  inputTokens?: number
  outputTokens?: number
  reasoningTokens?: number
  cacheReadTokens?: number
  cacheWriteTokens?: number
}

/**
 * A provider adapter translates between the internal unified message
 * format and the provider's API. Each provider (OpenAI, Anthropic,
 * Google, xAI, ...) implements this interface once and only once;
 * the coordinator never branches on provider.
 */
export interface ProviderAdapter {
  readonly providerId: ProviderId

  /**
   * Convert internal unified messages to the provider's native
   * request body shape. The adapter must NOT perform the HTTP call
   * itself — that's the coordinator's job. Returning a plain object
   * keeps the adapter pure and trivially testable.
   */
  toProviderRequest(
    input: ProviderRequestInput,
    caps: ModelCapabilities,
  ): unknown

  /**
   * Translate a single native stream chunk into zero or more
   * internal stream events. The coordinator iterates the result
   * and dispatches to its unified event pipeline.
   *
   * Returning an array lets one chunk fan out (e.g. an Anthropic
   * message_delta can carry both a content_block_delta and an
   * immediate usage delta in the same SSE frame).
   */
  fromProviderStreamChunk(chunk: unknown): InternalStreamEvent[]
}

export interface ProviderRequestInput {
  model: string
  messages: OpenAIMessage[]
  maxOutputTokens: number
  /** When true, the adapter should emit prompt-caching hints if supported. */
  enableCaching: boolean
  /** Caller-provided tool definitions, if any. */
  tools?: unknown[]
  /** AbortSignal — passed through so the adapter can attach it to the request. */
  signal?: AbortSignal
}

// ── Adapter registry ────────────────────────────────────────────────────

const adapterRegistry = new Map<ProviderId, ProviderAdapter>()

/**
 * Register a provider adapter. Idempotent for the same providerId —
 * later registrations overwrite earlier ones (useful for tests that
 * inject fakes).
 */
export function registerProviderAdapter(adapter: ProviderAdapter): void {
  adapterRegistry.set(adapter.providerId, adapter)
}

/**
 * Look up the adapter for a provider. Throws if none is registered.
 */
export function getProviderAdapter(providerId: ProviderId): ProviderAdapter {
  const adapter = adapterRegistry.get(providerId)
  if (!adapter) {
    throw new Error(`no provider adapter registered for '${providerId}'`)
  }
  return adapter
}

/** True when an adapter is registered for the provider. */
export function hasProviderAdapter(providerId: ProviderId): boolean {
  return adapterRegistry.has(providerId)
}

/** Test helper: clear all registered adapters. */
export function clearProviderAdapters(): void {
  adapterRegistry.clear()
}
