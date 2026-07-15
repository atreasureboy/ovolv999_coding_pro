/**
 * WebSearch — search the web and return results
 * Reference: src/tools/WebSearchTool/
 *
 * Backends (in priority order):
 *   1. OVOGO_SEARCH_API_KEY + OVOGO_SEARCH_ENGINE_ID → Google Custom Search JSON API
 *   2. SERPAPI_KEY → SerpAPI (google results)
 *   3. Fallback → DuckDuckGo Instant Answer API (no key needed, limited)
 *
 * Set env vars to unlock fuller results.
 *
 * Cancellation:
 *   The execute() method wires the outer ToolContext.signal into every
 *   helper so Ctrl+C aborts the in-flight fetch AND its body parse (no
 *   zombie timers, no hung parses left behind). The helper combines the
 *   outer abort with its own internal timeout via a single AbortController
 *   and races both phases (fetch + consume) against that controller's
 *   signal — so a Ctrl+C fires even after `await fetch()` returns headers
 *   but before `resp.json()` finishes.
 */

import type { Tool, ToolContext, ToolDefinition, ToolResult } from '../core/types.js'

const SEARCH_TIMEOUT_MS = 15_000

export interface WebSearchInput {
  query: string
  num_results?: number
}

interface SearchResult {
  title: string
  url: string
  snippet: string
}

/**
 * Cancel-aware fetch + parse wrapper used by every backend.
 *
 * The helper owns the cancellation lifecycle for BOTH phases:
 *   1. `await fetch(url, …)` — aborted via `controller.signal`.
 *   2. `consume(resp)` — typically `resp.json()`, raced against the
 *      same `controller.signal` so a Ctrl+C fired AFTER headers return
 *      still cancels the parse (otherwise the body-read hangs and the
 *      helper's `finally` had already torn the listener down).
 *
 * The helper aborts as soon as ANY of these fire:
 *   - The outer `signal` (Ctrl+C propagated through the engine).
 *   - The internal SEARCH_TIMEOUT_MS timer.
 *
 * All abort reasons are real Errors with `.name` set so downstream
 * `.catch` can pattern-match on the cancellation source — same fix as
 * webFetch.
 *
 * NOTE: callers MUST pass the parse step through `consume`. The helper
 * used to return a raw `Response`, but tests proved that body reads
 * (`resp.json()`) sat OUTSIDE the helper and ignored aborts entirely.
 */
async function fetchWithAbort<T>(
  url: string,
  init: RequestInit,
  signal: AbortSignal | undefined,
  label: string,
  consume: (resp: Response) => Promise<T>,
): Promise<T> {
  const controller = new AbortController()

  const timer = setTimeout(() => {
    controller.abort(new TimeoutError(label))
  }, SEARCH_TIMEOUT_MS)

  // Forward the outer signal into our controller. Converging both abort
  // sinks (timer + outer signal) on `controller.signal` lets the parse
  // race below observe a single, uniform signal.
  const propagate = (): void => {
    if (controller.signal.aborted) return
    clearTimeout(timer)
    controller.abort(new CancelledError(label))
  }

  if (signal) {
    if (signal.aborted) {
      clearTimeout(timer)
      throw new CancelledError(label)
    }
    signal.addEventListener('abort', propagate, { once: true })
  }

  // Race the body-parse against `controller.signal`. Without this, the
  // already-resolved `resp` would happily hang on `resp.json()` — the
  // previous bug: cleanup ran in `finally` BEFORE parse, so a Ctrl+C
  // after headers returned was a no-op.
  //
  // The `onAbort` listener is explicitly removed on natural settle: a
  // slow parse that lingers in this closure would otherwise keep the
  // listener attached until the parse eventually resolves and the
  // closure goes out of scope.
  const raceParse = (parse: () => Promise<T>): Promise<T> =>
    new Promise<T>((resolve, reject) => {
      let settled = false
      const settle = (fn: () => void): void => {
        if (settled) return
        settled = true
        controller.signal.removeEventListener('abort', onAbort)
        fn()
      }
      const onAbort = (): void => {
        settle(() =>
          reject(
            controller.signal.reason instanceof Error
              ? controller.signal.reason
              : new Error('aborted'),
          ),
        )
      }
      if (controller.signal.aborted) {
        onAbort()
        return
      }
      controller.signal.addEventListener('abort', onAbort, { once: true })
      parse().then(
        (v) => settle(() => resolve(v)),
        (e) => settle(() => reject(e instanceof Error ? e : new Error(String(e)))),
      )
    })

  try {
    const resp = await fetch(url, { ...init, signal: controller.signal })
    return await raceParse(() => consume(resp))
  } finally {
    clearTimeout(timer)
    if (signal) {
      signal.removeEventListener('abort', propagate)
    }
  }
}

class TimeoutError extends Error {
  constructor(label: string) {
    super(`Search timed out after ${SEARCH_TIMEOUT_MS / 1000}s: ${label}`)
    this.name = 'TimeoutError'
  }
}

class CancelledError extends Error {
  constructor(label: string) {
    super(`Search cancelled: ${label}`)
    this.name = 'CancelledError'
  }
}

// ─── Backend: DuckDuckGo Instant Answer (no key) ────────────

interface DuckDuckGoResponse {
  AbstractText?: string
  AbstractURL?: string
  AbstractSource?: string
  RelatedTopics?: Array<{ Text?: string; FirstURL?: string }>
}

async function duckduckgoSearch(
  query: string,
  numResults: number,
  signal: AbortSignal | undefined,
): Promise<SearchResult[]> {
  const url = `https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json&no_html=1&skip_disambig=1`

  try {
    const data = await fetchWithAbort<DuckDuckGoResponse>(
      url,
      { headers: { 'User-Agent': 'ovogogogo/0.1.0' } },
      signal,
      'duckduckgo',
      (r) => r.json() as Promise<DuckDuckGoResponse>,
    )

    const results: SearchResult[] = []

    // Abstract (main answer)
    if (data.AbstractText && data.AbstractURL) {
      results.push({
        title: data.AbstractSource ?? 'Answer',
        url: data.AbstractURL,
        snippet: data.AbstractText,
      })
    }

    // Related topics
    for (const topic of data.RelatedTopics ?? []) {
      if (topic.Text && topic.FirstURL) {
        results.push({
          title: topic.Text.split(' - ')[0] ?? topic.Text,
          url: topic.FirstURL,
          snippet: topic.Text,
        })
        if (results.length >= numResults) break
      }
    }

    return results
  } catch (err: unknown) {
    // Cancellation propagates upward as a real error so the execute()
    // method can return a clear ToolResult instead of falling back.
    if (err instanceof Error && (err.name === 'CancelledError' || err.name === 'TimeoutError')) {
      throw err
    }
    return []
  }
}

// ─── Backend: Google Custom Search JSON API ──────────────────

interface GoogleResponse {
  items?: Array<{ title: string; link: string; snippet: string }>
}

async function googleSearch(
  query: string,
  numResults: number,
  apiKey: string,
  engineId: string,
  signal: AbortSignal | undefined,
): Promise<SearchResult[]> {
  const url =
    `https://www.googleapis.com/customsearch/v1?key=${apiKey}` +
    `&cx=${engineId}&q=${encodeURIComponent(query)}&num=${Math.min(numResults, 10)}`

  try {
    const data = await fetchWithAbort<GoogleResponse>(
      url,
      {},
      signal,
      'google',
      (r) => r.json() as Promise<GoogleResponse>,
    )

    return (data.items ?? []).map(item => ({
      title: item.title,
      url: item.link,
      snippet: item.snippet,
    }))
  } catch (err: unknown) {
    if (err instanceof Error && (err.name === 'CancelledError' || err.name === 'TimeoutError')) {
      throw err
    }
    return []
  }
}

// ─── Backend: SerpAPI ────────────────────────────────────────

interface SerpApiResponse {
  organic_results?: Array<{ title: string; link: string; snippet: string }>
}

async function serpApiSearch(
  query: string,
  numResults: number,
  apiKey: string,
  signal: AbortSignal | undefined,
): Promise<SearchResult[]> {
  const url =
    `https://serpapi.com/search.json?api_key=${apiKey}` +
    `&q=${encodeURIComponent(query)}&num=${Math.min(numResults, 10)}&engine=google`

  try {
    const data = await fetchWithAbort<SerpApiResponse>(
      url,
      {},
      signal,
      'serpapi',
      (r) => r.json() as Promise<SerpApiResponse>,
    )

    return (data.organic_results ?? []).map(r => ({
      title: r.title,
      url: r.link,
      snippet: r.snippet,
    }))
  } catch (err: unknown) {
    if (err instanceof Error && (err.name === 'CancelledError' || err.name === 'TimeoutError')) {
      throw err
    }
    return []
  }
}

// ─────────────────────────────────────────────────────────────

function formatResults(results: SearchResult[], query: string, backend: string): string {
  if (results.length === 0) {
    return `No results found for: ${query}\n\nTip: Set OVOGO_SEARCH_API_KEY + OVOGO_SEARCH_ENGINE_ID (Google) or SERPAPI_KEY for better results.`
  }

  const lines = [`Search: ${query}  [via ${backend}]`, '']
  results.forEach((r, i) => {
    lines.push(`${i + 1}. ${r.title}`)
    lines.push(`   ${r.url}`)
    lines.push(`   ${r.snippet}`)
    lines.push('')
  })
  return lines.join('\n')
}

export class WebSearchTool implements Tool {
  name = 'WebSearch'
  metadata = { readOnly: true, concurrencySafe: true, requiresNetwork: true }

  definition: ToolDefinition = {
    type: 'function',
    function: {
      name: 'WebSearch',
      description: `Search the web and return results with titles, URLs, and snippets.

Use this to:
- Look up documentation, APIs, error messages
- Find recent information (post training cutoff)
- Verify package names, versions, or compatibility

Results include URLs you can then fetch with WebFetch for full content.

**Important**: After answering based on search results, you MUST include a "Sources:" section at the end of your response citing the URLs used.

Tips:
- Use the current year in queries for fresh results (e.g. "Node.js best practices 2025")
- Keep queries concise (under 70 characters)

Backends (set env vars for better results):
- OVOGO_SEARCH_API_KEY + OVOGO_SEARCH_ENGINE_ID → Google Custom Search
- SERPAPI_KEY → SerpAPI
- Fallback: DuckDuckGo Instant Answer (no key needed, limited)`,
      parameters: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: 'Search query',
          },
          num_results: {
            type: 'number',
            description: 'Number of results to return (default: 5, max: 10)',
          },
        },
        required: ['query'],
      },
    },
  }

  async execute(input: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
    const { query, num_results } = input as unknown as WebSearchInput

    if (!query || typeof query !== 'string') {
      return { content: 'Error: query is required', isError: true }
    }

    // Fast-path: the caller pre-aborted — don't even start a fetch.
    if (context.signal?.aborted) {
      return { content: 'Search cancelled.', isError: true }
    }

    const numResults = Math.min(typeof num_results === 'number' ? num_results : 5, 10)
    const signal = context.signal

    // Try backends in priority order.
    const googleKey = process.env.OVOGO_SEARCH_API_KEY
    const googleEngineId = process.env.OVOGO_SEARCH_ENGINE_ID
    const serpKey = process.env.SERPAPI_KEY

    try {
      let results: SearchResult[] = []
      let backend = 'DuckDuckGo'

      if (googleKey && googleEngineId) {
        results = await googleSearch(query, numResults, googleKey, googleEngineId, signal)
        backend = 'Google Custom Search'
      } else if (serpKey) {
        results = await serpApiSearch(query, numResults, serpKey, signal)
        backend = 'SerpAPI'
      }

      // Fallback to DDG if primary returned nothing.
      if (results.length === 0) {
        results = await duckduckgoSearch(query, numResults, signal)
        backend = 'DuckDuckGo'
      }

      return {
        content: formatResults(results, query, backend),
        isError: false,
      }
    } catch (err: unknown) {
      const error = err as Error
      if (error.name === 'CancelledError') {
        return { content: 'Search cancelled.', isError: true }
      }
      if (error.name === 'TimeoutError') {
        return { content: error.message || 'Search timed out.', isError: true }
      }
      return {
        content: `Search error: ${error.message ?? String(err)}`,
        isError: true,
      }
    }
  }
}
