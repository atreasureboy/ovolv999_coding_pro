/**
 * Critic system prompt — runs every N iterations to review recent
 * conversation history for common failure modes and inject corrections.
 *
 * Extracted from engine.ts so the prompt is domain-specific and can be
 * swapped without touching the engine loop.
 */

import type { OpenAIMessage } from '../core/types.js'

// ── Critic configuration ──────────────────────────────────────────────

/** Run critic every N iterations (only when there are enough messages to review) */
export const CRITIC_INTERVAL = 5
/** Don't bother before this many iterations */
export const CRITIC_MIN_ITERATIONS = 4
/** How many recent messages to feed the critic */
export const CRITIC_CONTEXT_MESSAGES = 24
/** Max tokens the critic can produce */
export const CRITIC_MAX_TOKENS = 400

// ── Default critic prompt (domain-neutral) ──────────────────────────

export const DEFAULT_CRITIC_SYSTEM_PROMPT = `You are a critical supervision agent for a coding session.
You only read the action history — you do not execute anything. Your job is to spot common mistakes and give brief corrections:

1. **Goal drift** — executing operations outside the user's stated scope
2. **Duplicate work** — repeating an already-completed operation
3. **Tool misuse** — using the wrong tool (e.g. Read to run a command, Bash to read a large file)
4. **Ignored errors** — tool returned an error but was not handled or retried
5. **Missing context** — sub-agent delegation without sufficient context
6. **Output bloat** — producing large amounts of meaningless text

Output rules:
- Found issues: use "[ISSUE] {description}" + "[FIX] {specific action}" format, max 3 items
- No issues: output only "OK"
- No role explanation, no filler — direct conclusions only`

// ── Formatting helpers ────────────────────────────────────────────────

/**
 * Serialize recent messages into a compact text format for the critic.
 * Truncates long fields to keep the critic prompt within budget.
 */
export function formatMessagesForCritic(messages: OpenAIMessage[]): string {
  return messages
    .map((m) => {
      if (m.role === 'assistant') {
        const toolCalls = (m as { tool_calls?: Array<{ function: { name: string; arguments: string } }> }).tool_calls
        if (toolCalls && toolCalls.length > 0) {
          const calls = toolCalls
            .map((tc) => {
              let args: Record<string, unknown>
              try { args = JSON.parse(tc.function.arguments) as Record<string, unknown> } catch { args = {} }
              const truncated = Object.fromEntries(
                Object.entries(args).map(([k, v]) => [
                  k,
                  typeof v === 'string' && v.length > 300 ? v.slice(0, 300) + '...' : v,
                ]),
              )
              return `  [TOOL_CALL] ${tc.function.name}(${JSON.stringify(truncated)})`
            })
            .join('\n')
          const text = typeof m.content === 'string' && m.content ? `  ${m.content}\n` : ''
          return `[ASSISTANT]\n${text}${calls}`
        }
        return typeof m.content === 'string' ? `[ASSISTANT] ${m.content}` : '[ASSISTANT]'
      }
      if (m.role === 'tool') {
        const content = typeof m.content === 'string' ? m.content.slice(0, 800) : ''
        const name = (m as { name?: string }).name ?? 'tool'
        return `[TOOL_RESULT:${name}] ${content}${content.length >= 800 ? '...' : ''}`
      }
      if (m.role === 'user') {
        const content = typeof m.content === 'string' ? m.content.slice(0, 400) : ''
        return `[USER] ${content}`
      }
      return ''
    })
    .filter(Boolean)
    .join('\n')
}

/**
 * Parse the critic's response. Returns null if the critic found no issues,
 * or the correction string if it did.
 */
export function parseCriticOutput(output: string): string | null {
  const trimmed = output
    .replace(/<think\b[^>]*>[\s\S]*?<\/think>/gi, '')
    .replace(/<think\b[^>]*>[\s\S]*$/gi, '')
    .trim()
  if (!trimmed || /^ok[.!]?$/i.test(trimmed)) return null
  const lines = trimmed
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => /^\[(?:ISSUE|FIX)\]\s+\S/i.test(line))
    .slice(0, 6)
  return lines.length > 0 ? lines.join('\n') : null
}
