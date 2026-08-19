import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { McpHttpClient } from '../../src/core/mcpHttpClient.js'
import { storeToken } from '../../src/integrations/mcpOAuth.js'

interface MockResponse {
  ok: boolean
  status?: number
  body: unknown
  headers?: Record<string, string>
}

function mockFetch(responses: MockResponse[]): { calls: Array<{ url: string; headers: Record<string, string>; body: unknown }>; impl: typeof fetch } {
  const calls: Array<{ url: string; headers: Record<string, string>; body: unknown }> = []
  let i = 0
  const impl = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({
      url: typeof input === 'string' ? input : input.toString(),
      headers: init?.headers as Record<string, string> ?? {},
      body: init?.body ? JSON.parse(init.body as string) : undefined,
    })
    const r = responses[i++] ?? responses[responses.length - 1]
    return new Response(
      typeof r.body === 'string' ? r.body : JSON.stringify(r.body),
      {
        status: r.status ?? (r.ok ? 200 : 400),
        headers: { 'content-type': 'application/json', ...(r.headers ?? {}) },
      },
    )
  }) as typeof fetch
  return { calls, impl }
}

/** Successful initialize answer (everything after this index is post-handshake). */
const INIT_OK: MockResponse = {
  ok: true,
  body: { result: { protocolVersion: '2024-11-05', capabilities: {}, serverInfo: { name: 'srv', version: '1.0' } } },
}
/** Consumed by the notifications/initialized POST (body never parsed). */
const NOTIFY_OK: MockResponse = { ok: true, status: 202, body: '' }
/** connect() = initialize + notifications/initialized → two responses. */
const HANDSHAKE: MockResponse[] = [INIT_OK, NOTIFY_OK]

describe('McpHttpClient', () => {
  let dir: string
  const oldHome = process.env.HOME

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'mcp-http-'))
    process.env.HOME = dir
  })
  afterEach(() => {
    process.env.HOME = oldHome
    rmSync(dir, { recursive: true, force: true })
  })

  it('runs the real initialize handshake before any other request', async () => {
    const { calls, impl } = mockFetch([
      ...HANDSHAKE,
      { ok: true, body: { result: { tools: [{ name: 'foo', description: 'd', inputSchema: { type: 'object' } }] } } },
    ])
    const client = new McpHttpClient(
      { name: 'srv', type: 'http', url: 'https://mcp.example.com' },
      { fetchImpl: impl },
    )
    await client.connect()
    expect(client.getServerInfo()).toEqual({ name: 'srv', version: '1.0' })
    expect(calls[0]?.body).toMatchObject({
      method: 'initialize',
      params: { protocolVersion: '2024-11-05', clientInfo: { name: 'ovolv999' } },
    })
    expect(calls[1]?.body).toMatchObject({ method: 'notifications/initialized' })
    expect((calls[1]?.body as { id?: unknown }).id).toBeUndefined()

    const tools = await client.listTools()
    expect(tools).toEqual([{ name: 'foo', description: 'd', inputSchema: { type: 'object' } }])
    expect(calls[2]?.body).toMatchObject({ method: 'tools/list' })
  })

  it('echoes the mcp-session-id issued by the server', async () => {
    const { calls, impl } = mockFetch([
      { ...INIT_OK, headers: { 'mcp-session-id': 'sess-42' } },
      NOTIFY_OK,
      { ok: true, body: { result: { tools: [] } } },
    ])
    const client = new McpHttpClient(
      { name: 'srv', type: 'http', url: 'https://mcp.example.com' },
      { fetchImpl: impl },
    )
    await client.connect()
    await client.listTools()
    expect(calls[1]?.headers['mcp-session-id']).toBe('sess-42')
    expect(calls[2]?.headers['mcp-session-id']).toBe('sess-42')
  })

  it('parses SSE initialize responses', async () => {
    const sse = 'event: message\ndata: {"jsonrpc":"2.0","id":1,"result":{"protocolVersion":"2024-11-05","serverInfo":{"name":"sse-srv"}}}\n\n'
    const { impl } = mockFetch([
      { ok: true, body: sse, headers: { 'content-type': 'text/event-stream' } },
      NOTIFY_OK,
    ])
    const client = new McpHttpClient(
      { name: 'srv', type: 'http', url: 'https://mcp.example.com' },
      { fetchImpl: impl },
    )
    await client.connect()
    expect(client.getServerInfo()).toEqual({ name: 'sse-srv' })
  })

  it('connect rejects when the handshake fails', async () => {
    const { impl } = mockFetch([{ ok: false, status: 500, body: { error: { code: -32603, message: 'boom' } } }])
    const client = new McpHttpClient(
      { name: 'srv', type: 'http', url: 'https://mcp.example.com' },
      { fetchImpl: impl },
    )
    await expect(client.connect()).rejects.toThrow(/initialize/)
    expect(client.isConnected).toBe(false)
  })

  it('throws when connecting to non-http config', async () => {
    const { impl } = mockFetch([])
    const client = new McpHttpClient({ name: 'srv', type: 'stdio', command: ['x'] }, { fetchImpl: impl })
    await expect(client.connect()).rejects.toThrow(/non-http/)
  })

  it('attaches Authorization: Bearer from oauth token store', async () => {
    storeToken({
      serverId: 'auth-srv',
      accessToken: 'token-abc',
      acquiredAt: Date.now(),
      expiresAt: Date.now() + 3600_000,
    })
    const { calls, impl } = mockFetch([
      ...HANDSHAKE,
      { ok: true, body: { result: { tools: [] } } },
    ])
    const client = new McpHttpClient(
      {
        name: 'auth-srv',
        type: 'http',
        url: 'https://mcp.example.com',
        oauth: {
          authorizationEndpoint: 'https://auth.example.com/authorize',
          tokenEndpoint: 'https://auth.example.com/token',
          clientId: 'cid',
          redirectUri: 'http://localhost/callback',
        },
      },
      { fetchImpl: impl },
    )
    await client.connect()
    await client.listTools()
    expect(calls[0]?.headers['authorization']).toBe('Bearer token-abc')
  })

  it('throws with actionable message when oauth fails', async () => {
    const { impl } = mockFetch([])
    const client = new McpHttpClient(
      {
        name: 'no-auth',
        type: 'http',
        url: 'https://mcp.example.com',
        oauth: {
          authorizationEndpoint: 'https://auth.example.com/authorize',
          tokenEndpoint: 'https://auth.example.com/token',
          clientId: 'cid',
          redirectUri: 'http://localhost/callback',
        },
      },
      { fetchImpl: impl },
    )
    await expect(client.connect()).rejects.toThrow(/ovolv999 mcp auth/)
  })

  it('invokes tools/call with name + arguments', async () => {
    const { calls, impl } = mockFetch([
      ...HANDSHAKE,
      { ok: true, body: { result: { content: [{ type: 'text', text: 'ok' }] } } },
    ])
    const client = new McpHttpClient(
      { name: 'srv', type: 'http', url: 'https://mcp.example.com' },
      { fetchImpl: impl },
    )
    await client.connect()
    const result = await client.callTool('foo', { x: 1 })
    expect(result).toEqual({ content: 'ok', isError: false })
    expect(calls[2]?.body).toMatchObject({ method: 'tools/call', params: { name: 'foo', arguments: { x: 1 } } })
  })

  it('listResources / readResource / listPrompts parse responses', async () => {
    const { calls, impl } = mockFetch([
      ...HANDSHAKE,
      { ok: true, body: { result: { resources: [{ uri: 'file:///a', name: 'A', description: 'd', mimeType: 'text/plain' }] } } },
      { ok: true, body: { result: { contents: [{ uri: 'file:///a', mimeType: 'text/plain', text: 'hello' }] } } },
      { ok: true, body: { result: { prompts: [{ name: 'summarize', description: 'Summarize', arguments: [{ name: 'topic', required: true }] }] } } },
    ])
    const client = new McpHttpClient(
      { name: 'srv', type: 'http', url: 'https://mcp.example.com' },
      { fetchImpl: impl },
    )
    await client.connect()

    const resources = await client.listResources()
    expect(resources).toEqual([{ uri: 'file:///a', name: 'A', description: 'd', mimeType: 'text/plain' }])

    const contents = await client.readResource('file:///a')
    expect(contents).toEqual([{ uri: 'file:///a', mimeType: 'text/plain', text: 'hello' }])

    const prompts = await client.listPrompts()
    expect(prompts).toEqual([{ name: 'summarize', description: 'Summarize', arguments: [{ name: 'topic', description: undefined, required: true }] }])

    expect(calls.slice(2).map((c) => (c.body as { method: string }).method)).toEqual(['resources/list', 'resources/read', 'prompts/list'])
  })

  it('listResources and listPrompts return empty on error (best-effort)', async () => {
    const { impl } = mockFetch([
      ...HANDSHAKE,
      { ok: false, status: 404, body: { error: { code: -32601, message: 'not found' } } },
      { ok: false, status: 404, body: { error: { code: -32601, message: 'not found' } } },
    ])
    const client = new McpHttpClient(
      { name: 'srv', type: 'http', url: 'https://mcp.example.com' },
      { fetchImpl: impl },
    )
    await client.connect()
    await expect(client.listResources()).resolves.toEqual([])
    await expect(client.listPrompts()).resolves.toEqual([])
  })
})
