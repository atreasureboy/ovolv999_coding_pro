import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { existsSync } from 'node:fs'

import { McpStdioClient } from '../src/core/mcpClient.js'
import { McpToolAdapter } from '../src/tools/mcpToolAdapter.js'
import { McpModule } from '../src/modules/mcp.js'
import type { ModuleBootContext } from '../src/core/module.js'
import type { EngineConfig } from '../src/core/types.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const FIXTURE = join(__dirname, 'fixtures', 'mcpEchoServer.mjs')

function makeClient(name = 'echo'): McpStdioClient {
  return new McpStdioClient({
    name,
    type: 'stdio',
    command: [process.execPath, FIXTURE],
  })
}

describe('McpStdioClient — stdio JSON-RPC', () => {
  let client: McpStdioClient

  beforeEach(() => {
    client = makeClient()
  })

  afterEach(async () => {
    await client.close().catch(() => {})
  })

  it('fixture exists', () => {
    expect(existsSync(FIXTURE)).toBe(true)
  })

  it('T1: connect() resolves after initialize handshake', async () => {
    await expect(client.connect()).resolves.toBeUndefined()
  })

  it('T2: listTools() returns the echo tool', async () => {
    await client.connect()
    const tools = await client.listTools()
    expect(tools.length).toBeGreaterThanOrEqual(1)
    const echo = tools.find((t) => t.name === 'echo')
    expect(echo).toBeDefined()
    expect(echo!.description).toContain('Echo')
    expect(echo!.inputSchema).toMatchObject({ type: 'object' })
  })

  it('T3: callTool("echo", {msg}) returns prefixed text, isError=false', async () => {
    await client.connect()
    const r = await client.callTool('echo', { msg: 'hi' })
    expect(r.content).toBe('echo: hi')
    expect(r.isError).toBe(false)
  })

  it('T4: callTool("boom") returns isError=true', async () => {
    await client.connect()
    const r = await client.callTool('boom', {})
    expect(r.isError).toBe(true)
    expect(r.content).toContain('boom')
  })

  it('T5: close() is idempotent and stops the child process', async () => {
    await client.connect()
    await client.close()
    await expect(client.close()).resolves.toBeUndefined()
  })

  it('rejects when calling before connect', async () => {
    await expect(client.listTools()).rejects.toThrow(/not connected/)
  })
})

describe('McpToolAdapter', () => {
  it('T6: namespaced name + execute forwards to client.callTool', async () => {
    const client = makeClient('echo')
    await client.connect()
    const tools = await client.listTools()
    const adapter = new McpToolAdapter('echo', tools[0], client)
    expect(adapter.name).toBe('mcp__echo__echo')
    expect(adapter.definition.function.name).toBe('mcp__echo__echo')
    expect(adapter.isConcurrencySafe()).toBe(false)
    expect(adapter.metadata.readOnly).toBe(false)
    const result = await adapter.execute({ msg: 'world' }, { cwd: '/tmp' } as never)
    expect(result.content).toBe('echo: world')
    expect(result.isError).toBe(false)
    await client.close()
  })

  it('execute swallows client errors into isError result', async () => {
    const client = makeClient('echo')
    const adapter = new McpToolAdapter('echo', { name: 'nope', inputSchema: {} }, client)
    // not connected → callTool throws → adapter returns isError
    const result = await adapter.execute({}, { cwd: '/tmp' } as never)
    expect(result.isError).toBe(true)
    expect(result.content).toContain('failed')
  })
})

describe('McpModule — boot wiring', () => {
  it('T7: boot with echo server returns the mcp__echo__echo tool', async () => {
    const mod = new McpModule()
    const ctx: ModuleBootContext = {
      cwd: '/tmp',
      config: {
        mcp: {
          servers: [{ name: 'echo', type: 'stdio', command: [process.execPath, FIXTURE] }],
        },
      } as EngineConfig,
    }
    const result = await mod.boot(ctx)
    expect(result.tools).toBeDefined()
    expect(result.tools!.length).toBe(1)
    expect(result.tools![0].name).toBe('mcp__echo__echo')
  })

  it('boot with no servers returns empty result', async () => {
    const mod = new McpModule()
    const result = await mod.boot({ cwd: '/tmp', config: {} as EngineConfig })
    expect(result.tools ?? []).toHaveLength(0)
  })

  it('boot with a broken server does NOT throw (isolated failure)', async () => {
    const mod = new McpModule()
    const ctx: ModuleBootContext = {
      cwd: '/tmp',
      config: {
        mcp: {
          servers: [{ name: 'broken', type: 'stdio', command: [process.execPath, '/nonexistent/file.mjs'] }],
        },
      } as EngineConfig,
    }
    // should resolve (not throw) with empty tools
    const result = await mod.boot(ctx)
    expect(result.tools ?? []).toHaveLength(0)
  })

  it('T8: boot publishes mcpRegistry in toolContextPatch for connected servers', async () => {
    const mod = new McpModule()
    const ctx: ModuleBootContext = {
      cwd: '/tmp',
      config: {
        mcp: {
          servers: [{ name: 'echo', type: 'stdio', command: [process.execPath, FIXTURE] }],
        },
      } as EngineConfig,
    }
    const result = await mod.boot(ctx)
    expect(result.toolContextPatch).toBeDefined()
    const registry = result.toolContextPatch!.mcpRegistry
    expect(registry).toBeDefined()
    expect(registry!.size).toBe(1)
    expect(registry!.has('echo')).toBe(true)
    const entry = registry!.get('echo')!
    expect(entry.serverName).toBe('echo')
    // The registry entry exposes resource/prompt methods that the tools call.
    // The echo fixture does not implement resources/prompts, so these resolve to [].
    await expect(entry.client.listResources()).resolves.toEqual([])
    await expect(entry.client.listPrompts()).resolves.toEqual([])
    await mod.dispose()
  })

  it('T9: boot with NO connected servers does NOT publish mcpRegistry', async () => {
    const mod = new McpModule()
    const ctx: ModuleBootContext = {
      cwd: '/tmp',
      config: {
        mcp: {
          servers: [{ name: 'broken', type: 'stdio', command: [process.execPath, '/nonexistent/file.mjs'] }],
        },
      } as EngineConfig,
    }
    const result = await mod.boot(ctx)
    // No server connected → registry empty → patch should be absent (or empty)
    expect(result.toolContextPatch?.mcpRegistry).toBeFalsy()
  })
})
