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
  readdirSync, statSync, appendFileSync,
} from 'fs'
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
  writeFileSync(getMetadataPath(meta.id), JSON.stringify(meta, null, 2))
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
 * Resolve the ovolv999 executable to spawn. Honors the OVOGV999_BIN
 * env var (useful for tests), otherwise uses process.argv[1].
 */
function resolveOvogogogoBin(): string {
  if (process.env.OVOGV999_BIN) return process.env.OVOGV999_BIN
  if (process.argv[1]) return process.argv[1]
  return 'ovolv999'
}

export function startBackgroundSession(options: StartSessionOptions): StartSessionResult {
  ensureSessionsDir()
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

  const bin = resolveOvogogogoBin()
  const env = { ...process.env, ...options.env, OVOGV999_SESSION_ID: id }

  let proc: ChildProcess
  try {
    proc = spawn(process.execPath, [bin, ...spawnArgs], {
      cwd,
      detached: true,
      stdio: ['ignore', 'ignore', 'ignore'],
      env,
    })
  } catch {
    // Fallback: try invoking the bin directly (non-node)
    try {
      proc = spawn(bin, spawnArgs, {
        cwd,
        detached: true,
        stdio: ['ignore', 'ignore', 'ignore'],
        env,
      })
    } catch {
      throw new Error(`Failed to spawn background session: ${bin}`)
    }
  }

  // Redirect child stdout+stderr to the log file via a re-open in append mode.
  // We can't pass an fd directly with detached + ignore, so we spawn a tiny
  // log-writer loop in the parent that drains proc.stdout — BUT since we
  // set stdio to 'ignore', there's nothing to drain. Instead the child must
  // redirect its own output. We pass the log path via env so the child can
  // open it. For now, mark this as a known limitation: logs are populated
  // by the child process itself when it detects OVOGV999_SESSION_ID.
  const pid = proc.pid ?? null

  // Unref so the parent can exit independently
  try { proc.unref() } catch { /* ignore */ }

  const meta: SessionMetadata = {
    id,
    task: options.task,
    cwd,
    model: options.model,
    pid,
    startedAt: new Date().toISOString(),
    status: 'running',
    logPath,
    args: spawnArgs,
  }
  saveMetadata(meta)

  return { sessionId: id, pid, logPath }
}

// ── Stop Session ────────────────────────────────────────────────────────────

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
    if (isPidAlive(meta.pid!) && Date.now() < deadline) {
      // Still alive — escalate
      try { process.kill(meta.pid!, 'SIGKILL') } catch { /* ignore */ }
    }
  }
  setTimeout(checkLiveness, graceMs)

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

  const logPath = getLogPath(id)
  let offset = getLogSize(id)
  let stopped = false
  let timer: ReturnType<typeof setTimeout> | null = null

  const queue: string[] = []
  let resolveNext: ((value: IteratorResult<string>) => void) | null = null

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
      // Also detect process exit
      const fresh = getSession(id)
      if (fresh && fresh.status !== 'running' && queue.length === 0 && !resolveNext) {
        // Drain complete
      }
    } catch { /* ignore */ }

    if (!stopped) {
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
 * Called by the spawned ovolv999 process itself: redirects its stdout
 * and stderr to the session log file when OVOGV999_SESSION_ID is set.
 * This is how background sessions capture their output.
 */
export function initChildLogCapture(): string | null {
  const sessionId = process.env.OVOGV999_SESSION_ID
  if (!sessionId) return null

  const logPath = getLogPath(sessionId)
  ensureSessionsDir()

  // Tee: write to the log AND keep the original stream (so pipe mode
  // still works if someone backgrounds a pipe run).
  const origWrite = process.stdout.write.bind(process.stdout)
  const origErrWrite = process.stderr.write.bind(process.stderr)

  const appendLog = (data: unknown): void => {
    try {
      appendFileSync(logPath, data as string | Uint8Array)
    } catch { /* ignore disk errors */ }
  }

  // @ts-ignore — patching the write method signature for log capture
  process.stdout.write = (data: unknown, ...rest: unknown[]): boolean => {
    appendLog(data)
    return origWrite(data as string | Uint8Array)
  }
  // @ts-ignore — same
  process.stderr.write = (data: unknown, ...rest: unknown[]): boolean => {
    appendLog(data)
    return origErrWrite(data as string | Uint8Array)
  }

  // Write exit code on process end
  process.on('exit', (code) => {
    try {
      writeFileSync(getExitPath(sessionId), `${code ?? 0}\n`)
    } catch { /* ignore */ }
  })

  return sessionId
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
