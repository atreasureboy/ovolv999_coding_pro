/**
 * PipeRenderer — the --pipe output contract, enforced in one place.
 *
 * Promise: stdout carries the ANSWER and nothing else.
 *   - text mode: assistant tokens stream raw to stdout (no bullets, no
 *     ANSI, no banner); diagnostics go to stderr; chrome is suppressed.
 *   - json mode: even the answer is buffered (`responseText`); the caller
 *     emits one frozen envelope on stdout. sshRemote.ts consumes this
 *     contract, so the envelope keys live in pipeMode.formatPipeOutput
 *     and are pinned by tests/pipeMode.test.ts.
 *
 * Also home to the --pipe exit ladder helpers:
 *   pipeExitCodeFor — completed → 0, every other terminal status → 1
 *   isApiClassError — API/transport-class throws escalate to exit 2
 *   outcomeIsApiClassFailure — same escalation for API failures the
 *     engine SWALLOWS (the coordinator's circuit breaker maps a dead
 *     provider to a `failed` TurnOutcome instead of throwing; without
 *     this, a 401 would exit 1 and be indistinguishable from a task
 *     that ran and failed)
 */

import { Renderer } from './renderer.js'
import type { CompletionStatus, TurnOutcome } from '../core/runtime/turnOutcome.js'

export class PipeRenderer extends Renderer {
  private readonly format: 'text' | 'json'
  private chunks: string[] = []

  constructor(opts: { format?: 'text' | 'json' } = {}) {
    // Diagnostics stream to stderr so stdout stays answer-only even for
    // the inherited methods (tool progress, agent heartbeats, compaction
    // notices) that this class does not override.
    super({ stream: process.stderr })
    this.format = opts.format ?? 'text'
  }

  /** Everything the model said this turn, in arrival order. */
  get responseText(): string {
    return this.chunks.join('')
  }

  // ── answer → stdout ─────────────────────────────────────────────

  override streamToken(token: string): void {
    this.chunks.push(token)
    if (this.format === 'text') process.stdout.write(token)
  }

  // ── diagnostics → stderr (plain, undecorated) ───────────────────

  override info(msg: string): void { process.stderr.write(`${msg}\n`) }
  override success(msg: string): void { process.stderr.write(`${msg}\n`) }
  override error(msg: string): void { process.stderr.write(`${msg}\n`) }
  override warn(msg: string): void {
    if (msg.trim()) process.stderr.write(`${msg}\n`)
  }

  // ── chrome suppressed entirely ──────────────────────────────────

  override banner(_version: string, _model: string): void {}
  override humanPrompt(_text: string): void {}
  override beginAssistantText(): void {}
  override endAssistantText(): void {}
  override streamReasoning(_token: string): void {}
  override startSpinner(_verb?: string): void {}
  override stopSpinner(): void {}
  override writePrompt(): string { return '' }
  override closePrompt(_text?: string, _replaceReadline = false): void {}
  override newline(): void {}
}

/**
 * The --pipe exit ladder. completed → 0; partial / blocked / exhausted /
 * cancelled / failed → 1 (with a one-line status on stderr from the CLI).
 * API/transport-class THROWS escalate to 2 at the call site.
 */
export function pipeExitCodeFor(status: CompletionStatus): 0 | 1 {
  return status === 'completed' ? 0 : 1
}

/**
 * Classify a thrown error as API/transport-class (→ exit 2) vs local
 * logic error (→ exit 1). Recognizes OpenAI SDK errors (numeric `status`),
 * Node network error codes, and common timeout/connection message shapes.
 */
export function isApiClassError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false
  const e = err as { status?: unknown; code?: unknown; message?: unknown }
  if (typeof e.status === 'number') return true
  if (typeof e.code === 'string' &&
    /^E(CONNREFUSED|CONNRESET|TIMEDOUT|AI_AGAIN|HOSTUNREACH|NETUNREACH|PIPE|SOCKET)$/.test(e.code)) {
    return true
  }
  const msg = typeof e.message === 'string' ? e.message.toLowerCase() : ''
  return /(timed? ?out|timeout|connection (refused|reset|closed)|econnrefused|econnreset|invalid api key|incorrect api key|\b(401|403|408|429|500|502|503|504)\b)/.test(msg)
}

/**
 * Attempt statuses that mean "the provider rejected/constrained the request"
 * — a failed EXCHANGE, not a failed task. A generic 'failed' attempt is
 * only API-class when its error string is (aborts and logic errors also
 * land as 'failed').
 */
const API_CLASS_ATTEMPT_STATUSES = new Set([
  'rate_limited', 'timed_out', 'unavailable', 'invalid_request', 'context_limit', 'unsupported',
])

/**
 * Exit-2 classifier for API failures the engine absorbed into a terminal
 * outcome (coordinator.ts catches gateway errors and maps them to a
 * `failed` TurnOutcome — nothing is thrown to the CLI). True only when
 * the turn never got a single successful model call AND the last attempt
 * shows an API/transport-class cause. A turn where the model DID respond
 * and then the task failed is task-level (exit 1).
 */
export function outcomeIsApiClassFailure(
  outcome: Pick<TurnOutcome, 'completion' | 'modelAttempts'>,
): boolean {
  if (outcome.completion.status === 'completed') return false
  const attempts = outcome.modelAttempts ?? []
  if (attempts.length === 0) return false
  if (attempts.some((a) => a.status === 'succeeded')) return false
  const last = attempts[attempts.length - 1]
  return API_CLASS_ATTEMPT_STATUSES.has(last.status) || isApiClassError(new Error(last.error ?? ''))
}
