/**
 * ACP WebSocket transport — wraps a single WebSocket client connection
 * into an ACPTransport. Zero deps: raw WebSocket frame parsing per
 * RFC 6455 (handshake + text frames + close).
 *
 * NOT supported: binary frames, deflate extensions, WSS (TLS).
 * The transport refuses upgrades with these extensions so clients
 * fall back to plain WS.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { Socket } from 'node:net'
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import type { ACPTransport } from './acpTransport.js'

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'
const MAX_FRAME_BYTES = 1 << 20

export interface WebSocketConnection {
  remoteAddress?: string
  close(): void
  sendFrame(text: string): void
}

export class WebSocketACPTransport implements ACPTransport {
  private handler: ((frame: string) => void) | null = null
  private open = true
  private socket: Socket
  private buffer: Buffer = Buffer.alloc(0)
  private sendQueue: string[] = []
  private closing = false
  private closedListeners: Array<() => void> = []
  /** RFC 6455 fragmentation: payloads of the message currently being assembled. */
  private fragments: Buffer[] = []

  constructor(socket: Socket, private readonly remoteAddress: string | undefined) {
    this.socket = socket
    socket.on('data', (chunk: Buffer) => this.onData(chunk))
    socket.on('end', () => this.markClosed())
    socket.on('close', () => this.markClosed())
    socket.on('error', () => this.markClosed())
  }

  /** Underlying socket — exposed for connection-close wiring. */
  getSocket(): Socket {
    return this.socket
  }

  /** Subscribe to close events. Returns an unsubscribe function. */
  onClose(handler: () => void): () => void {
    this.closedListeners.push(handler)
    return () => {
      const idx = this.closedListeners.indexOf(handler)
      if (idx >= 0) this.closedListeners.splice(idx, 1)
    }
  }

  onMessage(handler: (frame: string) => void): void {
    this.handler = handler
  }

  send(frame: string): void {
    if (!this.open) return
    if (this.sendQueue.length >= 1000) {
      this.markClosed()
      return
    }
    this.sendQueue.push(frame)
    this.flush()
  }

  close(): void {
    if (this.closing) return
    this.closing = true
    try {
      this.socket.write(encodeFrame(0x8, Buffer.alloc(0)))
    } catch { /* noop */ }
    try { this.socket.end() } catch { /* noop */ }
    this.markClosed()
  }

  isOpen(): boolean {
    return this.open
  }

  private markClosed(): void {
    if (!this.open) return
    this.open = false
    for (const listener of this.closedListeners) {
      try { listener() } catch { /* noop */ }
    }
  }

  private flush(): void {
    if (!this.open || this.sendQueue.length === 0) return
    const queued = this.sendQueue.join('')
    this.sendQueue.length = 0
    try {
      const payload = Buffer.from(queued, 'utf8')
      // Split oversized batches at line boundaries — peers enforce the same
      // 1 MiB frame cap we do, and a line split across frames would parse
      // as two broken JSON lines on the receiving side.
      let start = 0
      while (start < payload.length) {
        let end = Math.min(start + MAX_FRAME_BYTES, payload.length)
        if (end < payload.length) {
          const lastNewline = payload.lastIndexOf(0x0a, end - 1)
          if (lastNewline <= start) {
            this.markClosed() // single line exceeds the frame cap
            return
          }
          end = lastNewline + 1
        }
        this.socket.write(encodeFrame(0x1, payload.subarray(start, end)))
        start = end
      }
    } catch {
      this.markClosed()
    }
  }

  private onData(chunk: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, chunk])
    while (this.buffer.length >= 2) {
      const first = this.buffer[0]
      const second = this.buffer[1]
      const fin = (first & 0x80) !== 0
      const op = first & 0x0f
      const masked = (second & 0x80) !== 0
      let payloadLen = second & 0x7f
      let offset = 2
      if (payloadLen === 126) {
        if (this.buffer.length < 4) return
        payloadLen = this.buffer.readUInt16BE(2)
        offset = 4
      } else if (payloadLen === 127) {
        if (this.buffer.length < 10) return
        payloadLen = Number(this.buffer.readBigUInt64BE(2))
        offset = 10
      }
      let maskKey: Buffer | null = null
      if (masked) {
        if (this.buffer.length < offset + 4) return
        maskKey = this.buffer.subarray(offset, offset + 4)
        offset += 4
      }
      if (this.buffer.length < offset + payloadLen) return
      if (payloadLen > MAX_FRAME_BYTES) {
        this.markClosed()
        return
      }
      let payload = this.buffer.subarray(offset, offset + payloadLen)
      if (maskKey) {
        payload = Buffer.alloc(payloadLen)
        for (let i = 0; i < payloadLen; i++) {
          payload[i] = this.buffer[offset + i] ^ maskKey[i % 4]
        }
      }
      this.buffer = this.buffer.subarray(offset + payloadLen)
      this.dispatchFrame(op, payload, fin)
      if (op === 0x8) {
        this.markClosed()
        return
      }
    }
  }

  private dispatchFrame(opcode: number, payload: Buffer, fin: boolean): void {
    if (opcode === 0x1 && fin) {
      this.dispatchText(payload.toString('utf8'))
      return
    }
    if (opcode === 0x1 || opcode === 0x0) {
      // RFC 6455 fragmentation: the FIN-less first text frame opens a
      // message; 0x0 continuations append; the FIN-bearing piece completes
      // it. Dropping fragments silently truncated JSON-RPC frames.
      if (opcode === 0x1) {
        this.fragments = [payload]
        return
      }
      if (this.fragments.length === 0) {
        this.markClosed() // stray continuation — protocol error
        return
      }
      this.fragments.push(payload)
      const total = this.fragments.reduce((sum, part) => sum + part.length, 0)
      if (total > MAX_FRAME_BYTES) {
        this.markClosed()
        return
      }
      if (!fin) return
      const text = Buffer.concat(this.fragments).toString('utf8')
      this.fragments = []
      this.dispatchText(text)
      return
    }
    if (opcode === 0x8) {
      this.close()
    } else if (opcode === 0x9) {
      try { this.socket.write(encodeFrame(0xA, payload)) } catch { /* noop */ }
    }
  }

  private dispatchText(text: string): void {
    const lines = text.split('\n')
    for (const line of lines) {
      if (line.trim() && this.handler) this.handler(line)
    }
  }
}

function encodeFrame(opcode: number, payload: Buffer): Buffer {
  const len = payload.length
  let header: Buffer
  if (len < 126) {
    header = Buffer.alloc(2)
    header[0] = 0x80 | opcode
    header[1] = len
  } else if (len < 65536) {
    header = Buffer.alloc(4)
    header[0] = 0x80 | opcode
    header[1] = 126
    header.writeUInt16BE(len, 2)
  } else {
    header = Buffer.alloc(10)
    header[0] = 0x80 | opcode
    header[1] = 127
    header.writeBigUInt64BE(BigInt(len), 2)
  }
  return Buffer.concat([header, payload], header.length + payload.length)
}

export interface AcpWebSocketServerOptions {
  port: number
  host?: string
  authToken: string
  /** Optional callback per connection — receives the raw Socket and the ACPServer transport. */
  onConnection?: (transport: WebSocketACPTransport, remoteAddress: string | undefined) => void
  /**
   * Security (H4): allowed browser origins for the WebSocket handshake.
   * Requests WITHOUT an Origin header (non-browser clients) are always
   * allowed. When an Origin IS present (any webpage can open
   * ws://127.0.0.1:port from the user's browser), it must match an entry
   * here. Default: loopback origins only (http://localhost and
   * http://127.0.0.1 on any port) — cross-site WebSocket hijacking
   * otherwise lets a malicious page drive the agent.
   */
  allowedOrigins?: string[]
}

export class AcpWebSocketServer {
  private server: Server | null = null
  private readonly transports = new Set<WebSocketACPTransport>()

  constructor(private readonly options: AcpWebSocketServerOptions) {}

  async start(): Promise<number> {
    if (this.server) return this.options.port
    return new Promise((resolve, reject) => {
      const server = createServer((req: IncomingMessage, res: ServerResponse) => {
        if (req.url === '/health') {
          res.writeHead(200, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ ok: true, connections: this.transports.size }))
          return
        }
        res.writeHead(404)
        res.end()
      })
      server.on('upgrade', (req, socket) => {
        try {
          this.handleUpgrade(req, socket as Socket)
        } catch {
          try { (socket as Socket).destroy() } catch { /* noop */ }
        }
      })
      server.on('error', reject)
      server.listen(this.options.port, this.options.host ?? '127.0.0.1', () => {
        const addr = server.address()
        const port = typeof addr === 'object' && addr ? addr.port : this.options.port
        this.server = server
        resolve(port)
      })
    })
  }

  async stop(): Promise<void> {
    for (const t of this.transports) t.close()
    this.transports.clear()
    if (!this.server) return
    await new Promise<void>((resolve, reject) => {
      this.server!.close((err) => {
        this.server = null
        if (err) reject(err)
        else resolve()
      })
    })
  }

  getConnectionCount(): number {
    return this.transports.size
  }

  private isOriginAllowed(origin: string): boolean {
    const allowed = this.options.allowedOrigins
    if (allowed && allowed.length > 0) {
      return allowed.includes(origin)
    }
    // Default policy: loopback origins only (any port)
    try {
      const u = new URL(origin)
      if (u.protocol !== 'http:' && u.protocol !== 'https:') return false
      return u.hostname === 'localhost' || u.hostname === '127.0.0.1' || u.hostname === '[::1]' || u.hostname === '::1'
    } catch {
      return false
    }
  }

  private handleUpgrade(req: IncomingMessage, socket: Socket): void {
    const authorization = req.headers.authorization
    const bearer = typeof authorization === 'string' && authorization.startsWith('Bearer ')
      ? authorization.slice(7)
      : ''
    const queryToken = (() => {
      try {
        return new URL(req.url ?? '/', 'http://localhost').searchParams.get('token') ?? ''
      } catch {
        return ''
      }
    })()
    const suppliedToken = bearer || queryToken
    const expected = Buffer.from(this.options.authToken)
    const supplied = Buffer.from(suppliedToken)
    if (expected.length === 0 || expected.length !== supplied.length || !timingSafeEqual(expected, supplied)) {
      socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n')
      socket.destroy()
      return
    }

    // Security (H4): Origin check. Browsers force an Origin header on
    // cross-site WebSocket handshakes; native clients send none. Allow
    // origin-less requests (CLI/ACP agents), reject browser origins that
    // are not explicitly allowed.
    const origin = req.headers.origin
    if (origin !== undefined && !this.isOriginAllowed(String(origin))) {
      socket.write('HTTP/1.1 403 Forbidden\r\n\r\n')
      socket.destroy()
      return
    }
    const key = req.headers['sec-websocket-key']
    const version = req.headers['sec-websocket-version']
    if (req.headers.upgrade?.toLowerCase() !== 'websocket') {
      socket.write('HTTP/1.1 400 Bad Request\r\n\r\n')
      socket.destroy()
      return
    }
    if (version !== '13') {
      socket.write('HTTP/1.1 426 Upgrade Required\r\nSec-WebSocket-Version: 13\r\n\r\n')
      socket.destroy()
      return
    }
    if (!key || Array.isArray(key)) {
      socket.write('HTTP/1.1 400 Bad Request\r\n\r\n')
      socket.destroy()
      return
    }
    const extensions = (req.headers['sec-websocket-extensions'] ?? '').toString()
    if (/(permessage-deflate|pmce)/i.test(extensions)) {
      socket.write('HTTP/1.1 400 Bad Request\r\nSec-WebSocket-Extensions: none supported\r\n\r\n')
      socket.destroy()
      return
    }
    const accept = createHash('sha1').update(key + WS_GUID).digest('base64')
    const headers = [
      'HTTP/1.1 101 Switching Protocols',
      'Upgrade: websocket',
      'Connection: Upgrade',
      `Sec-WebSocket-Accept: ${accept}`,
      '',
      '',
    ].join('\r\n')
    socket.write(headers)
    const remoteAddress = socket.remoteAddress ?? undefined
    const transport = new WebSocketACPTransport(socket, remoteAddress)
    this.transports.add(transport)
    socket.once('close', () => {
      this.transports.delete(transport)
    })
    if (this.options.onConnection) {
      try {
        this.options.onConnection(transport, remoteAddress)
      } catch {
        transport.close()
      }
    }
  }
}

export function generateSessionId(): string {
  return randomBytes(16).toString('hex')
}

export const _MAX_FRAME_BYTES = MAX_FRAME_BYTES
