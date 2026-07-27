/**
 * v0.3.4 (durable supervisor contract §Phase 4-6): Durable Loop Lease + Heartbeat + Checkpoint.
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
  workerReferences?: Array<{ runId: string; status: string; worktree?: string; branch?: string }>
  progressEvidenceHash?: string
  workspaceEvidenceHash?: string
  goalHash: string
  acceptanceHash: string
  lastCommit?: string
  head?: string
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

export function getProcessIdentity(pid: number): string | null {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8')
    const close = stat.lastIndexOf(')')
    if (close < 0) return null
    const fields = stat.slice(close + 2).split(/\s+/)
    const startTime = fields[19]
    if (!startTime) return null
    let bootId = ''
    try { bootId = readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim() } catch { /* optional */ }
    return `${hostname()}:${bootId}:${pid}:${startTime}`
  } catch {
    return pid === process.pid ? CURRENT_PROCESS_IDENTITY : null
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
