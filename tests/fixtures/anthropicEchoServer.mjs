/**
 * Fixture: minimal Anthropic Messages API server for real-CLI E2E tests.
 *
 *   POST /v1/messages → SSE stream with the EXACT usage shape the real
 *   API sends, designed to catch accounting regressions:
 *     message_start.usage = { input_tokens: 1000, output_tokens: 3,
 *                             cache_read_input_tokens: 4000,
 *                             cache_creation_input_tokens: 2000 }
 *     message_delta.usage = { output_tokens: 50 }   ← CUMULATIVE final
 *
 *   If the translator treats message_delta as a delta, completion tokens
 *   become 53 (3+50) or worse; if it double-emits usage, accumulating
 *   consumers over-count. The recorded request bodies let tests assert
 *   the wire-level cache_control breakpoints.
 *
 * Also serves GET /v1/models and an OpenAI-style /v1/chat/completions
 * fallback so incidental probes from the engine never crash the run.
 * Zero dependencies (node:http). Listens on 127.0.0.1 port 0.
 */
import { createServer } from 'node:http'

function sseFrames() {
  const frames = []
  const push = (event, data) => frames.push(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
  push('message_start', {
    type: 'message_start',
    message: {
      id: 'msg_e2e', type: 'message', role: 'assistant', content: [], model: 'claude-e2e',
      stop_reason: null,
      usage: { input_tokens: 1000, output_tokens: 3, cache_read_input_tokens: 4000, cache_creation_input_tokens: 2000 },
    },
  })
  push('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } })
  push('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'E2E response body' } })
  push('content_block_stop', { type: 'content_block_stop', index: 0 })
  push('message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 50 } })
  push('message_stop', { type: 'message_stop' })
  return frames.join('')
}

export async function startAnthropicServer() {
  const requests = []
  const server = createServer((req, res) => {
    const chunks = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8')
      let body = {}
      try { body = JSON.parse(raw) } catch { /* empty */ }

      if (req.method === 'GET' && req.url === '/v1/models') {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ object: 'list', data: [{ id: 'claude-e2e', object: 'model', created: 1, owned_by: 'fixture' }] }))
        return
      }

      if (req.method === 'POST' && req.url === '/v1/messages') {
        requests.push({ url: req.url, body })
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' })
        res.end(sseFrames())
        return
      }

      if (req.method === 'POST' && req.url === '/v1/chat/completions') {
        // OpenAI-protocol fallback for incidental engine probes.
        requests.push({ url: req.url, body })
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({
          id: 'chatcmpl-fixture', object: 'chat.completion', created: 1, model: body.model ?? 'claude-e2e',
          choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        }))
        return
      }

      res.writeHead(404)
      res.end()
    })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port
  return {
    port,
    baseURL: `http://127.0.0.1:${port}`,
    requests,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  }
}
