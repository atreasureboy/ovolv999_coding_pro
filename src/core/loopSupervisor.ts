/**
 * v0.3.4 (durable supervisor contract §Phase 4-6): Durable Loop Lease + Heartbeat + Checkpoint.
 *
 * Replaces the simple PID lock with a lease-based lock that includes
 * heartbeat, owner token, process fingerprint, and atomic creation.
 * Provides checkpoint persistence for crash recovery.
 */
import { writeFileSync, readFileSync, existsSync, renameSync, unlinkSync, mkdirSync } from 'fs'
import { execFileSync } from 'child_process'
import { join, dirname } from 'path'
import { hostname } from 'os'
import { randomUUID } from 'crypto'

export interface LoopLease {
  schemaVersion: number
  ownerToken: string
  pid: number
  hostname: string
  cwd: string
  taskId: string
  createdAt: string
  heartbeatAt: string
  processStartFingerprint: string
}

export interface LoopCheckpoint {
  schemaVersion: number
  sequence: number
  taskId: string
  branch: string
  worktree: string
  iteration: number
  phase: string
  runId?: string
  turnOutcome?: unknown
  taskGraph?: unknown
  passedQualityGates?: string[]
  providerCircuit?: {
    status: 'closed' | 'open' | 'half-open'
    consecutiveFailures: number
    failureBudget?: number
    lastFailureAt?: number
  }
  recentCommands?: string[]
  workerReferences?: Array<{
    runId: string
    status: string
    modelProfile?: string
    modelRole?: string
    modelTier?: 'top' | 'secondary'
    model?: string
    provider?: string
    worktree?: string
    branch?: string
  }>
  progressEvidenceHash?: string
  workspaceEvidenceHash?: string
  goalHash: string
  acceptanceHash: string
  head?: string
  changedFiles: string[]
  consecutiveNoProgress: number
  consecutiveProviderFailures: number
  createdAt: string
  updatedAt: string
}

export interface HeartbeatInfo {
  iteration: number
  runId?: string
  phase: string
  lastProgressAt: string
  currentCommand?: string
  workerCount: number
  circuitStatus: 'closed' | 'open' | 'half-open'
  checkpointSequence: number
}

export interface HeartbeatConfig {
  intervalMs: number
  staleAfterMs: number
}

export const DEFAULT_HEARTBEAT_CONFIG: HeartbeatConfig = {
  intervalMs: 30_000,
  staleAfterMs: 120_000,
}

export class LoopLeaseManager {
  private lease: LoopLease | null = null
  private readonly leasePath: string
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null
  private heartbeatInfo: HeartbeatInfo | null = null
  private heartbeatWriteFailures = 0
  private readonly config: HeartbeatConfig

  constructor(loopDir: string, config?: Partial<HeartbeatConfig>) {
    this.leasePath = join(loopDir, 'loop.lock')
    this.config = { ...DEFAULT_HEARTBEAT_CONFIG, ...config }
  }

  /**
   * Atomically acquire a lease. Uses 'wx' flag (exclusive create) —
   * throws if the file already exists (no existsSync→write race window).
   */
  acquire(taskId: string, cwd: string): LoopLease {
    const now = new Date().toISOString()
    const ownerToken = randomUUID()
    const fingerprint = getProcessIdentity(process.pid)
    if (!fingerprint) throw new Error('Unable to establish a stable process identity for loop lease')
    const lease: LoopLease = {
      schemaVersion: 1,
      ownerToken,
      pid: process.pid,
      hostname: hostname(),
      cwd,
      taskId,
      createdAt: now,
      heartbeatAt: now,
      processStartFingerprint: fingerprint,
    }
    // Atomic exclusive create
    writeFileSync(this.leasePath, JSON.stringify(lease, null, 2) + '\n', { flag: 'wx' })
    this.lease = lease
    return lease
  }

  /**
   * Attempt to take over a stale lease. Only succeeds when:
   * - heartbeat is older than staleAfterMs
   * - PID doesn't exist OR fingerprint doesn't match (PID reuse)
   * - owner token is not ours
   */
  tryTakeover(taskId: string, cwd: string): LoopLease | null {
    if (!existsSync(this.leasePath)) return this.acquire(taskId, cwd)
    let existing: LoopLease
    try {
      existing = JSON.parse(readFileSync(this.leasePath, 'utf8')) as LoopLease
    } catch {
      return null
    }
    // Check if stale
    const heartbeatAge = Date.now() - new Date(existing.heartbeatAt).getTime()
    if (heartbeatAge < this.config.staleAfterMs) return null // still fresh
    // Check PID liveness
    let pidAlive: boolean
    try { process.kill(existing.pid, 0); pidAlive = true } catch { pidAlive = false }
    if (pidAlive) {
      const currentFingerprint = getProcessIdentity(existing.pid)
      if (!currentFingerprint) return null
      if (existing.processStartFingerprint === currentFingerprint) return null
    }
    let confirmed: LoopLease
    try {
      confirmed = JSON.parse(readFileSync(this.leasePath, 'utf8')) as LoopLease
    } catch {
      return null
    }
    if (confirmed.ownerToken !== existing.ownerToken) return null
    const quarantine = `${this.leasePath}.stale.${existing.ownerToken}`
    try {
      renameSync(this.leasePath, quarantine)
      const acquired = this.acquire(taskId, cwd)
      try { unlinkSync(quarantine) } catch { /* best-effort */ }
      return acquired
    } catch {
      try {
        if (!existsSync(this.leasePath) && existsSync(quarantine)) renameSync(quarantine, this.leasePath)
      } catch { /* best-effort */ }
      return null
    }
  }

  /** Update heartbeat. Must be called periodically by the Supervisor. */
  updateHeartbeat(info: HeartbeatInfo): boolean {
    if (!this.lease) return false
    this.heartbeatInfo = info
    this.lease.heartbeatAt = new Date().toISOString()
    try {
      const current = JSON.parse(readFileSync(this.leasePath, 'utf8')) as LoopLease
      if (current.ownerToken !== this.lease.ownerToken) {
        this.heartbeatWriteFailures++
        return false
      }
      // Atomic temp + rename — single JSON object with embedded heartbeat
      const data = { ...this.lease, heartbeat: info }
      const tmp = `${this.leasePath}.${this.lease.ownerToken}.tmp`
      writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n')
      renameSync(tmp, this.leasePath)
      this.heartbeatWriteFailures = 0
      return true
    } catch {
      this.heartbeatWriteFailures++
      return false
    }
  }

  startHeartbeat(getInfo: () => HeartbeatInfo, onUnhealthy?: () => void): void {
    if (this.heartbeatTimer) return
    this.heartbeatTimer = setInterval(() => {
      const ok = this.updateHeartbeat(getInfo())
      if (!ok && this.heartbeatWriteFailures >= 3) onUnhealthy?.()
    }, this.config.intervalMs)
    if (typeof this.heartbeatTimer.unref === 'function') this.heartbeatTimer.unref()
  }

  stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer)
      this.heartbeatTimer = null
    }
  }

  getHeartbeatWriteFailures(): number {
    return this.heartbeatWriteFailures
  }

  /** Release the lease — only if we still own it. */
  release(): void {
    this.stopHeartbeat()
    if (!this.lease) return
    // Verify we still own before removing
    if (existsSync(this.leasePath)) {
      try {
        const current = JSON.parse(readFileSync(this.leasePath, 'utf8')) as LoopLease
        if (current.ownerToken !== this.lease.ownerToken) return // not ours
      } catch { return }
    }
    try { unlinkSync(this.leasePath) } catch { /* best-effort */ }
    this.lease = null
  }

  getLease(): LoopLease | null { return this.lease }

}

/**
 * Build a portable process identity for `pid` so stale-lease takeover can
 * detect PID reuse across reboots / process restarts.
 *
 * The identity must be (a) stable for the lifetime of the process, (b)
 * different after the process exits and its PID is reused. The strongest
 * signal is the kernel's per-process start time. We read it straight from
 * `/proc/<pid>/stat` on Linux (field 22, the start time in clock ticks
 * since boot), and combine it with `boot_id` so a reboot that recycles
 * the same PID + start tick still yields a different identity.
 *
 * On non-Linux platforms `/proc` is absent, so `getProcessStartTime()`
 * falls back to a portable subprocess probe (wmic on Windows, ps on
 * macOS/BSD). That probe returns the process creation time, which is the
 * closest cross-platform equivalent to the start-time field.
 *
 * For the CURRENT process we additionally synthesize an identity from
 * `process.uptime()` (the wall-clock ms at which this Node process
 * started) — this needs no subprocess and is exact. It is used as the
 * final fallback when the subprocess probe is unavailable or fails.
 */
export function getProcessIdentity(pid: number): string | null {
  const startTime = getProcessStartTime(pid)
  if (startTime !== null) {
    let bootId = ''
    try { bootId = readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim() } catch { /* optional / non-Linux */ }
    return `${hostname()}:${bootId}:${pid}:${startTime}`
  }
  // Last-resort fallback: only valid for the current process, where
  // process.uptime() gives an exact start timestamp with no probe needed.
  // For other PIDs on a platform without a working probe, we genuinely
  // cannot establish an identity — returning null lets the caller
  // (tryTakeover) refuse the takeover rather than silently proceeding.
  return pid === process.pid ? CURRENT_PROCESS_IDENTITY : null
}

/**
 * Resolve the start time of `pid` as a string, or null if it cannot be
 * determined. Linux reads `/proc/<pid>/stat` directly (no subprocess);
 * other platforms shell out to a portable probe. Never throws.
 */
function getProcessStartTime(pid: number): string | null {
  // Linux fast path: parse /proc/<pid>/stat. Field 22 (1-indexed in the
  // man page) is the start time in clock ticks since boot; it is at
  // index 19 after stripping the comm field (which may contain spaces
  // and is wrapped in parens, so we cut after the last ')').
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8')
    const close = stat.lastIndexOf(')')
    if (close < 0) return null
    const fields = stat.slice(close + 2).split(/\s+/)
    const startTime = fields[19]
    return startTime || null
  } catch {
    // /proc unavailable (non-Linux) or PID gone — fall through to probe.
  }
  return probeProcessStartTime(pid)
}

/**
 * Portable subprocess probe for a process's creation/start time, used on
 * platforms without `/proc` (Windows, macOS, BSD). Returns the raw
 * stdout (trimmed) so the caller can embed it verbatim in the identity
 * string — the exact units differ per platform, but all we need is a
 * value that is stable for a live process and changes on PID reuse.
 *
 * `wmic` is used on Windows (deprecated by Microsoft but present on all
 * currently supported Windows releases); `ps -o lstart` elsewhere. Both
 * are invoked with a hard 2s timeout and swallowed errors.
 */
function probeProcessStartTime(pid: number): string | null {
  const isWindows = process.platform === 'win32'
  try {
    if (isWindows) {
      // wmic process where ProcessId=<pid> get CreationDate /value
      // → "CreationDate=20260811000000.000000+000"
      const out = execFileSync(
        'wmic',
        ['process', 'where', `ProcessId=${pid}`, 'get', 'CreationDate', '/value'],
        { encoding: 'utf8', timeout: 2000, stdio: ['ignore', 'pipe', 'ignore'] },
      ).trim()
      const match = out.match(/CreationDate=(.+)/)
      return match ? match[1].trim() : null
    }
    // macOS / *BSD: `ps -o lstart= -p <pid>` → "Mon Aug 11 10:45:07 2026"
    const out = execFileSync(
      'ps',
      ['-o', 'lstart=', '-p', String(pid)],
      { encoding: 'utf8', timeout: 2000, stdio: ['ignore', 'pipe', 'ignore'] },
    ).trim()
    return out || null
  } catch {
    return null
  }
}

const CURRENT_PROCESS_IDENTITY =
  `${hostname()}:${process.pid}:${Math.round(Date.now() - process.uptime() * 1000)}`

/**
 * Checkpoint manager — atomic temp+rename writes, keeps one backup.
 */
export class CheckpointManager {
  private readonly checkpointPath: string
  private readonly backupPath: string

  constructor(loopDir: string) {
    this.checkpointPath = join(loopDir, 'checkpoint.json')
    this.backupPath = join(loopDir, 'checkpoint.previous.json')
  }

  save(checkpoint: LoopCheckpoint): void {
    // Backup current → previous
    if (existsSync(this.checkpointPath)) {
      try { renameSync(this.checkpointPath, this.backupPath) } catch { /* best-effort */ }
    }
    // Atomic write: temp → flush → rename
    const tmp = this.checkpointPath + '.tmp'
    mkdirSync(dirname(this.checkpointPath), { recursive: true })
    writeFileSync(tmp, JSON.stringify(checkpoint, null, 2) + '\n')
    renameSync(tmp, this.checkpointPath)
  }

  load(): LoopCheckpoint | null {
    if (existsSync(this.checkpointPath)) {
      try {
        return JSON.parse(readFileSync(this.checkpointPath, 'utf8')) as LoopCheckpoint
      } catch {
        // Corrupt — fall through to backup
      }
    }
    // Missing OR corrupt main file → try the backup. save() renames the
    // previous checkpoint to the backup BEFORE writing the new main file,
    // so a crash in that window (or a corrupt write) leaves a valid
    // backup that the old code silently discarded.
    if (existsSync(this.backupPath)) {
      try { return JSON.parse(readFileSync(this.backupPath, 'utf8')) as LoopCheckpoint } catch { return null }
    }
    return null
  }

  loadBackup(): LoopCheckpoint | null {
    if (!existsSync(this.backupPath)) return null
    try { return JSON.parse(readFileSync(this.backupPath, 'utf8')) as LoopCheckpoint } catch { return null }
  }

  exists(): boolean { return existsSync(this.checkpointPath) }
  clear(): void {
    try { unlinkSync(this.checkpointPath) } catch { /* best-effort */ }
    try { unlinkSync(this.backupPath) } catch { /* best-effort */ }
  }
}

/** Hash a contract string for change detection. */
export function hashContract(content: string): string {
  // Simple FNV-1a hash — sufficient for change detection, no crypto dep needed
  let hash = 0x811c9dc5
  for (let i = 0; i < content.length; i++) {
    hash ^= content.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193)
  }
  return (hash >>> 0).toString(16).padStart(8, '0')
}
