/**
 * ReasoningTransformer — provider-specific reasoning/thinking parameter
 * translation (opencode transform.ts pattern, adapted to this codebase's
 * OpenAI-shaped transport).
 *
 * Problem: reasoning models disagree on THREE axes —
 *   1. how reasoning is REQUESTED (effort enum / budget tokens / boolean
 *      enable / vendor-specific object shapes),
 *   2. how reasoning CONTENT is RETURNED in the stream
 *      (delta.reasoning_content | delta.reasoning | thinking blocks),
 *   3. whether prior reasoning must be REPLAYED on the next request
 *      (DeepSeek R1 requires reasoning_content on assistant messages;
 *      Anthropic requires thinking blocks; OpenAI omits reasoning from
 *      history entirely).
 *
 * This module owns axis 1 (request shaping) and axis 3 (history
 * normalization); axis 2 (stream extraction) lives in the adapter, which
 * calls extractReasoningDelta here so every transport agrees on the
 * normalized `reasoning_content` chunk shape.
 *
 * Flavors (detected from model id + provider):
 *   openai      → reasoning_effort: 'minimal'|'low'|'medium'|'high'
 *   anthropic   → thinking: { type: 'enabled', budget_tokens }
 *   deepseek    → (reasoning is always-on; history replay required)
 *   qwen        → enable_thinking: boolean (+ thinking_budget optional)
 *   minimax     → interleaved_thinking / reasoning_config variants
 *   glm         → thinking: { type: 'enabled' } object form
 *   grok        → reasoning_effort: 'low'|'high'
 *   openrouter  → reasoning: { effort, exclude } (openrouter-native shape)
 *
 * Unknown models: NO reasoning parameters are added — an unrecognized
 * body key is a 400 on most backends, so the default is silence.
 */

// ── Normalized public shape ────────────────────────────────────────────────

export type ReasoningEffort = 'minimal' | 'low' | 'medium' | 'high'
export type ReasoningFlavor =
  | 'openai-effort'
  | 'anthropic-thinking'
  | 'deepseek-replay'
  | 'qwen-toggle'
  | 'glm-object'
  | 'minimax-config'
  | 'grok-effort'
  | 'openrouter-native'
  | 'none'

export interface ReasoningRequestOptions {
  /** Normalized effort. undefined = provider default (usually medium). */
  effort?: ReasoningEffort
  /** Explicit budget in tokens (anthropic-flavor only; clamped to the model cap). */
  budgetTokens?: number
  /** When false, request NO reasoning (models that support disabling). */
  enabled?: boolean
}

/** Detect which reasoning flavor a (provider, model) pair speaks. */
export function detectReasoningFlavor(provider: string | undefined, model: string): ReasoningFlavor {
  const p = (provider ?? '').toLowerCase()
  const m = model.toLowerCase()
  if (p === 'anthropic') return 'anthropic-thinking'
  if (p === 'openrouter') return 'openrouter-native'
  if (p === 'grok' || m.includes('grok-')) return 'grok-effort'
  if (m.includes('deepseek-r') || m.includes('deepseek-reasoner')) return 'deepseek-replay'
  if (m.includes('qwen3') || m.includes('qwq')) return 'qwen-toggle'
  if (m.includes('glm-') || m.includes('glm4') || m.includes('chatglm')) return 'glm-object'
  if (m.includes('minimax-m') || p === 'minimax') return 'minimax-config'
  if (m.includes('o1') || m.includes('o3') || m.includes('o4') || m.includes('gpt-5')) return 'openai-effort'
  if (p === 'openai') return 'openai-effort'
  return 'none'
}

/** Efforts each flavor accepts, weakest → strongest. */
const FLAVOR_EFFORTS: Partial<Record<ReasoningFlavor, ReasoningEffort[]>> = {
  'openai-effort': ['minimal', 'low', 'medium', 'high'],
  'grok-effort': ['low', 'high'],
  'anthropic-thinking': ['low', 'medium', 'high'],
  'openrouter-native': ['low', 'medium', 'high'],
}

export function supportedEfforts(flavor: ReasoningFlavor): ReasoningEffort[] {
  return FLAVOR_EFFORTS[flavor] ?? []
}

// ── Axis 1: request shaping ────────────────────────────────────────────────

/** Anthropic thinking budget caps per family (tokens). */
function anthropicBudgetCap(model: string): number {
  const m = model.toLowerCase()
  if (m.includes('opus')) return 32_768
  if (m.includes('sonnet')) return 64_000
  return 32_768
}

/**
 * Translate normalized reasoning options into provider-specific body keys.
 * Returns undefined when no parameters should be added (unknown flavor or
 * explicitly disabled on a model that cannot disable).
 *
 * The returned object is SPREAD into the request body by the adapter —
 * never a nested wrapper, so unknown-flavor silence stays byte-identical.
 */
export function buildReasoningParams(
  provider: string | undefined,
  model: string,
  opts: ReasoningRequestOptions | undefined,
): Record<string, unknown> | undefined {
  if (!opts) return undefined
  const flavor = detectReasoningFlavor(provider, model)
  const { effort, budgetTokens, enabled } = opts

  switch (flavor) {
    case 'openai-effort': {
      if (enabled === false) return undefined // OpenAI models can't turn reasoning off
      const chosen = effort ?? 'medium'
      if (!supportedEfforts(flavor).includes(chosen)) return undefined
      return { reasoning_effort: chosen }
    }
    case 'grok-effort': {
      if (enabled === false) return undefined
      const chosen = effort === 'minimal' ? 'low' : effort === 'high' ? 'high' : 'low'
      return { reasoning_effort: chosen }
    }
    case 'openrouter-native': {
      if (enabled === false) return { reasoning: { enabled: false } }
      const chosen = effort ?? 'medium'
      if (!['low', 'medium', 'high'].includes(chosen)) return undefined
      return { reasoning: { effort: chosen, exclude: false } }
    }
    case 'anthropic-thinking': {
      if (enabled === false) return { thinking: { type: 'disabled' } }
      const cap = anthropicBudgetCap(model)
      const budget = Math.max(1_024, Math.min(budgetTokens ?? 10_240, cap))
      return { thinking: { type: 'enabled', budget_tokens: budget } }
    }
    case 'qwen-toggle': {
      return {
        enable_thinking: enabled !== false,
        ...(enabled !== false && budgetTokens ? { thinking_budget: Math.min(budgetTokens, 32_768) } : {}),
      }
    }
    case 'glm-object': {
      if (enabled === false) return { thinking: { type: 'disabled' } }
      return { thinking: { type: 'enabled' } }
    }
    case 'minimax-config': {
      if (enabled === false) return { interleaved_thinking: false }
      return { interleaved_thinking: true }
    }
    case 'deepseek-replay': {
      // DeepSeek R1 reasons always; no request-side knob exists.
      return undefined
    }
    case 'none':
    default:
      return undefined
  }
}

// ── Axis 2: stream extraction ──────────────────────────────────────────────

/**
 * Extract reasoning text from a streamed delta, whatever field the
 * backend used. Returns the normalized text or undefined. Callers write
 * it into `delta.reasoning_content` so the StreamConsumer has ONE shape
 * to render.
 *
 * Recognized shapes (verified against vendor docs / opencode transform):
 *   delta.reasoning_content        — DeepSeek R1, Qwen (DashScope), MiniMax M1
 *   delta.reasoning                — OpenRouter normalized, Zhipu GLM
 *   delta.reasoning_details[].text — Anthropic-via-OpenAI-compat gateways
 *   delta.thinking                 — some XAI/Grok gateways
 */
export function extractReasoningDelta(
  delta: Record<string, unknown> | undefined | null,
): string | undefined {
  if (!delta) return undefined
  if (typeof delta.reasoning_content === 'string' && delta.reasoning_content.length > 0) {
    return delta.reasoning_content
  }
  if (typeof delta.reasoning === 'string' && delta.reasoning.length > 0) {
    return delta.reasoning
  }
  if (typeof delta.thinking === 'string' && delta.thinking.length > 0) {
    return delta.thinking
  }
  const details = delta.reasoning_details
  if (Array.isArray(details)) {
    const text = details
      .map((d) => (d && typeof d === 'object' && typeof (d as { text?: unknown }).text === 'string'
        ? (d as { text: string }).text
        : ''))
      .filter(Boolean)
      .join('')
    if (text.length > 0) return text
  }
  return undefined
}

// ── Axis 3: history normalization ─────────────────────────────────────────

/**
 * OpenAIMessage with optional reasoning — the normalized in-history shape.
 * Reasoning extracted from a stream is attached to the assistant message
 * so flavors that REQUIRE replay can put it back, and flavors that must
 * NOT replay can strip it. Uses a distinct `reasoningContent` field (not
 * a fake content part) so the OpenAI-shaped body builders stay clean.
 */
export interface ReasoningMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string | null
  reasoningContent?: string
  tool_calls?: unknown[]
  tool_call_id?: string
  name?: string
}

/**
 * Normalize assistant history for a target flavor:
 *   deepseek-replay → attach reasoning back as `reasoning_content` (R1
 *                     rejects histories that omit it once present).
 *   everything else → STRIP reasoningContent (OpenAI/Anthropic reject
 *                     unknown assistant fields; replaying wastes tokens).
 * Tool/user/system messages pass through untouched.
 */
export function normalizeHistoryForRequest(
  provider: string | undefined,
  model: string,
  messages: Array<Record<string, unknown>>,
): Array<Record<string, unknown>> {
  const flavor = detectReasoningFlavor(provider, model)
  return messages.map((m) => {
    if (m.role !== 'assistant') return m
    const reasoning = typeof m.reasoningContent === 'string' ? m.reasoningContent : undefined
    if (!reasoning) {
      // No reasoning recorded — nothing to strip or replay.
      return m
    }
    if (flavor === 'deepseek-replay') {
      const { reasoningContent: _drop, ...rest } = m
      return { ...rest, reasoning_content: reasoning }
    }
    const { reasoningContent: _strip, ...rest } = m
    return rest
  })
}
