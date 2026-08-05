/**
 * RetryManager (v0.6.0) — exponential backoff with jitter for transient
 * API/provider failures.
 *
 * Inspired by Codex's retry policy and standard resilience patterns
 * (resilience4j-style). Key properties:
 *
 *   - Exponential backoff: base * 2^attempt with full jitter
 *     (randomized within [0, backoff]) to avoid thundering herd
 *   - Retryable classification: 429, 5xx, network errors, timeouts;
 *     NOT retryable: 4xx auth, 400 invalid request, 404 model not found
 *   - Retry-After header honored when present
 *   - Max attempts + total deadline (wall-clock) caps
 *   - Circuit breaker: after N consecutive failures, fail fast for a
 *     cooldown window; half-open probe after cooldown
 *   - Event hooks for observability (attempt, success, giveUp, open, halfOpen, close)
 */

// ── Types ───────────────────────────────────────────────────────────────────

export type RetryableError = Error & { status?: number; code?: string }

export interface RetryOptions {
  maxAttempts?: number
  baseDelayMs?: number
  maxDelayMs?: number
  /** Total wall-clock budget in ms (default 60s). */
  deadlineMs?: number
  /** Custom classification of retryable errors. */
  isRetryable?: (err: unknown) => boolean
}

export interface RetryEvent {
  type: 'attempt' | 'success' | 'giveUp' | 'open' | 'halfOpen' | 'close'
  attempt?: number
  error?: unknown
  delayMs?: number
  elapsedMs?: number
}

export type RetryResult<T> =
  | { ok: true; value: T; attempts: number; totalElapsedMs: number }
  | { ok: false; error: unknown; attempts: number; totalElapsedMs: number }

export interface CircuitState {
  state: 'closed' | 'open' | 'half-open'
  consecutiveFailures: number
  failureThreshold: number
  cooldownMs: number
  openedAt?: number
  nextProbeAt?: number
}

// ── Defaults ────────────────────────────────────────────────────────────────

const DEFAULT_MAX_ATTEMPTS = 4
const DEFAULT_BASE_DELAY = 500
const DEFAULT_MAX_DELAY = 15_000
const DEFAULT_DEADLINE = 60_000
const DEFAULT_FAILURE_THRESHOLD = 3
const DEFAULT_COOLDOWN = 30_000

// ── Classification ──────────────────────────────────────────────────────────

export function isRetryableError(err: unknown): boolean {
  if (!err) return false
  const e = err as RetryableError
  const status = e.status
  const code = e.code
  const msg = (e.message ?? '').toLowerCase()

  if (status !== undefined) {
    if (status === 429 || status === 408 || (status >= 500 && status <= 599)) return true
    if (status >= 400 && status < 500) return false
  }
  if (code === 'ECONNRESET' || code === 'ECONNREFUSED' || code === 'ENOTFOUND' || code === 'ETIMEDOUT' || code === 'EAI_AGAIN') return true
  if (code === 'UND_ERR_CONNECT_TIMEOUT' || code === 'UND_ERR_SOCKET') return true
  if (/rate.?limit|timeout|temporarily unavailable|overloaded|busy|try again later|internal server error|bad gateway|service unavailable/.test(msg)) return true
  return false
}

/** Extract Retry-After seconds from an error's headers if present. */
function retryAfterMs(err: unknown): number | null {
  const e = err as RetryableError & { headers?: Record<string, string> }
  const h = e.headers?.['retry-after']
  if (!h) return null
  const secs = Number(h)
  if (!Number.isNaN(secs)) return secs * 1000
  const date = Date.parse(h)
  if (!Number.isNaN(date)) return Math.max(0, date - Date.now())
  return null
}

// ── Circuit breaker ─────────────────────────────────────────────────────────

export class CircuitBreaker {
  private state: CircuitState = {
    state: 'closed',
    consecutiveFailures: 0,
    failureThreshold: DEFAULT_FAILURE_THRESHOLD,
    cooldownMs: DEFAULT_COOLDOWN,
  }

  constructor(opts: { failureThreshold?: number; cooldownMs?: number } = {}) {
    if (opts.failureThreshold) this.state.failureThreshold = opts.failureThreshold
    if (opts.cooldownMs) this.state.cooldownMs = opts.cooldownMs
  }

  get currentState(): CircuitState {
    // Lazy transition: if open and cooldown elapsed, move to half-open.
    if (this.state.state === 'open' && this.state.nextProbeAt && Date.now() >= this.state.nextProbeAt) {
      this.state.state = 'half-open'
    }
    return { ...this.state }
  }

  /** Can we attempt a call right now? */
  allowRequest(): boolean {
    const s = this.currentState
    return s.state !== 'open'
  }

  /** Record a success (closes circuit). */
  recordSuccess(): void {
    this.state.consecutiveFailures = 0
    if (this.state.state === 'half-open' || this.state.state === 'open') {
      this.state.state = 'closed'
    }
  }

  /** Record a failure (may open circuit). */
  recordFailure(): void {
    this.state.consecutiveFailures++
    if (this.state.consecutiveFailures >= this.state.failureThreshold && this.state.state === 'closed') {
      this.state.state = 'open'
      this.state.openedAt = Date.now()
      this.state.nextProbeAt = Date.now() + this.state.cooldownMs
    }
  }

  reset(): void {
    this.state = {
      state: 'closed',
      consecutiveFailures: 0,
      failureThreshold: this.state.failureThreshold,
      cooldownMs: this.state.cooldownMs,
    }
  }
}

// ── Retry runner ────────────────────────────────────────────────────────────

export class RetryManager {
  private readonly options: Required<Pick<RetryOptions, 'maxAttempts' | 'baseDelayMs' | 'maxDelayMs' | 'deadlineMs'>>
  private readonly isRetryable: (err: unknown) => boolean
  private readonly events: Array<(e: RetryEvent) => void> = []
  readonly circuit: CircuitBreaker

  constructor(opts: RetryOptions = {}) {
    this.options = {
      maxAttempts: opts.maxAttempts ?? DEFAULT_MAX_ATTEMPTS,
      baseDelayMs: opts.baseDelayMs ?? DEFAULT_BASE_DELAY,
      maxDelayMs: opts.maxDelayMs ?? DEFAULT_MAX_DELAY,
      deadlineMs: opts.deadlineMs ?? DEFAULT_DEADLINE,
    }
    this.isRetryable = opts.isRetryable ?? isRetryableError
    this.circuit = new CircuitBreaker()
  }

  onEvent(fn: (e: RetryEvent) => void): void {
    this.events.push(fn)
  }

  private emit(e: RetryEvent): void {
    for (const fn of this.events) {
      try { fn(e) } catch { /* observer must not break retry */ }
    }
  }

  /** Compute backoff with full jitter for attempt n (0-based). */
  backoffMs(attempt: number, retryAfter: number | null): number {
    if (retryAfter !== null) return Math.min(retryAfter, this.options.maxDelayMs)
    const exp = this.options.baseDelayMs * 2 ** attempt
    const cap = Math.min(exp, this.options.maxDelayMs)
    return Math.floor(Math.random() * cap)
  }

  /**
   * Run fn with retry. fn must reject on failure (throw or return a
   * rejected promise). Returns RetryResult.
   */
  async run<T>(fn: () => Promise<T>, opts: { signal?: AbortSignal } = {}): Promise<RetryResult<T>> {
    const start = Date.now()
    let attempts = 0
    let lastError: unknown

    // Fail fast when the circuit is open.
    if (!this.circuit.allowRequest()) {
      const err = new Error('Circuit breaker open — provider failing repeatedly; skipping attempt')
      this.emit({ type: 'giveUp', error: err, attempt: 0, elapsedMs: 0 })
      return { ok: false, error: err, attempts: 0, totalElapsedMs: 0 }
    }

    while (attempts < this.options.maxAttempts) {
      if (opts.signal?.aborted) {
        return { ok: false, error: new Error('Aborted'), attempts, totalElapsedMs: Date.now() - start }
      }
      const elapsed = Date.now() - start
      if (elapsed >= this.options.deadlineMs && attempts > 0) {
        break
      }

      attempts++
      this.emit({ type: 'attempt', attempt: attempts, elapsedMs: Date.now() - start })
      try {
        const value = await fn()
        this.circuit.recordSuccess()
        this.emit({ type: 'success', attempt: attempts, elapsedMs: Date.now() - start })
        return { ok: true, value, attempts, totalElapsedMs: Date.now() - start }
      } catch (err) {
        lastError = err
        this.circuit.recordFailure()
        if (this.circuit.currentState.state === 'open') {
          this.emit({ type: 'open', error: err })
        }
        if (!this.isRetryable(err)) {
          break
        }
        if (attempts >= this.options.maxAttempts) {
          break
        }
        const retryAfter = retryAfterMs(err)
        const delay = this.backoffMs(attempts - 1, retryAfter)
        this.emit({ type: 'attempt', attempt: attempts, error: err, delayMs: delay })
        await this.sleep(delay, opts.signal)
      }
    }

    this.emit({ type: 'giveUp', error: lastError, attempt: attempts, elapsedMs: Date.now() - start })
    return { ok: false, error: lastError, attempts, totalElapsedMs: Date.now() - start }
  }

  private sleep(ms: number, signal?: AbortSignal): Promise<void> {
    return new Promise((resolve) => {
      if (signal?.aborted) return resolve()
      const t = setTimeout(resolve, ms)
      signal?.addEventListener('abort', () => { clearTimeout(t); resolve() }, { once: true })
    })
  }
}
