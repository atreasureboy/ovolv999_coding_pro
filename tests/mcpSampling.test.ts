import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { McpStdioClient } from '../src/core/mcpClient.js'

/**
 * Round 36 (MCP sampling): server→client completion requests round-trip —
 * the client routes sampling/createMessage to the wired handler and
 * answers with the handler's result, so MCP servers that depend on
 * sampling degrade gracefully instead of hanging.
 *
 * The fake server speaks newline-delimited JSON-RPC and HOLDS the
 * tools/list response until it has received the sampling reply — proving
 * the reply actually arrives over the wire.
 */

let dir = ''
let serverScript = ''
let replyFile = ''

const FAKE_SERVER_JS = `
const readline = require('readline')
const fs = require('fs')
const rl = readline.createInterface({ input: process.stdin })
const send = (o) => process.stdout.write(JSON.stringify(o) + '\\n')
const replyFile = process.env.REPLY_FILE
let toolsListId = null
let samplingSeen = false
let respondedTools = false

// Deterministic ordering: answer tools/list ONLY after BOTH the request
// arrived AND the sampling reply was observed (either success or error).
function respondTools() {
  if (respondedTools || toolsListId === null || !samplingSeen) return
  respondedTools = true
  send({ jsonrpc: '2.0', id: toolsListId, result: { tools: [{ name: 't1', description: 'd', inputSchema: { type: 'object' } }] } })
  setTimeout(() => process.exit(0), 100)
}

rl.on('line', (line) => {
  let msg
  try { msg = JSON.parse(line) } catch { return }
  if (msg.method === 'initialize') {
    send({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: '2024-11-05', capabilities: {}, serverInfo: { name: 'fake' } } })
  } else if (msg.method === 'notifications/initialized') {
    // Server-initiated sampling request AFTER the handshake completes.
    send({ jsonrpc: '2.0', id: 900, method: 'sampling/createMessage', params: { messages: [{ role: 'user', content: 'Say hi' }], maxTokens: 50 } })
  } else if (msg.method === 'tools/list') {
    toolsListId = msg.id
    respondTools()
  } else if (msg.id === 900) {
    fs.writeFileSync(replyFile, JSON.stringify(msg))
    samplingSeen = true
    respondTools()
  }
})
`

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ovogo-mcp-sampling-'))
  serverScript = join(dir, 'server.cjs')
  replyFile = join(dir, 'sampling-reply.json')
  writeFileSync(serverScript, FAKE_SERVER_JS, 'utf8')
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('MCP sampling', () => {
  it('answers sampling/createMessage with the handler result', async () => {
    const client = new McpStdioClient(
      { name: 'fake', type: 'stdio', command: ['node', serverScript], env: { REPLY_FILE: replyFile } },
      {
        samplingHandler: async (params) => ({
          role: 'assistant',
          content: { type: 'text', text: `sampled: ${(params.messages ?? []).length} message(s)` },
          model: 'fake-model',
          stopReason: 'endTurn',
        }),
      },
    )
    await client.connect()
    const tools = await client.listTools()
    expect(tools.map((t) => t.name)).toEqual(['t1'])
    await client.close()

    // The server wrote the reply it received before exiting.
    expect(existsSync(replyFile)).toBe(true)
    const reply = JSON.parse(readFileSync(replyFile, 'utf8')) as Record<string, unknown>
    expect(reply.id).toBe(900)
    expect(reply.error).toBeUndefined()
    const result = reply.result as Record<string, unknown>
    expect(result.role).toBe('assistant')
    expect(result.model).toBe('fake-model')
    expect((result.content as Record<string, unknown>).text).toBe('sampled: 1 message(s)')
  })

  it('rejects sampling with a protocol error when no handler is wired', async () => {
    // Same server, but the client has NO samplingHandler — the reply must
    // be an error so the server can degrade instead of hanging.
    const client = new McpStdioClient(
      { name: 'fake2', type: 'stdio', command: ['node', serverScript], env: { REPLY_FILE: replyFile } },
    )
    await client.connect()
    const tools = await client.listTools()
    expect(tools.map((t) => t.name)).toEqual(['t1'])
    await client.close()

    expect(existsSync(replyFile)).toBe(true)
    const reply = JSON.parse(readFileSync(replyFile, 'utf8')) as Record<string, unknown>
    const error = reply.error as Record<string, unknown>
    expect(error.code).toBe(-32601)
    expect(String(error.message)).toContain('sampling')
  })
})
