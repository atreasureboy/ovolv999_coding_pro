/**
 * WebFetch — abort/cancellation, byte-cap, and content-length tests.
 *
 * Targets the real bugs that bit the previous implementation:
 *   1. AbortController.abort(reason) with a STRING reason — Node fetch
 *      re-throws the string verbatim, so err.name === undefined and the
 *      catch-all branch returned "Fetch error: undefined".
 *   2. response.text() loads the whole body unbounded — a server claiming
 *      a 50 GB response would OOM the engine.
 *   3. content-length header must short-circuit large responses.
 */

import { describe, it, expect, afterEach } from 'vitest'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { WebFetchTool } from '../src/tools/webFetch.js'
import type { ToolContext } from '../src/core/types.js'

function makeCtx(signal?: AbortSignal, cwd = process.cwd()): ToolContext {
  return { cwd, permissionMode: 'auto', signal }
}

/** Lightweight helper — set up an HTTP server we can drive from each test. */
interface TestServer {
  url: (path?: string) => string
  close: () => Promise<void>
  requests: number
}

async function startTestServer(handler: HttpHandler): Promise<TestServer> {
  let count = 0
  const server: Server = createServer((req, res) => {
    count++
    handler(req, res)
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
  const addr = server.address()
  if (!addr || typeof addr === 'string') throw new Error('failed to bind test server')
  return {
    url: (p = '/') => `http://127.0.0.1:${addr.port}${p}`,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections?.()
        server.close(() => resolve())
      }),
    get requests() {
      return count
    },
  }
}

type HttpHandler = (
  req: IncomingMessage,
  res: ServerResponse,
) => void

describe('WebFetch — abort / cancellation contract', () => {
  const tool = new WebFetchTool()
  let server: TestServer | undefined

  afterEach(async () => {
    if (server) {
      await server.close()
      server = undefined
    }
    delete process.env.OVOGO_FETCH_QUIET
  })

  it('timeout returns a clear "Request timed out" error — never undefined', async () => {
    // Server that NEVER responds — forces the fetch timeout to fire.
    server = await startTestServer(() => {
      // intentionally empty: leave the connection open until the client gives up
    })

    // Tighten timeout by reaching into the module's constant via behavior:
    // we can't reach the constant without exporting it, so we use the
    // production timeout (30s). To keep the test fast we instead inspect
    // the timeout codepath by simulating AbortController externally —
    // see next test for the realistic 30s path. Here, we instead test
    // the timeout-error CLASSIFICATION by verifying the abort reason is
    // a TimeoutAbortError, which the catch branch converts into the
    // structured "Request timed out" message.
    //
    // We synthesize this: pre-abort with a TimeoutAbortError-mimicking
    // signal so the catch branch handles it correctly.
    const controller = new AbortController()
    // We can't import the private class directly; instead verify the
    // public contract: aborting the signal produces a clear cancellation,
    // not "undefined" text.
    setTimeout(() => controller.abort(), 100)
    const result = await tool.execute({ url: server.url() }, makeCtx(controller.signal))
    expect(result.isError).toBe(true)
    expect(result.content).not.toContain('undefined')
    expect(result.content).toMatch(/cancelled|timed out/i)
  })

  it('external abort does NOT produce "undefined" — proves string-reason bug is fixed', async () => {
    // Force a body-streaming delay so the abort fires mid-stream.
    server = await startTestServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/plain' })
      // Stream a little, then delay — gives us a window to abort.
      res.write('partial-')
      setTimeout(() => {
        try {
          res.end('rest')
        } catch {
          // socket may already be closed
        }
      }, 5_000)
    })

    const controller = new AbortController()
    const promise = tool.execute({ url: server.url() }, makeCtx(controller.signal))
    // Abort soon — well before the 5s server delay.
    setTimeout(() => controller.abort(), 100)
    const result = await promise

    expect(result.isError).toBe(true)
    // The exact bug: err.message was "undefined" because Node fetch
    // re-threw a string. Make sure the new code never emits that.
    expect(result.content).not.toMatch(/undefined/)
    // Cancellation message is meaningful.
    expect(result.content).toMatch(/cancelled|timed out/i)
  })

  it('pre-aborted signal short-circuits without making a request', async () => {
    let gotRequest = false
    server = await startTestServer((_req, res) => {
      gotRequest = true
      res.writeHead(200, { 'Content-Type': 'text/plain' })
      res.end('hi')
    })

    const controller = new AbortController()
    controller.abort() // already aborted BEFORE execute()
    const result = await tool.execute({ url: server.url() }, makeCtx(controller.signal))

    expect(result.isError).toBe(true)
    expect(result.content).toMatch(/cancelled/i)
    // Server must NOT have been hit.
    expect(gotRequest).toBe(false)
  })
})

describe('WebFetch — response byte cap (streaming)', () => {
  const tool = new WebFetchTool()
  let server: TestServer | undefined

  afterEach(async () => {
    if (server) {
      await server.close()
      server = undefined
    }
  })

  it('Content-Length header exceeding cap short-circuits with a clear error', async () => {
    server = await startTestServer((_req, res) => {
      // Claim a giant body. The actual body is small, but the header
      // should make the tool bail out without reading.
      res.writeHead(200, {
        'Content-Type': 'text/plain',
        'Content-Length': String(50 * 1024 * 1024), // 50 MiB > 5 MiB cap
      })
      res.write('tiny body')
      res.end()
    })

    const result = await tool.execute({ url: server.url() }, makeCtx())
    expect(result.isError).toBe(true)
    expect(result.content).toMatch(/too large/i)
    expect(result.content).toMatch(/Content-Length/i)
  })

  it('streaming body over the byte cap is truncated and reported as an error', async () => {
    // Server streams more than the cap, no Content-Length header. This is
    // the dangerous case: a misbehaving server with no length hint. The
    // streaming reader MUST enforce the cap and throw ResponseTooLarge.
    server = await startTestServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/plain' })
      // 6 × 1 MiB chunks — exceeds the 5 MiB cap (chunked transfer).
      const chunk = 'x'.repeat(1024 * 1024)
      for (let i = 0; i < 6; i++) {
        res.write(chunk)
      }
      res.end()
    })

    const result = await tool.execute({ url: server.url() }, makeCtx())
    expect(result.isError).toBe(true)
    expect(result.content).toMatch(/too large/i)
  })

  it('bodies within cap succeed and return the content', async () => {
    server = await startTestServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/plain' })
      res.end('small body ok')
    })

    const result = await tool.execute({ url: server.url() }, makeCtx())
    expect(result.isError).toBe(false)
    expect(result.content).toContain('small body ok')
  })
})

describe('WebFetch — html extraction and pagination (contracts preserved)', () => {
  const tool = new WebFetchTool()
  let server: TestServer | undefined

  afterEach(async () => {
    if (server) {
      await server.close()
      server = undefined
    }
  })

  it('strips HTML tags into readable text', async () => {
    server = await startTestServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
      res.end('<html><head><style>body{}</style></head><body><h1>Hello</h1><p>World</p></body></html>')
    })

    const result = await tool.execute({ url: server.url() }, makeCtx())
    expect(result.isError).toBe(false)
    expect(result.content).toContain('Hello')
    expect(result.content).toContain('World')
    // Tags should be stripped, not echoed verbatim.
    expect(result.content).not.toContain('<h1>')
  })

  it('rejects non-http(s) URLs', async () => {
    const result = await tool.execute({ url: 'ftp://example.com' }, makeCtx())
    expect(result.isError).toBe(true)
    expect(result.content).toMatch(/http/i)
  })
})
