import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { McpHttpClient } from '../../src/core/mcpHttpClient.js'
import { storeToken } from '../../src/integrations/mcpOAuth.js'

function mockFetch(responses: Array<{ ok: boolean; status?: number; body: unknown }>): { calls: Array<{ url: string; headers: Record<string, string>; body: unknown }>; impl: typeof fetch } {
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
      { status: r.status ?? (r.ok ? 200 : 400), headers: { 'content-type': 'application/json' } },
    )
  }) as typeof fetch
  return { calls, impl }
}

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

  it('connects and lists tools', async () => {
    const { calls, impl } = mockFetch([
      { ok: true, body: { result: { tools: [{ name: 'foo', description: 'd', inputSchema: { type: 'object' } }] } } },
    ])
    const client = new McpHttpClient(
      { name: 'srv', type: 'http', url: 'https://mcp.example.com' },
      { fetchImpl: impl },
    )
    await client.connect()
    const tools = await client.listTools()
    expect(tools).toEqual([{ name: 'foo', description: 'd', inputSchema: { type: 'object' } }])
    expect(calls[0]?.url).toBe('https://mcp.example.com')
    expect(calls[0]?.body).toMatchObject({ method: 'tools/list' })
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
    await client.connect()
    await expect(client.listTools()).rejects.toThrow(/ovolv999 mcp auth/)
  })

  it('invokes tools/call with name + arguments', async () => {
    const { calls, impl } = mockFetch([
      { ok: true, body: { result: { content: 'ok' } } },
    ])
    const client = new McpHttpClient(
      { name: 'srv', type: 'http', url: 'https://mcp.example.com' },
      { fetchImpl: impl },
    )
    await client.connect()
    const result = await client.callTool('foo', { x: 1 })
    expect(result).toEqual({ content: 'ok' })
    expect(calls[0]?.body).toMatchObject({ method: 'tools/call', params: { name: 'foo', arguments: { x: 1 } } })
  })
})
