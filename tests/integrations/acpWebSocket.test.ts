import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { connect } from 'node:net'
import { AcpWebSocketServer } from '../../src/integrations/acpWebSocket.js'
import type { ACPTransport } from '../../src/integrations/acpTransport.js'

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'
const ACCEPT_HASH_HEADER = (key: string): string =>
  Buffer.from(
    require('node:crypto').createHash('sha1').update(key + WS_GUID).digest('base64'),
  ).toString()

function buildHandshakeKey(): string {
  return Buffer.from(require('node:crypto').randomBytes(16)).toString('base64')
}

describe('AcpWebSocketServer', () => {
  let server: AcpWebSocketServer | undefined
  let port = 0
  const connectionPromises: Array<{ resolve: (t: ACPTransport) => void }> = []
  const authToken = 'test-auth-token'

  function setupConnectionCapture(): void {
    connectionPromises.length = 0
    server = new AcpWebSocketServer({
      port: 0,
      authToken,
      onConnection: (transport) => {
        const p = connectionPromises.shift()
        if (p) p.resolve(transport)
      },
    })
  }

  beforeEach(() => { setupConnectionCapture() })
  afterEach(async () => {
    if (server) await server.stop()
    server = undefined
  })

  it('accepts a valid WebSocket upgrade (handshake response includes correct Accept)', async () => {
    if (!server) throw new Error('server not initialized')
    const p = await server.start()
    port = p
    const key = buildHandshakeKey()
    const c = connect({ port, host: '127.0.0.1' }, () => {
      c.write([
        `GET /chat?token=${authToken} HTTP/1.1`,
        'Host: 127.0.0.1',
        'Upgrade: websocket',
        'Connection: Upgrade',
        `Sec-WebSocket-Key: ${key}`,
        'Sec-WebSocket-Version: 13',
        '',
        '',
      ].join('\r\n'))
    })
    await new Promise<void>((resolve) => c.once('connect', () => resolve()))
    const response = await new Promise<string>((resolve) => {
      let buf = ''
      c.on('data', (chunk: Buffer) => {
        buf += chunk.toString('utf8')
        if (buf.includes('\r\n\r\n')) resolve(buf)
      })
      setTimeout(() => resolve(buf), 500)
    })
    expect(response).toContain('101 Switching Protocols')
    expect(response).toContain(`Sec-WebSocket-Accept: ${ACCEPT_HASH_HEADER(key)}`)
    c.end()
  })

  it('rejects non-websocket upgrade (returns 404)', async () => {
    if (!server) throw new Error('server not initialized')
    const p = await server.start()
    port = p
    const c = connect({ port, host: '127.0.0.1' }, () => {
      c.write('GET / HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n')
    })
    await new Promise<void>((resolve) => c.once('connect', () => resolve()))
    const response = await new Promise<string>((resolve) => {
      let buf = ''
      c.on('data', (chunk: Buffer) => {
        buf += chunk.toString('utf8')
      })
      c.on('end', () => resolve(buf))
      setTimeout(() => resolve(buf), 500)
    })
    expect(response).toContain('404')
    c.end()
  })

  it('rejects wrong version', async () => {
    if (!server) throw new Error('server not initialized')
    const p = await server.start()
    port = p
    const c = connect({ port, host: '127.0.0.1' }, () => {
      c.write([
        `GET /chat?token=${authToken} HTTP/1.1`,
        'Host: 127.0.0.1',
        'Upgrade: websocket',
        'Connection: Upgrade',
        'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==',
        'Sec-WebSocket-Version: 8',
        '',
        '',
      ].join('\r\n'))
    })
    await new Promise<void>((resolve) => c.once('connect', () => resolve()))
    const response = await new Promise<string>((resolve) => {
      let buf = ''
      c.on('data', (chunk: Buffer) => {
        buf += chunk.toString('utf8')
        if (buf.includes('\r\n\r\n')) resolve(buf)
      })
      setTimeout(() => resolve(buf), 200)
    })
    expect(response).toContain('426')
    c.end()
  })

  it('serves /health endpoint', async () => {
    if (!server) throw new Error('server not initialized')
    const p = await server.start()
    port = p
    const c = connect({ port, host: '127.0.0.1' }, () => {
      c.write('GET /health HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n')
    })
    await new Promise<void>((resolve) => c.once('connect', () => resolve()))
    const response = await new Promise<string>((resolve) => {
      let buf = ''
      c.on('data', (chunk: Buffer) => {
        buf += chunk.toString('utf8')
      })
      c.on('end', () => resolve(buf))
    })
    expect(response).toContain('200')
    expect(response).toContain('"ok":true')
    c.end()
  })

  it('rejects an upgrade without a valid token', async () => {
    if (!server) throw new Error('server not initialized')
    port = await server.start()
    const c = connect({ port, host: '127.0.0.1' }, () => {
      c.write([
        'GET /chat HTTP/1.1',
        'Host: 127.0.0.1',
        'Upgrade: websocket',
        'Connection: Upgrade',
        `Sec-WebSocket-Key: ${buildHandshakeKey()}`,
        'Sec-WebSocket-Version: 13',
        '',
        '',
      ].join('\r\n'))
    })
    const response = await new Promise<string>((resolve) => {
      let buf = ''
      c.on('data', (chunk: Buffer) => { buf += chunk.toString('utf8') })
      c.on('end', () => resolve(buf))
    })
    expect(response).toContain('401 Unauthorized')
  })
})
