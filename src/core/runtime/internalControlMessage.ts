/**
 * InternalControlMessage (v0.3.1, te_goal §七).
 *
 * Runtime control signals that must NOT be conflated with the user's
 * conversation history. Today the codebase uses free-form
 * `{ role: 'system', content: '[runtime] ...' }` strings which
 * permanently pollute the user-visible transcript and context
 * compaction. This module gives the runtime a typed channel:
 *
 *   - kinds: continue_after_length, retry_empty_response, budget_warning,
 *     stall_replan, critic_feedback, tool_recovery, completion_rejected,
 *     provider_fallback
 *   - log: append / drain / renderForProvider (NOT persisted in long-
 *     term memory; not exposed as user messages; not exported)
 *   - renderInternalControlMessage: produce a single OpenAIMessage
 *     that can be sent to the provider for this turn, then dropped
 *
 * Compaction policy: only `budget_warning` and `completion_rejected`
 * are kept across compaction (they describe the run state); the
 * rest are re-derived from runtime state on each turn.
 */
import type { OpenAIMessage } from '../types.js'

export type InternalControlMessage =
  | { kind: 'continue_after_length'; remainingTokens: number; partialLength: number }
  | { kind: 'retry_empty_response'; retryCount: number; max: number }
  | { kind: 'budget_warning'; remainingPct: number }
  | { kind: 'stall_replan'; level: 'soft' | 'hard'; reason: string }
  | { kind: 'critic_feedback'; verdict: string; problems: string[] }
  | { kind: 'tool_recovery'; tool: string; error: string }
  | { kind: 'completion_rejected'; verdict: string; blockers: string[] }
  | { kind: 'provider_fallback'; from: string; to: string; reason: string }

const KEEP_ACROSS_COMPACTION: ReadonlySet<InternalControlMessage['kind']> = new Set([
  'budget_warning',
  'completion_rejected',
])

export class ControlMessageLog {
  private readonly buffer: InternalControlMessage[] = []

  append(msg: InternalControlMessage): void {
    this.buffer.push(msg)
  }

  /** Drain returns ALL messages and clears the buffer. */
  drain(): InternalControlMessage[] {
    const out = this.buffer.splice(0, this.buffer.length)
    return out
  }

  /** Peek without draining. Used by /progress and /why. */
  peek(): readonly InternalControlMessage[] {
    return [...this.buffer]
  }

  size(): number {
    return this.buffer.length
  }

  /**
   * Render a snapshot of the log as OpenAIMessages suitable for sending
   * to the provider this turn. Does NOT drain — caller can decide.
   * The returned messages are wrapped with a clear `[runtime control]`
   * prefix so the model can distinguish them from user input.
   */
  renderForProvider(): OpenAIMessage[] {
    return this.buffer.map(renderInternalControlMessage)
  }

  /**
   * Apply compaction: drop everything except kinds we keep across
   * compaction (budget_warning, completion_rejected). Returns the
   * number of dropped messages.
   */
  compact(): number {
    const before = this.buffer.length
    const kept = this.buffer.filter((m) => KEEP_ACROSS_COMPACTION.has(m.kind))
    this.buffer.length = 0
    this.buffer.push(...kept)
    return before - kept.length
  }

  /** Clear the log without rendering. */
  clear(): void {
    this.buffer.length = 0
  }
}

export function renderInternalControlMessage(msg: InternalControlMessage): OpenAIMessage {
  return { role: 'system', content: formatControlMessage(msg) }
}

export function formatControlMessage(msg: InternalControlMessage): string {
  switch (msg.kind) {
    case 'continue_after_length':
      return `[runtime control · continue_after_length] ${msg.partialLength} chars were cut. Continue without repeating. Remaining budget: ${msg.remainingTokens} tokens.`
    case 'retry_empty_response':
      return `[runtime control · retry_empty_response] Your previous response was empty. Retry ${msg.retryCount}/${msg.max}: respond with text or invoke a tool.`
    case 'budget_warning':
      return `[runtime control · budget_warning] ${Math.round(msg.remainingPct * 100)}% of budget remains. Prioritise the core acceptance criteria.`
    case 'stall_replan':
      return `[runtime control · stall_replan · ${msg.level}] ${msg.reason}. Stop the current line of attack; change approach.`
    case 'critic_feedback':
      return `[runtime control · critic_feedback · ${msg.verdict}] ${msg.problems.join('; ')}`
    case 'tool_recovery':
      return `[runtime control · tool_recovery] ${msg.tool} failed: ${msg.error}. Diagnose the root cause before retrying with different args.`
    case 'completion_rejected':
      return `[runtime control · completion_rejected · ${msg.verdict}] ${msg.blockers.join('; ')}`
    case 'provider_fallback':
      return `[runtime control · provider_fallback] Switched from ${msg.from} to ${msg.to} (${msg.reason}). Tools executed before the switch remain — do not re-run them.`
  }
}

export function isControlMessage(msg: OpenAIMessage): boolean {
  if (msg.role !== 'system') return false
  const content = typeof msg.content === 'string' ? msg.content : ''
  return content.startsWith('[runtime control')
}