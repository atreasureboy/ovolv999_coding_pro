import { describe, expect, it } from 'vitest'
import { Readable } from 'node:stream'
import { BufferedACPTransport, StdioACPTransport } from '../../src/integrations/acpTransport.js'

function bufferOf(lines: string[]): Readable {
  const readable = new Readable({ read() {} })
  process.nextTick(() => {
    readable.push(lines.join('\n') + '\n')
    readable.push(null)
  })
  return readable
}

function writableSink(): { writable: NodeJS.WritableStream; writes: string[] } {
  const writes: string[] = []
  const writable = new (require('node:stream').Writable)({
    write(chunk: string, _enc: string, cb: () => void) {
      writes.push(chunk)
      cb()
    },
  })
  return { writable, writes }
}

describe('BufferedACPTransport', () => {
  it('delivers injected frames to handler', () => {
    const t = new BufferedACPTransport()
    const received: string[] = []
    t.onMessage((f) => received.push(f))
    t.injectIncoming('{"jsonrpc":"2.0","id":1}')
    expect(received).toEqual(['{"jsonrpc":"2.0","id":1}'])
  })

  it('queues frames injected before handler is registered', () => {
    const t = new BufferedACPTransport()
    t.injectIncoming('a')
    t.injectIncoming('b')
    const received: string[] = []
    t.onMessage((f) => received.push(f))
    expect(received).toEqual(['a', 'b'])
  })

  it('records sent frames', () => {
    const t = new BufferedACPTransport()
    t.send('{"hello":1}\n')
    t.send('{"hello":2}\n')
    expect(t.getSentFrames()).toEqual(['{"hello":1}\n', '{"hello":2}\n'])
  })

  it('close stops delivering and sending', () => {
    const t = new BufferedACPTransport()
    t.close()
    expect(t.isOpen()).toBe(false)
    t.injectIncoming('a')
    t.send('b')
    expect(t.getSentFrames()).toEqual([])
  })
})

describe('StdioACPTransport', () => {
  it('parses lines from readable', async () => {
    const writable = writableSink()
    const transport = new StdioACPTransport(bufferOf(['{"x":1}', '{"x":2}']), writable.writable)
    const received: string[] = []
    transport.onMessage((f) => received.push(f))
    await new Promise((r) => setTimeout(r, 20))
    expect(received).toEqual(['{"x":1}', '{"x":2}'])
  })

  it('writes frames to writable', async () => {
    const writable = writableSink()
    const transport = new StdioACPTransport(bufferOf([]), writable.writable)
    transport.send('{"hello":1}\n')
    transport.send('{"hello":2}\n')
    await new Promise((r) => setTimeout(r, 5))
    expect(writable.writes.join('')).toContain('"hello":1')
    expect(writable.writes.join('')).toContain('"hello":2')
  })
})
