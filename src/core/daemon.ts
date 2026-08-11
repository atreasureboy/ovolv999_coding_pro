/**
 * Daemon Mode — long-running background supervisor
 *
 * Lets the tool run as a persistent daemon that can:
 *   - Accept commands via a Unix socket
 *   - Run scheduled tasks
 *   - Monitor file changes
 *   - Manage background agents
 *
 * Inspired by claude-code's daemon mode.
 */

import { createServer, type Server, Socket } from 'net'
import { existsSync, unlinkSync, writeFileSync, readFileSync, mkdirSync } from 'fs'
import { join } from 'path'
import { createHash } from 'crypto'
import { homedir } from 'os'

// ── Types ───────────────────────────────────────────────────────────────────

function fmtPayloadValue(v: unknown): string {
  if (typeof v === 'string') return v
  if (typeof v === 'number' || typeof v === 'boolean') return String(v)
  try {
    return JSON.stringify(v) ?? String(v)
  } catch {
    return Object.prototype.toString.call(v)
  }
}

export type DaemonStatus = 'running' | 'stopped' | 'starting' | 'error'

export interface DaemonInfo {
  pid: number
  status: DaemonStatus
  startTime: string
  socketPath: string
  logPath: string
  workers: number
  uptime: number
}

export interface DaemonCommand {
  action: 'status' | 'stop' | 'ping' | 'health' | 'list-workers' | 'restart-worker' | 'tag-stats' | 'tag-uptime' | 'validate'
  payload?: Record<string, unknown>
}

export interface DaemonResponse {
  ok: boolean
  data?: unknown
  error?: string
}

interface WorkerEntry {
  id: string
  name: string
  pid?: number
  status: 'starting' | 'running' | 'stopped' | 'failed'
  startedAt: string
  command?: string
  /** R18: optional tag for batch-restart by tag (e.g. 'tag:cli'). */
  tag?: string
  /** R28: optional tags array for AND selection (e.g. 'tag:cli+web').
   * Each tag in the array is an additional "label" the worker carries.
   * A worker with both `tag: 'cli'` and `tags: ['web']` would match
   * `tag:cli`, `tag:web`, and `tag:cli+web`. */
  tags?: string[]
  /** R29: optional aliases for legacy name compatibility. A worker
   * tagged 'cli' with aliases ['cli-handler'] would match `tag:cli-handler`
   * too. Aliased labels are virtual — they don't appear in tag-stats
   * results, only on-join resolution. */
  aliases?: string[]
  /** R32: optional parentId. When set, the worker inherits tags
   * from its parent for selector matching. Cycles are not
   * prevented — the caller is responsible for not creating them. */
  parentId?: string
  /** R34: number of restarts this worker has had. 0 = never
   * restarted. Incremented on every restart-worker call. */
  restartCount: number
  /** R34: cumulative uptime in ms across all past restart cycles
   * plus the current cycle. Updated on every restart. */
  cumulativeUptimeMs: number
}

export type { WorkerEntry }

// ── Daemon ──────────────────────────────────────────────────────────────────

export class Daemon {
  private server: Server | null = null
  private startTime: number = 0
  private workers = new Map<string, WorkerEntry>()
  private status: DaemonStatus = 'stopped'

  constructor(
    private readonly socketPath: string,
    private readonly logPath: string,
  ) {}

  async start(): Promise<void> {
    if (this.status === 'running') return

    this.status = 'starting'

    // v0.6.0 (audit): Windows cannot bind a Unix-domain socket to a
    // filesystem path (Node treats it as a named pipe and fails with
    // EACCES). Translate the logical socket path into a named-pipe
    // address; on POSIX the path is used as-is. Named pipes have no
    // filesystem node, so the stale-socket cleanup only runs on POSIX.
    const sock = toSocketPath(this.socketPath)
    if (process.platform !== 'win32' && existsSync(this.socketPath)) {
      try { unlinkSync(this.socketPath) } catch { /* ignore */ }
    }

    // Ensure log dir exists
    const logDir = join(this.logPath, '..')
    if (!existsSync(logDir)) mkdirSync(logDir, { recursive: true })

    return new Promise((resolve, reject) => {
      this.server = createServer((socket: Socket) => {
        this.handleConnection(socket)
      })

      this.server.on('error', (err) => {
        this.status = 'error'
        this.log(`Daemon error: ${err.message}`)
        reject(err)
      })

      this.server.listen(sock, () => {
        this.status = 'running'
        this.startTime = Date.now()
        this.log(`Daemon started (pid=${process.pid}, socket=${sock})`)
        resolve()
      })
    })
  }

  async stop(): Promise<void> {
    this.status = 'stopped'
    if (this.server) {
      await new Promise<void>((resolve) => {
        this.server!.close(() => resolve())
      })
      this.server = null
    }
    if (process.platform !== 'win32' && existsSync(this.socketPath)) {
      try { unlinkSync(this.socketPath) } catch { /* ignore */ }
    }
    this.log('Daemon stopped')
  }

  getInfo(): DaemonInfo {
    return {
      pid: process.pid,
      status: this.status,
      startTime: new Date(this.startTime).toISOString(),
      socketPath: this.socketPath,
      logPath: this.logPath,
      workers: this.workers.size,
      uptime: Date.now() - this.startTime,
    }
  }

  addWorker(name: string, command?: string, tag?: string, tags?: string[], aliases?: string[], parentId?: string): WorkerEntry {
    const id = `worker-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
    const worker: WorkerEntry = {
      id,
      name,
      status: 'starting',
      startedAt: new Date().toISOString(),
      command,
      tag,
      tags,
      aliases,
      parentId,
      restartCount: 0,
      cumulativeUptimeMs: 0,
    }
    this.workers.set(id, worker)
    this.log(`Worker added: ${name} (${id})${tag ? ` tag=${tag}` : ''}${tags ? ` tags=${JSON.stringify(tags)}` : ''}${aliases ? ` aliases=${JSON.stringify(aliases)}` : ''}${parentId ? ` parent=${parentId}` : ''}`)
    return worker
  }

  removeWorker(id: string): boolean {
    const existed = this.workers.delete(id)
    if (existed) this.log(`Worker removed: ${id}`)
    return existed
  }

  listWorkers(): WorkerEntry[] {
    return Array.from(this.workers.values())
  }

  updateWorkerStatus(id: string, status: WorkerEntry['status'], pid?: number): void {
    const worker = this.workers.get(id)
    if (worker) {
      worker.status = status
      if (pid !== undefined) worker.pid = pid
    }
  }

  /** R32: collect a worker's labels (tag + tags + aliases). Used
   * for parent-id inheritance when matching selectors.
   * R33: walk the parent chain, accumulating ancestor labels with
   * cycle detection. A worker that is its own ancestor (via
   * `parentId` cycle) is detected and the chain terminates to
   * prevent infinite recursion. */
  private collectLabels(w: WorkerEntry | undefined, visited?: Set<string>): string[] {
    if (!w) return []
    const seen = visited ?? new Set<string>()
    if (seen.has(w.id)) return []  // cycle break
    seen.add(w.id)
    const parts: string[] = []
    if (w.tag !== undefined) parts.push(w.tag)
    if (w.tags) parts.push(...w.tags)
    if (w.aliases) parts.push(...w.aliases)
    if (w.parentId !== undefined) {
      const parent = this.workers.get(w.parentId)
      const parentLabels = this.collectLabels(parent, seen)
      parts.push(...parentLabels)
    }
    return parts
  }

  private handleConnection(socket: Socket): void {
    let buffer = ''
    socket.on('error', () => {})
    socket.on('data', (data: Buffer) => {
      buffer += data.toString()
      let nl = buffer.indexOf('\n')
      while (nl !== -1) {
        const line = buffer.slice(0, nl).trim()
        buffer = buffer.slice(nl + 1)
        nl = buffer.indexOf('\n')
        if (!line) continue
        try {
          const cmd = JSON.parse(line) as DaemonCommand
          const response = this.handleCommand(cmd)
          this.writeResponse(socket, response)
        } catch (err) {
          const response: DaemonResponse = { ok: false, error: err instanceof Error ? err.message : String(err) }
          this.writeResponse(socket, response)
        }
      }
    })
  }

  private writeResponse(socket: Socket, response: DaemonResponse): void {
    if (socket.destroyed || !socket.writable) return
    socket.write(JSON.stringify(response) + '\n', (err) => {
      if (err && !socket.destroyed) socket.destroy()
    })
  }

  private handleCommand(cmd: DaemonCommand): DaemonResponse {
    switch (cmd.action) {
      case 'ping':
        return { ok: true, data: 'pong' }
      case 'status':
        return { ok: true, data: this.getInfo() }
      case 'health':
        return {
          ok: true,
          data: {
            status: this.status,
            uptime: Date.now() - this.startTime,
            workers: this.workers.size,
            memoryMB: Math.round(process.memoryUsage().rss / 1024 / 1024),
          },
        }
      case 'stop':
        this.stop().catch(() => {})
        return { ok: true, data: 'stopping' }
      case 'list-workers': {
        // R37: optional sortBy. Default insertion order (Map).
        // R38: optional sortDir. Default 'asc'. 'desc' reverses.
        // R40: optional limit/offset for pagination. default limit=100,
        // offset=0. Out-of-range offset → empty result.
        const sortBy = cmd.payload?.sortBy
        const sortDir = cmd.payload?.sortDir
        if (sortDir !== undefined && sortDir !== 'asc' && sortDir !== 'desc') {
          return { ok: false, error: `list-workers invalid sortDir: ${fmtPayloadValue(sortDir)}` }
        }
        const rawLimit = cmd.payload?.limit
        const rawOffset = cmd.payload?.offset
        const limit = typeof rawLimit === 'number' && Number.isFinite(rawLimit) ? Math.max(0, Math.floor(rawLimit)) : 100
        const offset = typeof rawOffset === 'number' && Number.isFinite(rawOffset) ? Math.max(0, Math.floor(rawOffset)) : 0
        let workers = this.listWorkers()
        if (sortBy === 'name') {
          workers = [...workers].sort((a, b) => a.name.localeCompare(b.name))
        } else if (sortBy === 'status') {
          // R39: tie-break by name for deterministic output. Two
          // workers with the same status were order-dependent on
          // insertion order (interpreter-level Array.sort is stable
          // in V8, but the contract wasn't explicit). Adding the
          // secondary name key makes the output reproducible across
          // daemon restarts and across scripts.
          const statusOrder: Record<string, number> = { starting: 0, running: 1, stopped: 2, failed: 3 }
          workers = [...workers].sort((a, b) => {
            const sa = statusOrder[a.status] ?? 99
            const sb = statusOrder[b.status] ?? 99
            if (sa !== sb) return sa - sb
            return a.name.localeCompare(b.name)
          })
        } else if (sortBy === 'createdAt') {
          workers = [...workers].sort((a, b) => a.startedAt.localeCompare(b.startedAt))
        } else if (sortBy !== undefined && sortBy !== 'insertion') {
          return { ok: false, error: `list-workers invalid sortBy: ${fmtPayloadValue(sortBy)}` }
        }
        if (sortDir === 'desc') {
          workers = workers.slice().reverse()
        }
        const total = workers.length
        const paged = workers.slice(offset, offset + limit)
        return {
          ok: true,
          data: {
            workers: paged,
            total,
            offset,
            limit,
          },
        }
      }
      case 'tag-stats': {
        // R20: aggregate per-tag stats. Returns one entry per tag
        // plus an `untagged` summary for workers without a tag.
        // Each entry includes total count + per-status breakdown so
        // callers can spot 'failed' workers per tag without iterating
        // the worker list themselves.
        // R21: optional payload.status filter — only count workers
        // matching the given status. The byStatus breakdown returns
        // zero buckets for non-matching statuses since totals are
        // post-filter.
        // R22: payload.status accepts a string[] for multi-status
        // filtering. Each worker matches if its status is in the
        // list (OR semantics). The single string form (R21) is
        // preserved as a backward-compatible shorthand.
        // R23: payload.tag filters the aggregation to a single tag.
        // Combined with payload.status (R21/R22) for focused queries.
        // Theotagged counter is dropped when a tag filter is active
        // because the caller's intent is "this tag only".
        // R31: payload.statusGte / payload.statusLte for range
        // filtering. Lifecycle ordering: starting(0) < running(1) <
        // stopped(2) < failed(3). Gte ≤ Lte for a valid range.
        const STATUS_ORDER: Record<string, number> = { starting: 0, running: 1, stopped: 2, failed: 3 }
        const statusFilter = cmd.payload?.status
        let allowedStatuses: string[] | null = null
        if (statusFilter !== undefined) {
          if (typeof statusFilter === 'string') {
            allowedStatuses = [statusFilter]
          } else if (Array.isArray(statusFilter) && statusFilter.every((s) => typeof s === 'string')) {
            allowedStatuses = statusFilter
          } else {
            return { ok: false, error: `tag-stats invalid status: ${fmtPayloadValue(statusFilter)}` }
          }
          const valid = ['starting', 'running', 'stopped', 'failed']
          const allValid = allowedStatuses.every((s) => valid.includes(s))
          if (!allValid) {
            return { ok: false, error: `tag-stats invalid status in list: ${JSON.stringify(allowedStatuses)}` }
          }
        }
        const statusGteRaw = cmd.payload?.statusGte
        const statusLteRaw = cmd.payload?.statusLte
        let statusGte: number | null = null
        let statusLte: number | null = null
        if (statusGteRaw !== undefined) {
          if (typeof statusGteRaw !== 'string' || !(statusGteRaw in STATUS_ORDER)) {
            return { ok: false, error: `tag-stats invalid statusGte: ${fmtPayloadValue(statusGteRaw)}` }
          }
          statusGte = STATUS_ORDER[statusGteRaw]!
        }
        if (statusLteRaw !== undefined) {
          if (typeof statusLteRaw !== 'string' || !(statusLteRaw in STATUS_ORDER)) {
            return { ok: false, error: `tag-stats invalid statusLte: ${fmtPayloadValue(statusLteRaw)}` }
          }
          statusLte = STATUS_ORDER[statusLteRaw]!
        }
        if (statusGte !== null && statusLte !== null && statusGte > statusLte) {
          return { ok: false, error: `tag-stats statusGte (${statusGte}) > statusLte (${statusLte})` }
        }
        const passesRange = (s: string): boolean => {
          if (statusGte === null && statusLte === null) return true
          const order = STATUS_ORDER[s]
          if (statusGte !== null && order < statusGte) return false
          if (statusLte !== null && order > statusLte) return false
          return true
        }
        const tagFilter = cmd.payload?.tag
        if (tagFilter !== undefined && typeof tagFilter !== 'string') {
          return { ok: false, error: `tag-stats invalid tag: ${fmtPayloadValue(tagFilter)}` }
        }
        // R25: exclude-status filter. Symmetric to R21/R22 include.
        // Validated against the same status whitelist.
        const excludeFilter = cmd.payload?.exclude
        let excludedStatuses: string[] | null = null
        if (excludeFilter !== undefined) {
          if (typeof excludeFilter === 'string') {
            excludedStatuses = [excludeFilter]
          } else if (Array.isArray(excludeFilter) && excludeFilter.every((s) => typeof s === 'string')) {
            excludedStatuses = excludeFilter
          } else {
            return { ok: false, error: `tag-stats invalid exclude: ${fmtPayloadValue(excludeFilter)}` }
          }
          const validE = ['starting', 'running', 'stopped', 'failed']
          if (!excludedStatuses.every((s) => validE.includes(s))) {
            return { ok: false, error: `tag-stats invalid exclude in list: ${JSON.stringify(excludedStatuses)}` }
          }
        }
        const buckets = new Map<string, { total: number; byStatus: Record<string, number> }>()
        let untagged = 0
        let totalWorkers = 0
        for (const w of this.workers.values()) {
          if (allowedStatuses !== null && !allowedStatuses.includes(w.status)) continue
          if (!passesRange(w.status)) continue
          if (tagFilter !== undefined && w.tag !== tagFilter) continue
          if (excludedStatuses !== null && excludedStatuses.includes(w.status)) continue
          totalWorkers++
          if (w.tag === undefined) {
            untagged++
            continue
          }
          let bucket = buckets.get(w.tag)
          if (!bucket) {
            bucket = { total: 0, byStatus: {} }
            buckets.set(w.tag, bucket)
          }
          bucket.total++
          bucket.byStatus[w.status] = (bucket.byStatus[w.status] ?? 0) + 1
        }
        const tags = Array.from(buckets.entries()).map(([tag, stats]) => ({
          tag,
          total: stats.total,
          byStatus: stats.byStatus,
        })).sort((a, b) => a.tag.localeCompare(b.tag))
        // R41: pagination for the tags[] array. limit/offset apply
        // post-sort. totalTags is the unfiltered count.
        const tagLimit = typeof cmd.payload?.limit === 'number' && Number.isFinite(cmd.payload.limit)
          ? Math.max(0, Math.floor(cmd.payload.limit))
          : 100
        const tagOffset = typeof cmd.payload?.offset === 'number' && Number.isFinite(cmd.payload.offset)
          ? Math.max(0, Math.floor(cmd.payload.offset))
          : 0
        const pagedTags = tags.slice(tagOffset, tagOffset + tagLimit)
        return {
          ok: true,
          data: {
            totalWorkers,
            untagged: tagFilter === undefined ? untagged : 0,
            tags: pagedTags,
            totalTags: tags.length,
            limit: tagLimit,
            offset: tagOffset,
            statusFilter: allowedStatuses,
            excludeFilter: excludedStatuses,
            tagFilter: tagFilter ?? null,
            statusGte: statusGteRaw ?? null,
            statusLte: statusLteRaw ?? null,
          },
        }
      }
      case 'validate': {
        // R35: walk the parent graph and detect cycles. Returns
        // ok=true with cycleCount=0 if the graph is a DAG, or
        // ok=false with the cycle path. Per-worker validation is
        // reported via workerId list.
        const inCycle = new Set<string>()
        const cyclePaths: string[][] = []
        for (const w of this.workers.values()) {
          if (inCycle.has(w.id)) continue
          const seen = new Set<string>()
          const path: string[] = []
          let cur: WorkerEntry | undefined = w
          while (cur !== undefined) {
            if (seen.has(cur.id)) {
              // found a cycle starting at path[seen.size]
              const startIdx = path.indexOf(cur.id)
              if (startIdx >= 0) {
                cyclePaths.push(path.slice(startIdx).concat([cur.id]))
                for (const id of path.slice(startIdx)) inCycle.add(id)
                inCycle.add(cur.id)
              }
              break
            }
            seen.add(cur.id)
            path.push(cur.id)
            cur = cur.parentId !== undefined ? this.workers.get(cur.parentId) : undefined
          }
        }
        return {
          ok: cyclePaths.length === 0,
          data: {
            cycleCount: cyclePaths.length,
            cycles: cyclePaths,
            inCycleCount: inCycle.size,
          },
        }
      }
      case 'tag-uptime': {
        // R30: per-tag aggregate uptime. Returns average age in ms
        // computed from each worker's startedAt. Workers without a
        // tag are excluded from per-tag aggregation but counted in
        // totalWorkers. The age is "wall-clock since startedAt" —
        // the daemon doesn't track restart history, so this is the
        // current-uptime-since-last-restart metric.
        // R34: cumulativeMs extends this by adding the worker's
        // cumulativeUptimeMs (sum of past restart cycles' uptime)
        // to the current cycle. totalRestartCount is the sum of
        // restart cycles across all workers.
        const now = Date.now()
        const tagAges = new Map<string, { total: number; count: number; oldestMs: number; newestMs: number; cumulativeMs: number; restartCount: number }>()
        let totalUp = 0
        let totalCount = 0
        let totalCumulative = 0
        let totalRestartCount = 0
        for (const w of this.workers.values()) {
          const age = Math.max(0, now - new Date(w.startedAt).getTime())
          totalUp += age
          totalCount++
          totalCumulative += w.cumulativeUptimeMs + age
          totalRestartCount += w.restartCount
          if (w.tag === undefined) continue
          let entry = tagAges.get(w.tag)
          if (!entry) {
            entry = { total: 0, count: 0, oldestMs: 0, newestMs: Number.MAX_SAFE_INTEGER, cumulativeMs: 0, restartCount: 0 }
            tagAges.set(w.tag, entry)
          }
          entry.total += age
          entry.count++
          entry.cumulativeMs += w.cumulativeUptimeMs + age
          entry.restartCount += w.restartCount
          if (age > entry.oldestMs) entry.oldestMs = age
          if (age < entry.newestMs) entry.newestMs = age
        }
        const tags = Array.from(tagAges.entries()).map(([tag, agg]) => ({
          tag,
          averageMs: agg.count > 0 ? Math.round(agg.total / agg.count) : 0,
          oldestMs: agg.oldestMs,
          newestMs: agg.newestMs === Number.MAX_SAFE_INTEGER ? 0 : agg.newestMs,
          count: agg.count,
          cumulativeMs: agg.cumulativeMs,
          restartCount: agg.restartCount,
        })).sort((a, b) => a.tag.localeCompare(b.tag))
        return {
          ok: true,
          data: {
            totalWorkers: totalCount,
            averageMs: totalCount > 0 ? Math.round(totalUp / totalCount) : 0,
            totalCumulativeMs: totalCumulative,
            totalRestartCount,
            tags,
          },
        }
      }
      case 'restart-worker': {
        // R14: payload validation. Without a workerId the action is
        // a no-op (return ok=false) so the caller can retry.
        // R16: payload.workerId === 'all' triggers a bulk restart.
        // R24: payload.tag + payload.status filters apply BEFORE
        // the workerId selector. tag is a single string equality
        // (use workerId='tag:foo,bar' for multi-tag union).
        // status uses the same string[] OR semantics as
        // tag-stats (R22). The intersection of tag + status +
        // workerId forms the working set.
        const workerId = cmd.payload?.workerId
        if (typeof workerId !== 'string' || workerId.length === 0) {
          return { ok: false, error: 'restart-worker requires payload.workerId' }
        }
        const tagFilter = cmd.payload?.tag
        if (tagFilter !== undefined && typeof tagFilter !== 'string') {
          return { ok: false, error: 'restart-worker invalid tag: must be a string' }
        }
        const statusFilter = cmd.payload?.status
        let allowedStatuses: string[] | null = null
        if (statusFilter !== undefined) {
          if (typeof statusFilter === 'string') {
            allowedStatuses = [statusFilter]
          } else if (Array.isArray(statusFilter) && statusFilter.every((s) => typeof s === 'string')) {
            allowedStatuses = statusFilter
          } else {
            return { ok: false, error: 'restart-worker invalid status payload' }
          }
          const validStatuses = ['starting', 'running', 'stopped', 'failed']
          if (!allowedStatuses.every((s) => validStatuses.includes(s))) {
            return { ok: false, error: `restart-worker invalid status: ${JSON.stringify(allowedStatuses)}` }
          }
        }
        // R26: exclude-status filter, symmetric to tag-stats (R25).
        // Validated against the same status whitelist.
        const excludeFilter = cmd.payload?.exclude
        let excludedStatuses: string[] | null = null
        if (excludeFilter !== undefined) {
          if (typeof excludeFilter === 'string') {
            excludedStatuses = [excludeFilter]
          } else if (Array.isArray(excludeFilter) && excludeFilter.every((s) => typeof s === 'string')) {
            excludedStatuses = excludeFilter
          } else {
            return { ok: false, error: 'restart-worker invalid exclude payload' }
          }
          const validExcludes = ['starting', 'running', 'stopped', 'failed']
          if (!excludedStatuses.every((s) => validExcludes.includes(s))) {
            return { ok: false, error: `restart-worker invalid exclude: ${JSON.stringify(excludedStatuses)}` }
          }
        }
        // R24: filter helper applied to bulk paths.
        // R26: include excludeStatuses — workers matching any
        // excluded status are also filtered out.
        const passesFilter = (w: WorkerEntry): boolean => {
          if (tagFilter !== undefined && w.tag !== tagFilter) return false
          if (allowedStatuses !== null && !allowedStatuses.includes(w.status)) return false
          if (excludedStatuses !== null && excludedStatuses.includes(w.status)) return false
          return true
        }
        if (workerId === 'all') {
          const ids = Array.from(this.workers.values()).filter(passesFilter).map((w) => w.id)
          if (ids.length === 0) {
            return { ok: true, data: { workerId: 'all', restarted: 0, requestedAt: new Date().toISOString() } }
          }
          // R17: honor `concurrency` payload option. Default 1 (serial).
          // For 100 workers, concurrency=1 spawns 100 setTimeout(50ms)
          // serially over 5s. concurrency=4 (typical) does 25 batches
          // of 4 → 1.25s total. Clamped to [1, 16] to avoid pathological
          // values.
          const rawConcurrency = cmd.payload?.concurrency
          const parsedConcurrency = typeof rawConcurrency === 'number' && Number.isFinite(rawConcurrency)
            ? Math.floor(rawConcurrency)
            : 1
          const concurrency = Math.max(1, Math.min(16, parsedConcurrency))
          const results: Array<{ workerId: string; ok: boolean }> = []
          for (let i = 0; i < ids.length; i += concurrency) {
            const batch = ids.slice(i, i + concurrency)
            for (const id of batch) {
              // R34: propagate maxRestarts (and other options) to the
              // per-worker recursive call. Without this, the cap from
              // the outer payload is silently dropped on bulk paths.
              const r = this.handleCommand({ action: 'restart-worker', payload: cmd.payload ? { ...cmd.payload, workerId: id } : { workerId: id } })
              results.push({ workerId: id, ok: r.ok })
            }
          }
          const failures = results.filter((r) => !r.ok).length
          return {
            ok: failures === 0,
            data: {
              workerId: 'all',
              requested: ids.length,
              failed: failures,
              concurrency,
              results,
              tagFilter: tagFilter ?? null,
              statusFilter: allowedStatuses,
              excludeFilter: excludedStatuses,
              requestedAt: new Date().toISOString(),
            },
          }
        }
        // R18: tag selector. `tag:foo` restarts every worker whose tag
        // matches (exact match). Returns ok=false with a clear error
        // if no workers match the tag.
        // R19: multi-tag via comma-separated `tag:foo,bar`. Workers
        // matching ANY of the listed tags are restarted (union).
        // R27: tag negation via `tag:!foo` or comma-separated
        // `tag:!foo,!bar`. Workers whose tag matches ANY of the
        // listed negative tags are excluded. Positive + negative can
        // be combined in a single selector e.g. `tag:cli,!web`.
        // R24: status filter applies on top of tag selector.
        if (workerId.startsWith('tag:')) {
          const rawTags = workerId.slice(4)
          if (rawTags.length === 0) {
            return { ok: false, error: 'tag: requires a non-empty tag (e.g. tag:cli)' }
          }
          const tokens = rawTags.split(',').map((t) => t.trim()).filter((t) => t.length > 0)
          if (tokens.length === 0) {
            return { ok: false, error: 'tag: requires at least one non-empty tag after split' }
          }
          // R28: tokens containing '+' are AND sub-selectors. A
          // worker must match ALL tags in the sub-selector. e.g.
          // `tag:cli+web` requires the worker to have both 'cli' and
          // 'web' (either as primary tag or in the tags[] array).
          const positive: string[] = []
          const negative: string[] = []
          const ands: string[][] = []
          for (const t of tokens) {
            if (t.startsWith('!')) {
              const tag = t.slice(1)
              if (tag.length === 0) {
                return { ok: false, error: 'tag:! requires a non-empty tag (e.g. tag:!cli)' }
              }
              negative.push(tag)
            } else if (t.includes('+')) {
              const parts = t.split('+').map((p) => p.trim()).filter((p) => p.length > 0)
              if (parts.length === 0) {
                return { ok: false, error: 'tag:foo+ requires at least one non-empty tag' }
              }
              ands.push(parts)
            } else {
              positive.push(t)
            }
          }
          const tagged = Array.from(this.workers.values()).filter((w) => {
            // R32: labels include the worker's own tag + tags + aliases,
            // plus the parent's labels (one level up). Cycles are
            // caller's responsibility — we don't recurse.
            const parentLabels = w.parentId !== undefined
              ? this.collectLabels(this.workers.get(w.parentId))
              : []
            const labels = w.tag !== undefined
              ? [w.tag, ...(w.tags ?? []), ...(w.aliases ?? []), ...parentLabels]
              : [...(w.tags ?? []), ...(w.aliases ?? []), ...parentLabels]
            if (labels.length === 0) return false
            if (negative.some((n) => labels.includes(n))) return false
            if (positive.length > 0 && !positive.some((p) => labels.includes(p))) return false
            for (const andGroup of ands) {
              if (!andGroup.every((t) => labels.includes(t))) return false
            }
            return passesFilter(w)
          })
          if (tagged.length === 0) {
            const desc = [
              positive.length > 0 ? `tags ${JSON.stringify(positive)}` : '',
              negative.length > 0 ? `excluding ${JSON.stringify(negative)}` : '',
            ].filter(Boolean).join(' ')
            return { ok: false, error: `No workers found with ${desc}` }
          }
          const results: Array<{ workerId: string; ok: boolean }> = []
          for (const w of tagged) {
            // R34: propagate maxRestarts to the per-worker recursive
            // call. Without this, the cap is silently bypassed on
            // tag: selectors.
            const r = this.handleCommand({ action: 'restart-worker', payload: cmd.payload ? { ...cmd.payload, workerId: w.id } : { workerId: w.id } })
            results.push({ workerId: w.id, ok: r.ok })
          }
          const failures = results.filter((r) => !r.ok).length
          return {
            ok: failures === 0,
            data: {
              workerId: `tag:${tokens.join(',')}`,
              requested: tagged.length,
              failed: failures,
              results,
              statusFilter: allowedStatuses,
              excludeFilter: excludedStatuses,
              requestedAt: new Date().toISOString(),
            },
          }
        }
        const worker = this.workers.get(workerId)
        if (!worker) {
          return { ok: false, error: `Worker not found: ${workerId}` }
        }
        // R36: max-restarts policy. If the worker has already
        // exceeded the threshold, refuse the restart. Default 3
        // (configurable via payload.maxRestarts). maxRestarts=0
        // means unlimited (no cap). Reset on success would be a
        // future round — for now, the cap is per-worker lifetime.
        const rawMaxRestarts = cmd.payload?.maxRestarts
        const maxRestarts = typeof rawMaxRestarts === 'number' && Number.isFinite(rawMaxRestarts)
          ? Math.floor(rawMaxRestarts)
          : 3
        if (maxRestarts > 0 && worker.restartCount >= maxRestarts) {
          return { ok: false, error: `Worker ${workerId} has reached max-restarts (${maxRestarts})` }
        }
        // The daemon doesn't actually spawn subprocesses for workers
        // (that's a future capability). What we can do is reset the
        // worker's lifecycle atomically: mark it 'starting' with a
        // fresh startedAt, then immediately 'running' once the
        // restart cycle completes. This unblocks the type union and
        // gives the caller a confirmation that the action was
        // processed.
        // R34: capture cumulative uptime before resetting startedAt.
        const prevStartedAt = new Date(worker.startedAt).getTime()
        const prevUptime = Math.max(0, Date.now() - prevStartedAt)
        worker.cumulativeUptimeMs += prevUptime
        worker.restartCount += 1
        const now = new Date().toISOString()
        worker.status = 'starting'
        worker.startedAt = now
        // Simulate restart cycle: schedule the 'running' state 50ms
        // later. In a real subprocess world this would track the
        // child's spawn + health probe completion.
        const status = worker.status
        // R18: unref so a pending restart state-transition cannot keep the
        // event loop alive if the daemon is stop()'d within the 50ms window.
        const restartTimer = setTimeout(() => {
          if (this.workers.get(workerId)?.status === 'starting') {
            this.updateWorkerStatus(workerId, 'running')
          }
        }, 50)
        restartTimer.unref()
        this.log(`Worker restart requested: ${worker.name} (${workerId})`)
        return { ok: true, data: { workerId, status, requestedAt: now } }
      }
      default:
        return { ok: false, error: `Unknown action: ${fmtPayloadValue(cmd.action)}` }
    }
  }

  private log(message: string): void {
    try {
      const timestamp = new Date().toISOString()
      const line = `[${timestamp}] ${message}\n`
      if (existsSync(this.logPath)) {
        const existing = readFileSync(this.logPath, 'utf8')
        writeFileSync(this.logPath, existing + line)
      } else {
        writeFileSync(this.logPath, line)
      }
    } catch { /* ignore log errors */ }
  }
}

// ── Daemon Client ───────────────────────────────────────────────────────────

export class DaemonClient {
  constructor(private readonly socketPath: string) {}

  async send(cmd: DaemonCommand, timeoutMs = 5000): Promise<DaemonResponse> {
    // v0.6.0 (audit): on win32 the address is a named pipe — there is
    // no filesystem node to stat, so the existence pre-check is
    // skipped (a failed connect reports the real error below).
    if (process.platform !== 'win32' && !existsSync(this.socketPath)) {
      return { ok: false, error: 'Daemon socket not found. Is the daemon running?' }
    }

    return new Promise((resolve) => {
      const socket = new Socket()
      let buffer = ''
      let settled = false

      const timer = setTimeout(() => {
        if (!settled) {
          settled = true
          socket.destroy()
          resolve({ ok: false, error: `Daemon request timed out after ${timeoutMs}ms` })
        }
      }, timeoutMs)

      socket.on('connect', () => {
        socket.write(JSON.stringify(cmd) + '\n')
      })

      socket.on('data', (data: Buffer) => {
        buffer += data.toString()
        const nl = buffer.indexOf('\n')
        if (nl !== -1 && !settled) {
          settled = true
          clearTimeout(timer)
          const line = buffer.slice(0, nl).trim()
          try {
            resolve(JSON.parse(line) as DaemonResponse)
          } catch {
            resolve({ ok: false, error: 'Invalid daemon response' })
          }
          socket.destroy()
        }
      })

      socket.on('error', (err) => {
        if (!settled) {
          settled = true
          clearTimeout(timer)
          resolve({ ok: false, error: err.message })
        }
      })

      socket.connect(toSocketPath(this.socketPath))
    })
  }

  async ping(): Promise<boolean> {
    const res = await this.send({ action: 'ping' })
    return res.ok && res.data === 'pong'
  }

  async status(): Promise<DaemonInfo | null> {
    const res = await this.send({ action: 'status' })
    return res.ok ? res.data as DaemonInfo : null
  }

  async stop(): Promise<boolean> {
    const res = await this.send({ action: 'stop' })
    return res.ok
  }
}

// ── Paths ───────────────────────────────────────────────────────────────────

/**
 * v0.6.0 (audit): resolve the OS-level socket address for a logical
 * socket path. POSIX uses the filesystem path directly. Windows
 * cannot bind net sockets to file paths (EACCES) — the address is
 * translated to a named pipe. The hash keeps the pipe name short
 * (Windows pipe names have a 256-char limit) and stable per logical
 * path, so server and client agree without a shared registry.
 */
export function toSocketPath(raw: string): string {
  if (process.platform !== 'win32') return raw
  const key = createHash('sha256').update(raw).digest('hex').slice(0, 24)
  return `\\\\.\\pipe\\ovolv999-${key}`
}

export function getDaemonSocketPath(): string {
  // v0.6.0 (audit): env override for tests/embedders that need to
  // point the /daemon slash command at a custom supervisor socket
  // without homedir surgery or symlinks (which need admin rights on
  // Windows). Default behaviour is unchanged when unset.
  const override = process.env.OVOGO_DAEMON_SOCKET
  if (override && override.trim().length > 0) return override.trim()
  return join(homedir(), '.ovolv999', 'daemon.sock')
}

export function getDaemonLogPath(): string {
  return join(homedir(), '.ovolv999', 'daemon.log')
}

export function isDaemonRunning(): boolean {
  // v0.6.0 (audit): named pipes have no filesystem node — existsSync
  // would always report false on Windows. Optimistically return true
  // there and let the DaemonClient's connect attempt surface the real
  // answer (a failed connect is fast and reports a truthful error).
  if (process.platform === 'win32') {
    return true
  }
  return existsSync(getDaemonSocketPath())
}

// ── Formatting ──────────────────────────────────────────────────────────────

export function formatDaemonInfo(info: DaemonInfo): string {
  const lines: string[] = [
    `Daemon Status: ${info.status}`,
    `  PID: ${info.pid}`,
    `  Started: ${info.startTime}`,
    `  Uptime: ${(info.uptime / 1000 / 60).toFixed(1)} minutes`,
    `  Socket: ${info.socketPath}`,
    `  Log: ${info.logPath}`,
    `  Workers: ${info.workers}`,
  ]
  return lines.join('\n')
}

export function formatWorkers(workers: WorkerEntry[]): string {
  if (workers.length === 0) return 'No workers registered.'
  const lines: string[] = [`Workers (${workers.length}):`]
  for (const w of workers) {
    const icon = { starting: '○', running: '●', stopped: '⊘', failed: '✗' }[w.status]
    lines.push(`  ${icon} ${w.name} (${w.id}) — ${w.status}`)
  }
  return lines.join('\n')
}
