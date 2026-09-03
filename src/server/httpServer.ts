/**
 * ObservabilityServer — zero-dependency HTTP + SSE server (opencode's
 * server architecture, observability slice).
 *
 * Exposes the running agent to local tooling WITHOUT any external deps
 * (mirrors the zero-dep approach of acpWebSocket):
 *
 *   GET /health            → { ok, version, model, provider, uptimeS }
 *   GET /sessions          → session list (titles, status, message counts)
 *   GET /session/<name>    → one session's metadata + outcome (no messages)
 *   GET /events            → SSE stream of every RunEvent (live observability:
 *                            model switches, tool calls, compaction, routing)
 *
 * Design notes:
 *   - Binds 127.0.0.1 by default — personal-use scope; no auth layer by
 *     design (the ACP WS server shares this contract).
 *   - The engine attaches LATE (after REPL boot); /events connections
 *     registered before that simply wait — events flow once attached.
 *   - EADDRINUSE walks the port range instead of dying — `--serve` with
 *     a stale instance left over shouldn't break a new session.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'http'
import { RunEventEmitter } from '../core/runtime/events.js'
import { listSessionsDetailed, resolveSessionPath, loadSessionEnvelope } from '../core/sessionManager.js'
import { readFileSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'

/** Narrow engine surface the server needs (no engine import cycle). */
export interface EngineHandle {
  getEventEmitter(): RunEventEmitter
  getModel(): string
  getProvider(): string
}

export interface ObservabilityServerOptions {
  cwd: string
  /** First port to try; +1 on EADDRINUSE up to +10. 0 = ephemeral. */
  port?: number
  /** Bind address. Default 127.0.0.1. */
  host?: string
}

const DEFAULT_PORT = 7717
const SSE_HEARTBEAT_MS = 25_000

function readVersion(): string {
  try {
    // ESM-safe __dirname derivation. dist layout mirrors src/, so
    // ../../package.json resolves to the shipped package manifest.
    const here = dirname(fileURLToPath(import.meta.url))
    const pkg = JSON.parse(readFileSync(join(here, '..', '..', 'package.json'), 'utf8')) as { version?: string }
    return pkg.version ?? 'unknown'
  } catch {
    return 'unknown'
  }
}

export class ObservabilityServer {
  private server: Server | null = null
  private engine: EngineHandle | null = null
  private unsubscribe: (() => void) | null = null
  private readonly sseClients = new Set<ServerResponse>()
  private heartbeat: ReturnType<typeof setInterval> | null = null
  private startedAt = 0
  private port = 0
  private host = '127.0.0.1'
  private readonly cwd: string
  private readonly version = readVersion()

  constructor(private readonly opts: ObservabilityServerOptions) {
    this.cwd = opts.cwd
  }

  /** Attach (or re-attach) the live engine. Idempotent per emitter. */
  attachEngine(engine: EngineHandle): void {
    if (this.engine?.getEventEmitter() === engine.getEventEmitter()) return
    this.unsubscribe?.()
    this.unsubscribe = null
    this.engine = engine
    this.unsubscribe = engine.getEventEmitter().onAny((event) => this.broadcast(event.type, event))
  }

  get listening(): boolean {
    return this.server !== null
  }

  get address(): { port: number; host: string } | null {
    return this.listening ? { port: this.port, host: this.host } : null
  }

  get url(): string | null {
    const a = this.address
    return a ? `http://${a.host}:${a.port}` : null
  }

  async start(): Promise<{ port: number; host: string }> {
    if (this.server) return { port: this.port, host: this.host }

    const wanted = this.opts.port ?? DEFAULT_PORT
    this.host = this.opts.host ?? '127.0.0.1'

    const server = createServer((req, res) => this.handle(req, res))

    if (wanted === 0) {
      await this.listenOnce(server, 0)
    } else {
      let bound = false
      for (let offset = 0; offset <= 10 && !bound; offset++) {
        const result = await this.listenOnce(server, wanted + offset)
        if (result.ok) {
          bound = true
        } else if (!result.retryable) {
          // Round 41 audit fix: hard bind errors (EACCES on privileged
          // ports, EINVAL on a bad host) must NOT be retried as if they
          // were port collisions — rethrow with the real code visible.
          throw new Error(
            `ObservabilityServer: cannot bind ${this.host}:${wanted + offset} — ${result.code ?? 'unknown error'}`,
          )
        }
      }
      if (!bound) {
        throw new Error(`ObservabilityServer: no free port in ${wanted}-${wanted + 10} on ${this.host}`)
      }
    }

    this.server = server
    this.startedAt = Date.now()
    this.heartbeat = setInterval(() => {
      for (const res of this.sseClients) {
        try { res.write(': hb\n\n') } catch { /* dead client — close handler cleans up */ }
      }
    }, SSE_HEARTBEAT_MS)
    this.heartbeat.unref?.()
    return { port: this.port, host: this.host }
  }

  private listenOnce(server: Server, port: number): Promise<{ ok: boolean; retryable: boolean; code?: string }> {
    return new Promise((resolve) => {
      const onError = (err: NodeJS.ErrnoException): void => {
        server.removeListener('error', onError)
        // Only EADDRINUSE is worth walking the range for; everything
        // else (EACCES / EINVAL / EADDRNOTAVAIL …) is fatal.
        resolve({ ok: false, retryable: err.code === 'EADDRINUSE', code: err.code })
      }
      server.once('error', onError)
      server.listen(port, this.host, () => {
        server.removeListener('error', onError)
        const addr = server.address()
        this.port = typeof addr === 'object' && addr !== null ? addr.port : port
        resolve({ ok: true, retryable: false })
      })
    })
  }

  async stop(): Promise<void> {
    if (this.heartbeat) {
      clearInterval(this.heartbeat)
      this.heartbeat = null
    }
    for (const res of this.sseClients) {
      try { res.end() } catch { /* best-effort */ }
    }
    this.sseClients.clear()
    this.unsubscribe?.()
    this.unsubscribe = null
    this.engine = null
    const server = this.server
    this.server = null
    if (server) {
      await new Promise<void>((resolve) => {
        server.close(() => resolve())
        // Force-close lingering keep-alive sockets so close() settles.
        server.closeAllConnections?.()
      })
    }
  }

  // ── HTTP handling ────────────────────────────────────────────────────────

  private handle(req: IncomingMessage, res: ServerResponse): void {
    // No CORS header by design (mirrors the ACP WS origin posture): local
    // tools don't need CORS, and a permissive header would let any webpage
    // the user visits read /sessions and the /events stream cross-origin.
    res.setHeader('cache-control', 'no-store')
    const url = new URL(req.url ?? '/', 'http://local')
    try {
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        this.json(res, 405, { error: 'method not allowed' })
        return
      }
      if (url.pathname === '/health') {
        this.json(res, 200, {
          ok: true,
          version: this.version,
          engine: this.engine
            ? { model: this.engine.getModel(), provider: this.engine.getProvider() }
            : null,
          sseClients: this.sseClients.size,
          uptimeS: this.startedAt > 0 ? Math.round((Date.now() - this.startedAt) / 1000) : 0,
        })
        return
      }
      if (url.pathname === '/sessions') {
        this.json(res, 200, { sessions: listSessionsDetailed(this.cwd) })
        return
      }
      if (url.pathname.startsWith('/session/')) {
        this.handleSession(url.pathname.slice('/session/'.length), res)
        return
      }
      if (url.pathname === '/events') {
        this.handleSse(req, res)
        return
      }
      this.json(res, 404, { error: `no route: ${url.pathname}` })
    } catch (err) {
      this.json(res, 500, { error: (err as Error).message })
    }
  }

  private handleSession(name: string, res: ServerResponse): void {
    try {
      const dir = resolveSessionPath(this.cwd, decodeURIComponent(name))
      const envelope = loadSessionEnvelope(dir)
      if (!envelope) {
        this.json(res, 404, { error: `session has no history: ${name}` })
        return
      }
      const firstUser = envelope.messages.find((m) => m.role === 'user')
      this.json(res, 200, {
        name,
        title: envelope.title ?? null,
        messages: envelope.messages.length,
        firstUserMessage: typeof firstUser?.content === 'string' ? firstUser.content.slice(0, 400) : null,
        lastOutcome: envelope.lastOutcome ?? null,
        updatedAt: envelope.updatedAt,
      })
    } catch (err) {
      this.json(res, 404, { error: (err as Error).message })
    }
  }

  private handleSse(req: IncomingMessage, res: ServerResponse): void {
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    })
    res.write('retry: 3000\n\n')
    this.send(res, 'hello', { ok: true, listening: this.listening })
    this.sseClients.add(res)
    // Round 41: an async socket error on a vanished client must never
    // surface as an uncaughtException.
    res.on('error', () => {
      this.sseClients.delete(res)
    })
    req.on('close', () => {
      this.sseClients.delete(res)
    })
  }

  private send(res: ServerResponse, event: string, payload: unknown): void {
    try {
      res.write(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`)
    } catch { /* dead client — close handler cleans up */ }
  }

  private broadcast(event: string, payload: unknown): void {
    for (const res of this.sseClients) {
      this.send(res, event, payload)
    }
  }

  private json(res: ServerResponse, status: number, body: unknown): void {
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
    res.end(JSON.stringify(body))
  }
}

// ── Shared instance (for --serve) ──────────────────────────────────────────

let shared: ObservabilityServer | null = null

/**
 * Shared instance backing --serve. A supplied `port`/`host` must win: when
 * the running instance differs, it is stopped and rebuilt (a stopped
 * instance always rebuilds).
 */
export function getSharedObservabilityServer(cwd: string, port?: number, host?: string): ObservabilityServer {
  const addr = shared?.address ?? null
  const conflicts = addr !== null
    && ((port !== undefined && addr.port !== port) || (host !== undefined && addr.host !== host))
  if (!shared || conflicts || (port !== undefined && !shared.listening)) {
    // Round 41 audit fix: stop the old instance before replacing it —
    // its engine-event subscription otherwise leaked forever.
    void shared?.stop().catch(() => { /* best-effort */ })
    shared = new ObservabilityServer({
      cwd,
      ...(port !== undefined ? { port } : {}),
      ...(host !== undefined ? { host } : {}),
    })
  }
  return shared
}
