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
import { createHash, randomBytes } from 'node:crypto'
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
      this.socket.write(encodeFrame(0x1, Buffer.from(queued, 'utf8')))
    } catch {
      this.markClosed()
    }
  }

  private onData(chunk: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, chunk])
    while (this.buffer.length >= 2) {
      const first = this.buffer[0]
      const second = this.buffer[1]
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
      this.dispatchFrame(op, payload)
      if (op === 0x8) {
        this.markClosed()
        return
      }
    }
  }

  private dispatchFrame(opcode: number, payload: Buffer): void {
    if (opcode === 0x1) {
      const text = payload.toString('utf8')
      const lines = text.split('\n')
      for (const line of lines) {
        if (line.trim() && this.handler) this.handler(line)
      }
    } else if (opcode === 0x8) {
      this.close()
    } else if (opcode === 0x9) {
      try { this.socket.write(encodeFrame(0xA, payload)) } catch { /* noop */ }
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
  /** Optional callback per connection — receives the raw Socket and the ACPServer transport. */
  onConnection?: (transport: WebSocketACPTransport, remoteAddress: string | undefined) => void
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

  private handleUpgrade(req: IncomingMessage, socket: Socket): void {
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
