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

// Rough chars-per-token estimate (conservative — better to compact early)
const CHARS_PER_TOKEN = 3.5

// Model max context window (tokens). Matches claude-sonnet-4-x 200k context.
// Sub-agents inherit the same model so one constant is sufficient here.
export const MODEL_MAX_CONTEXT_TOKENS = 200_000

// Percentage-based thresholds — the single source of truth for context pressure
const CONTEXT_WARN_PCT    = 0.70   // 70%  → display yellow warning
const CONTEXT_COMPACT_PCT = 0.85   // 85%  → force auto-compact (LLM summarization)

// microCompact — lightweight pre-compact that clears old tool results WITHOUT
// an LLM call. Runs at a lower threshold than full compact, buying headroom
// cheaply. Inspired by Claude Code's microCompact.
const CONTEXT_MICROCOMPACT_PCT = 0.50  // 50%  → clear old tool results
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
 * Rough token count estimate from message array.
 * Counts all content strings + JSON overhead.
 */
export function estimateTokens(messages: OpenAIMessage[]): number {
  let chars = 0
  for (const msg of messages) {
    if (typeof msg.content === 'string') {
      chars += msg.content.length
    } else if (msg.content === null) {
      chars += 4
    }
    if (msg.tool_calls) {
      chars += JSON.stringify(msg.tool_calls).length
    }
    if (msg.name) chars += msg.name.length
    chars += 20 // message envelope overhead
  }
  return Math.ceil(chars / CHARS_PER_TOKEN)
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

