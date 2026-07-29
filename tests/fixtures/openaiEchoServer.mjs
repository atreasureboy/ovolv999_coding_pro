/**
 * Fixture: minimal OpenAI-compatible HTTP server for real-CLI spawn tests.
 *
 *   GET  /v1/models              → model list
 *   POST /v1/chat/completions    → echoes the last user message
 *
 * Modes (per server instance):
 *   'echo' (default) — SSE stream (when body.stream) or plain JSON; every
 *     response carries deterministic usage (11 prompt / 7 completion tokens)
 *     so costTracker stats are observable in the pipe envelope.
 *   '401' — every completions call returns a 401 invalid_api_key error.
 *
 * Zero dependencies (node:http). Listens on 127.0.0.1 port 0; the resolved
 * port is returned so callers can point OPENAI_BASE_URL at it.
 */
import { createServer } from 'node:http'

const USAGE = { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 }

function lastUserText(body) {
  const messages = Array.isArray(body.messages) ? body.messages : []
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]
    if (m && m.role === 'user') {
      if (typeof m.content === 'string') return m.content
      if (Array.isArray(m.content)) {
        return m.content
          .filter((p) => p && typeof p === 'object' && p.type === 'text')
          .map((p) => String(p.text ?? ''))
          .join('')
      }
    }
  }
  return ''
}

function jsonCompletion(model, text) {
  return {
    id: 'chatcmpl-fixture',
    object: 'chat.completion',
    created: 1,
    model,
    choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: 'stop' }],
    usage: USAGE,
  }
}

function streamChunks(model, text) {
  const base = { id: 'chatcmpl-fixture', object: 'chat.completion.chunk', created: 1, model }
  const third = Math.max(1, Math.ceil(text.length / 3))
  const pieces = [text.slice(0, third), text.slice(third, third * 2), text.slice(third * 2)].filter((p) => p !== '')
  const lines = []
  pieces.forEach((piece, i) => {
    lines.push(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: i === 0 ? { role: 'assistant', content: piece } : { content: piece }, finish_reason: null }] })}\n\n`)
  })
  lines.push(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\n`)
  lines.push(`data: ${JSON.stringify({ ...base, choices: [], usage: USAGE })}\n\n`)
  lines.push('data: [DONE]\n\n')
  return lines
}

function streamToolCall(model, id, name, args) {
  const base = { id: 'chatcmpl-fixture-tool', object: 'chat.completion.chunk', created: 1, model }
  return [
    `data: ${JSON.stringify({
      ...base,
      choices: [{
        index: 0,
        delta: { tool_calls: [{ index: 0, id, type: 'function', function: { name, arguments: JSON.stringify(args) } }] },
        finish_reason: null,
      }],
    })}\n\n`,
    `data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] })}\n\n`,
    'data: [DONE]\n\n',
  ]
}

/**
 * Start the echo server.
 * @param {{ mode?: 'echo' | '401' | 'plan-tool' }} [opts]
 * @returns {Promise<{ port: number, baseURL: string, close: () => Promise<void>, requests: Array<{ model: string, stream: boolean }> }>}
 *   baseURL already includes the `/v1` suffix expected by OPENAI_BASE_URL.
 *   `requests` logs every completions request body summary (v0.4.1 C4:
 *   model-on-the-wire parity checks across entry doors).
 */
export function startEchoServer(opts = {}) {
  const mode = opts.mode ?? 'echo'
  const requests = []
  const server = createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/v1/models') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ object: 'list', data: [{ id: 'echo-model', object: 'model', created: 1, owned_by: 'fixture' }] }))
      return
    }
    if (req.method === 'POST' && req.url === '/v1/chat/completions') {
      let raw = ''
      req.on('data', (c) => { raw += c })
      req.on('end', () => {
        if (mode === '401') {
          res.writeHead(401, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ error: { message: 'Incorrect API key provided: test-key.', type: 'invalid_request_error', param: null, code: 'invalid_api_key' } }))
          return
        }
        let body = {}
        try { body = JSON.parse(raw) } catch { /* empty body → echo '' */ }
        requests.push({ model: typeof body.model === 'string' ? body.model : '', stream: body.stream === true })
        const model = typeof body.model === 'string' && body.model ? body.model : 'echo-model'
        const text = `ECHO: ${lastUserText(body)}`
        if (body.stream === true) {
          res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' })
          const chunks = mode === 'plan-tool' && requests.length === 1
            ? streamToolCall(model, 'call_plan', 'ExitPlanMode', { plan: 'Inspect, implement, verify.' })
            : streamChunks(model, text)
          for (const line of chunks) res.write(line)
          res.end()
        } else {
          res.writeHead(200, { 'content-type': 'application/json' })
          res.end(JSON.stringify(jsonCompletion(model, text)))
        }
      })
      return
    }
    res.writeHead(404, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ error: { message: `fixture: no route for ${req.method} ${req.url}`, type: 'invalid_request_error' } }))
  })
  return new Promise((resolve, reject) => {
    server.on('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      const port = typeof address === 'object' && address ? address.port : 0
      resolve({
        port,
        baseURL: `http://127.0.0.1:${port}/v1`,
        close: () => new Promise((res) => { server.close(() => res()) }),
        requests,
      })
    })
  })
}
