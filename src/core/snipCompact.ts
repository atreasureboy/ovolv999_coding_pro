/**
 * Snip Compact Strategy
 *
 * Complements {@link microCompact} in compact.ts. While microCompact replaces
 * entire old tool results with a placeholder, snipCompact performs surgical
 * trims on OVERSIZED individual messages:
 *
 *   1. Truncate long tool results to head+tail (keeps the start and end,
 *      drops the middle). Useful when a single Read returned 50k tokens.
 *   2. Drop empty / whitespace-only messages.
 *   3. Collapse consecutive duplicate user messages.
 *   4. Strip "thinking" content from old assistant turns (keep only the
 *      final text reply).
 *   5. Drop redundant system reminders in old messages.
 *
 * Snip is a second-line defense, run BETWEEN microCompact (50% pressure)
 * and the full LLM summarization (85% pressure). It's pure / deterministic
 * / free.
 */

import type { OpenAIMessage } from './types.js'
import { estimateTextTokens, estimateTokens } from './compact.js'

// ── Constants ───────────────────────────────────────────────────────────────

/** Tool results longer than this (in chars) get head/tail-trimmed. */
export const SNIP_TOOL_RESULT_MAX_CHARS = 4_000

/** Head kept when snipping (chars). */
export const SNIP_HEAD_CHARS = 1_500

/** Tail kept when snipping (chars). */
export const SNIP_TAIL_CHARS = 1_500

/** Messages newer than this index offset are never snipped. */
export const SNIP_KEEP_RECENT = 6

/** Minimum saving (chars) required to actually snip a message. */
export const SNIP_MIN_SAVINGS_CHARS = 200

// ── Types ───────────────────────────────────────────────────────────────────

export interface SnipResult {
  snipped: boolean
  messages: OpenAIMessage[]
  tokensBefore: number
  tokensAfter: number
  messagesTrimmed: number
  messagesDropped: number
  thinkingStripped: number
  charsSaved: number
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function isWhitespace(s: unknown): boolean {
  return typeof s === 'string' && s.trim().length === 0
}

function headTailTruncate(text: string, maxChars: number, head: number, tail: number): string {
  if (text.length <= maxChars) return text
  const saved = text.length - (head + tail)
  if (saved < SNIP_MIN_SAVINGS_CHARS) return text
  const omitted = text.length - head - tail
  return (
    text.slice(0, head)
    + `\n\n[…snip: ${omitted} chars omitted…]\n\n`
    + text.slice(-tail)
  )
}

// ── Snip Passes ─────────────────────────────────────────────────────────────

/**
 * Truncate oversized tool results to head+tail.
 */
function snipToolResults(
  messages: OpenAIMessage[],
  protectedRange: number,
): { trimmed: number; charsSaved: number } {
  let trimmed = 0
  let charsSaved = 0

  for (let i = 0; i < messages.length - protectedRange; i++) {
    const msg = messages[i]
    if (msg.role !== 'tool') continue
    if (typeof msg.content !== 'string') continue

    const original = msg.content
    if (original.length <= SNIP_TOOL_RESULT_MAX_CHARS) continue

    const snipped = headTailTruncate(
      original,
      SNIP_TOOL_RESULT_MAX_CHARS,
      SNIP_HEAD_CHARS,
      SNIP_TAIL_CHARS,
    )

    if (snipped !== original) {
      messages[i] = { ...msg, content: snipped }
      trimmed++
      charsSaved += original.length - snipped.length
    }
  }

  return { trimmed, charsSaved }
}

/**
 * Drop empty / whitespace-only messages, EXCEPT we never drop the last
 * user message (the active prompt) or any system message.
 */
function dropEmptyMessages(
  messages: OpenAIMessage[],
  protectedRange: number,
): number {
  const original = messages.length
  for (let i = messages.length - 1 - protectedRange; i >= 0; i--) {
    const msg = messages[i]
    if (msg.role === 'system') continue
    if (isWhitespace(msg.content)) {
      messages.splice(i, 1)
    } else if (Array.isArray(msg.content)) {
      const allEmpty = msg.content.every(
        (p) => typeof p === 'object' && p !== null && 'text' in p && isWhitespace((p as { text: string }).text),
      )
      if (allEmpty && msg.content.length > 0) {
        messages.splice(i, 1)
      }
    }
  }
  return original - messages.length
}

/**
 * Collapse consecutive duplicate user messages (keep the latest).
 */
function collapseDuplicateUsers(
  messages: OpenAIMessage[],
  protectedRange: number,
): number {
  let dropped = 0
  for (let i = messages.length - 2 - protectedRange; i >= 0; i--) {
    const cur = messages[i]
    const next = messages[i + 1]
    if (cur.role !== 'user' || next.role !== 'user') continue
    if (cur.content === next.content) {
      messages.splice(i, 1)
      dropped++
    }
  }
  return dropped
}

/**
 * Strip "thinking" content parts from old assistant turns (older than
 * the protected range). Modern APIs return thinking blocks separately,
 * but some transports inline them as text. We strip both.
 */
function stripOldThinking(
  messages: OpenAIMessage[],
  protectedRange: number,
): number {
  let stripped = 0

  for (let i = 0; i < messages.length - protectedRange; i++) {
    const msg = messages[i]
    if (msg.role !== 'assistant') continue
    if (!Array.isArray(msg.content)) continue

    const filtered = msg.content.filter((part) => {
      if (typeof part !== 'object' || part === null) return true
      // ContentPart only declares text|image_url, but real transports may
      // emit a 'thinking' type — read type as unknown to bypass the narrow.
      const raw = part as unknown as Record<string, unknown>
      if (raw.type === 'thinking') {
        stripped++
        return false
      }
      // Drop text parts that look like captured thinking
      if (typeof raw.text === 'string') {
        const t = raw.text.trim()
        if (t.startsWith('<thinking>') && t.endsWith('</thinking>')) {
          stripped++
          return false
        }
        if (t.startsWith('Let me think') && t.length < 200) {
          stripped++
          return false
        }
      }
      return true
    })

    if (filtered.length !== msg.content.length) {
      // Don't leave an empty assistant message
      if (filtered.length === 0) {
        messages[i] = { ...msg, content: '[thinking stripped]' }
      } else {
        messages[i] = { ...msg, content: filtered }
      }
    }
  }

  return stripped
}

// ── Main Entry ──────────────────────────────────────────────────────────────

/**
 * Run all snip passes on a message array.
 *
 * Mutates messages in place (consistent with microCompact / maybeCompact).
 * Pass `protectRecent` to override how many trailing messages are immune.
 */
export function snipCompact(
  messages: OpenAIMessage[],
  protectRecent: number = SNIP_KEEP_RECENT,
): SnipResult {
  const tokensBefore = estimateTokens(messages)
  const working = [...messages]

  // Pass 1: strip old thinking blocks (cheapest, most common win)
  const thinkingStripped = stripOldThinking(working, protectRecent)

  // Pass 2: truncate oversized tool results
  const { trimmed, charsSaved } = snipToolResults(working, protectRecent)

  // Pass 3: drop empty messages
  const messagesDropped = dropEmptyMessages(working, protectRecent)

  // Pass 4: collapse consecutive duplicate user prompts
  const duplicatesDropped = collapseDuplicateUsers(working, protectRecent)
  const totalDropped = messagesDropped + duplicatesDropped

  const tokensAfter = estimateTokens(working)
  const totalCharsSaved =
    charsSaved
    + thinkingStripped * 100 // rough estimate
    + totalDropped * 50

  const snipped =
    trimmed > 0 || totalDropped > 0 || thinkingStripped > 0

  return {
    snipped,
    messages: working,
    tokensBefore,
    tokensAfter,
    messagesTrimmed: trimmed,
    messagesDropped: totalDropped,
    thinkingStripped,
    charsSaved: totalCharsSaved,
  }
}

/**
 * Snip a single string to head+tail with a marker.
 * Exported for ad-hoc use (e.g. before sending to LLM).
 */
export function snipString(text: string, maxChars = SNIP_TOOL_RESULT_MAX_CHARS): string {
  return headTailTruncate(text, maxChars, SNIP_HEAD_CHARS, SNIP_TAIL_CHARS)
}

/**
 * Estimate how many tokens snipCompact would recover without running it.
 * Useful for deciding whether snip is worth doing.
 */
export function estimateSnipSavings(messages: OpenAIMessage[]): number {
  let savings = 0
  const cutoff = messages.length - SNIP_KEEP_RECENT

  for (let i = 0; i < cutoff; i++) {
    const msg = messages[i]

    // Oversized tool results
    if (msg.role === 'tool' && typeof msg.content === 'string') {
      if (msg.content.length > SNIP_TOOL_RESULT_MAX_CHARS) {
        const recovered = msg.content.length - SNIP_TOOL_RESULT_MAX_CHARS - 50
        if (recovered > SNIP_MIN_SAVINGS_CHARS) {
          savings += estimateTextTokens(' '.repeat(recovered))
        }
      }
    }

    // Thinking blocks
    if (msg.role === 'assistant' && Array.isArray(msg.content)) {
      for (const part of msg.content) {
        if (typeof part === 'object' && part !== null && 'type' in part) {
          if ((part as { type: string }).type === 'thinking') {
            const text = 'text' in part ? String((part as { text: unknown }).text) : ''
            savings += estimateTextTokens(text)
          }
        }
      }
    }

    // Empty messages
    if (msg.role !== 'system' && isWhitespace(msg.content)) {
      savings += 4 // baseline overhead per message
    }
  }

  return savings
}

// ── Formatting ──────────────────────────────────────────────────────────────

export function formatSnipResult(result: SnipResult): string {
  if (!result.snipped) return 'Snip: nothing to trim.'
  const lines = ['Snip results:']
  if (result.messagesTrimmed > 0) lines.push(`  Trimmed ${result.messagesTrimmed} oversized message(s)`)
  if (result.messagesDropped > 0) lines.push(`  Dropped ${result.messagesDropped} empty/duplicate message(s)`)
  if (result.thinkingStripped > 0) lines.push(`  Stripped ${result.thinkingStripped} thinking block(s)`)
  lines.push(`  Tokens: ${result.tokensBefore} → ${result.tokensAfter} (saved ${result.tokensBefore - result.tokensAfter})`)
  lines.push(`  Chars saved: ~${result.charsSaved}`)
  return lines.join('\n')
}
