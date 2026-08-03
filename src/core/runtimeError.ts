/**
 * RuntimeErrorInfo (v0.5.2, Stage 4) — unified error contract.
 *
 * Before this module existed, each subsystem invented its own error
 * shape:
 *   - permission denies used `PermissionResult { allow, reason }`
 *   - tool failures used `ToolResult { isError, content }`
 *   - provider failures used `Error.message` (string-sniffed downstream)
 *   - daemon IPC used `{ ok: false, error: string }`
 *   - worker failures used `WorkerResult { status: 'failed', ... }`
 *   - verification failures used `ReviewerFinding { severity }`
 *
 * Cross-cutting consumers (UI error card, `/trace`, retry classifier)
 * could not reliably tell which subsystem produced the failure
 * because the surfaces were different.
 *
 * This module defines a single shape. Subsystems MAY expose their own
 * shape AND a `toRuntimeErrorInfo()` mapper. Callers that want to
 * classify / retry / trace uniformly use this shape and the
 * `categorize*` helpers — no more string-prefix sniffing.
 */

export type RuntimeSubsystem =
  | 'permission'
  | 'hook'
  | 'tool'
  | 'provider'
  | 'daemon'
  | 'worker'
  | 'verification'
  | 'memory'
  | 'routing'
  | 'context'
  | 'taskGraph'
  | 'unknown'

export interface RuntimeErrorInfo {
  /** Stable machine-readable code. Examples:
   *  - 'permission.denied_by_rule'
   *  - 'permission.denied_by_mode'
   *  - 'hook.denied_by_user'
   *  - 'hook.timeout'
   *  - 'tool.execution_failed'
   *  - 'tool.argument_invalid'
   *  - 'provider.unauthorized'
   *  - 'provider.rate_limited'
   *  - 'provider.server_error'
   *  - 'provider.timeout'
   *  - 'provider.circuit_open'
   *  - 'daemon.ipc_failed'
   *  - 'worker.terminated'
   *  - 'worker.lost'
   *  - 'verification.failed'
   *  - 'memory.commit_required'
   *  - 'memory.verification_required'
   *  - 'routing.chain_exhausted'
   *  - 'context.compact_failed'
   *  - 'taskGraph.cycle_detected'
   *  - 'unknown'
   */
  code: string
  subsystem: RuntimeSubsystem
  /** Pipeline phase where the error fired (e.g. 'boot', 'llm', 'tool_execution'). */
  phase?: string
  /** Human-readable message for the user / UI. */
  message: string
  /** True when retrying might succeed (network glitch, transient 5xx). */
  retryable: boolean
  /** Optional original cause (string representation). */
  cause?: string
  /** Optional run correlation. */
  runId?: string
  /** Optional tool correlation. */
  toolCallId?: string
  /** When the error happened (ms epoch). */
  at: number
}

/**
 * Build a RuntimeErrorInfo with sensible defaults. The only required
 * fields are `code` and `subsystem`; everything else is inferred.
 */
export function makeRuntimeError(
  code: string,
  subsystem: RuntimeSubsystem,
  message: string,
  opts: Partial<Omit<RuntimeErrorInfo, 'code' | 'subsystem' | 'message' | 'at'>> = {},
): RuntimeErrorInfo {
  return {
    code,
    subsystem,
    message,
    retryable: opts.retryable ?? false,
    cause: opts.cause,
    runId: opts.runId,
    toolCallId: opts.toolCallId,
    phase: opts.phase,
    at: Date.now(),
  }
}

/**
 * Extract a stable code from a raw error message. Used by callers that
 * don't yet have a typed RuntimeErrorInfo but need to categorize. The
 * regexes match a small set of well-known provider error strings and
 * fall back to 'unknown' for anything not recognized — string-prefix
 * sniffing is now confined to this helper.
 */
export function categorizeProviderError(err: unknown): string {
  const e = err as { name?: string; message?: string; code?: string; status?: number }
  const msg = (e?.message ?? '').toLowerCase()
  const code = e?.code
  const status = e?.status
  if (code === 'ECONNRESET' || msg.includes('econnreset')) return 'provider.connection_reset'
  if (code === 'ETIMEDOUT' || msg.includes('timeout') || msg.includes('timed out')) return 'provider.timeout'
  if (code === 'ENOTFOUND' || msg.includes('getaddrinfo') || msg.includes('enotfound')) return 'provider.dns_failure'
  if (status === 401 || msg.includes('unauthorized') || msg.includes('invalid api key')) return 'provider.unauthorized'
  if (status === 403 || msg.includes('forbidden')) return 'provider.forbidden'
  if (status === 404 || msg.includes('model not found')) return 'provider.model_not_found'
  if (status === 429 || msg.includes('rate limit') || msg.includes('rate_limit')) return 'provider.rate_limited'
  if (status && status >= 500 && status < 600) return 'provider.server_error'
  if (status && status >= 400 && status < 500) return 'provider.client_error'
  if (code === 'circuit_open' || msg.includes('circuit breaker open')) return 'provider.circuit_open'
  return 'unknown'
}

export function isProviderRetryable(err: unknown): boolean {
  const code = categorizeProviderError(err)
  return [
    'provider.connection_reset',
    'provider.timeout',
    'provider.rate_limited',
    'provider.server_error',
    'provider.dns_failure',
  ].includes(code)
}