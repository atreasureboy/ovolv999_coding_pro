/**
 * Daemon mode — long-running supervisor process that keeps engine
 * sessions alive between user turns.
 *
 * Inspired by claude-code's `daemon/` mode. Each session is a
 * separate ExecutionEngine instance; the daemon manages session
 * lifecycle, IPC routing, and persistence.
 *
 * IPC: line-delimited JSON over a Unix domain socket (or named pipe
 * on Windows). Protocol:
 *
 *   Client → Daemon:
 *     {"op": "list", "id": 1}
 *     {"op": "create", "id": 2, "goal": "...", "cwd": "..."}
 *     {"op": "attach", "id": 3, "sessionId": "..."}
 *     {"op": "message", "id": 4, "sessionId": "...", "text": "..."}
 *     {"op": "detach", "id": 5, "sessionId": "..."}
 *     {"op": "kill", "id": 6, "sessionId": "..."}
 *     {"op": "shutdown", "id": 7}
 *
 *   Daemon → Client:
 *     {"id": <req-id>, "ok": true, "result": ...}
 *     {"id": <req-id>, "ok": false, "error": "..."}
 *     {"event": "session/turn", "sessionId": "...", "output": "..."}
 *     {"event": "session/done", "sessionId": "...", "status": "..."}
 */

import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http'
import { EventEmitter } from 'node:events'
import { join } from 'node:path'
import { existsSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { appendTurn, loadTurns } from './sessionStore.js'

export interface DaemonOptions {
  /** Override socket path (default: ~/.ovolv999/daemon.sock). */
  socketPath?: string
  /** Maximum number of concurrent sessions. */
  maxSessions?: number
}

export interface DaemonSessionMeta {
  sessionId: string
  goal: string
  cwd: string
  startedAt: number
  status: 'running' | 'idle' | 'closed'
  lastActivityAt: number
}

export interface DaemonRequest {
  id: number | string
  op: 'list' | 'create' | 'attach' | 'message' | 'detach' | 'kill' | 'shutdown'
  sessionId?: string
  goal?: string
  cwd?: string
  text?: string
}

export interface DaemonResponse {
  id: number | string
  ok: boolean
  result?: unknown
  error?: string
}

export interface DaemonEvent {
  event: string
  sessionId: string
  [key: string]: unknown
}

export type DaemonListener = (req: DaemonRequest) => Promise<DaemonResponse | DaemonEvent>

export class DaemonServer extends EventEmitter {
  private readonly socketPath: string
  private readonly sessions = new Map<string, DaemonSessionMeta>()
  private server: Server | null = null
  private listener: DaemonListener | null = null

  constructor(options: DaemonOptions = {}) {
    super()
    this.socketPath = options.socketPath ?? join(homedir(), '.ovolv999', 'daemon.sock')
  }

  setListener(listener: DaemonListener | null): void {
    this.listener = listener
  }

  getSocketPath(): string {
    return this.socketPath
  }

  getSessions(): DaemonSessionMeta[] {
    return Array.from(this.sessions.values())
  }

  async start(): Promise<void> {
    const dir = join(this.socketPath, '..')
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    if (this.server) return
    return new Promise((resolve, reject) => {
      const server = createServer((req: IncomingMessage, res: ServerResponse) => {
        void this.handleHttp(req, res)
      })
      server.on('error', reject)
      server.listen(0, '127.0.0.1', () => {
        const addr = server.address()
        if (typeof addr !== 'object' || !addr) {
          reject(new Error('Failed to bind daemon HTTP socket'))
          return
        }
        const port = addr.port
        process.env.OVOGO_DAEMON_PORT = String(port)
        this.server = server
        this.emit('listening', { socketPath: this.socketPath, port })
        resolve()
      })
    })
  }

  async stop(): Promise<void> {
    if (!this.server) return
    for (const session of this.sessions.values()) {
      session.status = 'closed'
    }
    await new Promise<void>((resolve, reject) => {
      this.server!.close((err) => {
        this.server = null
        if (err) reject(err)
        else resolve()
      })
    })
  }

  /**
   * In-process entry point — used by `ovolv999 --attach <sessionId>`
   * to forward a request and stream the response. Returns the listener
   * result (or rejects on protocol error).
   */
  async dispatch(req: DaemonRequest): Promise<DaemonResponse | DaemonEvent> {
    if (!this.listener) {
      throw new Error('Daemon: no listener attached')
    }
    return this.listener(req)
  }

  /**
   * Persist the latest turn for a session. Called by the listener
   * after each `op: 'message'` completes.
   */
  recordTurn(sessionId: string, turn: { ts: number; user: string; assistant: string; status: 'completed' | 'failed' | 'partial' | 'blocked'; tokens?: { input: number; output: number } }): void {
    appendTurn(sessionId, turn)
  }

  /**
   * Load a session's history on startup. Returns an empty array if
   * the session does not exist or has no persisted turns.
   */
  loadHistory(sessionId: string): Array<{ ts: number; user: string; assistant: string; status: 'completed' | 'failed' | 'partial' | 'blocked'; tokens?: { input: number; output: number } }> {
    return loadTurns(sessionId)
  }

  private handleHttp(req: IncomingMessage, res: ServerResponse): void {
    if (req.method !== 'POST') {
      res.writeHead(405)
      res.end()
      return
    }
    let body = ''
    req.setEncoding('utf8')
    req.on('data', (chunk: string) => { body += chunk })
    req.on('end', () => {
      void this.processRequest(req, res, body)
    })
  }

  private async processRequest(req: IncomingMessage, res: ServerResponse, body: string): Promise<void> {
    let parsed: DaemonRequest
    try {
      parsed = JSON.parse(body) as DaemonRequest
    } catch {
      res.writeHead(400, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ ok: false, error: 'invalid json' }))
      return
    }
    try {
      const result = await this.dispatch(parsed)
      // R6: persist the turn after every successful 'message' dispatch so
      // session resume works across daemon restarts. Errors here are
      // non-fatal — we don't want a disk error to break the message ack.
      if (parsed.op === 'message' && 'text' in parsed && parsed.sessionId) {
        try {
          const assistantText = extractAssistantText(result)
          this.recordTurn(parsed.sessionId, {
            ts: Date.now(),
            user: parsed.text ?? '',
            assistant: assistantText,
            status: 'completed',
          })
        } catch {
          /* best-effort persistence */
        }
      }
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify(result))
    } catch (err) {
      res.writeHead(500, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ id: parsed.id, ok: false, error: (err as Error).message }))
    }
  }
}

function extractAssistantText(result: unknown): string {
  if (!result || typeof result !== 'object') return ''
  const obj = result as { result?: unknown }
  if (obj.result && typeof obj.result === 'object') {
    const r = obj.result as { result?: unknown; text?: string }
    if (typeof r.text === 'string') return r.text
    if (typeof r.result === 'string') return r.result
  }
  return ''
}

let defaultSocketPath: string | null = null

export function getDefaultDaemonSocketPath(): string {
  if (!defaultSocketPath) {
    defaultSocketPath = join(homedir(), '.ovolv999', 'daemon.sock')
  }
  return defaultSocketPath
}
