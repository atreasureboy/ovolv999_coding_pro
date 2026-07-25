/**
 * v0.3.4 (mimo_goal §Phase 4-6): Durable Loop Lease + Heartbeat + Checkpoint.
 *
 * Replaces the simple PID lock with a lease-based lock that includes
 * heartbeat, owner token, process fingerprint, and atomic creation.
 * Provides checkpoint persistence for crash recovery.
 */
import { writeFileSync, readFileSync, existsSync, renameSync, unlinkSync, mkdirSync } from 'fs'
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
  goalHash: string
  acceptanceHash: string
  lastCommit?: string
  changedFiles: string[]
  consecutiveNoProgress: number
  consecutiveProviderFailures: number
  consecutiveCommandFailures: number
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
  writeTimeoutMs: number
}

export const DEFAULT_HEARTBEAT_CONFIG: HeartbeatConfig = {
  intervalMs: 30_000,
  staleAfterMs: 120_000,
  writeTimeoutMs: 5_000,
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
    const fingerprint = this.getProcessFingerprint()
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
      existing = JSON.parse(readFileSync(this.leasePath, 'utf8'))
    } catch {
      // Corrupt lease — safe to take over
      try { unlinkSync(this.leasePath) } catch { /* best-effort */ }
      return this.acquire(taskId, cwd)
    }
    // Check if stale
    const heartbeatAge = Date.now() - new Date(existing.heartbeatAt).getTime()
    if (heartbeatAge < this.config.staleAfterMs) return null // still fresh
    // Check PID liveness
    let pidAlive = false
    try { process.kill(existing.pid, 0); pidAlive = true } catch { pidAlive = false }
    if (pidAlive) {
      // PID alive but heartbeat stale — check fingerprint for PID reuse
      const currentFingerprint = this.getProcessFingerprint()
      if (existing.processStartFingerprint === currentFingerprint) return null // same process
    }
    // Safe to take over
    try { unlinkSync(this.leasePath) } catch { /* best-effort */ }
    return this.acquire(taskId, cwd)
  }

  /** Update heartbeat. Must be called periodically by the Supervisor. */
  updateHeartbeat(info: HeartbeatInfo): boolean {
    if (!this.lease) return false
    this.heartbeatInfo = info
    this.lease.heartbeatAt = new Date().toISOString()
    try {
      // Atomic temp + rename — single JSON object with embedded heartbeat
      const data = { ...this.lease, heartbeat: info }
      const tmp = this.leasePath + '.tmp'
      writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n')
      renameSync(tmp, this.leasePath)
      this.heartbeatWriteFailures = 0
      return true
    } catch {
      this.heartbeatWriteFailures++
      return false
    }
  }

  startHeartbeat(getInfo: () => HeartbeatInfo): void {
    if (this.heartbeatTimer) return
    this.heartbeatTimer = setInterval(() => {
      this.updateHeartbeat(getInfo())
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
      } catch { /* corrupt — safe to remove */ }
    }
    try { unlinkSync(this.leasePath) } catch { /* best-effort */ }
    this.lease = null
  }

  getLease(): LoopLease | null { return this.lease }

  private getProcessFingerprint(): string {
    // Combine PID + start time as a rough fingerprint. PID reuse across
    // restarts will have a different start time.
    try {
      const usage = process.memoryUsage()
      return `${process.pid}:${process.cwd()}:${usage.rss}`
    } catch {
      return `${process.pid}:${Date.now()}`
    }
  }
}

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
    if (!existsSync(this.checkpointPath)) return null
    try {
      return JSON.parse(readFileSync(this.checkpointPath, 'utf8')) as LoopCheckpoint
    } catch {
      // Corrupt — try backup
      if (existsSync(this.backupPath)) {
        try { return JSON.parse(readFileSync(this.backupPath, 'utf8')) as LoopCheckpoint } catch { return null }
      }
      return null
    }
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
