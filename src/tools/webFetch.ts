/**
 * WebFetch — fetch URL and extract readable text
 * Reference: src/tools/WebFetchTool/
 *
 * Uses Node's built-in fetch (Node 18+).
 * Strips HTML tags to return clean text for LLM consumption.
 *
 * Streaming / safety:
 *   - Body is read through response.body.getReader() with a byte cap so
 *     a misbehaving server (no content-length, huge body) cannot exhaust
 *     memory.
 *   - The AbortController is aborted with proper Error reasons (not
 *     strings) so the catch branch can reliably distinguish timeout from
 *     user cancellation — Node fetch re-throws the abort reason verbatim,
 *     and a bare string would have neither .name nor .message.
 */

import type { Tool, ToolContext, ToolDefinition, ToolResult } from '../core/types.js'

const MAX_CONTENT_LENGTH = 50_000 // characters returned to LLM
const FETCH_TIMEOUT_MS = 30_000
/** Hard raw-byte cap for the response body, regardless of content-length. */
const MAX_RESPONSE_BYTES = 5 * 1024 * 1024 // 5 MiB
/** If content-length header is larger than this, reject without reading. */
const MAX_CONTENT_LENGTH_HEADER = MAX_RESPONSE_BYTES

/**
 * Marker errors thrown into AbortController#abort so the catch branch can
 * distinguish cancellation sources. We MUST abort with a real Error: if
 * we abort with a string, Node fetch re-throws that string and the catch
 * block has err.name === undefined (the original bug).
 */
class TimeoutAbortError extends Error {
  constructor(url: string) {
    super(`Request timed out after ${FETCH_TIMEOUT_MS / 1000}s: ${url}`)
    this.name = 'TimeoutAbortError'
  }
}

class UserCancelledAbortError extends Error {
  constructor() {
    super('Request cancelled')
    this.name = 'UserCancelledAbortError'
  }
}

class ResponseTooLargeError extends Error {
  constructor(bytes: number, cap: number) {
    super(`Response body of ${bytes} bytes exceeds ${cap} byte cap`)
    this.name = 'ResponseTooLargeError'
  }
}

export interface WebFetchInput {
  url: string
  max_length?: number
  start_index?: number
}

/**
 * Minimal HTML → plain text extraction.
 * Removes scripts/styles/tags, collapses whitespace.
 */
function htmlToText(html: string): string {
  return html
    // Remove script and style blocks entirely
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    // Convert common block elements to newlines
    .replace(/<\/?(p|div|section|article|header|footer|h[1-6]|li|tr|br)[^>]*>/gi, '\n')
    // Remove all remaining tags
    .replace(/<[^>]+>/g, '')
    // Decode common HTML entities
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    // Collapse whitespace
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/**
 * Stream the response body through a TextDecoder, abandoning at `cap` bytes.
 * Honors an AbortSignal by racing the read loop.
 *
 * Returns the decoded UTF-8 string. Throws ResponseTooLargeError if cap is
 * hit, or the underlying read error otherwise.
 */
async function readBodyWithCap(
  response: Response,
  signal: AbortSignal | undefined,
  cap: number,
): Promise<string> {
  if (!response.body) {
    // Some responses (e.g. 204) have no body — fall back to .text() on the
    // empty body, which is safe.
    return ''
  }

  const reader = response.body.getReader()
  const decoder = new TextDecoder('utf-8')
  const chunks: string[] = []
  let total = 0
  let truncated = false

  // Cleanup helper — runs on every exit path so we don't leak the reader
  // (which keeps the underlying socket alive) when we bail out early.
  const release = (): void => {
    try {
      reader.cancel().catch(() => undefined)
    } catch {
      // best-effort
    }
  }

  try {
    while (true) {
      if (signal?.aborted) {
        throw signal.reason instanceof Error ? signal.reason : new Error('aborted')
      }
      // Explicit type — `reader.read()` is typed loosely under our minimal
      // lib config; without this every access on `value` triggers
      // `@typescript-eslint/no-unsafe-*`.
      const readResult: { value: Uint8Array | undefined; done: boolean } =
        await reader.read()
      const { value, done } = readResult
      if (done) break
      if (!value) continue
      total += value.byteLength
      if (total > cap) {
        truncated = true
        break
      }
      chunks.push(decoder.decode(value, { stream: true }))
    }
    chunks.push(decoder.decode())
  } finally {
    release()
  }

  if (truncated) {
    throw new ResponseTooLargeError(total, cap)
  }
  return chunks.join('')
}

export class WebFetchTool implements Tool {
  name = 'WebFetch'
  metadata = { readOnly: true, concurrencySafe: true, requiresNetwork: true }

  definition: ToolDefinition = {
    type: 'function',
    function: {
      name: 'WebFetch',
      description: `Fetch a URL and return its content as plain text.

Use this to:
- Read documentation pages
- Fetch API responses
- Check package READMEs or changelogs
- Read web resources referenced in the task

HTML is automatically stripped to extract readable text.
Large pages are truncated — use start_index to paginate.`,
      parameters: {
        type: 'object',
        properties: {
          url: {
            type: 'string',
            description: 'The URL to fetch (must start with http:// or https://)',
          },
          max_length: {
            type: 'number',
            description: `Maximum characters to return (default: ${MAX_CONTENT_LENGTH})`,
          },
          start_index: {
            type: 'number',
            description: 'Character offset to start from (for pagination, default: 0)',
          },
        },
        required: ['url'],
      },
    },
  }

  async execute(input: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
    const { url, max_length, start_index } = input as unknown as WebFetchInput

    if (!url || typeof url !== 'string') {
      return { content: 'Error: url is required', isError: true }
    }

    if (!url.startsWith('http://') && !url.startsWith('https://')) {
      return { content: 'Error: URL must start with http:// or https://', isError: true }
    }

    const maxLen = typeof max_length === 'number' ? Math.min(max_length, MAX_CONTENT_LENGTH) : MAX_CONTENT_LENGTH
    const startIdx = typeof start_index === 'number' ? start_index : 0

    // Compose a single AbortController that fires on timeout OR user cancel.
    // Both call-sites MUST abort with a real Error — see the comment at
    // the top of the file for why strings break Node fetch.
    const fetchController = new AbortController()
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      fetchController.abort(new TimeoutAbortError(url))
    }, FETCH_TIMEOUT_MS)

    const propagateAbort = (): void => {
      clearTimeout(timer)
      fetchController.abort(new UserCancelledAbortError())
    }

    // Forwards the outer context.signal into the fetch controller. Done
    // BEFORE we hit any await so a pre-aborted signal is honored.
    if (context.signal) {
      if (context.signal.aborted) {
        clearTimeout(timer)
        return { content: 'Request cancelled.', isError: true }
      }
      context.signal.addEventListener('abort', propagateAbort, { once: true })
    }

    try {
      const response = await fetch(url, {
        signal: fetchController.signal,
        headers: {
          'User-Agent': 'ovogogogo/0.1.0 (autonomous code execution engine)',
          'Accept': 'text/html,application/xhtml+xml,text/plain,*/*',
        },
        redirect: 'follow',
      })

      clearTimeout(timer)

      if (!response.ok) {
        const status = response.status
        let hint = ''
        if (status === 401 || status === 403) hint = ' Hint: the resource may require authentication or a different User-Agent.'
        else if (status === 404) hint = ' Hint: verify the URL is correct, or use WebSearch to find the current location.'
        else if (status >= 500) hint = ' Hint: server error — try again later or use WebSearch as an alternative.'
        return {
          content: `HTTP ${status} ${response.statusText} for ${url}.${hint}`,
          isError: true,
        }
      }

      const contentType = response.headers.get('content-type') ?? ''

      // Short-circuit when the server tells us the body is too big — no
      // need to actually stream the bytes.
      const contentLengthHeader = response.headers.get('content-length')
      if (contentLengthHeader) {
        const declared = Number(contentLengthHeader)
        if (Number.isFinite(declared) && declared > MAX_CONTENT_LENGTH_HEADER) {
          return {
            content: `Response too large: Content-Length ${declared} bytes exceeds ${MAX_CONTENT_LENGTH_HEADER} byte cap for ${url}.`,
            isError: true,
          }
        }
      }

      let rawBody: string
      try {
        rawBody = await readBodyWithCap(response, fetchController.signal, MAX_RESPONSE_BYTES)
      } catch (err: unknown) {
        const error = err as Error
        if (error.name === 'ResponseTooLargeError') {
          return {
            content: `Response too large: ${error.message} for ${url}.`,
            isError: true,
          }
        }
        // The streaming reader surfaces our TimeoutAbortError /
        // UserCancelledAbortError here — distinguish them.
        if (error.name === 'TimeoutAbortError') {
          return { content: error.message, isError: true }
        }
        if (error.name === 'UserCancelledAbortError') {
          return { content: 'Request cancelled.', isError: true }
        }
        return { content: `Fetch error: ${error.message ?? String(err)}`, isError: true }
      }

      let text: string
      if (contentType.includes('text/html')) {
        text = htmlToText(rawBody)
      } else {
        // JSON, plain text, etc — return as-is
        text = rawBody.trim()
      }

      const totalLen = text.length
      const slice = text.slice(startIdx, startIdx + maxLen)

      const header = `URL: ${url}\nContent-Type: ${contentType}\nLength: ${totalLen} chars\n`
      const pagination =
        startIdx + maxLen < totalLen
          ? `\n\n[Showing chars ${startIdx}–${startIdx + maxLen} of ${totalLen}. Use start_index=${startIdx + maxLen} for next page.]`
          : ''

      return {
        content: header + '\n' + slice + pagination,
        isError: false,
      }
    } catch (err: unknown) {
      // Top-level catch: only reached for synchronous failures (URL parse
      // errors, AbortError surfaced from the network stack). Streaming
      // errors are handled inside readBodyWithCap().
      const error = err as { name?: string; message?: string; cause?: unknown }
      if (error.name === 'TimeoutAbortError') {
        return { content: `Request timed out after ${FETCH_TIMEOUT_MS / 1000}s: ${url}`, isError: true }
      }
      if (error.name === 'UserCancelledAbortError') {
        return { content: 'Request cancelled.', isError: true }
      }
      if (timedOut) {
        return { content: `Request timed out after ${FETCH_TIMEOUT_MS / 1000}s: ${url}`, isError: true }
      }
      if (error.name === 'AbortError') {
        // Generic abort (e.g. context.signal aborted but our specific
        // error wrapper never landed) — surface a clear cancellation.
        return { content: 'Request cancelled.', isError: true }
      }
      const msg = typeof error.message === 'string' ? error.message : `unknown fetch error`
      return { content: `Fetch error: ${msg}`, isError: true }
    } finally {
      clearTimeout(timer)
      if (context.signal) {
        context.signal.removeEventListener('abort', propagateAbort)
      }
    }
  }
}
