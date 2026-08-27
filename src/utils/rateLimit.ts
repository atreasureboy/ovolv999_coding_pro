/**
 * Rate-limit wait extraction (codex responses_retry pattern).
 *
 * Pain point: on a 429 the provider often states EXACTLY when to retry —
 * in the Retry-After header or buried in the message body
 * ("try again in 11.054s"). Blind exponential backoff either re-hits the
 * wall 0.05s early or dumbly waits 30s. These helpers dig out the precise
 * delay; only when nothing is found does the caller fall back to its own
 * backoff.
 */

/** Parse "try again in 11.054s" / "try again in 850ms" / "in 3 seconds". */
export function parseWaitFromBody(message: string): number | null {
  const m = /try again in\s+([0-9]+(?:\.[0-9]+)?)\s*(ms|s|sec|secs|second|seconds)/i.exec(message)
  if (!m) return null
  const value = Number(m[1])
  if (!Number.isFinite(value) || value < 0) return null
  const unit = (m[2] ?? '').toLowerCase()
  if (unit === 'ms') return Math.ceil(value)
  return Math.ceil(value * 1000)
}

/**
 * Extract the retry delay for a rate-limit error.
 * Order: explicit override → message body ("try again in …") → defaultMs.
 */
export function rateLimitDelayMs(error: unknown, defaultMs: number): number {
  const headers = (error as { headers?: Record<string, unknown> } | null)?.headers
  const ra = headers?.['retry-after'] ?? headers?.['Retry-After']
  if (typeof ra === 'string' && ra.trim()) {
    const n = Number(ra.trim())
    // HTTP spec: seconds. Some gateways emit ms-with-suffix or HTTP dates.
    if (Number.isFinite(n) && n >= 0) return Math.ceil(n * 1000)
    const date = Date.parse(ra)
    if (!Number.isNaN(date)) return Math.max(0, date - Date.now())
  }
  const msg = (error as { message?: string } | null)?.message
  if (typeof msg === 'string') {
    const fromBody = parseWaitFromBody(msg)
    if (fromBody !== null) return fromBody
  }
  return defaultMs
}
