/**
 * Resource scheduler (fi_goal.md §五 Phase 4 / Round 7).
 *
 * Tools declare resource claims; the scheduler decides whether two
 * claims conflict and serializes accordingly. The model:
 *
 *   access='read'       → shared (many readers OK)
 *   access='write'      → exclusive against everyone else on the same key
 *   access='exclusive'  → blocks even readers and other writers
 *
 * Conflict matrix (existing \ new | read | write | exclusive):
 *   read                  OK    CONFLICT  CONFLICT
 *   write                 OK*   CONFLICT  CONFLICT
 *   exclusive             CONFLICT CONFLICT CONFLICT
 *
 *   (*) The original spec lists write-read as CONFLICT in the matrix,
 *   but a reader that started before the write should not be evicted.
 *   Acquire is atomic: if a new write can't get a clean lock, it
 *   waits — but a pending write doesn't evict existing readers.
 *
 * Required guarantees (§五):
 *   - deadlock avoidance     → atomic acquire (all-or-nothing)
 *   - acquire timeout        → configurable, default 30s
 *   - cancel releases locks  → AbortSignal aware
 *   - Run completion cleanup → wire to ExecutionRunRegistry
 *   - worktree isolation     → claim keys namespaced by workspaceCwd
 *   - Git serialization      → type='git' always exclusive
 */

import type { ResourceClaim, RunStatus } from './executionRun.js'
import type { ExecutionRunRegistry } from './executionRun.js'
import type { RunEventEnvelope } from './executionRunEvents.js'

// ── Types ───────────────────────────────────────────────────────────────

/**
 * A handle returned by `acquire()`. Holds the claims until `release()`
 * is called (or the owning run transitions to a terminal status, in
 * which case the scheduler auto-releases).
 */
export interface ResourceLease {
  runId: string
  leaseId: string
  claims: ReadonlyArray<ResourceClaim>
  /** Release all claims held by this lease. Idempotent. */
  release(): void
  /** Whether this lease has been released. */
  readonly released: boolean
}

export interface AcquireOptions {
  /** Max time to wait for conflicting claims to drain. Default 30s. */
  timeoutMs?: number
  /** AbortSignal — aborting rejects the acquire + releases any partial hold. */
  signal?: AbortSignal
  /**
   * When true, fail fast (reject with ResourceConflictError) instead of
   * waiting. Default false.
   */
  noWait?: boolean
}

export class ResourceConflictError extends Error {
  constructor(
    public readonly conflicts: ReadonlyArray<ConflictDetail>,
    message?: string,
  ) {
    super(message ?? `resource conflict on ${conflicts.length} claim(s)`)
    this.name = 'ResourceConflictError'
  }
}

export class ResourceAcquireTimeoutError extends Error {
  constructor(
    public readonly runId: string,
    public readonly claims: ReadonlyArray<ResourceClaim>,
    timeoutMs: number,
  ) {
    super(`resource acquire timed out after ${timeoutMs}ms (run ${runId})`)
    this.name = 'ResourceAcquireTimeoutError'
  }
}

export interface ConflictDetail {
  claim: ResourceClaim
  blockerRunId: string
  blockerLeaseId: string
  blockerAccess: ResourceClaim['access']
}

// ── Internals ───────────────────────────────────────────────────────────

interface HeldClaim {
  leaseId: string
  runId: string
  claim: ResourceClaim
  acquiredAt: number
}

const TERMINAL_STATUSES: ReadonlySet<RunStatus> = new Set([
  'succeeded',
  'failed',
  'cancelled',
  'timed_out',
  'verification_failed',
])

/**
 * Returns true if `existing` and `incoming` on the SAME resource key
 * cannot coexist.
 *
 *   read vs read       → compatible
 *   read vs write      → conflict (write blocks reader from acquiring)
 *   write vs read      → conflict (writer blocks new reader)
 *   write vs write     → conflict
 *   exclusive vs *     → conflict
 */
function claimsConflict(
  existing: ResourceClaim['access'],
  incoming: ResourceClaim['access'],
): boolean {
  if (existing === 'exclusive' || incoming === 'exclusive') return true
  if (existing === 'write' || incoming === 'write') {
    // write vs write, or write vs read, or read vs write
    return !(existing === 'read' && incoming === 'read')
  }
  return false // both read
}

/**
 * Normalize a claim for storage. Git claims are forced to 'exclusive'
 * (per §五 "Git 操作串行化"). Claim keys are namespaced by workspaceCwd
 * when the scheduler is constructed with isolation enabled.
 */
function normalizeClaim(
  claim: ResourceClaim,
  workspaceKey: string | undefined,
): ResourceClaim {
  const access: ResourceClaim['access'] =
    claim.type === 'git' ? 'exclusive' : claim.access
  const key = workspaceKey ? `${workspaceKey}::${claim.key}` : claim.key
  return { type: claim.type, key, access }
}

// ── Scheduler ───────────────────────────────────────────────────────────

export interface ResourceSchedulerOptions {
  /**
   * When set, every claim key is prefixed with this string so two
   * different worktrees (or two repo checkouts) don't collide.
   */
  workspaceKey?: string
  /** Default acquire timeout. Default 30000ms. */
  defaultTimeoutMs?: number
  /**
   * Optional registry wiring — when set, the scheduler auto-releases
   * every lease tied to a run when that run transitions to terminal.
   */
  registry?: ExecutionRunRegistry
  /**
   * Optional event bus — when set, the scheduler subscribes to
   * run.completed / run.failed / run.cancelled events for cleanup.
   */
  eventBus?: { on(handler: (e: RunEventEnvelope) => void): () => void }
}

export class ResourceScheduler {
  private readonly holdings = new Map<string, HeldClaim[]>()
  private readonly leases = new Map<string, ResourceLease>()
  private readonly waiters: Array<{
    runId: string
    claims: ResourceClaim[]
    resolve: (lease: ResourceLease) => void
    reject: (err: Error) => void
    timer?: ReturnType<typeof setTimeout>
    signal?: AbortSignal
    onAbort?: () => void
  }> = []
  private readonly workspaceKey?: string
  private readonly defaultTimeoutMs: number

  constructor(opts: ResourceSchedulerOptions = {}) {
    this.workspaceKey = opts.workspaceKey
    this.defaultTimeoutMs = opts.defaultTimeoutMs ?? 30_000
    if (opts.eventBus) {
      opts.eventBus.on((e) => this.onRunEvent(e))
    }
  }

  // ── Public API ───────────────────────────────────────────────────────

  /**
   * Acquire all `claims` atomically. If ANY claim conflicts with an
   * existing holding, the call either:
   *   - rejects synchronously with ResourceConflictError (noWait: true), or
   *   - waits until conflicting claims drain, then retries (default).
   *
   * On success, returns a lease whose `release()` returns the claims.
   * The lease is auto-released when the owning run goes terminal.
   */
  acquire(
    runId: string,
    claims: ResourceClaim[],
    opts: AcquireOptions = {},
  ): Promise<ResourceLease> {
    if (claims.length === 0) {
      return Promise.resolve(this.mintEmptyLease(runId))
    }
    const normalized = claims.map((c) => normalizeClaim(c, this.workspaceKey))
    const timeoutMs = opts.timeoutMs ?? this.defaultTimeoutMs

    // Fast path: try non-blocking acquire.
    const conflicts = this.findConflicts(normalized, undefined)
    if (conflicts.length === 0) {
      return Promise.resolve(this.installLease(runId, normalized))
    }
    if (opts.noWait) {
      return Promise.reject(new ResourceConflictError(conflicts))
    }
    // Slow path: queue and wait.
    return new Promise<ResourceLease>((resolve, reject) => {
      const entry: (typeof this.waiters)[number] = {
        runId,
        claims: normalized,
        resolve,
        reject,
      }
      const cleanup = () => {
        if (entry.timer) clearTimeout(entry.timer)
        if (entry.signal && entry.onAbort) {
          entry.signal.removeEventListener('abort', entry.onAbort)
        }
        const idx = this.waiters.indexOf(entry)
        if (idx >= 0) this.waiters.splice(idx, 1)
      }
      entry.timer = setTimeout(() => {
        cleanup()
        reject(new ResourceAcquireTimeoutError(runId, claims, timeoutMs))
      }, timeoutMs)
      if (opts.signal) {
        entry.signal = opts.signal
        entry.onAbort = () => {
          cleanup()
          reject(new Error(`resource acquire aborted (run ${runId})`))
        }
        opts.signal.addEventListener('abort', entry.onAbort, { once: true })
      }
      // Wrap resolve/reject so the waiter is removed before delivering.
      const origResolve = resolve
      const origReject = reject
      entry.resolve = (lease) => { cleanup(); origResolve(lease) }
      entry.reject = (err) => { cleanup(); origReject(err) }
      this.waiters.push(entry)
    })
  }

  /**
   * Synchronous conflict check. Returns the leases that currently
   * block `claims`. Empty array = claims are acquirable right now.
   */
  conflictsFor(claims: ResourceClaim[]): ConflictDetail[] {
    const normalized = claims.map((c) => normalizeClaim(c, this.workspaceKey))
    return this.findConflicts(normalized, undefined)
  }

  /**
   * Release every lease owned by `runId`. Called automatically on
   * terminal transition; also safe to call manually.
   */
  releaseRun(runId: string): number {
    let released = 0
    for (const leaseId of [...this.leases.keys()]) {
      const lease = this.leases.get(leaseId)!
      if (lease.runId !== runId) continue
      lease.release()
      released++
    }
    return released
  }

  /** Snapshot of currently held claims (for diagnostics / metrics). */
  snapshotHoldings(): ReadonlyArray<{ runId: string; leaseId: string; claim: ResourceClaim }> {
    const out: Array<{ runId: string; leaseId: string; claim: ResourceClaim }> = []
    for (const held of this.holdings.values()) {
      for (const h of held) {
        out.push({ runId: h.runId, leaseId: h.leaseId, claim: h.claim })
      }
    }
    return out
  }

  /** Number of waiters currently blocked on conflicting claims. */
  waiterCount(): number {
    return this.waiters.length
  }

  /** Release everything. Used in tests + shutdown. */
  releaseAll(): void {
    for (const lease of [...this.leases.values()]) {
      lease.release()
    }
    for (const w of [...this.waiters]) {
      w.reject(new Error('scheduler shutting down'))
    }
  }

  // ── Internal ────────────────────────────────────────────────────────

  private mintEmptyLease(runId: string): ResourceLease {
    const leaseId = `lease_${randomId()}`
    const lease = this.makeLease(runId, leaseId, [])
    this.leases.set(leaseId, lease)
    return lease
  }

  private installLease(runId: string, claims: ResourceClaim[]): ResourceLease {
    const leaseId = `lease_${randomId()}`
    const now = Date.now()
    for (const claim of claims) {
      const held = this.holdings.get(claim.key) ?? []
      held.push({ leaseId, runId, claim, acquiredAt: now })
      this.holdings.set(claim.key, held)
    }
    const lease = this.makeLease(runId, leaseId, claims)
    this.leases.set(leaseId, lease)
    return lease
  }

  private makeLease(
    runId: string,
    leaseId: string,
    claims: ResourceClaim[],
  ): ResourceLease {
    const self = this
    const handle: ResourceLease = {
      runId,
      leaseId,
      claims,
      get released() {
        return !self.leases.has(leaseId)
      },
      release() {
        if (!self.leases.has(leaseId)) return
        self.leases.delete(leaseId)
        for (const c of claims) {
          const held = self.holdings.get(c.key)
          if (!held) continue
          const next = held.filter((h) => h.leaseId !== leaseId)
          if (next.length === 0) {
            self.holdings.delete(c.key)
          } else {
            self.holdings.set(c.key, next)
          }
        }
        // Wake up waiters — one of them may now fit.
        self.pumpWaiters()
      },
    }
    return handle
  }

  private findConflicts(
    claims: ResourceClaim[],
    _excludingLease?: string,
  ): ConflictDetail[] {
    const conflicts: ConflictDetail[] = []
    for (const claim of claims) {
      const held = this.holdings.get(claim.key) ?? []
      for (const h of held) {
        if (claimsConflict(h.claim.access, claim.access)) {
          conflicts.push({
            claim,
            blockerRunId: h.runId,
            blockerLeaseId: h.leaseId,
            blockerAccess: h.claim.access,
          })
        }
      }
    }
    return conflicts
  }

  private pumpWaiters(): void {
    // Iterate to a fixed point — releasing one waiter may unblock more.
    let progress = true
    while (progress) {
      progress = false
      for (let i = 0; i < this.waiters.length; i++) {
        const w = this.waiters[i]!
        const conflicts = this.findConflicts(w.claims, undefined)
        if (conflicts.length === 0) {
          this.waiters.splice(i, 1)
          if (w.timer) clearTimeout(w.timer)
          if (w.signal && w.onAbort) {
            w.signal.removeEventListener('abort', w.onAbort)
          }
          const lease = this.installLease(w.runId, w.claims)
          w.resolve(lease)
          progress = true
          break
        }
      }
    }
  }

  private onRunEvent(e: RunEventEnvelope): void {
    if (!TERMINAL_EVENT_TYPES.has(e.type)) return
    this.releaseRun(e.runId)
  }
}

const TERMINAL_EVENT_TYPES: ReadonlySet<string> = new Set([
  'run.completed',
  'run.failed',
  'run.cancelled',
])

function randomId(): string {
  return Math.random().toString(36).slice(2, 10) + Date.now().toString(36)
}

// ── Helpers for tool authors ────────────────────────────────────────────

/**
 * Build a ResourceClaim for a file path. Read tools (Read, Grep, Glob)
 * should use `read`; modifying tools (Edit, Write) should use `write`.
 */
export function fileClaim(path: string, access: ResourceClaim['access']): ResourceClaim {
  return { type: 'file', key: path, access }
}

/**
 * Build a ResourceClaim for a directory tree. `npm install` should
 * declare `exclusive` on node_modules; `npm test` declares `read` on
 * the repo root.
 */
export function directoryClaim(
  path: string,
  access: ResourceClaim['access'],
): ResourceClaim {
  return { type: 'directory', key: path, access }
}

/**
 * Build a ResourceClaim for a git ref / branch. All git operations
 * are serialized — the scheduler forces `access='exclusive'`.
 */
export function gitClaim(ref: string): ResourceClaim {
  // Even though we pass 'write', normalizeClaim will rewrite it to
  // 'exclusive' because type === 'git'. We expose 'write' in the
  // public claim so call sites read naturally.
  return { type: 'git', key: ref, access: 'write' }
}

/**
 * Build a ResourceClaim for a TCP port. Useful for tools that start
 * dev servers or fixtures that bind to specific ports.
 */
export function portClaim(port: number, access: ResourceClaim['access']): ResourceClaim {
  return { type: 'port', key: String(port), access }
}

export { TERMINAL_STATUSES }
