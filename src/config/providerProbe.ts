/**
 * v0.4.1 WS2 — prove a freshly configured provider ACTUALLY works before
 * the user sits down at the UI.
 *
 * The probe checks the two capabilities every turn depends on:
 *  1. streaming — the runtime consumes SSE chunks, never plain completions;
 *  2. tool calling — a tool definition rides along, so a provider that
 *     rejects the `tools` field fails HERE (with an honest error card)
 *     instead of mid-task.
 *
 * `models.list` is tried first for observability but is NOT a gate: many
 * OpenAI-compatible providers (Ollama, vLLM) answer it with 404 and serve
 * completions fine. The completion probe is the verdict.
 *
 * The injected-client seam mirrors the engine DI pattern — tests never
 * touch the network. A failed probe NEVER deletes the saved config: an
 * offline user who configured correctly is not locked out, they re-run
 * when the network is back.
 */
import OpenAI from 'openai'

export interface ProbeClient {
  models?: { list: (...args: unknown[]) => Promise<unknown> }
  chat: {
    completions: {
      create: (params: Record<string, unknown>, opts?: unknown) => Promise<AsyncIterable<unknown>>
    }
  }
}

export interface ProbeOptions {
  apiKey: string
  baseURL?: string
  model: string
  /** Per-phase deadline in ms (default 15000). */
  timeoutMs?: number
  /** DI seam — anything shaped like the OpenAI client. Real client by default. */
  client?: ProbeClient
}

export interface ProbeResult {
  ok: boolean
  /** models.list succeeded; undefined when the client has no models API. */
  modelsListed?: boolean
  model: string
  latencyMs: number
  /** Present iff ok=false — the real completion-probe failure, never fabricated. */
  error?: Error
}

const PROBE_TOOL_DEF = {
  type: 'function',
  function: {
    name: 'probe_echo',
    description: 'First-run probe tool — never invoked; only checks tool-calling support.',
    parameters: { type: 'object', properties: {} },
  },
}

export async function probeProvider(opts: ProbeOptions): Promise<ProbeResult> {
  const timeoutMs = opts.timeoutMs ?? 15_000
  const client: ProbeClient = opts.client ?? (new OpenAI({
    apiKey: opts.apiKey,
    baseURL: opts.baseURL,
    timeout: timeoutMs,
  }) as unknown as ProbeClient)

  const startedAt = Date.now()

  // Observability, not a gate — 404/501 here says nothing about completions.
  let modelsListed: boolean | undefined
  if (typeof client.models?.list === 'function') {
    try {
      await client.models.list()
      modelsListed = true
    } catch {
      modelsListed = false
    }
  }

  try {
    const stream = await client.chat.completions.create({
      model: opts.model,
      messages: [{ role: 'user', content: 'Reply with the single word: ok' }],
      max_tokens: 16,
      stream: true,
      tools: [PROBE_TOOL_DEF],
    }, { timeout: timeoutMs })
    let gotChunk = false
    for await (const _chunk of stream) {
      gotChunk = true
    }
    const latencyMs = Date.now() - startedAt
    if (!gotChunk) {
      return {
        ok: false,
        modelsListed,
        model: opts.model,
        latencyMs,
        error: new Error('Provider returned an empty stream (no chunks received)'),
      }
    }
    return { ok: true, modelsListed, model: opts.model, latencyMs }
  } catch (err) {
    return {
      ok: false,
      modelsListed,
      model: opts.model,
      latencyMs: Date.now() - startedAt,
      error: err instanceof Error ? err : new Error(String(err)),
    }
  }
}
