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
  /** Detailed message of what happened. */
  detail: string
  /** What happened. */
  what?: string
  /** Possible causes. */
  causes?: string[]
  /** Auto recoveries attempted. */
  autoRecovery?: string
  /** User next steps. */
  nextSteps?: string[]
  /** Trace or log location. */
  logPath?: string
  /** Optional actionable hint. */
  hint?: string
}

/**
 * Parse an error into a structured user-friendly FormattedError.
 * Recognizes OpenAI SDK error patterns, Node.js network errors,
 * and common HTTP status codes.
 *
 * v0.4.1 WS8 (error truth): `autoRecovery` is DERIVED from the real model
 * call attempt count — pre-WS8 every branch carried a static fabricated
 * string ("ModelRouter fallback chain triggered" etc.) that lied whenever
 * no recovery actually happened. `attempts` is the number of model calls
 * the engine really made before surfacing this error (0/absent when the
 * failure never reached a model call).
 */
export function formatApiError(err: unknown, sessionDir?: string, attempts?: number): FormattedError {
  const error = err as Error & { status?: number; code?: string; type?: string }
  const msg = error.message || String(err)
  const status = error.status
  const code = error.code
  const logPath = sessionDir ? `${sessionDir}/events.ndjson` : '~/.ovogo/logs'
  const autoRecovery = attempts && attempts > 0
    ? `Engine attempted ${attempts} model call${attempts === 1 ? '' : 's'} before surfacing this error`
    : 'No automatic recovery was performed — the error surfaced directly'

  // ── Network errors ──────────────────────────────────────────────────────
  if (code === 'ECONNREFUSED' || msg.includes('ECONNREFUSED')) {
    return {
      title: 'Connection refused',
      detail: 'The API server refused the connection.',
      what: 'Failed to establish HTTP connection with the configured provider endpoint.',
      causes: ['Invalid baseURL configuration', 'Local proxy or server is down', 'Network firewall blocking connection'],
      autoRecovery,
      nextSteps: ['Check OPENAI_BASE_URL or ANTHROPIC_BASE_URL', 'Verify endpoint host is running', 'Run /config or /status to test connection'],
      logPath,
      hint: 'Check that your baseUrl is correct and the server is running. Use /config to view settings.',
    }
  }
  if (code === 'ENOTFOUND' || msg.includes('ENOTFOUND')) {
    return {
      title: 'Host not found',
      detail: 'Could not resolve the API hostname.',
      what: 'DNS lookup failed for the provider domain name.',
      causes: ['No internet connection', 'Misspelled hostname in baseURL', 'DNS server resolution failure'],
      autoRecovery,
      nextSteps: ['Check network connectivity', 'Verify hostname spelling in settings'],
      logPath,
      hint: 'Check your internet connection and baseUrl setting.',
    }
  }
  if (code === 'ETIMEDOUT' || msg.includes('ETIMEDOUT') || msg.includes('timeout')) {
    return {
      title: 'Request timed out',
      detail: 'The API did not respond within the timeout period.',
      what: 'HTTP request exceeded the deadline without receiving headers/tokens.',
      causes: ['Provider service latency spike', 'Large prompt processing delay', 'Proxy bottleneck'],
      autoRecovery,
      nextSteps: ['Retry with /retry', 'Consider lowering context size with /compact'],
      logPath,
      hint: 'The server may be overloaded. Try /retry in a moment.',
    }
  }
  if (code === 'ECONNRESET' || msg.includes('ECONNRESET')) {
    return {
      title: 'Connection reset',
      detail: 'The connection was forcibly closed by the remote server.',
      what: 'Remote server reset the TCP connection.',
      causes: ['Network instability', 'Server side socket timeout'],
      autoRecovery,
      nextSteps: ['Retry with /retry'],
      logPath,
      hint: 'This is often transient. Try /retry.',
    }
  }

  // ── HTTP status codes ───────────────────────────────────────────────────
  if (status === 401 || msg.includes('401') || /invalid.*api.*key/i.test(msg) || /incorrect.*api.*key/i.test(msg)) {
    return {
      title: 'Authentication failed',
      detail: 'The API key was rejected (HTTP 401).',
      what: 'Provider returned 401 Unauthorized.',
      causes: ['Expired or invalid API key', 'Missing environment variable OPENAI_API_KEY / ANTHROPIC_AUTH_TOKEN'],
      autoRecovery,
      nextSteps: ['Set OPENAI_API_KEY environment variable', 'Run `ovolv999 init` to update credentials'],
      logPath,
      hint: 'Check that OPENAI_API_KEY is set correctly. Use /config to verify.',
    }
  }
  if (status === 403 || msg.includes('403')) {
    return {
      title: 'Access forbidden',
      detail: 'The API key lacks permission for this request (HTTP 403).',
      what: 'Provider returned 403 Forbidden.',
      causes: ['Account quota exhausted or unpaid bill', 'Region restriction on provider endpoint', 'Missing tier permission for requested model'],
      autoRecovery,
      nextSteps: ['Check account billing status at provider dashboard', 'Switch model via /model'],
      logPath,
      hint: 'This may be a billing or quota issue. Check your provider dashboard.',
    }
  }
  if (status === 404 || msg.includes('404') || /model.*not.*found/i.test(msg) || /does.*not.*exist/i.test(msg)) {
    return {
      title: 'Model not found',
      detail: 'The requested model does not exist or is not accessible.',
      what: 'Model endpoint rejected request for model name.',
      causes: ['Model name typo', 'Model deprecated by provider', 'Account lacks access to this model'],
      autoRecovery,
      nextSteps: ['Use /model to switch to an available model (e.g. gpt-4o)'],
      logPath,
      hint: 'Use /model to switch to an available model.',
    }
  }
  if (status === 429 || msg.includes('429') || /rate.*limit/i.test(msg)) {
    return {
      title: 'Rate limited',
      detail: 'Too many requests. The API is throttling responses (HTTP 429).',
      what: 'Provider rate limit or token-per-minute quota exceeded.',
      causes: ['Frequent parallel requests', 'Account RPM/TPM tier limit hit'],
      autoRecovery,
      nextSteps: ['Wait a few seconds and retry', 'Use /compact to reduce token size'],
      logPath,
      hint: 'Wait a few seconds and try /retry. Consider /compact to reduce token usage.',
    }
  }
  if (status === 500 || status === 502 || status === 503 || /[45]0[023]/.test(msg)) {
    return {
      title: 'Server error',
      detail: `The API server returned an error (HTTP ${status ?? '5xx'}).`,
      what: `Provider returned HTTP ${status ?? '5xx'} server error.`,
      causes: ['Provider infrastructure outage', 'Temporary upstream overload'],
      autoRecovery,
      nextSteps: ['Wait a moment and try /retry'],
      logPath,
      hint: 'This is usually transient. Try /retry in a moment.',
    }
  }

  // ── Context overflow ────────────────────────────────────────────────────
  if (msg.includes('context_length_exceeded') || msg.includes('maximum context length')) {
    return {
      title: 'Context overflow',
      detail: 'The conversation exceeded the model\'s context window.',
      what: 'Token count surpassed model maximum limit.',
      causes: ['Large files read into history', 'Long conversation session'],
      autoRecovery,
      nextSteps: ['Run /compact to compress conversation history', 'Run /clear for a fresh start'],
      logPath,
      hint: 'Use /compact to summarize the conversation, or /snip to remove old messages.',
    }
  }

  // ── Abort ───────────────────────────────────────────────────────────────
  if (error.name === 'AbortError' || msg.includes('abort') || msg.includes('aborted')) {
    return {
      title: 'Interrupted',
      detail: 'The request was cancelled.',
    }
  }

  // ── Generic fallback ────────────────────────────────────────────────────
  return {
    title: 'Error',
    detail: msg.slice(0, 500),
    what: msg.slice(0, 200),
    causes: ['Unexpected runtime error or system exception'],
    autoRecovery,
    nextSteps: ['Review log trace', 'Re-run prompt or command'],
    logPath,
  }
}

/**
 * Format an error as a single-line string for inline display.
 */
export function formatErrorInline(err: unknown, sessionDir?: string, attempts?: number): string {
  const fe = formatApiError(err, sessionDir, attempts)
  let line = `${fe.title}: ${fe.detail}`
  if (fe.hint) line += ` ${fe.hint}`
  return line
}

/**
 * Format an error into a complete 5-section structured error card.
 */
export function formatErrorCardText(err: unknown, sessionDir?: string, attempts?: number): string {
  const fe = formatApiError(err, sessionDir, attempts)
  const lines: string[] = [
    `✖ ${fe.title}: ${fe.detail}`,
  ]
  if (fe.what) lines.push(`  • What happened: ${fe.what}`)
  if (fe.causes && fe.causes.length > 0) lines.push(`  • Possible causes: ${fe.causes.join('; ')}`)
  if (fe.autoRecovery) lines.push(`  • Auto-recovery: ${fe.autoRecovery}`)
  if (fe.nextSteps && fe.nextSteps.length > 0) lines.push(`  • Recommended next steps: ${fe.nextSteps.join(' | ')}`)
  if (fe.logPath) lines.push(`  • Log trace location: ${fe.logPath}`)
  return lines.join('\n')
}
