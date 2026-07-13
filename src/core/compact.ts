/**
 * Conversation Compact — auto-summarize when context grows too large
 *
 * Strategy:
 *   1. Estimate token count of current conversation (~4 chars/token)
 *   2. When context pressure exceeds the compact threshold (85%), call the LLM to summarize
 *   3. Replace old messages with a single system-style summary message
 *   4. Keep last N recent messages verbatim (fresh context)
 */

import type OpenAI from 'openai'
import type { OpenAIMessage } from './types.js'

// Legacy single-rate constant kept here historically; the multilingual
// estimator now uses ASCII_CHARS_PER_TOKEN (for ASCII) and
// NON_ASCII_CHARS_PER_TOKEN (for CJK/emoji/etc.) instead. See estimateTextTokens.

// Model max context window (tokens). Matches claude-sonnet-4-x 200k context.
// Sub-agents inherit the same model so one constant is sufficient here.
export const MODEL_MAX_CONTEXT_TOKENS = 200_000

/**
 * Per-character token estimate factor. ASCII is the common case and the
 * legacy 3.5 chars/token rate is reasonable for English / code / JSON syntax.
 * Non-ASCII (CJK / emoji / accented Latin / etc.) is treated SEPARATELY by
 * {@link NON_ASCII_CHARS_PER_TOKEN}, so this constant applies only to
 * code-point order 0..127.
 */
export const ASCII_CHARS_PER_TOKEN = 3.5

/**
 * Default `max_tokens` for completion requests. Single source of truth so the
 * primary, no-stream-options fallback, and post-compact-retry paths can never
 * silently drift again — the previous code had one path on 8192 and the
 * retry path on 16_384, which would surface as inconsistent response lengths
 * depending on which branch the API took.
 */
export const MAX_OUTPUT_TOKENS_DEFAULT = 8192

/**
 * Conservative clamp on max_tokens given a model context window.
 *
 * The model needs headroom for input (system prompt + tool definitions +
 * messages) AND for its own response. If `max_tokens` exceeds ~half the
 * window, the API will reject anything but the emptiest prompts.
 *
 * Strategy:
 *   - `requested` is sanitised: anything that is not a finite positive
 *     integer (NaN, Infinity, 0, negative, float, null, undefined) falls back
 *     to {@link MAX_OUTPUT_TOKENS_DEFAULT} before clamping. This prevents
 *     corrupt config values from producing illegal `max_tokens` values that
 *     would either be rejected upstream or never fit in the model's window.
 *   - Then cap at half the window so input always has at least
 *     `window - max_tokens ≥ window / 2` tokens of headroom.
 *   - Floors at 1 to ensure the request is still well-formed on pathological
 *     configurations (e.g. contextWindow=1).
 */
export function clampMaxOutputTokens(
  maxOutput: number | undefined | null,
  contextWindow: number,
): number {
  const requested = isFinitePositiveInteger(maxOutput)
    ? maxOutput as number
    : MAX_OUTPUT_TOKENS_DEFAULT
  if (!Number.isFinite(contextWindow) || contextWindow <= 0) {
    return Math.max(1, requested)
  }
  const halfWindow = Math.max(1, Math.floor(contextWindow / 2))
  return Math.max(1, Math.min(requested, halfWindow))
}

/**
 * True iff the value is a finite positive integer.
 * Used by {@link clampMaxOutputTokens} and {@link resolveContextWindow} to
 * validate numeric config inputs.
 */
export function isFinitePositiveInteger(value: unknown): boolean {
  return (
    typeof value === 'number'
    && Number.isFinite(value)
    && Number.isInteger(value)
    && value > 0
  )
}

/**
 * Compute the effective INPUT budget for percentage-based checks.
 *
 * Subtracts the clamped output budget from the context window. The result is
 * the maximum input tokens the model can ingest WITHOUT exceeding the window
 * during generation. Use this as the denominator for `pct` calculations —
 * otherwise warnings/compactions fire at thresholds that mathematically
 * guarantee an API rejection for small-window models.
 *
 * Example: 8k window, default 8k max → effectiveInput = 4k → warning at 70%
 * fires at 2.8k input instead of 5.6k, leaving room for 8k output.
 *
 * Floors at 1 to keep `pct` finite on degenerate configs.
 */
export function effectiveInputBudget(
  contextWindow: number,
  maxOutput: number | undefined | null,
): number {
  const reservedOutput = clampMaxOutputTokens(maxOutput, contextWindow)
  const input = contextWindow - reservedOutput
  return Math.max(1, input)
}

/**
 * Known model context windows (tokens). Lookup is by exact name or substring
 * match (longest match wins). Unknown models fall back to
 * {@link MODEL_MAX_CONTEXT_TOKENS}. Override via {@link maxContextTokens} in
 * EngineConfig for any model not listed here.
 */
export const KNOWN_MODEL_CONTEXT_WINDOWS: ReadonlyArray<readonly [pattern: RegExp, window: number]> = [
  // Claude family — 200k context
  [/^claude-(?:opus|sonnet|haiku)-?4/i, 200_000],
  [/^claude-3-7-sonnet/i, 200_000],
  [/^claude-3-5-(?:sonnet|haiku)/i, 200_000],
  [/^claude-3-(?:opus|sonnet|haiku)/i, 200_000],
  [/^claude-instant/i, 100_000],
  // OpenAI o-series / GPT-5 family — 200k+ context
  [/^o[1-9](?:-mini|-nano)?(?:-preview|-pro)?$/i, 200_000],
  [/^gpt-5/i, 400_000],
  [/^chatgpt-4o/i, 128_000],
  // GPT-4o / GPT-4 Turbo — 128k
  [/^gpt-4o(?:-mini)?/i, 128_000],
  [/^gpt-4-turbo/i, 128_000],
  // Older GPT-4 — 8k context
  [/^gpt-4(?:-vision)?$/i, 8_192],
  [/^gpt-4-32k/i, 32_768],
  // GPT-3.5 — 16k
  [/^gpt-3\.5-turbo-16k/i, 16_385],
  [/^gpt-3\.5-turbo/i, 4_096],
  // DeepSeek — 64k reasoning context
  [/^deepseek-(?:reasoner|chat)/i, 64_000],
  // Qwen — 32k+ context
  [/^qwen(?:-(?:plus|turbo|max|long))?/i, 32_768],
  // Llama-3.x — 128k context
  [/^llama-3\.1(?:-\d+b)?/i, 128_000],
  [/^llama-3(?:\.\d+)?(?:-\d+b)?$/i, 8_192],
]

/**
 * Resolve context window for a model name.
 *
 * Precedence: explicit override > pattern match against {@link KNOWN_MODEL_CONTEXT_WINDOWS}
 * > {@link MODEL_MAX_CONTEXT_TOKENS} fallback.
 *
 * Override contract: must be a FINITE POSITIVE INTEGER.
 *   - Infinity / -Infinity are REJECTED — they would silently disable every
 *     percentage-based check (pct = totalTokens / Infinity → 0) and
 *     permanently turn off compaction.
 *   - NaN is REJECTED — all comparisons with NaN are false; the previous
 *     `override > 0` accidentally let NaN fall through to the lookup, which
 *     "works" but is fragile (direct callers get silent surprises).
 *   - Floats are REJECTED — context windows are integer token counts.
 *   - Non-positive numbers are REJECTED.
 * Invalid overrides silently fall through to the model lookup.
 *
 * The match is the LONGEST pattern that matches anywhere in the model name,
 * so e.g. "gpt-4o-mini" matches the 128k rule, not the 8k "gpt-4" rule.
 */
export function resolveContextWindow(model: string, override?: number): number {
  if (isFinitePositiveInteger(override)) {
    return override as number
  }
  if (typeof model !== 'string' || !model) return MODEL_MAX_CONTEXT_TOKENS

  // Find longest matching pattern so more-specific rules shadow generic ones
  let bestMatch: { pattern: RegExp; window: number } | null = null
  for (const entry of KNOWN_MODEL_CONTEXT_WINDOWS) {
    if (entry[0].test(model)) {
      if (!bestMatch || entry[0].source.length > bestMatch.pattern.source.length) {
        bestMatch = { pattern: entry[0], window: entry[1] }
      }
    }
  }
  if (bestMatch) return bestMatch.window
  return MODEL_MAX_CONTEXT_TOKENS
}

// Percentage-based thresholds — the single source of truth for context pressure
export const CONTEXT_WARN_PCT    = 0.70   // 70%  → display yellow warning
export const CONTEXT_COMPACT_PCT = 0.85   // 85%  → force auto-compact (LLM summarization)

// microCompact — lightweight pre-compact that clears old tool results WITHOUT
// an LLM call. Runs at a lower threshold than full compact, buying headroom
// cheaply. Inspired by Claude Code's microCompact.
export const CONTEXT_MICROCOMPACT_PCT = 0.50  // 50%  → clear old tool results
const KEEP_RECENT_TOOL_RESULTS = 6     // keep the N most recent tool results
const CLEARED_PLACEHOLDER = '[Old tool result content cleared — re-run the tool if needed]'

// Tools whose results are safe to clear (they can be re-fetched).
// State-mutating tools (Write, Edit) are NOT compactable — their results
// are small and meaningful (success/failure confirmation).
const COMPACTABLE_TOOLS = new Set([
  'Read', 'Glob', 'Grep', 'WebFetch', 'WebSearch', 'Bash',
])

/** Compression strategy selected based on context pressure */
export type CompressionStrategy = 'proportional' | 'priority' | 'aggressive'

/** Determine compression strategy from usage fraction */
export function getCompressionStrategy(pct: number): CompressionStrategy {
  if (pct > 0.9) return 'aggressive'
  if (pct > 0.85) return 'priority'
  return 'proportional'
}

// Keep this many recent messages verbatim after compaction
const KEEP_RECENT_MESSAGES = 8

// Reserve tokens for the summary output itself
const SUMMARY_OUTPUT_RESERVE = 4_000

// ── Context state ────────────────────────────────────────────────────────────

export interface ContextState {
  /** Estimated current token count */
  currentTokens: number
  /** Model maximum context window */
  maxTokens: number
  /** Usage fraction 0–1 */
  pct: number
  /** True when ≥ CONTEXT_MICROCOMPACT_PCT — clear old tool results (no LLM call) */
  shouldMicroCompact: boolean
  /** True when ≥ CONTEXT_WARN_PCT — show a yellow warning */
  shouldWarn: boolean
  /** True when ≥ CONTEXT_COMPACT_PCT — trigger auto-compact immediately */
  shouldCompact: boolean
  /** Compression strategy based on current pressure */
  strategy: CompressionStrategy
}

/**
 * Calculate current context usage and determine whether to warn or compact.
 */
export function calculateContextState(
  messages: OpenAIMessage[],
  maxTokens: number = MODEL_MAX_CONTEXT_TOKENS,
): ContextState {
  const currentTokens = estimateTokens(messages)
  const pct = currentTokens / maxTokens
  return {
    currentTokens,
    maxTokens,
    pct,
    shouldMicroCompact: pct >= CONTEXT_MICROCOMPACT_PCT,
    shouldWarn:   pct >= CONTEXT_WARN_PCT,
    shouldCompact: pct >= CONTEXT_COMPACT_PCT,
    strategy: getCompressionStrategy(pct),
  }
}

/**
 * Non-ASCII code points are estimated at 2 tokens EACH via this heuristic.
 * Real-world token cost varies wildly per code point:
 *   - A CJK character typically tokenizes to 1–2 BPE tokens (occasionally 3
 *     on older tokenizers).
 *   - An emoji can be 1–4 BPE tokens depending on family.
 *   - ZWJ sequences (`👨‍👩‍👧`) are MULTIPLE code points; we count each separately.
 * This heuristic is more conservative than the legacy single-rate estimator
 * for non-ASCII content but IS NOT a worst-case bound: certain tokenizers
 * can emit more tokens for specific code points (very rare CJK ideographs,
 * regional indicators, complex ZWJ chains). Margin against those is
 * absorbed by the override-friendly pressure thresholds (micro at 50%,
 * warn at 70%, compact at 85% of the EFFECTIVE input budget, which itself
 * already reserves space for the clamped output — see
 * {@link effectiveInputBudget}). We do not promise exact parity with any
 * real tokenizer; we promise the estimate stays in the conservative
 * direction relative to the per-codepoint baseline of 1.
 *
 * LOWERING THIS FACTOR would require a real tokenizer dependency
 * (gpt-tokenizer / js-tiktoken) — out of scope by design.
 */
export const NON_ASCII_CHARS_PER_TOKEN = 0.5

/**
 * Multilingual-aware token estimate for a free-form string.
 *
 * Iteration: walks the string as a sequence of Unicode CODE POINTS (NOT
 * grapheme clusters). `for…of` over a string in JS yields one Unicode code
 * point per iteration, even when a code point is encoded as a surrogate pair
 * in UTF-16 (e.g. `🎉` = U+1F389; `length === 2`, but iterated ONCE).
 *
 * What this function does NOT do:
 *   - Grapheme segmentation. A ZWJ sequence like `👨‍👩‍👧` (man + ZWJ + woman +
 *     ZWJ + girl) iterates as FIVE code points, not as the single visible
 *     emoji the user sees.
 *   - Real BPE tokenization. Cost is approximated, not measured.
 *
 * Per code point:
 *   - ASCII (U+0000..U+007F): contributes `1 / ASCII_CHARS_PER_TOKEN = ~0.286`
 *     tokens (i.e. 3.5 chars/token — the legacy rate for English / code / JSON).
 *   - non-ASCII: contributes `1 / NON_ASCII_CHARS_PER_TOKEN = 2` tokens each
 *     (more conservative than the 1-token-per-codepoint baseline; still
 *     heuristic).
 *
 * No external dependency. Deterministic.
 */
export function estimateTextTokens(text: string | null | undefined): number {
  if (!text) return 0
  let asciiChars = 0
  let nonAsciiChars = 0
  // for…of yields one Unicode code point per iteration. A supplementary
  // plane character encoded as a UTF-16 surrogate pair (e.g. `🎉`, `🚀`,
  // CJK Extension B characters) contributes ONE iteration here — not two —
  // because the surrogate halves are a single JavaScript iteration pair.
  // This is the entire "surrogate-pair safety" guarantee.
  //
  // It is NOT grapheme-cluster safe: ZWJ sequences and combining marks split
  // across multiple iterations. We do not paper over that.
  for (const ch of text) {
    const cp = ch.codePointAt(0)
    if (cp === undefined) continue
    if (cp <= 0x7F) {
      asciiChars++
    } else {
      nonAsciiChars++
    }
  }
  return asciiChars / ASCII_CHARS_PER_TOKEN + nonAsciiChars / NON_ASCII_CHARS_PER_TOKEN
}

/**
 * Rough token count estimate from message array.
 *
 * Counts:
 *   - role string ("user"/"assistant"/"tool"/"system" overhead — ~4 tokens)
 *   - content (multilingual — non-ASCII code points at 2 tokens each,
 *     ASCII at the legacy 3.5 chars/token rate)
 *   - tool_calls JSON (multilingual)
 *   - tool_call_id and name overhead for tool result messages
 *   - per-message envelope overhead
 *
 * Heuristic, not a tokenizer. CJK strings cost roughly what real tokenizers
 * bill, but the relationship is not exact and may under-count for specific
 * high-cost code points (rare CJK ideographs, complex ZWJ emoji chains).
 * The margin against inaccuracy comes from THREE fixed buffers, not from
 * per-model knob tuning:
 *   1. Output reservation via {@link effectiveInputBudget}: room for the
 *      clamped response is carved out BEFORE computing `pct`, so percentage
 *      thresholds apply to INPUT budget not full window.
 *   2. The fixed pressure thresholds {@link CONTEXT_MICROCOMPACT_PCT} /
 *      {@link CONTEXT_WARN_PCT} / {@link CONTEXT_COMPACT_PCT} (50% / 70% /
 *      85%) are intentionally conservative — built-in headroom for the
 *      estimate error.
 *   3. The reactive `context_length_exceeded` retry in the engine, which
 *      last-resort compacts if the API rejects the request.
 *
 * Truly per-model / per-deployment knobs are `maxContextTokens` and
 * `maxOutputTokens` in EngineConfig (they override the model lookup and
 * the default output cap respectively). The thresholds above are constants.
 */
export function estimateTokens(messages: OpenAIMessage[]): number {
  let tokens = 0
  for (const msg of messages) {
    if (typeof msg.content === 'string') {
      tokens += estimateTextTokens(msg.content)
    } else if (msg.content === null) {
      tokens += 1 // ≈1 token for null content with tool_calls
    }
    // Role token (~4) + role string cost
    tokens += 4 + Math.ceil(msg.role.length / ASCII_CHARS_PER_TOKEN)
    if (msg.tool_calls) {
      // Tool call name + arguments + JSON syntax overhead (multilingual)
      tokens += estimateTextTokens(JSON.stringify(msg.tool_calls)) + 1
    }
    if (msg.name) tokens += 1 + Math.ceil(msg.name.length / ASCII_CHARS_PER_TOKEN)
    if (msg.tool_call_id) tokens += 1 + Math.ceil(msg.tool_call_id.length / ASCII_CHARS_PER_TOKEN)
    tokens += 4 // message envelope overhead
  }
  return Math.ceil(tokens)
}

/**
 * Estimate token cost of a tool definitions array (the `tools` parameter sent
 * alongside the message list). Each tool definition is JSON-serialized with
 * name + description + JSON-schema parameters — typically 50–200 tokens per tool.
 * Multilingual via {@link estimateTextTokens}: a non-ASCII code point in a
 * tool description contributes 2 tokens (heuristic — see the caveat on
 * {@link NON_ASCII_CHARS_PER_TOKEN}).
 *
 * Ignored if `toolDefs` is absent/empty — falls back to an empty result.
 */
export function estimateToolDefinitionTokens(
  toolDefs: ReadonlyArray<unknown> | undefined | null,
): number {
  if (!toolDefs || toolDefs.length === 0) return 0
  let tokens = 1 // wrapper-level overhead ({"tools":[...]})
  for (const def of toolDefs) {
    tokens += estimateTextTokens(JSON.stringify(def))
  }
  return Math.ceil(tokens)
}

// ── Compact prompt ──────────────────────────────────

const NO_TOOLS_PREAMBLE = `CRITICAL: Respond with TEXT ONLY. Do NOT call any tools.
Do NOT use any tools. Your entire response must be a plain text summary.
Tool calls will be IGNORED — you have one turn to produce text.

`

const SUMMARY_SYSTEM_PROMPT = `${NO_TOOLS_PREAMBLE}You are summarizing a conversation between a user and an AI coding assistant.

Your summary will replace the full conversation history. The assistant must be able to continue the conversation from your summary with complete context.

Before writing the summary, analyze the conversation in <analysis> tags:
1. Go through each message chronologically
2. Identify: user requests, decisions made, files modified, commands run, errors encountered and fixed
3. Note any explicit user feedback or corrections
4. Identify what is still in progress or incomplete

Then write the summary in <summary> tags with these sections:

## Task Overview
What the user asked for and the overall goal.

## All User Messages
List ALL user messages (excluding tool results) verbatim or closely paraphrased. This preserves user feedback, changing requirements, and corrections across compaction. Never omit a user message.

## Work Completed
- Files created/modified (with paths and key changes)
- Commands run and their outcomes
- Problems solved and how

## Errors and Fixes
Any errors encountered and how they were resolved. Include the error message and the fix applied.

## Current State
What has been done, what is working, what is still pending.

## Key Context
Important decisions, patterns, constraints, or user preferences to remember.
Include relevant code snippets, function signatures, or file contents that are critical for continuing.

## Next Steps
What needs to be done next (if anything is incomplete). If the user's last message contained a specific request, quote it verbatim here.

IMPORTANT: Do NOT call any tools. Respond with TEXT ONLY.`

/**
 * Extract content between tags, stripping the analysis scratchpad.
 */
function extractSummary(text: string): string {
  // Try to get <summary>...</summary>
  const summaryMatch = text.match(/<summary>([\s\S]*?)<\/summary>/i)
  if (summaryMatch?.[1]) {
    return summaryMatch[1].trim()
  }

  // Fall back: strip <analysis> block and return the rest
  return text
    .replace(/<analysis>[\s\S]*?<\/analysis>/i, '')
    .trim()
}

/**
 * Serialize messages to text for the summarization prompt.
 */
function serializeMessages(messages: OpenAIMessage[]): string {
  const parts: string[] = []
  for (const msg of messages) {
    const role = msg.role.toUpperCase()
    if (typeof msg.content === 'string' && msg.content) {
      parts.push(`[${role}]: ${msg.content}`)
    } else if (msg.content === null && msg.tool_calls?.length) {
      const calls = msg.tool_calls
        .map(tc => `  → ${tc.function.name}(${tc.function.arguments.slice(0, 200)})`)
        .join('\n')
      parts.push(`[ASSISTANT tool calls]:\n${calls}`)
    }
    if (msg.role === 'tool' && typeof msg.content === 'string') {
      const preview = msg.content.slice(0, 500)
      const truncated = msg.content.length > 500 ? ' ...[truncated]' : ''
      parts.push(`[TOOL RESULT: ${msg.name ?? '?'}]: ${preview}${truncated}`)
    }
  }
  return parts.join('\n\n')
}

export interface CompactResult {
  compacted: boolean
  messages: OpenAIMessage[]
  summaryTokens: number
  originalTokens: number
}

/**
 * Compact the conversation by summarizing older messages.
 * The engine gates this call — by the time we're here, compaction is needed.
 * Returns new (smaller) messages array.
 */
export async function maybeCompact(
  client: OpenAI,
  model: string,
  messages: OpenAIMessage[],
): Promise<CompactResult> {
  const originalTokens = estimateTokens(messages)

  // Keep the most recent messages verbatim — they're the freshest context.
  // CRITICAL: The recent window must START with a valid message type:
  //   - 'user' or 'assistant' (with or without tool_calls)
  //   - NEVER start with 'tool' (orphan result → API 400)
  //
  // Strategy: find a split point where recentMessages[0] is NOT a tool message.
  // Walk BACKWARD from the initial split point until we find a safe boundary.
  let splitPoint = messages.length - KEEP_RECENT_MESSAGES
  if (splitPoint > 0) {
    // Walk FORWARD past tool results first (like before)
    while (
      splitPoint < messages.length &&
      messages[splitPoint]?.role === 'tool'
    ) {
      splitPoint++
    }
    // If we walked past everything, recent is empty — walk BACKWARD instead
    // to find the last non-tool message before the tool batch
    if (splitPoint >= messages.length) {
      splitPoint = messages.length - KEEP_RECENT_MESSAGES
      while (splitPoint > 0 && messages[splitPoint]?.role === 'tool') {
        splitPoint--
      }
      // Ensure splitPoint is at a non-tool message
      if (messages[splitPoint]?.role === 'tool' && splitPoint > 0) {
        splitPoint--
      }
    }
    // Final safety: splitPoint must be >= 0 and point to a non-tool message
    splitPoint = Math.max(0, splitPoint)
  }
  const recentMessages = messages.slice(splitPoint)
  const olderMessages = messages.slice(0, splitPoint)

  if (olderMessages.length === 0 || messages.length < KEEP_RECENT_MESSAGES * 2) {
    // Not enough messages to compact meaningfully
    return { compacted: false, messages, summaryTokens: 0, originalTokens }
  }

  // Build the summarization request
  const conversationText = serializeMessages(olderMessages)
  const userPrompt = `Please summarize the following conversation:\n\n${conversationText}`

  let summaryText: string
  try {
    const response = await client.chat.completions.create({
      model,
      messages: [
        { role: 'system', content: SUMMARY_SYSTEM_PROMPT },
        { role: 'user', content: userPrompt },
      ],
      temperature: 0,
      max_tokens: SUMMARY_OUTPUT_RESERVE,
      // No tools — we explicitly don't want tool calls here
    })
    summaryText = response.choices[0]?.message?.content ?? ''
  } catch {
    // If summarization fails, return original messages unchanged
    return { compacted: false, messages, summaryTokens: 0, originalTokens }
  }

  const summary = extractSummary(summaryText)
  if (!summary) {
    return { compacted: false, messages, summaryTokens: 0, originalTokens }
  }

  // Build compacted history: summary message + recent verbatim messages
  const summaryContent = `[CONVERSATION SUMMARY — previous context compacted]\n\n${summary}`

  const summaryMessage: OpenAIMessage = {
    role: 'user',
    content: summaryContent,
  }

  const syntheticAssistantAck: OpenAIMessage = {
    role: 'assistant',
    content: `I've reviewed the conversation summary and have the context needed to continue.`,
  }

  const compactedMessages: OpenAIMessage[] = [
    summaryMessage,
    syntheticAssistantAck,
    ...recentMessages,
  ]

  const summaryTokens = estimateTokens(compactedMessages)

  return {
    compacted: true,
    messages: compactedMessages,
    summaryTokens,
    originalTokens,
  }
}

// ── microCompact ────────────────────────────────────────────────────────────

export interface MicroCompactResult {
  compacted: boolean
  messages: OpenAIMessage[]
  tokensBefore: number
  tokensAfter: number
  toolsCleared: number
}

/**
 * Lightweight context reduction — clears old tool result content WITHOUT
 * calling the LLM. Replaces compactable tool results (Read, Grep, Glob,
 * Bash, Web*) that are older than KEEP_RECENT_TOOL_RESULTS with a placeholder.
 *
 * Inspired by Claude Code's microCompact. This is a first-line defense that
 * runs at 50% context pressure — much cheaper and faster than the full
 * LLM-summarization compact (maybeCompact) which runs at 85%.
 *
 * The tool results can be re-fetched by the LLM if needed (re-run Read/Grep/etc).
 * State-mutating tools (Write, Edit, Agent) are NOT cleared — their results
 * are small and meaningful.
 *
 * Mutates messages in place (like maybeCompact does).
 */
export function microCompact(messages: OpenAIMessage[]): MicroCompactResult {
  const tokensBefore = estimateTokens(messages)

  // Collect indices of compactable tool results, in order
  const toolResultIndices: number[] = []
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i]
    if (msg.role === 'tool' && msg.name && COMPACTABLE_TOOLS.has(msg.name)) {
      // Skip already-cleared results (idempotency)
      if (msg.content === CLEARED_PLACEHOLDER) continue
      toolResultIndices.push(i)
    }
  }

  // Nothing to compact
  if (toolResultIndices.length <= KEEP_RECENT_TOOL_RESULTS) {
    return { compacted: false, messages, tokensBefore, tokensAfter: tokensBefore, toolsCleared: 0 }
  }

  // Keep the N most recent, clear the rest
  const toClear = new Set(
    toolResultIndices.slice(0, toolResultIndices.length - KEEP_RECENT_TOOL_RESULTS),
  )

  let toolsCleared = 0
  for (const idx of toClear) {
    const msg = messages[idx]
    // Only clear if the content is substantial (don't bother for tiny results)
    if (typeof msg.content === 'string' && msg.content.length > CLEARED_PLACEHOLDER.length) {
      messages[idx] = { ...msg, content: CLEARED_PLACEHOLDER }
      toolsCleared++
    }
  }

  if (toolsCleared === 0) {
    return { compacted: false, messages, tokensBefore, tokensAfter: tokensBefore, toolsCleared: 0 }
  }

  const tokensAfter = estimateTokens(messages)
  return { compacted: true, messages, tokensBefore, tokensAfter, toolsCleared }
}

