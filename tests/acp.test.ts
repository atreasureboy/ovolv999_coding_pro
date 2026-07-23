import { describe, it, expect, vi } from 'vitest'
import { Writable, Readable } from 'stream'
import {
  ACPServer,
  parseMessage,
  serializeMessage,
  okResponse,
  errorResponse,
  notification,
  RPC_ERRORS,
  ACP_VERSION,
  PROTOCOL_VERSION,
  type JsonRpcMessage,
  type ACPHandlers,
} from '../src/integrations/acp.js'

// ── Helpers ─────────────────────────────────────────────────────────────────

function createServer(handlers: ACPHandlers = {}, cwd = '/test'): {
  server: ACPServer
  output: string[]
} {
  const output: string[] = []
  const writeFn = (data: string) => { output.push(data) }
  const server = new ACPServer(handlers, { cwd, write: writeFn })
  return { server, output }
}

function getResponses(output: string[]): JsonRpcMessage[] {
  return output.map(line => JSON.parse(line) as JsonRpcMessage)
}

// ── Constants ───────────────────────────────────────────────────────────────

describe('Constants', () => {
  it('has version', () => {
    expect(ACP_VERSION).toBeTruthy()
    expect(PROTOCOL_VERSION).toBeTruthy()
  })

  it('has standard error codes', () => {
    expect(RPC_ERRORS.PARSE_ERROR.code).toBe(-32700)
    expect(RPC_ERRORS.INVALID_REQUEST.code).toBe(-32600)
    expect(RPC_ERRORS.METHOD_NOT_FOUND.code).toBe(-32601)
    expect(RPC_ERRORS.INVALID_PARAMS.code).toBe(-32602)
    expect(RPC_ERRORS.INTERNAL_ERROR.code).toBe(-32603)
  })
})

// ── Parsing ─────────────────────────────────────────────────────────────────

describe('parseMessage', () => {
  it('parses valid request', () => {
    const msg = parseMessage('{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}')
    expect(msg).not.toBeNull()
    expect((msg as { method: string }).method).toBe('initialize')
  })

  it('parses notification (no id)', () => {
    const msg = parseMessage('{"jsonrpc":"2.0","method":"shutdown"}')
    expect(msg).not.toBeNull()
  })

  it('parses response', () => {
    const msg = parseMessage('{"jsonrpc":"2.0","id":1,"result":{"ok":true}}')
    expect(msg).not.toBeNull()
  })

  it('returns null for empty line', () => {
    expect(parseMessage('')).toBeNull()
    expect(parseMessage('   ')).toBeNull()
  })

  it('returns null for invalid JSON', () => {
    expect(parseMessage('{invalid')).toBeNull()
  })

  it('returns null for non-object', () => {
    expect(parseMessage('"hello"')).toBeNull()
    expect(parseMessage('42')).toBeNull()
  })

  it('returns null for missing jsonrpc field', () => {
    expect(parseMessage('{"id":1,"method":"test"}')).toBeNull()
  })

  it('returns null for wrong jsonrpc version', () => {
    expect(parseMessage('{"jsonrpc":"1.0","method":"test"}')).toBeNull()
  })
})

describe('serializeMessage', () => {
  it('serializes to compact JSON', () => {
    const msg = notification('test', { x: 1 })
    const serialized = serializeMessage(msg)
    expect(serialized).toBe('{"jsonrpc":"2.0","method":"test","params":{"x":1}}')
  })
})

// ── Response builders ───────────────────────────────────────────────────────

describe('Response builders', () => {
  it('okResponse', () => {
    const r = okResponse(1, { ok: true })
    expect(r.jsonrpc).toBe('2.0')
    expect(r.id).toBe(1)
    expect(r.result).toEqual({ ok: true })
    expect(r.error).toBeUndefined()
  })

  it('errorResponse', () => {
    const r = errorResponse(2, -32601, 'not found')
    expect(r.id).toBe(2)
    expect(r.error?.code).toBe(-32601)
    expect(r.error?.message).toBe('not found')
  })

  it('errorResponse with data', () => {
    const r = errorResponse(3, -1, 'err', { detail: 'x' })
    expect(r.error?.data).toEqual({ detail: 'x' })
  })

  it('notification', () => {
    const n = notification('event', { a: 1 })
    expect(n.method).toBe('event')
    expect(n.params).toEqual({ a: 1 })
    expect('id' in n).toBe(false)
  })
})

// ── ACPServer: initialize ───────────────────────────────────────────────────

describe('ACPServer', () => {
  it('getCapabilities returns all capabilities', () => {
    const { server } = createServer()
    const caps = server.getCapabilities()
    expect(caps.streaming).toBe(true)
    expect(caps.tools).toBe(true)
    expect(caps.multiModal).toBe(true)
    expect(caps.worktrees).toBe(true)
    expect(caps.interrupts).toBe(true)
  })

  it('handles initialize request', async () => {
    const { server, output } = createServer()
    await server.handleMessage({
      jsonrpc: '2.0', id: 1, method: 'initialize', params: {},
    })
    const responses = getResponses(output)
    expect(responses).toHaveLength(1)
    const result = (responses[0] as { result: Record<string, unknown> }).result
    expect(result.protocolVersion).toBe(PROTOCOL_VERSION)
    expect((result.serverInfo as { name: string }).name).toBe('ovolv999')
    expect((result.serverInfo as { version: string }).version).toBe(ACP_VERSION)
    expect(result.capabilities).toBeDefined()
  })

  it('handles shutdown', async () => {
    const { server, output } = createServer()
    await server.handleMessage({ jsonrpc: '2.0', id: 1, method: 'shutdown' })
    const responses = getResponses(output)
    expect(responses).toHaveLength(1)
  })

  it('emits shutdown event', async () => {
    const { server } = createServer()
    const handler = vi.fn()
    server.on('shutdown', handler)
    await server.handleMessage({ jsonrpc: '2.0', id: 1, method: 'shutdown' })
    expect(handler).toHaveBeenCalledOnce()
  })

  it('returns method not found for unknown methods', async () => {
    const { server, output } = createServer()
    await server.handleMessage({
      jsonrpc: '2.0', id: 5, method: 'nonexistent/method', params: {},
    })
    const responses = getResponses(output)
    const r = responses[0] as { error: { code: number; message: string } }
    expect(r.error.code).toBe(-32601)
    expect(r.error.message).toContain('nonexistent')
  })
})

// ── ACPServer: message handling ─────────────────────────────────────────────

describe('ACPServer: message', () => {
  it('rejects message before initialize', async () => {
    const { server, output } = createServer({ onMessage: async () => 'hi' })
    await server.handleMessage({
      jsonrpc: '2.0', id: 1, method: 'message', params: { text: 'hello' },
    })
    const responses = getResponses(output)
    const r = responses[0] as { error: { code: number } }
    expect(r.error.code).toBe(-32600) // INVALID_REQUEST
  })

  it('handles message after initialize', async () => {
    const { server, output } = createServer({ onMessage: async () => 'Hello!' })
    // Initialize first
    await server.handleMessage({ jsonrpc: '2.0', id: 0, method: 'initialize' })
    output.length = 0

    await server.handleMessage({
      jsonrpc: '2.0', id: 1, method: 'message', params: { text: 'hi' },
    })
    const responses = getResponses(output)
    // Should have: message/received notification + response + response notification
    expect(responses.length).toBeGreaterThanOrEqual(2)

    // Find the response with id=1
    const responseWithId = responses.find(r => (r as { id?: number }).id === 1) as { result: { text: string; done: boolean } }
    expect(responseWithId.result.text).toBe('Hello!')
    expect(responseWithId.result.done).toBe(true)
  })

  it('passes images to handler', async () => {
    const onMessage = vi.fn(async (_text: string, images?: string[]) => `got ${images?.length ?? 0} images`)
    const { server, output } = createServer({ onMessage })
    await server.handleMessage({ jsonrpc: '2.0', id: 0, method: 'initialize' })
    output.length = 0

    await server.handleMessage({
      jsonrpc: '2.0', id: 1, method: 'message',
      params: { text: 'look', images: ['img1', 'img2'] },
    })
    expect(onMessage).toHaveBeenCalledWith('look', ['img1', 'img2'])
  })

  it('rejects empty text', async () => {
    const { server, output } = createServer({ onMessage: async () => 'x' })
    await server.handleMessage({ jsonrpc: '2.0', id: 0, method: 'initialize' })
    output.length = 0

    await server.handleMessage({
      jsonrpc: '2.0', id: 1, method: 'message', params: { text: '' },
    })
    const responses = getResponses(output)
    const r = responses[0] as { error: { code: number } }
    expect(r.error.code).toBe(-32602) // INVALID_PARAMS
  })

  it('returns error when no handler configured', async () => {
    const { server, output } = createServer({}) // no onMessage
    await server.handleMessage({ jsonrpc: '2.0', id: 0, method: 'initialize' })
    output.length = 0

    await server.handleMessage({
      jsonrpc: '2.0', id: 1, method: 'message', params: { text: 'hi' },
    })
    const responses = getResponses(output)
    const r = responses[0] as { error: { code: number } }
    expect(r.error.code).toBe(-32601) // METHOD_NOT_FOUND
  })

  it('handles handler errors', async () => {
    const { server, output } = createServer({
      onMessage: async () => { throw new Error('boom') },
    })
    await server.handleMessage({ jsonrpc: '2.0', id: 0, method: 'initialize' })
    output.length = 0

    await server.handleMessage({
      jsonrpc: '2.0', id: 1, method: 'message', params: { text: 'hi' },
    })
    const responses = getResponses(output)
    // Find the response with id=1 (not the message/received notification)
    const errorResp = responses.find(r => (r as { id?: number }).id === 1) as { error: { code: number; message: string } }
    expect(errorResp).toBeDefined()
    expect(errorResp.error.code).toBe(-32603) // INTERNAL_ERROR
    expect(errorResp.error.message).toContain('boom')
  })
})

// ── ACPServer: interrupt ────────────────────────────────────────────────────

describe('ACPServer: interrupt', () => {
  it('calls onInterrupt handler', async () => {
    const onInterrupt = vi.fn()
    const { server, output } = createServer({ onInterrupt })
    await server.handleMessage({ jsonrpc: '2.0', id: 0, method: 'initialize' })
    output.length = 0

    await server.handleMessage({ jsonrpc: '2.0', id: 1, method: 'interrupt' })
    expect(onInterrupt).toHaveBeenCalledOnce()
    const responses = getResponses(output)
    const r = responses[0] as { result: { interrupted: boolean } }
    expect(r.result.interrupted).toBe(true)
  })

  it('works without handler (no-op)', async () => {
    const { server, output } = createServer({})
    await server.handleMessage({ jsonrpc: '2.0', id: 0, method: 'initialize' })
    output.length = 0

    await server.handleMessage({ jsonrpc: '2.0', id: 1, method: 'interrupt' })
    const responses = getResponses(output)
    expect(responses).toHaveLength(1)
  })
})

// ── ACPServer: file operations ──────────────────────────────────────────────

describe('ACPServer: file/read', () => {
  it('reads from filesystem by default', async () => {
    const { server, output } = createServer({}, '/tmp')
    await server.handleMessage({ jsonrpc: '2.0', id: 0, method: 'initialize' })
    output.length = 0

    await server.handleMessage({
      jsonrpc: '2.0', id: 1, method: 'file/read', params: { path: '/etc/hostname' },
    })
    const responses = getResponses(output)
    const r = responses[0] as { result: { content: string } }
    expect(typeof r.result.content).toBe('string')
  })

  it('uses custom handler when provided', async () => {
    const { server, output } = createServer({ onFileRead: () => 'custom content' })
    await server.handleMessage({ jsonrpc: '2.0', id: 0, method: 'initialize' })
    output.length = 0

    await server.handleMessage({
      jsonrpc: '2.0', id: 1, method: 'file/read', params: { path: '/anywhere' },
    })
    const responses = getResponses(output)
    const r = responses[0] as { result: { content: string } }
    expect(r.result.content).toBe('custom content')
  })

  it('rejects missing path param', async () => {
    const { server, output } = createServer()
    await server.handleMessage({ jsonrpc: '2.0', id: 0, method: 'initialize' })
    output.length = 0

    await server.handleMessage({
      jsonrpc: '2.0', id: 1, method: 'file/read', params: {},
    })
    const responses = getResponses(output)
    const r = responses[0] as { error: { code: number } }
    expect(r.error.code).toBe(-32602) // INVALID_PARAMS
  })
})

describe('ACPServer: file/write', () => {
  it('writes to filesystem', async () => {
    const { server, output } = createServer({}, '/tmp')
    await server.handleMessage({ jsonrpc: '2.0', id: 0, method: 'initialize' })
    output.length = 0

    await server.handleMessage({
      jsonrpc: '2.0', id: 1, method: 'file/write',
      params: { path: '/tmp/acp-test-write.txt', content: 'hello acp' },
    })
    const responses = getResponses(output)
    const r = responses[0] as { result: { written: boolean } }
    expect(r.result.written).toBe(true)
  })

  it('uses custom handler', async () => {
    const onFileWrite = vi.fn()
    const { server, output } = createServer({ onFileWrite })
    await server.handleMessage({ jsonrpc: '2.0', id: 0, method: 'initialize' })
    output.length = 0

    await server.handleMessage({
      jsonrpc: '2.0', id: 1, method: 'file/write',
      params: { path: 'test.txt', content: 'data' },
    })
    expect(onFileWrite).toHaveBeenCalledWith('test.txt', 'data')
  })
})

// ── ACPServer: cost ─────────────────────────────────────────────────────────

describe('ACPServer: cost', () => {
  it('returns cost data when handler present', async () => {
    const { server, output } = createServer({
      onCost: () => ({ inputTokens: 1000, outputTokens: 500, totalCost: 0.05 }),
    })
    await server.handleMessage({ jsonrpc: '2.0', id: 0, method: 'initialize' })
    output.length = 0

    await server.handleMessage({ jsonrpc: '2.0', id: 1, method: 'cost' })
    const responses = getResponses(output)
    const r = responses[0] as { result: { totalCost: number } }
    expect(r.result.totalCost).toBe(0.05)
  })

  it('returns method not found when no handler', async () => {
    const { server, output } = createServer({})
    await server.handleMessage({ jsonrpc: '2.0', id: 0, method: 'initialize' })
    output.length = 0

    await server.handleMessage({ jsonrpc: '2.0', id: 1, method: 'cost' })
    const responses = getResponses(output)
    const r = responses[0] as { error: { code: number } }
    expect(r.error.code).toBe(-32601)
  })
})

// ── ACPServer: notifications (no id = no response) ──────────────────────────

describe('ACPServer: notifications', () => {
  it('does not respond to notifications (no id)', async () => {
    const { server, output } = createServer()
    await server.handleMessage({
      jsonrpc: '2.0', method: 'initialize', params: {},
    })
    expect(output).toHaveLength(0)
  })

  it('does not respond to unknown notification', async () => {
    const { server, output } = createServer()
    await server.handleMessage({
      jsonrpc: '2.0', method: 'some/notification', params: {},
    })
    expect(output).toHaveLength(0)
  })
})

// ── ACPServer: send and notify ──────────────────────────────────────────────

describe('ACPServer.send', () => {
  it('writes serialized message to output', () => {
    const { server, output } = createServer()
    server.send(notification('event', { x: 1 }))
    expect(output).toHaveLength(1)
    expect(output[0]).toContain('"method":"event"')
    expect(output[0]).toContain('"x":1')
    expect(output[0].endsWith('\n')).toBe(true)
  })

  it('notify is shorthand for send(notification)', () => {
    const { server, output } = createServer()
    server.notify('test', { a: 'b' })
    expect(output).toHaveLength(1)
    expect(output[0]).toContain('"method":"test"')
  })
})

// ── ACPServer: stdio integration ────────────────────────────────────────────

describe('ACPServer: stdio', () => {
  it('can start and stop', () => {
    const input = new Readable({ read() {} })
    const { server } = createServer()
    expect(() => server.start(input)).not.toThrow()
    expect(() => server.stop()).not.toThrow()
  })
})
