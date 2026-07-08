/**
 * Background Task Manager — async long-running task lifecycle
 *
 * Inspired by Claude Code's TaskStop/TaskOutput + TaskCreate/List/Get/Update.
 *
 * Fills ovolv999's gap: the Bash tool can spawn background processes
 * (run_in_background:true) but there was no way to later check their status,
 * retrieve output, or stop them. This manager provides that lifecycle:
 *
 *   createTask(cmd) → id   (spawn async, return immediately)
 *   getTask(id)            (status, exitCode, output preview)
 *   listTasks()            (all tasks with status summary)
 *   updateTask(id, ...)    (update description / metadata)
 *   stopTask(id)           (kill the process)
 *   waitForTask(id, ms)    (block until done or timeout)
 *
 * Each task runs as a child_process spawned with shell:true. Output
 * (stdout+stderr) is accumulated in-memory (capped) and optionally
 * persisted to sessionDir for large outputs.
 */

import { spawn, type ChildProcess } from 'child_process'
import { randomUUID } from 'crypto'
import { writeFileSync, mkdirSync, appendFileSync } from 'fs'
import { join } from 'path'

// ── Types ───────────────────────────────────────────────────────────────────

export type TaskStatus = 'running' | 'completed' | 'failed' | 'stopped'

/** Public task info — safe to return to tools (no internal process handle). */
export interface TaskInfo {
  id: string
  command: string
  description: string
  status: TaskStatus
  exitCode: number | null
  pid: number | null
  startTime: number
  endTime: number | null
  durationMs: number | null
  outputLength: number
  metadata: Record<string, unknown>
}

/** Task detail — includes accumulated output. */
export interface TaskDetail extends TaskInfo {
  output: string
}

interface InternalTask {
  info: TaskInfo
  process: ChildProcess | null
  output: string
  outputFile: string | null
  /** True after stopTask() — prevents close handler from overriding status */
  stopped: boolean
  /** Total bytes received (before in-memory buffer truncation) */
  totalOutputBytes: number
}

// ── Constants ───────────────────────────────────────────────────────────────

const MAX_OUTPUT_BUFFER = 200_000 // 200KB in-memory cap; rest goes to file
const MAX_OUTPUT_RETURN = 30_000  // 30KB cap when returning to LLM context

// ── Manager ─────────────────────────────────────────────────────────────────

export class BackgroundTaskManager {
  private tasks = new Map<string, InternalTask>()

  /**
   * Spawn a background command. Returns the task ID immediately.
   * The process runs detached; output is accumulated asynchronously.
   */
  createTask(
    command: string,
    options?: {
      description?: string
      cwd?: string
      sessionDir?: string
      metadata?: Record<string, unknown>
    },
  ): string {
    const id = `task_${randomUUID().slice(0, 8)}`
    const now = Date.now()

    const info: TaskInfo = {
      id,
      command,
      description: options?.description ?? command,
      status: 'running',
      exitCode: null,
      pid: null,
      startTime: now,
      endTime: null,
      durationMs: null,
      outputLength: 0,
      metadata: options?.metadata ?? {},
    }

    // Optional: persist output to file for large outputs
    let outputFile: string | null = null
    if (options?.sessionDir) {
      try {
        const dir = join(options.sessionDir, 'task-outputs')
        mkdirSync(dir, { recursive: true })
        outputFile = join(dir, `${id}.log`)
        writeFileSync(outputFile, '', 'utf8')
      } catch {
        outputFile = null
      }
    }

    const task: InternalTask = { info, process: null, output: '', outputFile, stopped: false, totalOutputBytes: 0 }

    // Spawn the process
    const proc = spawn(command, {
      shell: true,
      cwd: options?.cwd,
      detached: false,
      env: { ...process.env },
    })

    task.process = proc
    info.pid = proc.pid ?? null

    const appendOutput = (data: string): void => {
      task.totalOutputBytes += data.length
      task.output += data
      // outputLength tracks TOTAL output produced (not truncated buffer length)
      info.outputLength = task.totalOutputBytes
      // Cap in-memory buffer; keep the tail (most recent output)
      if (task.output.length > MAX_OUTPUT_BUFFER) {
        task.output = task.output.slice(-MAX_OUTPUT_BUFFER)
      }
      // Persist to file if available (append, no cap)
      if (outputFile) {
        try {
          appendFileSync(outputFile, data, 'utf8')
        } catch {
          /* best-effort */
        }
      }
    }

    proc.stdout?.on('data', (data: Buffer) => appendOutput(data.toString()))
    proc.stderr?.on('data', (data: Buffer) => appendOutput(data.toString()))

    proc.on('close', (code: number | null) => {
      // Don't override status if the task was manually stopped
      if (task.stopped) return
      info.exitCode = code
      info.status = code === 0 ? 'completed' : 'failed'
      info.endTime = Date.now()
      info.durationMs = info.endTime - info.startTime
      task.process = null
    })

    proc.on('error', (err: Error) => {
      appendOutput(`\n[Process error: ${err.message}]\n`)
      // Don't override status if the task was manually stopped
      if (task.stopped) return
      info.exitCode = -1
      info.status = 'failed'
      info.endTime = Date.now()
      info.durationMs = info.endTime - info.startTime
      task.process = null
    })

    this.tasks.set(id, task)
    return id
  }

  /** Get basic task info (no output). */
  getTask(id: string): TaskInfo | undefined {
    const task = this.tasks.get(id)
    return task ? { ...task.info } : undefined
  }

  /**
   * Get task detail including output.
   * @param outputPreview  Max chars of output to return (default 30_000)
   */
  getTaskDetail(id: string, outputPreview = MAX_OUTPUT_RETURN): TaskDetail | undefined {
    const task = this.tasks.get(id)
    if (!task) return undefined
    const output = task.output.length > outputPreview
      ? task.output.slice(-outputPreview) +
        `\n\n[... output truncated: showing last ${outputPreview} of ${task.info.outputLength} chars ...]`
      : task.output
    return { ...task.info, output }
  }

  /** List all tasks (newest first). */
  listTasks(): TaskInfo[] {
    return Array.from(this.tasks.values())
      .map((t) => ({ ...t.info }))
      .sort((a, b) => b.startTime - a.startTime)
  }

  /** Update a task's description and/or metadata. Returns false if not found. */
  updateTask(
    id: string,
    updates: { description?: string; metadata?: Record<string, unknown> },
  ): boolean {
    const task = this.tasks.get(id)
    if (!task) return false
    if (updates.description !== undefined) {
      task.info.description = updates.description
    }
    if (updates.metadata !== undefined) {
      task.info.metadata = { ...task.info.metadata, ...updates.metadata }
    }
    return true
  }

  /** Stop a running task. Returns true if the task was running and was killed. */
  stopTask(id: string): boolean {
    const task = this.tasks.get(id)
    if (!task || !task.process) return false
    try {
      task.stopped = true  // prevent close handler from overriding status
      task.process.kill('SIGTERM')
      // Escalate to SIGKILL after 3s if still alive
      const proc = task.process
      setTimeout(() => {
        try {
          if (!proc.killed) proc.kill('SIGKILL')
        } catch {
          /* already dead */
        }
      }, 3000).unref()
      task.info.status = 'stopped'
      task.info.endTime = Date.now()
      task.info.durationMs = task.info.endTime - task.info.startTime
      task.process = null
      return true
    } catch {
      return false
    }
  }

  /**
   * Wait for a task to complete (or timeout). Polls every 100ms.
   * Returns the final TaskInfo, or null if the task doesn't exist.
   */
  async waitForTask(id: string, timeoutMs = 30_000): Promise<TaskInfo | null> {
    const task = this.tasks.get(id)
    if (!task) return null
    if (task.info.status !== 'running') return { ...task.info }

    const deadline = Date.now() + timeoutMs
    return new Promise((resolve) => {
      const poll = (): void => {
        const t = this.tasks.get(id)
        if (!t) {
          resolve(null)
          return
        }
        if (t.info.status !== 'running' || Date.now() >= deadline) {
          resolve({ ...t.info })
          return
        }
        setTimeout(poll, 100)
      }
      poll()
    })
  }

  /** Remove completed/failed/stopped tasks from memory. Returns count removed. */
  clearCompleted(): number {
    let removed = 0
    for (const [id, task] of this.tasks) {
      if (task.info.status !== 'running') {
        this.tasks.delete(id)
        removed++
      }
    }
    return removed
  }

  /** Get the output file path for a task (if sessionDir was provided). */
  getOutputFile(id: string): string | null {
    const task = this.tasks.get(id)
    return task?.outputFile ?? null
  }
}

// ── Formatting helpers ──────────────────────────────────────────────────────

/** Format a task list as a readable string for tool results. */
export function formatTaskList(tasks: TaskInfo[]): string {
  if (tasks.length === 0) return 'No background tasks.'
  const lines = tasks.map((t) => {
    const statusIcon =
      t.status === 'running' ? '◆' :
      t.status === 'completed' ? '✓' :
      t.status === 'failed' ? '✗' : '⊙'
    const duration = t.durationMs !== null ? ` (${(t.durationMs / 1000).toFixed(1)}s)` : ''
    const exit = t.exitCode !== null && t.exitCode !== 0 ? ` exit=${t.exitCode}` : ''
    return `${statusIcon} ${t.id} [${t.status}]${duration}${exit} ${t.description}`
  })
  return lines.join('\n')
}

/** Format a single task detail for tool results. */
export function formatTaskDetail(detail: TaskDetail): string {
  const lines = [
    `Task ${detail.id}: ${detail.description}`,
    `Status: ${detail.status}` +
      (detail.exitCode !== null ? ` (exit code: ${detail.exitCode})` : ''),
    `Command: ${detail.command}`,
    `Started: ${new Date(detail.startTime).toISOString()}`,
  ]
  if (detail.endTime) {
    lines.push(`Ended: ${new Date(detail.endTime).toISOString()}`)
    lines.push(`Duration: ${(detail.durationMs! / 1000).toFixed(1)}s`)
  } else {
    lines.push('Duration: (still running)')
  }
  if (detail.pid) lines.push(`PID: ${detail.pid}`)
  lines.push(`Output (${detail.outputLength} chars):`)
  lines.push(detail.output || '(no output yet)')
  return lines.join('\n')
}
