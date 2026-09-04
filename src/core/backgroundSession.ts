/**
 * Background Session Manager
 *
 * Runs an entire ovolv999 REPL session detached from the current
 * terminal, so long-running tasks (refactors, big migrations, test
 * suites) can proceed without holding the user's TTY. The user can
 * later list, inspect, tail logs, attach, or stop these sessions via
 * the `ovolv999 ps` / `ovolv999 logs <id>` / `ovolv999 attach <id>` /
 * `ovolv999 stop <id>` CLI subcommands.
 *
 * Distinct from {@link BackgroundTaskManager}: that manages individual
 * shell subprocesses spawned by the Bash tool *within* one session;
 * this manages the sessions themselves.
 *
 * Storage layout (under ~/.ovolv999/sessions/):
 *   <id>.json   — session metadata (pid, task, cwd, status, timestamps)
 *   <id>.log    — captured stdout+stderr of the detached process
 *   <id>.exit   — written on process exit, contains the exit code
 */

import { spawn, type ChildProcess } from 'child_process'
import {
  existsSync, readFileSync, writeFileSync, mkdirSync, unlinkSync,
  readdirSync, statSync, appendFileSync, openSync, closeSync, fstatSync,
} from 'fs'
import { atomicWriteSync } from './atomicWrite.js'
import { join } from 'path'
import { homedir } from 'os'
import { randomBytes } from 'crypto'

// ── Types ───────────────────────────────────────────────────────────────────

export type SessionStatus = 'running' | 'completed' | 'failed' | 'stopped' | 'unknown'

export interface SessionMetadata {
  id: string
  task: string
  cwd: string
  model?: string
  pid: number | null
  startedAt: string
  endedAt?: string
  status: SessionStatus
  logPath: string
  exitCode?: number
  /** Extra args passed to the spawned ovolv999 */
  args?: string[]
  /**
   * Linux-only identity anchor: the kernel process start time (field 22
   * of /proc/<pid>/stat) captured at spawn. stopSession compares it
   * before escalating SIGKILL so a recycled PID can never cause the
   * escalation to murder an unrelated process.
   */
  pidStartTime?: string | null
}

export interface StartSessionOptions {
  task: string
  cwd?: string
  model?: string
  /** Extra CLI args to forward to the spawned ovolv999 */
  extraArgs?: string[]
  /** Environment override (defaults to process.env) */
  env?: NodeJS.ProcessEnv
}

export interface StartSessionResult {
  sessionId: string
  pid: number | null
  logPath: string
}

export interface LogReadOptions {
  /** Number of lines from the tail (default: all) */
  tailLines?: number
  /** Start byte offset (alternative to tailLines) */
  startOffset?: number
}

export interface AttachResult {
  /** Stream of new log lines (after attach point) */
  stream: AsyncIterable<string>
  /** Stop watching and clean up */
  stop: () => void
  /** Current metadata snapshot */
  metadata: SessionMetadata
}

// ── Paths ───────────────────────────────────────────────────────────────────

export function getSessionsDir(): string {
  return join(homedir(), '.ovolv999', 'sessions')
}

export function getMetadataPath(id: string): string {
  return join(getSessionsDir(), `${id}.json`)
}

export function getLogPath(id: string): string {
  return join(getSessionsDir(), `${id}.log`)
}

export function getExitPath(id: string): string {
  return join(getSessionsDir(), `${id}.exit`)
}

function ensureSessionsDir(): void {
  const dir = getSessionsDir()
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
}

// ── ID Generation ───────────────────────────────────────────────────────────

export function generateSessionId(): string {
  const ts = Date.now().toString(36)
  const rand = randomBytes(4).toString('hex')
  return `sess-${ts}-${rand}`
}

// ── Metadata I/O ────────────────────────────────────────────────────────────

export function saveMetadata(meta: SessionMetadata): void {
  ensureSessionsDir()
  atomicWriteSync(getMetadataPath(meta.id), JSON.stringify(meta, null, 2))
}

export function loadMetadata(id: string): SessionMetadata | null {
  const path = getMetadataPath(id)
  if (!existsSync(path)) return null
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as SessionMetadata
  } catch {
    return null
  }
}

export function updateMetadata(id: string, patch: Partial<SessionMetadata>): SessionMetadata | null {
  const current = loadMetadata(id)
  if (!current) return null
  const updated = { ...current, ...patch }
  saveMetadata(updated)
  return updated
}

// ── Liveness ────────────────────────────────────────────────────────────────

/**
 * Check if a PID is still alive. Uses process.kill(pid, 0) which
 * throws ESRCH if the process doesn't exist. Detached children get
 * reparented to init, so this works even though we're not the parent.
 */
export function isPidAlive(pid: number | null): boolean {
  if (!pid || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/**
 * Refresh a session's status by checking process liveness + exit file.
 * Updates the metadata on disk if the status changed.
 */
export function refreshSessionStatus(id: string): SessionMetadata | null {
  const meta = loadMetadata(id)
  if (!meta) return null
  if (meta.status !== 'running') return meta

  // Check exit code file first (written by wrapper or reaper)
  const exitPath = getExitPath(id)
  let exitCode: number | undefined
  if (existsSync(exitPath)) {
    try {
      exitCode = parseInt(readFileSync(exitPath, 'utf8').trim(), 10)
    } catch { /* ignore */ }
  }

  const alive = isPidAlive(meta.pid)
  if (alive && exitCode === undefined) return meta

  // Process ended
  const newStatus: SessionStatus =
    exitCode === undefined ? 'unknown' :
    exitCode === 0 ? 'completed' :
    exitCode === 130 ? 'stopped' :
    'failed'

  return updateMetadata(id, {
    status: newStatus,
    endedAt: new Date().toISOString(),
    exitCode,
  })
}

// ── Start Session ───────────────────────────────────────────────────────────

/**
 * Resolve the ovolv999 executable to spawn. Honors the OVOLV999_BIN
 * env var (useful for tests), otherwise uses process.argv[1].
 */
function resolveOvogogogoBin(): string {
  if (process.env.OVOLV999_BIN) return process.env.OVOLV999_BIN
  if (process.argv[1]) return process.argv[1]
  return 'ovolv999'
}

export function startBackgroundSession(options: StartSessionOptions): StartSessionResult {  ensureSessionsDir()
  const id = generateSessionId()
  const logPath = getLogPath(id)
  const cwd = options.cwd ?? process.cwd()

  // Build args: <task> [--model X] [...extraArgs]
  const spawnArgs: string[] = [options.task]
  if (options.model) {
    spawnArgs.push('--model', options.model)
  }
  if (options.extraArgs) {
    spawnArgs.push(...options.extraArgs)
  }

  // Write an empty log file so the path exists before we open the fd
  writeFileSync(logPath, '')

  // Open the log in append mode and pass the fd as the child's stdout AND
  // stderr. The OS dup2's the fd into the child's fd 1/2, so the child's
  // stdout/stderr are redirected straight to the log file at the kernel
  // level — no child-side self-detection, monkey-patching, or env var
  // needed. The background session does not need to know it is background.
  // (Previously this was stdio:['ignore','ignore','ignore'] with a fragile
  // child-side appendFileSync monkey-patch keyed off OVOLV999_SESSION_ID —
  // see initChildLogCapture, now retained only as a legacy fallback.)
  let logFd: number | null = null
  try {
    logFd = openSync(logPath, 'a')
  } catch { /* fall back to ignore stdio below */ }

  const bin = resolveOvogogogoBin()
  const env = { ...process.env, ...options.env, OVOLV999_SESSION_ID: id }

  // stdio config: pipe the log fd to both stdout & stderr when we have it.
  const stdio: ['ignore', number | 'ignore', number | 'ignore'] = logFd !== null
    ? ['ignore', logFd, logFd]
    : ['ignore', 'ignore', 'ignore']

  let proc: ChildProcess
  try {
    proc = spawn(process.execPath, [bin, ...spawnArgs], {
      cwd,
      detached: true,
      stdio,
      env,
    })
  } catch {
    // Fallback: try invoking the bin directly (non-node)
    try {
      proc = spawn(bin, spawnArgs, {
        cwd,
        detached: true,
        stdio,
        env,
      })
    } catch {
      if (logFd !== null) { try { closeSync(logFd) } catch { /* ignore */ } }
      throw new Error(`Failed to spawn background session: ${bin}`)
    }
  }

  // The child inherits the log fd via dup2; the parent must NOT close it
  // while the child lives, and on `detached: true` the child outlives the
  // parent. We leave it open for the parent's lifetime — it is freed when
  // the parent process exits. (Closing in the parent after spawn does NOT
  // affect the child's inherited copy, but keeping it avoids any race
  // where the parent exits immediately and the OS reaps the fd before the
  // child's dup2 completes.)

  const pid = proc.pid ?? null
  const pidStartTime = readPidStartTime(pid)

  // Unref so the parent can exit independently
  try { proc.unref() } catch { /* ignore */ }
  // R23: a post-spawn 'error' event (EAGAIN, fork-exec failure) has no
  // handler at the other spawn sites — but a detached background session
  // is non-fatal to the parent, so swallow it. refreshSessionStatus will
  // classify the dead session on the next poll.
  proc.on('error', () => { /* best-effort: detached child spawn failure */ })

  const meta: SessionMetadata = {
    id,
    task: options.task,
    cwd,
    model: options.model,
    pid,
    pidStartTime,
    startedAt: new Date().toISOString(),
    status: 'running',
    logPath,
    args: spawnArgs,
  }
  saveMetadata(meta)

  return { sessionId: id, pid, logPath }
}

// ── Stop Session ────────────────────────────────────────────────────────────

/**
 * Read the kernel start time of a PID (Linux /proc only, null elsewhere).
 * Used as a PID-identity anchor: if the process exits and the OS recycles
 * its PID, the new occupant has a different start time.
 */
function readPidStartTime(pid: number | null): string | null {
  if (process.platform !== 'linux' || pid == null || pid <= 0) return null
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8')
    // comm (field 2) may contain spaces/parens — parse after the last ')'.
    // Fields then run from state (3); starttime is field 22 → index 19.
    const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ')
    return fields[19] ?? null
  } catch {
    return null
  }
}

export function stopSession(id: string, graceMs = 5000): boolean {
  const meta = loadMetadata(id)
  if (!meta) return false
  if (!meta.pid) return false

  if (!isPidAlive(meta.pid)) {
    updateMetadata(id, { status: 'stopped', endedAt: new Date().toISOString() })
    return true
  }

  // Send SIGTERM (graceful), escalate to SIGKILL after grace period
  try {
    process.kill(meta.pid, 'SIGTERM')
  } catch {
    return false
  }

  // Check after grace period — caller can await this
  const deadline = Date.now() + graceMs
  const checkLiveness = (): void => {
    if (isPidAlive(meta.pid) && Date.now() < deadline) {
      // PID-identity guard: if the original process exited and the OS
      // recycled its PID within the grace window, SIGKILL would hit an
      // innocent process. Skip escalation when the start time no longer
      // matches (Linux only — other platforms keep best-effort behavior).
      if (meta.pidStartTime && readPidStartTime(meta.pid) !== meta.pidStartTime) return
      // Still alive — escalate
      try { process.kill(meta.pid!, 'SIGKILL') } catch { /* ignore */ }
    }
  }
  // R18: unref the liveness re-check so a pending escalation cannot keep
  // the event loop alive after stopSession returns (process exit would
  // hang for up to graceMs otherwise). One-shot, so no clear needed.
  const livenessTimer = setTimeout(checkLiveness, graceMs)
  livenessTimer.unref()

  // Write exit file so refreshSessionStatus classifies it as "stopped"
  try {
    writeFileSync(getExitPath(id), '130\n')
  } catch { /* ignore */ }

  updateMetadata(id, { status: 'stopped', endedAt: new Date().toISOString(), exitCode: 130 })
  return true
}

// ── List / Get ──────────────────────────────────────────────────────────────

export function listSessions(): SessionMetadata[] {
  const dir = getSessionsDir()
  if (!existsSync(dir)) return []

  const sessions: SessionMetadata[] = []
  for (const file of readdirSync(dir)) {
    if (!file.endsWith('.json')) continue
    const id = file.slice(0, -5)
    const meta = refreshSessionStatus(id)
    if (meta) sessions.push(meta)
  }

  // Most recent first
  sessions.sort((a, b) => b.startedAt.localeCompare(a.startedAt))
  return sessions
}

export function getSession(id: string): SessionMetadata | null {
  return refreshSessionStatus(id)
}

// ── Logs ────────────────────────────────────────────────────────────────────

export function readSessionLogs(id: string, opts: LogReadOptions = {}): string {
  const logPath = getLogPath(id)
  if (!existsSync(logPath)) return ''

  if (opts.startOffset !== undefined) {
    try {
      const fd = readFileSync(logPath)
      if (opts.startOffset >= fd.length) return ''
      return fd.slice(opts.startOffset).toString('utf8')
    } catch {
      return ''
    }
  }

  const content = readFileSync(logPath, 'utf8')
  if (opts.tailLines === undefined) return content

  const lines = content.split('\n')
  // Drop a single trailing empty element from a final newline so
  // `tail -n 2` of "a\nb\nc\nd\ne\n" returns "d\ne" (matching `tail -n2`).
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()
  const tail = lines.slice(-opts.tailLines)
  return tail.join('\n')
}

export function getLogSize(id: string): number {
  const logPath = getLogPath(id)
  if (!existsSync(logPath)) return 0
  try {
    return statSync(logPath).size
  } catch {
    return 0
  }
}

/**
 * Watch a session's log for new lines. Returns an async iterable that
 * yields each new line as it's appended. Polls the file every
 * `pollMs` (default 500ms) since fs.watch is unreliable across
 * platforms and over network filesystems.
 */
export function attachToSession(id: string, pollMs = 500): AttachResult | null {
  const meta = getSession(id)
  if (!meta) return null

  let offset = getLogSize(id)
  let stopped = false
  let timer: ReturnType<typeof setTimeout> | null = null

  const queue: string[] = []
  let resolveNext: ((value: IteratorResult<string>) => void) | null = null

  /**
   * Drain any buffered lines into a pending consumer, then — if the session
   * is no longer running — finalize the stream so the `for await` consumer
   * exits in bounded time. Without this, `ovolv999 attach <id>` on a
   * completed/stopped session hangs forever: the poll timer keeps ticking,
   * but nothing ever resolves the pending `next()` with `done: true`.
   * (Black-box E2E: tests/cli/attachE2E.test.ts test 2.)
   */
  const finalizeIfDone = (): void => {
    if (stopped) return
    const fresh = getSession(id)
    if (!fresh || fresh.status === 'running') return
    // Session ended. Flush any buffered lines first, then end the stream.
    if (queue.length > 0 || resolveNext === null) {
      if (queue.length === 0 && resolveNext === null) {
        stopped = true
        if (timer) { clearTimeout(timer); timer = null }
      }
      return
    }
    // resolveNext is pending and queue is empty → end now.
    stopped = true
    if (timer) { clearTimeout(timer); timer = null }
    resolveNext({ value: undefined, done: true })
    resolveNext = null
  }

  const poll = (): void => {
    if (stopped) return
    try {
      const size = getLogSize(id)
      if (size > offset) {
        const chunk = readSessionLogs(id, { startOffset: offset })
        offset = size
        for (const line of chunk.split('\n')) {
          if (line.length === 0) continue
          if (resolveNext) {
            resolveNext({ value: line, done: false })
            resolveNext = null
          } else {
            queue.push(line)
          }
        }
      }
      // If the session is no longer running, end the stream once the log is
      // fully drained — see finalizeIfDone.
      finalizeIfDone()
    } catch { /* ignore */ }

    if (!stopped) {
      // R23 originally unref'd the recursive poll timer to prevent an
      // abandoned attachment from keeping the event loop alive. But the
      // ONLY production caller is the `ovolv999 attach <id>` CLI, where
      // this poll timer is the work the process exists to do: it must
      // stay alive until a log line arrives, the session ends, or the
      // user hits Ctrl-C. With the timer unref'd, a pending
      // `for await (line of stream)` is NOT itself a ref handle, so Node
      // sees zero refs and exits immediately — attach dies before it can
      // deliver the first line. (Verified by black-box E2E:
      // tests/cli/attachE2E.test.ts.) Keep the timer REF'd so it keeps
      // the loop alive for the attach CLI. Abandoned non-CLI callers must
      // call stop() (they always have — the unit tests do).
      timer = setTimeout(poll, pollMs)
    }
  }
  timer = setTimeout(poll, pollMs)

  const stream: AsyncIterable<string> = {
    [Symbol.asyncIterator]() {
      return {
        next(): Promise<IteratorResult<string>> {
          if (queue.length > 0) {
            return Promise.resolve({ value: queue.shift()!, done: false })
          }
          if (stopped) {
            return Promise.resolve({ value: undefined, done: true })
          }
          return new Promise((resolve) => {
            resolveNext = resolve
          })
        },
        return(): Promise<IteratorResult<string>> {
          stopped = true
          if (timer) clearTimeout(timer)
          return Promise.resolve({ value: undefined, done: true })
        },
      }
    },
  }

  const stop = (): void => {
    stopped = true
    if (timer) clearTimeout(timer)
    if (resolveNext) {
      resolveNext({ value: undefined, done: true })
      resolveNext = null
    }
  }

  return { stream, stop, metadata: meta }
}

// ── Remove / Clean ──────────────────────────────────────────────────────────

export function removeSession(id: string, force = false): boolean {
  const meta = loadMetadata(id)
  if (!meta) return false

  // Don't remove running sessions unless forced
  if (!force && meta.status === 'running' && isPidAlive(meta.pid)) {
    return false
  }

  for (const path of [getMetadataPath(id), getLogPath(id), getExitPath(id)]) {
    if (existsSync(path)) {
      try { unlinkSync(path) } catch { /* ignore */ }
    }
  }
  return true
}

export function cleanStaleSessions(maxAge = 7 * 24 * 60 * 60 * 1000): number {
  const sessions = listSessions()
  const cutoff = Date.now() - maxAge
  let removed = 0
  for (const s of sessions) {
    if (s.status === 'running') continue
    const started = new Date(s.startedAt).getTime()
    if (started < cutoff) {
      if (removeSession(s.id, true)) removed++
    }
  }
  return removed
}

// ── Child-side log capture ──────────────────────────────────────────────────

/**
 * Called by the spawned ovolv999 process itself. When the parent spawned the
 * session via `stdio: ['ignore', logFd, logFd]` (the modern path), the OS has
 * already dup2'd the log fd into the child's fd 1/2, so `process.stdout` and
 * `process.stderr` already write straight to the log file. In that case the
 * monkey-patch below would DOUBLE-write (one copy via the OS redirect, one via
 * the appendFileSync), so we detect that condition and skip the patch — only
 * the exit-code writer still runs.
 *
 * The legacy detection key is `OVOLV999_SESSION_ID`. For processes launched
 * the old way (`stdio: 'ignore'` with no fd), stdout/stderr are not the log
 * file, so the monkey-patch is required and is applied. This keeps backward
 * compatibility with any session spawned before the fd-passing change.
 */
export function initChildLogCapture(): string | null {
  const sessionId = process.env.OVOLV999_SESSION_ID
  if (!sessionId) return null

  const logPath = getLogPath(sessionId)
  ensureSessionsDir()

  // Detect whether stdout is ALREADY the log file. When the parent passed
  // `stdio: ['ignore', logFd, logFd]`, fd 1 is the log fd and its destination
  // path matches `logPath`. fstat(fd) + stat(path) and compare dev/ino pair.
  const alreadyRedirected = stdoutIsLogFile(logPath)

  if (!alreadyRedirected) {
    // Legacy path: stdout is not the log file. Tee writes to the log AND
    // keeps the original stream (so pipe mode still works if someone
    // backgrounds a pipe run).
    const origWrite = process.stdout.write.bind(process.stdout)
    const origErrWrite = process.stderr.write.bind(process.stderr)

    const appendLog = (data: unknown): void => {
      try {
        appendFileSync(logPath, data as string | Uint8Array)
      } catch { /* ignore disk errors */ }
    }

    process.stdout.write = (data: unknown, ..._rest: unknown[]): boolean => {
      appendLog(data)
      return origWrite(data as string | Uint8Array)
    }
    process.stderr.write = (data: unknown, ..._rest: unknown[]): boolean => {
      appendLog(data)
      return origErrWrite(data as string | Uint8Array)
    }
  }

  // Write exit code on process end — runs in both modes.
  process.on('exit', (code) => {
    try {
      writeFileSync(getExitPath(sessionId), `${code ?? 0}\n`)
    } catch { /* ignore */ }
  })

  return sessionId
}

/**
 * Return true iff the child's stdout (fd 1) currently points at the same
 * file as `logPath` (by device + inode). Used by {@link initChildLogCapture}
 * to decide whether the OS-level redirect is already in place. Never throws.
 */
function stdoutIsLogFile(logPath: string): boolean {
  try {
    const stdoutFd = 1
    const fdStat = fstatSync(stdoutFd)
    const pathStat = statSync(logPath)
    return fdStat.dev === pathStat.dev && fdStat.ino === pathStat.ino
  } catch {
    return false
  }
}

// ── Formatting ──────────────────────────────────────────────────────────────

export function formatSessionList(sessions: SessionMetadata[]): string {
  if (sessions.length === 0) return 'No background sessions.'
  const lines: string[] = ['Background sessions:', '']
  for (const s of sessions) {
    const status = STATUS_ICON[s.status] ?? '?'
    const age = formatAge(s.startedAt)
    const task = s.task.length > 50 ? s.task.slice(0, 47) + '...' : s.task
    lines.push(`  ${status} ${s.id}  ${task}  (${age})`)
  }
  return lines.join('\n')
}

export function formatSessionDetail(meta: SessionMetadata): string {
  const lines: string[] = [
    `Session: ${meta.id}`,
    `  Task: ${meta.task}`,
    `  Status: ${meta.status}${meta.exitCode !== undefined ? ` (exit ${meta.exitCode})` : ''}`,
    `  PID: ${meta.pid ?? 'n/a'}${meta.pid && isPidAlive(meta.pid) ? ' (alive)' : ''}`,
    `  Started: ${meta.startedAt}`,
  ]
  if (meta.endedAt) lines.push(`  Ended: ${meta.endedAt}`)
  if (meta.model) lines.push(`  Model: ${meta.model}`)
  lines.push(`  CWD: ${meta.cwd}`)
  lines.push(`  Log: ${meta.logPath}`)
  return lines.join('\n')
}

const STATUS_ICON: Record<SessionStatus, string> = {
  running: '●',
  completed: '✓',
  failed: '✗',
  stopped: '◼',
  unknown: '?',
}

function formatAge(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime()
  if (ms < 60_000) return `${Math.round(ms / 1000)}s ago`
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m ago`
  if (ms < 86_400_000) return `${Math.round(ms / 3_600_000)}h ago`
  return `${Math.round(ms / 86_400_000)}d ago`
}
