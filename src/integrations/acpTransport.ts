/**
 * ACP transport abstraction — let ACPServer run over any byte
 * stream that can produce line-delimited JSON-RPC frames and write
 * them back.
 *
 * Existing stdio transport uses Node's readline + process.stdout;
 * the WebSocket transport wraps a single client connection. Both
 * implement this same interface so ACPServer can be reused.
 */

export interface ACPTransport {
  /** Register a handler invoked per received JSON-RPC frame (one frame = one line). */
  onMessage(handler: (frame: string) => void): void
  /** Write a JSON-RPC frame to the peer (must include trailing newline). */
  send(frame: string): void
  /** Close the underlying connection. Idempotent. */
  close(): void
  /** Whether the transport is currently open. */
  isOpen(): boolean
}

export class StdioACPTransport implements ACPTransport {
  private handler: ((frame: string) => void) | null = null
  private open = true

  constructor(
    private readonly reader: NodeJS.ReadableStream = process.stdin,
    private readonly writer: NodeJS.WritableStream = process.stdout,
  ) {
    let buffer = ''
    reader.setEncoding('utf8')
    reader.on('data', (chunk: string) => {
      buffer += chunk
      let nl: number
      while ((nl = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, nl)
        buffer = buffer.slice(nl + 1)
        if (line.trim() && this.handler) this.handler(line)
      }
    })
    reader.on('end', () => {
      this.open = false
    })
    reader.on('close', () => {
      this.open = false
    })
  }

  onMessage(handler: (frame: string) => void): void {
    this.handler = handler
  }

  send(frame: string): void {
    if (!this.open) return
    this.writer.write(frame)
  }

  close(): void {
    this.open = false
    try { (this.writer as { end?: () => void }).end?.() } catch { /* noop */ }
  }

  isOpen(): boolean {
    return this.open
  }
}

export class BufferedACPTransport implements ACPTransport {
  private handler: ((frame: string) => void) | null = null
  private open = true
  private readonly pendingIncoming: string[] = []
  private readonly sentFrames: string[] = []

  onMessage(handler: (frame: string) => void): void {
    this.handler = handler
    for (const frame of this.pendingIncoming) handler(frame)
    this.pendingIncoming.length = 0
  }

  send(frame: string): void {
    if (!this.open) return
    this.sentFrames.push(frame)
  }

  close(): void {
    this.open = false
  }

  isOpen(): boolean {
    return this.open
  }

  injectIncoming(frame: string): void {
    if (!this.open) return
    if (this.handler) this.handler(frame)
    else this.pendingIncoming.push(frame)
  }

  getSentFrames(): string[] {
    return [...this.sentFrames]
  }

  clearSentFrames(): void {
    this.sentFrames.length = 0
  }
}
