import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { TaskOwnershipError, type TaskControlPlane, type ControlTaskStatus, type EnqueueControlTask, type ControlTaskResult } from '../core/taskControlPlane.js'

export interface TaskControlPlaneServerOptions {
  plane: TaskControlPlane
  port?: number
  host?: string
}

export class TaskControlPlaneServer {
  private server: Server | null = null
  private port = 0
  private host: string

  constructor(private readonly options: TaskControlPlaneServerOptions) {
    this.host = options.host ?? '127.0.0.1'
  }

  get address(): { host: string; port: number } | null {
    return this.server ? { host: this.host, port: this.port } : null
  }

  async start(): Promise<{ host: string; port: number }> {
    if (this.server) return this.address!
    const server = createServer((request, response) => {
      this.handle(request, response).catch((error: unknown) => {
        const status = error instanceof TaskOwnershipError ? 409 : 400
        this.json(response, status, { error: error instanceof Error ? error.message : String(error) })
      })
    })
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(this.options.port ?? 0, this.host, () => {
        server.removeListener('error', reject)
        resolve()
      })
    })
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('task control plane has no TCP address')
    this.server = server
    this.port = address.port
    return this.address!
  }

  async stop(): Promise<void> {
    const server = this.server
    this.server = null
    if (!server) return
    await new Promise<void>((resolve) => {
      server.close(() => resolve())
      server.closeAllConnections?.()
    })
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const method = request.method ?? 'GET'
    const url = new URL(request.url ?? '/', 'http://local')
    if (method === 'GET' && url.pathname === '/health') {
      this.json(response, 200, { ok: true, queued: this.options.plane.list('queued').length, running: this.options.plane.list('running').length })
      return
    }
    if (method === 'GET' && url.pathname === '/tasks') {
      const status = url.searchParams.get('status') as ControlTaskStatus | null
      const allowed = new Set<ControlTaskStatus>(['queued', 'running', 'succeeded', 'failed', 'cancelled'])
      if (status && !allowed.has(status)) throw new Error(`invalid task status: ${status}`)
      this.json(response, 200, { tasks: this.options.plane.list(status ?? undefined) })
      return
    }
    if (method === 'GET' && url.pathname === '/events') {
      const taskId = url.searchParams.get('taskId') ?? undefined
      this.json(response, 200, { events: this.options.plane.events(taskId) })
      return
    }
    if (method === 'POST' && url.pathname === '/tasks') {
      const input = await this.body<EnqueueControlTask>(request)
      this.json(response, 201, { task: this.options.plane.enqueue(input) })
      return
    }
    if (method === 'POST' && url.pathname === '/tasks/claim') {
      const input = await this.body<{ workerId?: string; leaseMs?: number }>(request)
      const task = this.options.plane.claim(input.workerId ?? '', input.leaseMs)
      this.json(response, task ? 200 : 204, task ? { task } : undefined)
      return
    }
    if (method === 'POST' && url.pathname === '/tasks/recover') {
      this.json(response, 200, { tasks: this.options.plane.recoverExpiredLeases() })
      return
    }
    const match = /^\/tasks\/([^/]+)(?:\/(heartbeat|complete|fail|cancel))?$/.exec(url.pathname)
    if (!match) {
      this.json(response, 404, { error: `no route: ${url.pathname}` })
      return
    }
    const taskId = decodeURIComponent(match[1])
    const action = match[2]
    if (method === 'GET' && !action) {
      const task = this.options.plane.get(taskId)
      this.json(response, task ? 200 : 404, task ? { task } : { error: `task not found: ${taskId}` })
      return
    }
    if (method !== 'POST' || !action) {
      this.json(response, 405, { error: 'method not allowed' })
      return
    }
    if (action === 'cancel') {
      this.json(response, 200, { task: this.options.plane.cancel(taskId) })
      return
    }
    const input = await this.body<{ workerId?: string; leaseMs?: number; result?: ControlTaskResult; error?: string }>(request)
    if (action === 'heartbeat') {
      this.json(response, 200, { task: this.options.plane.heartbeat(taskId, input.workerId ?? '', input.leaseMs) })
      return
    }
    if (action === 'complete') {
      this.json(response, 200, { task: this.options.plane.complete(taskId, input.workerId ?? '', input.result ?? {}) })
      return
    }
    this.json(response, 200, { task: this.options.plane.fail(taskId, input.workerId ?? '', input.error ?? 'worker failed') })
  }

  private body<T>(request: IncomingMessage): Promise<T> {
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = []
      let size = 0
      request.on('data', (chunk: Buffer) => {
        size += chunk.length
        if (size > 1_048_576) {
          reject(new Error('request body exceeds 1 MiB'))
          request.destroy()
          return
        }
        chunks.push(chunk)
      })
      request.on('end', () => {
        try {
          const raw = Buffer.concat(chunks).toString('utf8')
          resolve((raw ? JSON.parse(raw) : {}) as T)
        } catch {
          reject(new Error('request body must be valid JSON'))
        }
      })
      request.on('error', reject)
    })
  }

  private json(response: ServerResponse, status: number, body: unknown): void {
    if (response.headersSent || response.destroyed) return
    response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
    response.end(body === undefined ? undefined : JSON.stringify(body))
  }
}
