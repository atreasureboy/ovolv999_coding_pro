import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DaemonServer, getDefaultDaemonSocketPath, type DaemonRequest } from '../../src/core/daemon/daemonServer.js'
import { DaemonClient } from '../../src/core/daemon/daemonClient.js'

async function fetchWithPort(port: number, body: unknown): Promise<{ status: number; json: unknown }> {
  const response = await fetch(`http://127.0.0.1:${port}/`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  return { status: response.status, json: await response.json() }
}

describe('DaemonServer', () => {
  let server: DaemonServer | undefined
  let port = 0

  beforeEach(async () => {
    server = new DaemonServer()
    await server.start()
    const envPort = process.env.OVOGO_DAEMON_PORT
    port = envPort ? parseInt(envPort, 10) : 0
  })

  afterEach(async () => {
    if (server) await server.stop()
    server = undefined
    delete process.env.OVOGO_DAEMON_PORT
  })

  it('starts and binds to loopback', () => {
    expect(port).toBeGreaterThan(0)
  })

  it('returns error on no listener', async () => {
    if (!server) throw new Error('server not initialized')
    const result = await fetchWithPort(port, { id: 1, op: 'list' } satisfies DaemonRequest)
    expect(result.status).toBe(500)
  })

  it('dispatches to attached listener', async () => {
    if (!server) throw new Error('server not initialized')
    server.setListener(async (req) => ({ id: req.id, ok: true, result: { ping: req.op } }))
    const result = await fetchWithPort(port, { id: 7, op: 'list' } satisfies DaemonRequest)
    expect(result.status).toBe(200)
    expect((result.json as { result?: { ping?: string } }).result?.ping).toBe('list')
  })

  it('rejects invalid JSON', async () => {
    const response = await fetch(`http://127.0.0.1:${port}/`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{ not json',
    })
    expect(response.status).toBe(400)
  })

  it('rejects non-POST methods', async () => {
    const response = await fetch(`http://127.0.0.1:${port}/`)
    expect(response.status).toBe(405)
  })
})

describe('DaemonClient', () => {
  it('reports isConfigured=false when no port set', () => {
    const client = new DaemonClient()
    expect(client.isConfigured()).toBe(false)
  })

  it('reports isConfigured=true when port set', () => {
    const client = new DaemonClient({ port: 1234 })
    expect(client.isConfigured()).toBe(true)
  })

  it('throws when sending without port', async () => {
    const client = new DaemonClient()
    await expect(client.send({ id: 1, op: 'list' })).rejects.toThrow(/port not configured/)
  })
})

describe('getDefaultDaemonSocketPath', () => {
  it('returns a non-empty path under home', () => {
    const path = getDefaultDaemonSocketPath()
    expect(path.length).toBeGreaterThan(0)
    expect(path).toContain('.ovolv999')
  })
})
