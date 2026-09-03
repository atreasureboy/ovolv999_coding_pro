import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'

export type ControlTaskStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled'

export interface ControlTaskResult {
  summary?: string
  output?: string
  changedFiles?: string[]
  artifacts?: Array<{ kind: string; path?: string; content?: string }>
  metadata?: Record<string, unknown>
}

export interface ControlTask {
  id: string
  goal: string
  cwd: string
  baseRef?: string
  status: ControlTaskStatus
  priority: number
  attempt: number
  maxAttempts: number
  workerId?: string
  leaseExpiresAt?: string
  result?: ControlTaskResult
  error?: string
  metadata?: Record<string, unknown>
  createdAt: string
  updatedAt: string
}

export interface EnqueueControlTask {
  goal: string
  cwd: string
  baseRef?: string
  priority?: number
  maxAttempts?: number
  metadata?: Record<string, unknown>
}

export interface ControlTaskEvent {
  sequence: number
  taskId: string
  type: 'enqueued' | 'claimed' | 'heartbeat' | 'completed' | 'failed' | 'requeued' | 'cancelled'
  timestamp: string
  task: ControlTask
}

export class TaskOwnershipError extends Error {}

export class TaskControlPlane {
  private readonly tasks = new Map<string, ControlTask>()
  private readonly taskEvents: ControlTaskEvent[] = []
  private sequence = 0

  constructor(private readonly eventFile: string, private readonly now: () => number = Date.now) {
    this.load()
  }

  enqueue(input: EnqueueControlTask): ControlTask {
    if (!input.goal.trim()) throw new Error('task goal is required')
    if (!input.cwd.trim()) throw new Error('task cwd is required')
    const timestamp = this.timestamp()
    const task: ControlTask = {
      id: randomUUID(),
      goal: input.goal.trim(),
      cwd: resolve(input.cwd),
      baseRef: input.baseRef,
      status: 'queued',
      priority: Number.isFinite(input.priority) ? Math.trunc(input.priority ?? 0) : 0,
      attempt: 0,
      maxAttempts: Number.isFinite(input.maxAttempts)
        ? Math.max(1, Math.trunc(input.maxAttempts ?? 1))
        : 1,
      metadata: input.metadata,
      createdAt: timestamp,
      updatedAt: timestamp,
    }
    return this.record('enqueued', task)
  }

  get(taskId: string): ControlTask | undefined {
    const task = this.tasks.get(taskId)
    return task ? structuredClone(task) : undefined
  }

  list(status?: ControlTaskStatus): ControlTask[] {
    return [...this.tasks.values()]
      .filter((task) => !status || task.status === status)
      .sort((a, b) => b.priority - a.priority || a.createdAt.localeCompare(b.createdAt))
      .map((task) => structuredClone(task))
  }

  events(taskId?: string): ControlTaskEvent[] {
    return this.taskEvents
      .filter((event) => !taskId || event.taskId === taskId)
      .map((event) => structuredClone(event))
  }

  claim(workerId: string, leaseMs = 60_000): ControlTask | null {
    if (!workerId.trim()) throw new Error('workerId is required')
    this.recoverExpiredLeases()
    const task = this.list('queued')[0]
    if (!task) return null
    const updated: ControlTask = {
      ...task,
      status: 'running',
      attempt: task.attempt + 1,
      workerId,
      leaseExpiresAt: new Date(this.now() + this.validLease(leaseMs)).toISOString(),
      error: undefined,
      updatedAt: this.timestamp(),
    }
    return this.record('claimed', updated)
  }

  heartbeat(taskId: string, workerId: string, leaseMs = 60_000): ControlTask {
    const task = this.ownedRunningTask(taskId, workerId)
    return this.record('heartbeat', {
      ...task,
      leaseExpiresAt: new Date(this.now() + this.validLease(leaseMs)).toISOString(),
      updatedAt: this.timestamp(),
    })
  }

  complete(taskId: string, workerId: string, result: ControlTaskResult): ControlTask {
    const task = this.ownedRunningTask(taskId, workerId)
    return this.record('completed', {
      ...task,
      status: 'succeeded',
      result: structuredClone(result),
      leaseExpiresAt: undefined,
      error: undefined,
      updatedAt: this.timestamp(),
    })
  }

  fail(taskId: string, workerId: string, error: string): ControlTask {
    const task = this.ownedRunningTask(taskId, workerId)
    if (task.attempt < task.maxAttempts) {
      return this.record('requeued', {
        ...task,
        status: 'queued',
        workerId: undefined,
        leaseExpiresAt: undefined,
        error,
        updatedAt: this.timestamp(),
      })
    }
    return this.record('failed', {
      ...task,
      status: 'failed',
      leaseExpiresAt: undefined,
      error,
      updatedAt: this.timestamp(),
    })
  }

  cancel(taskId: string): ControlTask {
    const task = this.require(taskId)
    if (task.status === 'succeeded' || task.status === 'failed' || task.status === 'cancelled') return task
    return this.record('cancelled', {
      ...task,
      status: 'cancelled',
      leaseExpiresAt: undefined,
      updatedAt: this.timestamp(),
    })
  }

  recoverExpiredLeases(): ControlTask[] {
    const recovered: ControlTask[] = []
    for (const task of this.tasks.values()) {
      if (task.status !== 'running' || !task.leaseExpiresAt) continue
      if (Date.parse(task.leaseExpiresAt) > this.now()) continue
      if (task.attempt < task.maxAttempts) {
        recovered.push(this.record('requeued', {
          ...task,
          status: 'queued',
          workerId: undefined,
          leaseExpiresAt: undefined,
          error: 'worker lease expired',
          updatedAt: this.timestamp(),
        }))
      } else {
        recovered.push(this.record('failed', {
          ...task,
          status: 'failed',
          leaseExpiresAt: undefined,
          error: 'worker lease expired',
          updatedAt: this.timestamp(),
        }))
      }
    }
    return recovered
  }

  private validLease(leaseMs: number): number {
    if (!Number.isFinite(leaseMs) || leaseMs < 1_000) throw new Error('leaseMs must be at least 1000')
    return Math.trunc(leaseMs)
  }

  private ownedRunningTask(taskId: string, workerId: string): ControlTask {
    const task = this.require(taskId)
    if (task.status !== 'running') throw new TaskOwnershipError(`task ${taskId} is not running`)
    if (task.workerId !== workerId) throw new TaskOwnershipError(`task ${taskId} is owned by ${task.workerId ?? 'no worker'}`)
    return task
  }

  private require(taskId: string): ControlTask {
    const task = this.get(taskId)
    if (!task) throw new Error(`task not found: ${taskId}`)
    return task
  }

  private timestamp(): string {
    return new Date(this.now()).toISOString()
  }

  private record(type: ControlTaskEvent['type'], task: ControlTask): ControlTask {
    const event: ControlTaskEvent = {
      sequence: ++this.sequence,
      taskId: task.id,
      type,
      timestamp: this.timestamp(),
      task: structuredClone(task),
    }
    mkdirSync(dirname(this.eventFile), { recursive: true })
    appendFileSync(this.eventFile, JSON.stringify(event) + '\n', 'utf8')
    this.taskEvents.push(structuredClone(event))
    this.tasks.set(task.id, structuredClone(task))
    return structuredClone(task)
  }

  private load(): void {
    if (!existsSync(this.eventFile)) return
    const lines = readFileSync(this.eventFile, 'utf8').split('\n')
    for (const line of lines) {
      if (!line.trim()) continue
      try {
        const event = JSON.parse(line) as ControlTaskEvent
        if (!event.task?.id || !Number.isFinite(event.sequence)) continue
        this.sequence = Math.max(this.sequence, event.sequence)
        this.taskEvents.push(structuredClone(event))
        this.tasks.set(event.task.id, event.task)
      } catch {
        continue
      }
    }
  }
}

export interface TaskWorkerOptions {
  workerId: string
  leaseMs?: number
  heartbeatMs?: number
  execute(task: ControlTask): Promise<ControlTaskResult>
}

export class TaskWorker {
  constructor(private readonly plane: TaskControlPlane, private readonly options: TaskWorkerOptions) {}

  async runOnce(): Promise<ControlTask | null> {
    const leaseMs = this.options.leaseMs ?? 60_000
    const task = this.plane.claim(this.options.workerId, leaseMs)
    if (!task) return null
    const heartbeat = setInterval(() => {
      try { this.plane.heartbeat(task.id, this.options.workerId, leaseMs) } catch { return }
    }, this.options.heartbeatMs ?? Math.max(1_000, Math.floor(leaseMs / 3)))
    heartbeat.unref?.()
    try {
      const result = await this.options.execute(task)
      return this.plane.complete(task.id, this.options.workerId, result)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      try {
        return this.plane.fail(task.id, this.options.workerId, message)
      } catch (ownershipError) {
        // Cancel or lease recovery took the task mid-run — fail() is no
        // longer ours to record; report the terminal state, don't reject.
        if (ownershipError instanceof TaskOwnershipError) return this.plane.get(task.id) ?? task
        throw ownershipError
      }
    } finally {
      clearInterval(heartbeat)
    }
  }
}
