/**
 * Session title generation (opencode-style).
 *
 * Two layers:
 *   - deriveFallbackTitle: pure heuristic from the conversation — the
 *     first user message, cleaned and truncated. Always available.
 *   - buildTitlePrompt: the one-shot completion prompt used by /title to
 *     ask the active model for a concise title (the REPL performs the
 *     actual client call and falls back to the heuristic on any error).
 */

import type { OpenAIMessage } from './types.js'

export const TITLE_FALLBACK_MAX_LENGTH = 60

/**
 * Heuristic title: first user message, whitespace-collapsed and trimmed
 * to TITLE_FALLBACK_MAX_LENGTH chars. Returns '' when the conversation
 * has no user message yet (caller decides whether to persist).
 */
export function deriveFallbackTitle(history: OpenAIMessage[]): string {
  const firstUser = history.find((m) => m.role === 'user')
  if (!firstUser || typeof firstUser.content !== 'string') return ''
  const cleaned = firstUser.content.trim().replaceAll(/\s+/g, ' ')
  if (!cleaned) return ''
  return cleaned.length > TITLE_FALLBACK_MAX_LENGTH
    ? cleaned.slice(0, TITLE_FALLBACK_MAX_LENGTH - 1) + '…'
    : cleaned
}

/**
 * Build the one-shot title request. Only the first user/assistant text
 * messages are included (tool chatter is noise for titling), bounded so
 * the request stays cheap regardless of session size.
 */
export function buildTitlePrompt(history: OpenAIMessage[]): string {
  const relevant: string[] = []
  for (const m of history) {
    if (relevant.length >= 6) break
    if (m.role !== 'user' && m.role !== 'assistant') continue
    if (typeof m.content !== 'string') continue
    const t = m.content.trim()
    if (!t) continue
    relevant.push(`${m.role === 'user' ? 'User' : 'Assistant'}: ${t.slice(0, 800)}`)
  }
  const transcript = relevant.length > 0 ? relevant.join('\n\n') : '(empty session)'
  return [
    'Generate a concise title (at most 8 words, no quotes, no trailing punctuation) for this coding session.',
    'Reply with ONLY the title text.',
    '',
    transcript,
  ].join('\n')
}

/** Sanitize a model-generated title before persisting. */
export function cleanGeneratedTitle(raw: string): string {
  return raw
    .trim()
    .replace(/^["'`]+|["'`]+$/g, '')
    .replace(/^Title:\s*/i, '')
    .trim()
}
