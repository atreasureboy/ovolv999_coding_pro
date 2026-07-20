/**
 * API Error formatting — translate raw API/network errors into user-friendly
 * messages with actionable hints.
 *
 * Common error patterns:
 * - HTTP 401: Invalid API key → tell user to check OPENAI_API_KEY
 * - HTTP 403: Forbidden → billing or access issue
 * - HTTP 429: Rate limited → suggest waiting
 * - HTTP 500/502/503: Server error → suggest retrying
 * - ECONNREFUSED/ENOTFOUND: Network → check connection/base URL
 * - ETIMEDOUT: Timeout → suggest /retry
 */

export interface FormattedError {
  /** Short user-friendly title. */
  title: string
  /** Detailed message. */
  detail: string
  /** Optional actionable hint. */
  hint?: string
}

/**
 * Parse an error into a user-friendly FormattedError.
 * Recognizes OpenAI SDK error patterns, Node.js network errors,
 * and common HTTP status codes.
 */
export function formatApiError(err: unknown): FormattedError {
  const error = err as Error & { status?: number; code?: string; type?: string }
  const msg = error.message || String(err)
  const status = error.status
  const code = error.code

  // ── Network errors ──────────────────────────────────────────────────────
  if (code === 'ECONNREFUSED' || msg.includes('ECONNREFUSED')) {
    return {
      title: 'Connection refused',
      detail: 'The API server refused the connection.',
      hint: 'Check that your baseUrl is correct and the server is running. Use /config to view settings.',
    }
  }
  if (code === 'ENOTFOUND' || msg.includes('ENOTFOUND')) {
    return {
      title: 'Host not found',
      detail: 'Could not resolve the API hostname.',
      hint: 'Check your internet connection and baseUrl setting.',
    }
  }
  if (code === 'ETIMEDOUT' || msg.includes('ETIMEDOUT') || msg.includes('timeout')) {
    return {
      title: 'Request timed out',
      detail: 'The API did not respond within the timeout period.',
      hint: 'The server may be overloaded. Try /retry in a moment.',
    }
  }
  if (code === 'ECONNRESET' || msg.includes('ECONNRESET')) {
    return {
      title: 'Connection reset',
      detail: 'The connection was forcibly closed by the remote server.',
      hint: 'This is often transient. Try /retry.',
    }
  }

  // ── HTTP status codes ───────────────────────────────────────────────────
  if (status === 401 || msg.includes('401') || /invalid.*api.*key/i.test(msg) || /incorrect.*api.*key/i.test(msg)) {
    return {
      title: 'Authentication failed',
      detail: 'The API key was rejected (HTTP 401).',
      hint: 'Check that OPENAI_API_KEY is set correctly. Use /config to verify.',
    }
  }
  if (status === 403 || msg.includes('403')) {
    return {
      title: 'Access forbidden',
      detail: 'The API key lacks permission for this request (HTTP 403).',
      hint: 'This may be a billing or quota issue. Check your provider dashboard.',
    }
  }
  if (status === 404 || msg.includes('404') || /model.*not.*found/i.test(msg) || /does.*not.*exist/i.test(msg)) {
    return {
      title: 'Model not found',
      detail: 'The requested model does not exist or is not accessible.',
      hint: 'Use /model to switch to an available model.',
    }
  }
  if (status === 429 || msg.includes('429') || /rate.*limit/i.test(msg)) {
    return {
      title: 'Rate limited',
      detail: 'Too many requests. The API is throttling responses (HTTP 429).',
      hint: 'Wait a few seconds and try /retry. Consider /compact to reduce token usage.',
    }
  }
  if (status === 500 || status === 502 || status === 503 || /[45]0[023]/.test(msg)) {
    return {
      title: 'Server error',
      detail: `The API server returned an error (HTTP ${status ?? '5xx'}).`,
      hint: 'This is usually transient. Try /retry in a moment.',
    }
  }

  // ── Context overflow ────────────────────────────────────────────────────
  if (msg.includes('context_length_exceeded') || msg.includes('maximum context length')) {
    return {
      title: 'Context overflow',
      detail: 'The conversation exceeded the model\'s context window.',
      hint: 'Use /compact to summarize the conversation, or /snip to remove old messages.',
    }
  }

  // ── Abort ───────────────────────────────────────────────────────────────
  if (error.name === 'AbortError' || msg.includes('abort')) {
    return {
      title: 'Interrupted',
      detail: 'The request was cancelled.',
    }
  }

  // ── Generic fallback ────────────────────────────────────────────────────
  return {
    title: 'Error',
    detail: msg.slice(0, 500),
  }
}

/**
 * Format an error as a single-line string for inline display.
 */
export function formatErrorInline(err: unknown): string {
  const fe = formatApiError(err)
  let line = `${fe.title}: ${fe.detail}`
  if (fe.hint) line += ` ${fe.hint}`
  return line
}
