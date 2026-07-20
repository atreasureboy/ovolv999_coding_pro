/**
 * Daemon Mode — long-running background supervisor
 *
 * Lets the tool run as a persistent daemon that can:
 *   - Accept commands via a Unix socket
 *   - Run scheduled tasks
 *   - Monitor file changes
 *   - Manage background agents
 *
 * Inspired by claude-code's daemon mode.
 */

import { createServer, type Server, Socket } from 'net'
import { existsSync, unlinkSync, writeFileSync, readFileSync, mkdirSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'

// ── Types ───────────────────────────────────────────────────────────────────

export type DaemonStatus = 'running' | 'stopped' | 'starting' | 'error'

export interface DaemonInfo {
  pid: number
  status: DaemonStatus
  startTime: string
  socketPath: string
  logPath: string
  workers: number
  uptime: number
}

export interface DaemonCommand {
  action: 'status' | 'stop' | 'ping' | 'health' | 'list-workers' | 'restart-worker'
  payload?: Record<string, unknown>
}

export interface DaemonResponse {
  ok: boolean
  data?: unknown
  error?: string
}

interface WorkerEntry {
  id: string
  name: string
  pid?: number
  status: 'starting' | 'running' | 'stopped' | 'failed'
  startedAt: string
  command?: string
}

export type { WorkerEntry }

// ── Daemon ──────────────────────────────────────────────────────────────────

export class Daemon {
  private server: Server | null = null
  private startTime: number = 0
  private workers = new Map<string, WorkerEntry>()
  private status: DaemonStatus = 'stopped'

  constructor(
    private readonly socketPath: string,
    private readonly logPath: string,
  ) {}

  async start(): Promise<void> {
    if (this.status === 'running') return

    this.status = 'starting'

    // Clean up stale socket
    if (existsSync(this.socketPath)) {
      try { unlinkSync(this.socketPath) } catch { /* ignore */ }
    }

    // Ensure log dir exists
    const logDir = join(this.logPath, '..')
    if (!existsSync(logDir)) mkdirSync(logDir, { recursive: true })

    return new Promise((resolve, reject) => {
      this.server = createServer((socket: Socket) => {
        this.handleConnection(socket)
      })

      this.server.on('error', (err) => {
        this.status = 'error'
        this.log(`Daemon error: ${err.message}`)
        reject(err)
      })

      this.server.listen(this.socketPath, () => {
        this.status = 'running'
        this.startTime = Date.now()
        this.log(`Daemon started (pid=${process.pid}, socket=${this.socketPath})`)
        resolve()
      })
    })
  }

  async stop(): Promise<void> {
    this.status = 'stopped'
    if (this.server) {
      await new Promise<void>((resolve) => {
        this.server!.close(() => resolve())
      })
      this.server = null
    }
    if (existsSync(this.socketPath)) {
      try { unlinkSync(this.socketPath) } catch { /* ignore */ }
    }
    this.log('Daemon stopped')
  }

  getInfo(): DaemonInfo {
    return {
      pid: process.pid,
      status: this.status,
      startTime: new Date(this.startTime).toISOString(),
      socketPath: this.socketPath,
      logPath: this.logPath,
      workers: this.workers.size,
      uptime: Date.now() - this.startTime,
    }
  }

  addWorker(name: string, command?: string): WorkerEntry {
    const id = `worker-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
    const worker: WorkerEntry = {
      id,
      name,
      status: 'starting',
      startedAt: new Date().toISOString(),
      command,
    }
    this.workers.set(id, worker)
    this.log(`Worker added: ${name} (${id})`)
    return worker
  }

  removeWorker(id: string): boolean {
    const existed = this.workers.delete(id)
    if (existed) this.log(`Worker removed: ${id}`)
    return existed
  }

  listWorkers(): WorkerEntry[] {
    return Array.from(this.workers.values())
  }

  updateWorkerStatus(id: string, status: WorkerEntry['status'], pid?: number): void {
    const worker = this.workers.get(id)
    if (worker) {
      worker.status = status
      if (pid !== undefined) worker.pid = pid
    }
  }

  private handleConnection(socket: Socket): void {
    let buffer = ''
    socket.on('data', (data: Buffer) => {
      buffer += data.toString()
      let nl = buffer.indexOf('\n')
      while (nl !== -1) {
        const line = buffer.slice(0, nl).trim()
        buffer = buffer.slice(nl + 1)
        nl = buffer.indexOf('\n')
        if (!line) continue
        try {
          const cmd = JSON.parse(line) as DaemonCommand
          const response = this.handleCommand(cmd)
          socket.write(JSON.stringify(response) + '\n')
        } catch (err) {
          const response: DaemonResponse = { ok: false, error: err instanceof Error ? err.message : String(err) }
          socket.write(JSON.stringify(response) + '\n')
        }
      }
    })
  }

  private handleCommand(cmd: DaemonCommand): DaemonResponse {
    switch (cmd.action) {
      case 'ping':
        return { ok: true, data: 'pong' }
      case 'status':
        return { ok: true, data: this.getInfo() }
      case 'health':
        return {
          ok: true,
          data: {
            status: this.status,
            uptime: Date.now() - this.startTime,
            workers: this.workers.size,
            memoryMB: Math.round(process.memoryUsage().rss / 1024 / 1024),
          },
        }
      case 'stop':
        this.stop().catch(() => {})
        return { ok: true, data: 'stopping' }
      case 'list-workers':
        return { ok: true, data: this.listWorkers() }
      default:
        return { ok: false, error: `Unknown action: ${cmd.action}` }
    }
  }

  private log(message: string): void {
    try {
      const timestamp = new Date().toISOString()
      const line = `[${timestamp}] ${message}\n`
      if (existsSync(this.logPath)) {
        const existing = readFileSync(this.logPath, 'utf8')
        writeFileSync(this.logPath, existing + line)
      } else {
        writeFileSync(this.logPath, line)
      }
    } catch { /* ignore log errors */ }
  }
}

// ── Daemon Client ───────────────────────────────────────────────────────────

export class DaemonClient {
  constructor(private readonly socketPath: string) {}

  async send(cmd: DaemonCommand, timeoutMs = 5000): Promise<DaemonResponse> {
    if (!existsSync(this.socketPath)) {
      return { ok: false, error: 'Daemon socket not found. Is the daemon running?' }
    }

    return new Promise((resolve) => {
      const socket = new Socket()
      let buffer = ''
      let settled = false

      const timer = setTimeout(() => {
        if (!settled) {
          settled = true
          socket.destroy()
          resolve({ ok: false, error: `Daemon request timed out after ${timeoutMs}ms` })
        }
      }, timeoutMs)

      socket.on('connect', () => {
        socket.write(JSON.stringify(cmd) + '\n')
      })

      socket.on('data', (data: Buffer) => {
        buffer += data.toString()
        const nl = buffer.indexOf('\n')
        if (nl !== -1 && !settled) {
          settled = true
          clearTimeout(timer)
          const line = buffer.slice(0, nl).trim()
          try {
            resolve(JSON.parse(line) as DaemonResponse)
          } catch {
            resolve({ ok: false, error: 'Invalid daemon response' })
          }
          socket.destroy()
        }
      })

      socket.on('error', (err) => {
        if (!settled) {
          settled = true
          clearTimeout(timer)
          resolve({ ok: false, error: err.message })
        }
      })

      socket.connect(this.socketPath)
    })
  }

  async ping(): Promise<boolean> {
    const res = await this.send({ action: 'ping' })
    return res.ok && res.data === 'pong'
  }

  async status(): Promise<DaemonInfo | null> {
    const res = await this.send({ action: 'status' })
    return res.ok ? res.data as DaemonInfo : null
  }

  async stop(): Promise<boolean> {
    const res = await this.send({ action: 'stop' })
    return res.ok
  }
}

// ── Paths ───────────────────────────────────────────────────────────────────

export function getDaemonSocketPath(): string {
  return join(homedir(), '.ovolv999', 'daemon.sock')
}

export function getDaemonLogPath(): string {
  return join(homedir(), '.ovolv999', 'daemon.log')
}

export function isDaemonRunning(): boolean {
  return existsSync(getDaemonSocketPath())
}

// ── Formatting ──────────────────────────────────────────────────────────────

export function formatDaemonInfo(info: DaemonInfo): string {
  const lines: string[] = [
    `Daemon Status: ${info.status}`,
    `  PID: ${info.pid}`,
    `  Started: ${info.startTime}`,
    `  Uptime: ${(info.uptime / 1000 / 60).toFixed(1)} minutes`,
    `  Socket: ${info.socketPath}`,
    `  Log: ${info.logPath}`,
    `  Workers: ${info.workers}`,
  ]
  return lines.join('\n')
}

export function formatWorkers(workers: WorkerEntry[]): string {
  if (workers.length === 0) return 'No workers registered.'
  const lines: string[] = [`Workers (${workers.length}):`]
  for (const w of workers) {
    const icon = { starting: '○', running: '●', stopped: '⊘', failed: '✗' }[w.status]
    lines.push(`  ${icon} ${w.name} (${w.id}) — ${w.status}`)
  }
  return lines.join('\n')
}
