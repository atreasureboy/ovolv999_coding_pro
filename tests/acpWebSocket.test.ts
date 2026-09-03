import { describe, expect, it } from 'vitest'
import { EventEmitter } from 'node:events'
import type { Socket } from 'node:net'
import { WebSocketACPTransport } from '../src/integrations/acpWebSocket.js'

class FakeSocket extends EventEmitter {
  remoteAddress = '127.0.0.1'
  written: Buffer[] = []
  ended = false

  write(chunk: Buffer | string): boolean {
    this.written.push(Buffer.isBuffer(chunk) ? Buffer.from(chunk) : Buffer.from(chunk))
    return true
  }

  end(): void {
    this.ended = true
  }

  feed(chunk: Buffer): void {
    this.emit('data', chunk)
  }

  framesWritten(): string[] {
    const out: string[] = []
    for (const buf of this.written) {
      let offset = 0
      while (offset + 2 <= buf.length) {
        const lenByte = buf[offset + 1] & 0x7f
        let headerLen = 2
        let payloadLen = lenByte
        if (lenByte === 126) { payloadLen = buf.readUInt16BE(offset + 2); headerLen = 4 }
        else if (lenByte === 127) { payloadLen = Number(buf.readBigUInt64BE(offset + 2)); headerLen = 10 }
        out.push(buf.subarray(offset + headerLen, offset + headerLen + payloadLen).toString('utf8'))
        offset += headerLen + payloadLen
      }
    }
    return out
  }
}

function clientFrame(payload: Buffer, opcode = 0x1, fin = true): Buffer {
  const mask = Buffer.from([0x11, 0x22, 0x33, 0x44])
  const masked = Buffer.from(payload)
  for (let i = 0; i < masked.length; i++) masked[i] ^= mask[i % 4]
  const len = payload.length
  let header: Buffer
  if (len < 126) {
    header = Buffer.alloc(2)
    header[1] = 0x80 | len
  } else if (len < 65536) {
    header = Buffer.alloc(4)
    header[1] = 0x80 | 126
    header.writeUInt16BE(len, 2)
  } else {
    header = Buffer.alloc(10)
    header[1] = 0x80 | 127
    header.writeBigUInt64BE(BigInt(len), 2)
  }
  header[0] = (fin ? 0x80 : 0) | opcode
  return Buffer.concat([header, mask, masked])
}

describe('WebSocketACPTransport', () => {
  it('assembles fragmented text messages before dispatch', () => {
    const socket = new FakeSocket()
    const transport = new WebSocketACPTransport(socket as unknown as Socket, '127.0.0.1')
    const frames: string[] = []
    transport.onMessage((line) => frames.push(line))

    const part1 = Buffer.from('{"jsonrpc":"2.0","id":1,', 'utf8')
    const part2 = Buffer.from('"method":"message"', 'utf8')
    const part3 = Buffer.from(',"params":{"text":"hi"}}\n', 'utf8')
    socket.feed(clientFrame(part1, 0x1, false))
    socket.feed(clientFrame(part2, 0x0, false))
    // control frames may interleave fragments (RFC 6455 §5.4)
    socket.feed(clientFrame(Buffer.from('ping'), 0x9, true))
    socket.feed(clientFrame(part3, 0x0, true))

    expect(frames).toEqual(['{"jsonrpc":"2.0","id":1,"method":"message","params":{"text":"hi"}}'])
    // the interleaved ping was answered with a pong (opcode 0xA)
    expect(socket.framesWritten().length).toBe(1)
  })

  it('does not dispatch a FIN-less first fragment early', () => {
    const socket = new FakeSocket()
    const transport = new WebSocketACPTransport(socket as unknown as Socket, '127.0.0.1')
    const frames: string[] = []
    transport.onMessage((line) => frames.push(line))

    socket.feed(clientFrame(Buffer.from('{"partial":', 'utf8'), 0x1, false))
    expect(frames).toEqual([])
    expect(transport.isOpen()).toBe(true)
  })

  it('closes the connection on a stray continuation frame', () => {
    const socket = new FakeSocket()
    const transport = new WebSocketACPTransport(socket as unknown as Socket, '127.0.0.1')
    transport.onMessage(() => { /* noop */ })

    socket.feed(clientFrame(Buffer.from('orphan', 'utf8'), 0x0, true))
    expect(transport.isOpen()).toBe(false)
  })

  it('splits oversized outbound batches at line boundaries', () => {
    const socket = new FakeSocket()
    const transport = new WebSocketACPTransport(socket as unknown as Socket, '127.0.0.1')
    const lines: string[] = []
    for (let i = 0; i < 1400; i++) {
      lines.push(JSON.stringify({ jsonrpc: '2.0', method: 'response', params: { text: 'x'.repeat(1000), seq: i } }))
    }
    for (const line of lines) transport.send(line + '\n')

    const frames = socket.framesWritten()
    expect(frames.length).toBeGreaterThan(1)
    // every frame stays within the 1 MiB cap
    for (const frame of frames) expect(Buffer.byteLength(frame)).toBeLessThanOrEqual(1 << 20)
    // reassembled output preserves every line intact
    const text = frames.join('')
    expect(text.split('\n').filter((line) => line.trim()).length).toBe(lines.length)
  })
})
