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
 */
export function formatApiError(err: unknown, sessionDir?: string): FormattedError {
  const error = err as Error & { status?: number; code?: string; type?: string }
  const msg = error.message || String(err)
  const status = error.status
  const code = error.code
  const logPath = sessionDir ? `${sessionDir}/events.jsonl` : '~/.ovogo/logs'

  // ── Network errors ──────────────────────────────────────────────────────
  if (code === 'ECONNREFUSED' || msg.includes('ECONNREFUSED')) {
    return {
      title: 'Connection refused',
      detail: 'The API server refused the connection.',
      what: 'Failed to establish HTTP connection with the configured provider endpoint.',
      causes: ['Invalid baseURL configuration', 'Local proxy or server is down', 'Network firewall blocking connection'],
      autoRecovery: 'Attempted retry 1 time with fallback transport',
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
      autoRecovery: 'DNS lookup re-attempted',
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
      autoRecovery: 'Streaming streamConsumer timed out and was aborted safely',
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
      autoRecovery: 'Session preserved',
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
      autoRecovery: 'Preserved local conversation state',
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
      autoRecovery: 'Logged attempt to ModelRouter failure tracker',
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
      autoRecovery: 'ModelRouter flagged profile as unavailable',
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
      autoRecovery: 'ModelRouter fallback chain triggered',
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
      autoRecovery: 'Prepared turn state for retry',
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
      autoRecovery: 'Auto-compact triggered',
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
    autoRecovery: 'Engine safely captured error state',
    nextSteps: ['Review log trace', 'Re-run prompt or command'],
    logPath,
  }
}

/**
 * Format an error as a single-line string for inline display.
 */
export function formatErrorInline(err: unknown, sessionDir?: string): string {
  const fe = formatApiError(err, sessionDir)
  let line = `${fe.title}: ${fe.detail}`
  if (fe.hint) line += ` ${fe.hint}`
  return line
}
