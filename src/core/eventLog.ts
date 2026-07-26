/**
 * EventLog — 不可变事件流，记录任务的完整审计轨迹
 *
 * 每条事件为 NDJSON 格式，追加写入 session 目录下的 events.ndjson。
 * 支持按类型/标签查询，供 critic 检查、上下文压缩、agent 回调等系统使用。
 *
 * Robustness contract:
 *   - append() is best-effort: any I/O failure is swallowed so the engine
 *     never crashes because the audit log is unwritable.
 *   - append() also performs BACKGROUND auto-rotation: when the on-disk
 *     file exceeds `rotateBytes`, the next append() renames the existing
 *     log to `events.ndjson.1` and starts a fresh file. Default threshold
 *     is {@link DEFAULT_EVENTLOG_ROTATE_BYTES} (10 MiB). Tests may pass
 *     a smaller threshold via the constructor `options.rotateBytes` to
 *     exercise the rotation path deterministically.
 *   - readAll() is line-tolerant: a single corrupted line does NOT drop the
 *     rest of the log. Each line is parsed independently; malformed lines
 *     (bad JSON or wrong shape) are skipped, and a readAll() with options
 *     { onSkip } receives the count of dropped lines for diagnostics.
 *   - query() exposes a lightweight predicate filter for common lookups.
 *   - rotateIfExceeded(thresholdBytes) is a public helper for callers that
 *     want to force a rotation check on a different threshold than the
 *     instance's default (e.g. before a readAll() on a long-running
 *     session). Production auto-rotation does NOT depend on this helper —
 *     append() handles it inline.
 *
 * NOTE: This module does NOT promise power-loss durability. `appendFileSync`
 * flushes to the OS but does not fsync the disk; a crash between the OS
 * flush and a hardware commit can still lose the last entry or two. Callers
 * that need stronger guarantees should add an explicit fsync layer.
 */

import { appendFileSync, mkdirSync, existsSync, readFileSync, statSync, renameSync } from 'fs'
import { join } from 'path'
import { randomUUID } from 'crypto'

export type EventType =
  | 'tool_call'
  | 'tool_result'
  | 'boot_context'
  | 'invoke_sent'
  | 'invoke_completed'
  | 'memory_write'
  | 'context_compact'
  | 'module_flag'
  | 'user_input'
  | 'user_interrupt'
  | 'agent_completion'

/** Runtime whitelist — used by isValidEntry to reject unknown event types. */
const EVENT_TYPES: ReadonlySet<EventType> = new Set<EventType>([
  'tool_call',
  'tool_result',
  'boot_context',
  'invoke_sent',
  'invoke_completed',
  'memory_write',
  'context_compact',
  'module_flag',
  'user_input',
  'user_interrupt',
  'agent_completion',
])

export interface EventLogEntry {
  id: string
  timestamp: string  // ISO 8601
  type: EventType
  source: string     // 工具名 / agent 类型 / 系统模块
  detail: Record<string, unknown>
  tags?: string[]
}

function nextId(): string {
  return `evt_${randomUUID()}`
}

// ── Validation ─────────────────────────────────────────────────────────────

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/**
 * Conservative schema check — returns true only if `value` matches the
 * EventLogEntry shape closely enough to be safe to forward to consumers.
 * Used by readAll() to skip garbage that survived JSON.parse.
 *
 * Required fields and their validation:
 *   - id        : non-empty string
 *   - timestamp : non-empty string parseable by Date.parse
 *   - type      : one of the EventType whitelist values
 *   - source    : non-empty string
 *   - detail    : object (not array, not primitive)
 *   - tags      : (optional) array whose every element is a string
 */
export function isValidEntry(value: unknown): value is EventLogEntry {
  if (!isObject(value)) return false
  if (typeof value.id !== 'string' || value.id.length === 0) return false
  if (typeof value.timestamp !== 'string' || value.timestamp.length === 0) return false
  if (Number.isNaN(Date.parse(value.timestamp))) return false
  if (typeof value.type !== 'string' || value.type.length === 0) return false
  if (!EVENT_TYPES.has(value.type as EventType)) return false
  if (typeof value.source !== 'string' || value.source.length === 0) return false
  if (!isObject(value.detail)) return false
  if (value.tags !== undefined) {
    if (!Array.isArray(value.tags)) return false
    if (!value.tags.every((t): t is string => typeof t === 'string')) return false
  }
  return true
}

// ── Query ───────────────────────────────────────────────────────────────────

/** Lightweight predicate — returns true to keep the entry. */
export type EventPredicate = (entry: EventLogEntry) => boolean

/**
 * Build a predicate from a structured filter. Exported for tests / callers
 * that want the same composability as the `query(filter)` convenience path.
 */
export function buildFilter(filter: {
  type?: EventType
  source?: string
  tag?: string
}): EventPredicate {
  return (entry) => {
    if (filter.type !== undefined && entry.type !== filter.type) return false
    if (filter.source !== undefined && entry.source !== filter.source) return false
    if (filter.tag !== undefined) {
      const tags = entry.tags
      if (!Array.isArray(tags) || !tags.includes(filter.tag)) return false
    }
    return true
  }
}

// ── EventLog ────────────────────────────────────────────────────────────────

export interface ReadAllOptions {
  /** Optional callback receiving count of skipped (corrupt / wrong-shape) lines. */
  onSkip?: (skipped: number) => void
  /**
   * Cap the number of entries returned. When set, readAll returns the
   * most recent `limit` entries (preserving append order) rather than
   * the entire file. Bounds the parsed-result memory footprint for
   * long-running sessions where the audit log has grown large.
   *
   * When omitted (default), the entire file is read — same as before.
   */
  limit?: number
}

export interface EventLogOptions {
  /**
   * Soft size cap for the on-disk log, in bytes. When the file exceeds
   * this size, the NEXT append() atomically rotates it (renaming the
   * existing log to `events.ndjson.1`) before writing the new entry.
   *
   * Defaults to {@link DEFAULT_EVENTLOG_ROTATE_BYTES} (10 MiB) when
   * omitted — enough headroom for a typical session, low enough that
   * a runaway audit log cannot blow up disk usage. Tests pass smaller
   * values to exercise the rotation path deterministically.
   *
   * Pass 0 (or a negative number) to disable auto-rotation entirely.
   * `rotateIfExceeded()` still works as an explicit rotation helper in
   * that mode.
   */
  rotateBytes?: number
}

/**
 * Default rotation threshold: 10 MiB. Long sessions routinely cross this
 * with audit volume; 10 MiB of NDJSON at ~150 bytes/entry is on the order
 * of 70k entries, well past anything a single session needs to retain
 * in-memory for review.
 */
export const DEFAULT_EVENTLOG_ROTATE_BYTES = 10 * 1024 * 1024

export class EventLog {
  private filePath: string
  /**
   * Auto-rotation threshold (bytes). When `> 0`, every append() checks
   * the file size and rotates the log once it crosses this cap. `<= 0`
   * disables auto-rotation; `rotateIfExceeded()` remains usable.
   */
  private rotateBytes: number

  constructor(sessionDir: string, options?: EventLogOptions) {
    this.filePath = join(sessionDir, 'events.ndjson')
    this.rotateBytes = options?.rotateBytes ?? DEFAULT_EVENTLOG_ROTATE_BYTES
    try { mkdirSync(sessionDir, { recursive: true }) } catch { /* best-effort */ }
  }

  /** Append a new event (best-effort, never throws). */
  append(
    type: EventType,
    source: string,
    detail: Record<string, unknown>,
    tags?: string[],
  ): EventLogEntry {
    const entry: EventLogEntry = {
      id: nextId(),
      timestamp: new Date().toISOString(),
      type,
      source,
      detail,
      tags,
    }
    // Auto-rotation: BEFORE writing, if the file already exceeds the
    // configured cap, rename it to `events.ndjson.1` and start fresh.
    // Best-effort: a rotation failure must NEVER block the actual
    // append — the audit log is already best-effort, and a failed
    // rotation just means we'll try again on the next append.
    if (this.rotateBytes > 0) {
      try {
        this.rotateIfExceeded(this.rotateBytes)
      } catch {
        /* swallow — see comment above */
      }
    }
    try {
      appendFileSync(this.filePath, JSON.stringify(entry) + '\n', 'utf8')
    } catch {
      // silently ignore — event log must never break the engine
    }
    return entry
  }

  /**
   * Read all events from the file. Line-tolerant: a single corrupted line
   * does NOT cause the rest of the log to be discarded. Each line is parsed
   * independently and validated against the EventLogEntry shape; malformed
   * lines (bad JSON or wrong shape) are silently skipped.
   *
   * Returns [] only when the file is missing, empty, or wholly unreadable.
   *
   * Bounded-read support: when `options.limit` is set, the returned array
   * is capped to the LAST `limit` valid entries (preserving append order).
   * Corrupt lines are still skipped first, so the limit applies to valid
   * entries — not to raw lines. This bounds the parsed-result memory
   * footprint for long-running sessions where the audit log has grown
   * large, while keeping the line-tolerant recovery contract intact.
   */
  readAll(options: ReadAllOptions = {}): EventLogEntry[] {
    if (!existsSync(this.filePath)) return []
    let raw: string
    try {
      raw = readFileSync(this.filePath, 'utf8')
    } catch {
      return []
    }

    const out: EventLogEntry[] = []
    let skipped = 0
    // Split preserves trailing empty line; trim each line so we don't
    // count a single trailing newline as a corrupt entry.
    for (const rawLine of raw.split('\n')) {
      const line = rawLine.trim()
      if (line.length === 0) continue
      let parsed: unknown
      try {
        parsed = JSON.parse(line)
      } catch {
        skipped++
        continue
      }
      if (!isValidEntry(parsed)) {
        skipped++
        continue
      }
      out.push(parsed)
    }
    if (skipped > 0) options.onSkip?.(skipped)

    // Apply the bounded-read cap. Drop the OLDEST entries first so the
    // caller keeps the most recent activity — which is almost always
    // what they want from an audit log. We use a non-negative integer
    // limit; anything else falls back to "no cap".
    if (typeof options.limit === 'number' && Number.isFinite(options.limit) && options.limit >= 0) {
      const limit = Math.floor(options.limit)
      if (out.length > limit) {
        out.splice(0, out.length - limit)
      }
    }
    return out
  }

  /**
   * Rotate the on-disk log when its size exceeds `thresholdBytes`.
   *
   * Behavior:
   *   - If the file is missing or smaller than the threshold, returns
   *     `false` and does nothing.
   *   - Otherwise, atomically renames `events.ndjson` to
   *     `events.ndjson.1` (overwriting any existing `.1`). The next
   *     `append()` creates a fresh empty log.
   *
   * Returns `true` iff a rotation was performed. Best-effort: any
   * rename failure returns `false` rather than throwing — the audit log
   * must never break the engine.
   *
   * Callers typically invoke this before `readAll()` on long-running
   * sessions so the read returns a bounded working set and the rotated
   * `.1` holds the historical tail.
   */
  rotateIfExceeded(thresholdBytes: number): boolean {
    if (!Number.isFinite(thresholdBytes) || thresholdBytes <= 0) return false
    if (!existsSync(this.filePath)) return false
    let size: number
    try {
      size = statSync(this.filePath).size
    } catch {
      return false
    }
    if (size <= thresholdBytes) return false
    const rotatedPath = `${this.filePath}.1`
    try {
      renameSync(this.filePath, rotatedPath)
      return true
    } catch {
      return false
    }
  }

  /**
   * Lightweight filtered read. Two equivalent forms:
   *   query()                 → returns all valid entries
   *   query(predicate)        → returns entries for which predicate(entry) is true
   *   query({ type, source, tag }) → structured convenience filter
   *
   * Internally reuses readAll() so the same line-tolerance applies.
   */
  query(
    arg: EventPredicate | {
      type?: EventType
      source?: string
      tag?: string
    } = {},
    options: ReadAllOptions = {},
  ): EventLogEntry[] {
    const predicate: EventPredicate =
      typeof arg === 'function' ? arg : buildFilter(arg)
    return this.readAll(options).filter(predicate)
  }

  /** Get the file path (for tools that want to cat/tail it) */
  getFilePath(): string {
    return this.filePath
  }
}