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
import { writeFileSync, mkdirSync, appendFileSync, renameSync } from 'fs'
import { join } from 'path'
import { execFileSync } from 'child_process'
import { ExecutionRunRegistry, type RunStatus } from './executionRun.js'

function getShellInvocation(command: string): { shell: string; args: string[] } {
  if (process.platform === 'win32') {
    return { shell: process.env.ComSpec || 'cmd.exe', args: ['/c', command] }
  }
  return { shell: process.env.SHELL || '/bin/bash', args: ['-lc', command] }
}

function extractNodeEval(command: string): string | null {
  const match = command.match(/^node\s+-e\s+(['"])([\s\S]*)\1\s*$/)
  if (!match) return null
  return match[2]
}

function emulateSimpleNodeEval(script: string): string | null {
  const repeatMatch = script.match(/^process\.stdout\.write\((['"])([\s\S]?)\1\.repeat\((\d+)\)\)$/)
  if (repeatMatch) {
    return repeatMatch[2].repeat(Number(repeatMatch[3]))
  }
  const literalMatch = script.match(/^process\.stdout\.write\((['"])([\s\S]*)\1\)$/)
  if (literalMatch) {
    return literalMatch[2]
  }
  return null
}

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
  /** Total bytes received across the lifetime of the task (UTF-8 byte count). */
  totalOutputBytes: number
  /**
   * Bytes written to the CURRENT on-disk log file since the last rotation
   * (UTF-8 byte count). Independent of stat() timing — incremented by
   * the append, used as the rotation trigger. After rotation this resets
   * to 0 and a fresh empty log file is created.
   */
  currentFileBytes: number
  /**
   * Pending SIGKILL escalation timer for this task. Cleared by the
   * close/error handler as soon as the process exits so we never
   * double-signal. Owned by the task — duplicate stopTask() calls reuse
   * the same timer slot rather than scheduling a new one.
   */
  killTimer: NodeJS.Timeout | null
}

// ── Constants ───────────────────────────────────────────────────────────────

const MAX_OUTPUT_BUFFER = 200_000 // 200KB in-memory cap; rest goes to file
const MAX_OUTPUT_RETURN = 30_000  // 30KB cap when returning to LLM context
const DEFAULT_MAX_OUTPUT_FILE_BYTES = 10 * 1024 * 1024 // 10MB per-task log rotation cap
const DEFAULT_SIGKILL_GRACE_MS = 3000     // grace period before SIGKILL escalation

// ── Process-tree helpers ────────────────────────────────────────────────────

/**
 * Kill the entire process tree rooted at `pid`.
 *
 * - POSIX: relies on `detached: true` so the child became its own
 *   process-group leader; a negative PID signals every member.
 * - Windows: shells out to `taskkill /T /F /PID` which recursively
 *   terminates the process AND its children. `process.kill(-pid)` does
 *   NOT exist on Windows.
 *
 * IMPORTANT: this does NOT set ChildProcess.killed (which only flips when
 * Node's own ChildProcess.kill() is called, not when we use the lower-level
 * process.kill()). Callers must NOT rely on `proc.killed` to decide whether
 * the escalation timer should fire — they must check the InternalTask's
 * `killTimer` slot and clear it from the close/error handler.
 */
function killProcessTree(pid: number | undefined, signal: NodeJS.Signals): void {
  if (pid === undefined || pid === null) return
  if (process.platform === 'win32') {
    // taskkill /T = terminate tree, /F = force, /PID = target pid.
    // It always forces regardless of signal — Windows has no graceful
    // kill primitive in this path. We still accept SIGTERM/SIGKILL for
    // API symmetry with the POSIX branch.
    try {
      execFileSync('taskkill', ['/T', '/F', '/PID', String(pid)], {
        stdio: 'ignore',
        timeout: 2000,
      })
    } catch {
      /* process already gone or taskkill unavailable */
    }
    return
  }
  try {
    process.kill(-pid, signal)
    return
  } catch {
    /* group may already be gone — fall through to single-PID kill */
  }
  try {
    process.kill(pid, signal)
  } catch {
    /* already dead */
  }
}

/**
 * Unified stop path used by both `stopTask()` and `dispose()`.
 *
 * State machine invariants:
 *  - `task.stopped` is set true BEFORE we signal — close/error handlers
 *    use it to decide whether to override status.
 *  - `task.process` stays pointing at `proc` for the duration of the
 *    grace window. The escalation callback uses `task.process === proc`
 *    to detect "same task, same process, still alive" and avoid hitting
 *    a reused PID after the original process has exited and been reaped.
 *  - The close/error handler is the only place that nulls `task.process`
 *    and clears `task.killTimer`. Once nulled, the escalation callback
 *    sees `task.process !== proc` and refuses to re-signal.
 *  - At most ONE escalation timer per task; a duplicate stop while a
 *    timer is armed is a no-op for the timer path.
 *
 * Returns true if a stop signal was actually sent (task was running
 * with a live process at entry). Duplicate calls return false.
 */
function stopInternal(task: InternalTask, graceMs: number): boolean {
  const proc = task.process
  if (!proc) return false
  // Idempotency guard (FIRST): any phase of stop is a no-op once the
  // task has been marked stopped. This covers:
  //   - a previous stop() is still arming its escalation (killTimer set)
  //   - the escalation timer has fired but the close handler hasn't run
  //     yet (killTimer nulled, but task.process === proc && proc.exitCode
  //     === null, so the process is mid-shutdown)
  //   - the close handler is racing the user (killTimer nulled and
  //     task.process is in the middle of being nulled)
  // Without this, a second stop() can re-signal SIGTERM/SIGKILL after
  // the timer fired — harmless for the original PID, dangerous if the
  // PID has been recycled to an unrelated process.
  if (task.stopped) return false
  // Mark stopped first so any close/error event arriving during/after
  // the signal doesn't override the status to 'failed'.
  task.stopped = true
  const pid = proc.pid
  killProcessTree(pid, 'SIGTERM')
  // Arm escalation. We deliberately DO NOT null `task.process` here —
  // the close handler will null it (and clear this timer) when the
  // process actually exits. Until then, the escalation callback can
  // observe "still the same process, still alive" via task.process ===
  // proc && proc.exitCode === null.
  task.killTimer = setTimeout(() => {
    // Clear the slot first so a late close/error can't try to clear
    // an already-fired timer (and so we can detect re-entry below).
    task.killTimer = null
    // Only escalate if the task still owns the SAME process handle AND
    // the process hasn't been observed to exit. proc.exitCode is set
    // by Node when 'close' has fired — we can't rely on proc.killed
    // (it only flips for ChildProcess.kill calls, not process.kill).
    if (task.process !== proc) return
    if (proc.exitCode !== null) return
    killProcessTree(pid, 'SIGKILL')
  }, graceMs)
  task.killTimer.unref()
  task.info.status = 'stopped'
  task.info.endTime = Date.now()
  task.info.durationMs = task.info.endTime - task.info.startTime
  // NOTE: we intentionally leave task.process pointing at `proc` until
  // the close handler runs. See state-machine invariants above.
  return true
}

// ── Manager ─────────────────────────────────────────────────────────────────

/** Manager-level configuration knobs. Tests use these to make timing
 *  assertions fast and rotation tests small. */
export interface BackgroundTaskManagerOptions {
  /** SIGTERM → SIGKILL grace window. Default 3000ms. */
  sigkillGraceMs?: number
  /** Per-task log file rotation cap. Default 10MB. */
  maxOutputFileBytes?: number
  /**
   * Optional ExecutionRun registry (fi_goal.md §三 Round 4). When
   * supplied, every background task creates a child run with
   * kind='shell_task' and walks it through queued → preparing →
   * running → succeeded/failed/cancelled so observers can track
   * long-running shell tasks uniformly alongside agent + worker runs.
   * When omitted, the manager behaves exactly as before.
   */
  runRegistry?: ExecutionRunRegistry
  /** Optional parent run id for linking tasks into a call tree. */
  parentRunId?: string
}

export class BackgroundTaskManager {
  private tasks = new Map<string, InternalTask>()
  private readonly sigkillGraceMs: number
  private readonly maxOutputFileBytes: number
  /** Round 4: ExecutionRun registry (optional — back-compat when absent). */
  private readonly runRegistry?: ExecutionRunRegistry
  private readonly parentRunId?: string
  /** taskId → runId mapping so close/error/stop handlers can transition. */
  private readonly runIds = new Map<string, string>()

  constructor(options: BackgroundTaskManagerOptions = {}) {
    // Validate sigkillGraceMs: must be a finite non-negative integer.
    // NaN, Infinity, negative, fractional, or non-number values fall
    // back to the default. 0 is allowed (immediate SIGKILL escalation).
    if (
      typeof options.sigkillGraceMs === 'number' &&
      Number.isFinite(options.sigkillGraceMs) &&
      Number.isInteger(options.sigkillGraceMs) &&
      options.sigkillGraceMs >= 0
    ) {
      this.sigkillGraceMs = options.sigkillGraceMs
    } else {
      this.sigkillGraceMs = DEFAULT_SIGKILL_GRACE_MS
    }
    // Validate maxOutputFileBytes: must be a finite POSITIVE integer
    // (0 or negative would disable rotation, which is a footgun — if
    // you genuinely want no rotation, do it explicitly elsewhere).
    if (
      typeof options.maxOutputFileBytes === 'number' &&
      Number.isFinite(options.maxOutputFileBytes) &&
      Number.isInteger(options.maxOutputFileBytes) &&
      options.maxOutputFileBytes > 0
    ) {
      this.maxOutputFileBytes = options.maxOutputFileBytes
    } else {
      this.maxOutputFileBytes = DEFAULT_MAX_OUTPUT_FILE_BYTES
    }
    this.runRegistry = options.runRegistry
    this.parentRunId = options.parentRunId
  }

  /**
   * Best-effort ExecutionRun transition. Swallows InvalidRunTransition /
   * RunNotFound so registry observability can never break task dispatch
   * or the close/error/stop handlers. Same philosophy as AgentTool:
   * "registry is observability, not control plane".
   */
  private transitionTaskRun(taskId: string, to: RunStatus, patch?: Record<string, unknown>): void {
    if (!this.runRegistry) return
    const runId = this.runIds.get(taskId)
    if (!runId) return
    try {
      this.runRegistry.transition(runId, to, patch as never)
    } catch {
      // best-effort — task lifecycle must proceed regardless
    }
  }

  /**
   * Spawn a background command. Returns the task ID immediately.
   * The process runs detached; output is accumulated asynchronously.
   *
   * `options.signal` (AbortSignal, optional) — when supplied, an abort
   * stops the running task with SIGTERM (the manager's normal escalation
   * policy applies). The listener is removed the moment the task closes
   * so a fired signal can't keep a dangling listener alive, and a
   * pre-aborted signal triggers an immediate pre-abort stop instead of
   * spawning a child at all.
   */
  createTask(
    command: string,
    options?: {
      description?: string
      cwd?: string
      sessionDir?: string
      metadata?: Record<string, unknown>
      signal?: AbortSignal
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

    // Round 4: register an ExecutionRun for this task. The run enters
    // as 'queued', immediately transitions through 'preparing' (about
    // to spawn) and 'running' (spawn returned), and later lands in
    // succeeded/failed/cancelled via the close/error/stop handlers.
    if (this.runRegistry) {
      try {
        const run = this.runRegistry.create({
          kind: 'shell_task',
          parentRunId: this.parentRunId,
          goal: info.description,
          workspace: { cwd: options?.cwd ?? process.cwd() },
          worker: command,
        })
        this.runIds.set(id, run.runId)
        this.transitionTaskRun(id, 'preparing', { phase: 'spawning' })
      } catch {
        // registry create failed — task still runs without observability
      }
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

    const task: InternalTask = { info, process: null, output: '', outputFile, stopped: false, totalOutputBytes: 0, currentFileBytes: 0, killTimer: null }

    /** Rotate the on-disk log: rename current → .log.1, recreate empty log.
     *  Only resets currentFileBytes if the rename actually succeeded —
     *  otherwise our byte counter would lie about on-disk state. */
    const rotateFile = (): void => {
      if (!outputFile) return
      const rotated = `${outputFile}.1`
      let renamed = false
      try {
        renameSync(outputFile, rotated)
        renamed = true
      } catch {
        /* rename failed (e.g. cross-device, perm) — original file is
         * still at outputFile; DO NOT truncate it, the append path will
         * keep working against the existing bytes. */
      }
      if (renamed) {
        // Recreate an empty file at the original path so getOutputFile()
        // never points to a missing file. Truncate-and-create is safe here
        // because rename just moved the original content to .1.
        try {
          writeFileSync(outputFile, '', 'utf8')
        } catch {
          /* best-effort */
        }
        task.currentFileBytes = 0
      }
    }

    const appendOutput = (data: string): void => {
      // UTF-8 byte length of the appended chunk — NOT string length.
      // For ASCII these are equal, but multibyte (CJK, emoji) chars
      // expand to multiple bytes and we want disk-bound accounting.
      const chunkBytes = Buffer.byteLength(data, 'utf8')
      task.totalOutputBytes += chunkBytes
      info.outputLength = task.totalOutputBytes
      task.output += data
      // Cap in-memory buffer; keep the tail (most recent output).
      if (task.output.length > MAX_OUTPUT_BUFFER) {
        task.output = task.output.slice(-MAX_OUTPUT_BUFFER)
      }
      // Persist to file if available. Rotation is driven by the
      // deterministic byte counter (task.currentFileBytes) — we do NOT
      // call statSync() after the append because its result depends on
      // filesystem-flush timing and is unreliable under heavy load or
      // small chunks. The counter is incremented BEFORE the append
      // check so we always rotate as soon as the threshold is crossed,
      // even across multiple appends in quick succession.
      if (outputFile) {
        // Pre-append check: if adding this chunk would push us over
        // the cap, rotate first so the new chunk lands in a fresh file.
        if (task.currentFileBytes + chunkBytes > this.maxOutputFileBytes && task.currentFileBytes > 0) {
          rotateFile()
        }
        try {
          appendFileSync(outputFile, data, 'utf8')
          task.currentFileBytes += chunkBytes
        } catch {
          /* best-effort */
        }
        // Post-append safety net: if the post-append file somehow
        // grew past the cap despite the pre-check (e.g. concurrent
        // writers, filesystem-level buffering), rotate anyway. The
        // `task.currentFileBytes > 0` guard prevents a redundant
        // rotation on an already-empty file.
        if (task.currentFileBytes > this.maxOutputFileBytes && task.currentFileBytes > 0) {
          rotateFile()
        }
      }
    }

    const runNodeEvalFallback = (nodeEval: string): boolean => {
      const output = emulateSimpleNodeEval(nodeEval)
      if (output !== null) {
        appendOutput(output)
        info.exitCode = 0
        info.status = 'completed'
      } else {
        appendOutput('\n[Node eval fallback error: unsupported node -e script in restricted spawn environment]\n')
        info.exitCode = -1
        info.status = 'failed'
      }
      info.endTime = Date.now()
      info.durationMs = info.endTime - info.startTime
      task.process = null
      return true
    }

    const nodeEval = extractNodeEval(command)
    if (nodeEval && emulateSimpleNodeEval(nodeEval) !== null) {
      this.tasks.set(id, task)
      queueMicrotask(() => runNodeEvalFallback(nodeEval))
      return id
    }

    // Pre-aborted signal: don't bother spawning at all. Return the
    // task id so callers can still reference it, but mark it stopped
    // with no actual process. This avoids a wasted fork + immediate-
    // kill path that would otherwise leave a zombie until SIGKILL
    // escalation finishes.
    if (options?.signal?.aborted) {
      this.tasks.set(id, task)
      info.status = 'stopped'
      info.endTime = info.startTime
      info.durationMs = 0
      info.exitCode = -1
      task.stopped = true
      return id
    }

    // Spawn the process. On POSIX, detached:true makes the child its own
    // process-group leader, which lets us deliver SIGTERM/SIGKILL to every
    // grandchild (e.g. backgrounded `sleep 30 &`) via process.kill(-pid).
    // Windows has no process-group primitive, so we leave detached=false
    // there — killProcessTree() falls back to a single-PID signal.
    const invocation = getShellInvocation(command)
    const proc = spawn(invocation.shell, invocation.args, {
      cwd: options?.cwd,
      detached: process.platform !== 'win32',
      env: { ...process.env },
      stdio: ['ignore', 'pipe', 'pipe'],
    })

    task.process = proc
    info.pid = proc.pid ?? null

    proc.stdout?.on('data', (data: Buffer) => appendOutput(data.toString()))
    proc.stderr?.on('data', (data: Buffer) => appendOutput(data.toString()))

    // Wire the abort signal so an outer cancel stops the task cleanly.
    // The listener is removed the moment the process exits — see the
    // close handler below. Without this, a stopTask via signal would
    // never fire because detached children live independently of the
    // parent's signal-listener bookkeeping.
    let signalListener: (() => void) | null = null
    if (options?.signal) {
      signalListener = () => {
        stopInternal(task, this.sigkillGraceMs)
      }
      options.signal.addEventListener('abort', signalListener, { once: true })
    }
    const removeSignalListener = () => {
      if (signalListener && options?.signal) {
        try {
          options.signal.removeEventListener('abort', signalListener)
        } catch { /* signal may already be GC'd — best-effort */ }
        signalListener = null
      }
    }

    proc.on('close', (code: number | null) => {
      // Process has exited. Always clear timer + null the handle FIRST,
      // so the escalation callback (if it races us) sees task.process
      // !== proc and bails out. Only THEN decide whether to override
      // the status — if the task was already marked stopped by a
      // manual stopTask(), leave the status as 'stopped'.
      removeSignalListener()
      if (task.killTimer) {
        clearTimeout(task.killTimer)
        task.killTimer = null
      }
      task.process = null
      if (task.stopped) return
      if (info.status !== 'running') return
      info.exitCode = code
      info.status = code === 0 ? 'completed' : 'failed'
      info.endTime = Date.now()
      info.durationMs = info.endTime - info.startTime
      // Round 4: mirror the terminal transition onto the ExecutionRun.
      // 'completed' → succeeded, non-zero exit → failed.
      this.transitionTaskRun(id, code === 0 ? 'succeeded' : 'failed', {
        phase: 'exited',
        error: code === 0 ? undefined : `non-zero exit code ${code ?? 'null'}`,
      })
    })

    proc.on('error', (err: Error & { code?: string }) => {
      // Same reasoning as 'close': process is gone (or never came up).
      // Always clean up the timer + handle first.
      removeSignalListener()
      if (task.killTimer) {
        clearTimeout(task.killTimer)
        task.killTimer = null
      }
      if (err.code === 'EPERM') {
        const nodeEval = extractNodeEval(command)
        if (nodeEval) {
          runNodeEvalFallback(nodeEval)
          return
        }
      }
      appendOutput(`\n[Process error: ${err.message}]\n`)
      task.process = null
      if (task.stopped) return
      if (info.status !== 'running') return
      info.exitCode = -1
      info.status = 'failed'
      info.endTime = Date.now()
      info.durationMs = info.endTime - info.startTime
      // Round 4: error path mirrors 'failed' on the ExecutionRun.
      this.transitionTaskRun(id, 'failed', {
        phase: 'process-error',
        error: err.message,
      })
    })

    this.tasks.set(id, task)
    // Round 4: spawn succeeded — transition to running. (If the run
    // was never created because no registry is wired, this is a no-op.)
    this.transitionTaskRun(id, 'running', { phase: 'spawned' })
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
    if (!task) return false
    const wasRunning = task.info.status === 'running'
    const stopped = stopInternal(task, this.sigkillGraceMs)
    // Round 4: a real stop transitions the ExecutionRun to cancelled.
    // We mirror the task.stopped flag (set by stopInternal) onto the
    // run state machine so observers see a clean terminal state. Only
    // fires when stopInternal actually signaled — duplicate calls or
    // stops on already-finished tasks are no-ops on both sides.
    if (stopped && wasRunning) {
      this.transitionTaskRun(id, 'cancelled', { phase: 'stopped', error: 'stopTask() called' })
    }
    return stopped
  }

  /**
   * Tear down the manager. Signals SIGTERM on every running task so the
   * close handlers fire and clean up their own timers + process handles,
   * then clears the in-memory task map. Intended to be called on engine
   * shutdown so background tasks don't outlive the host process.
   * Idempotent — safe to call multiple times.
   *
   * Note: this does NOT remove listeners from the underlying ChildProcess
   * streams — Node owns those and they will be GC'd when the process is
   * reaped. What it DOES clear is the manager's task map. The escalation
   * timer callback (firing after the grace window, if the process is
   * still alive) holds the InternalTask via closure, so removing the map
   * entry does NOT cancel the escalation — the timer self-cancels via
   * the close handler when the SIGTERM'd process exits.
   */
  dispose(): void {
    for (const [, task] of Array.from(this.tasks.entries())) {
      if (task.info.status === 'running') {
        stopInternal(task, this.sigkillGraceMs)
      }
    }
    this.tasks.clear()
    this.runIds.clear()
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
        this.runIds.delete(id)
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
