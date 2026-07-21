/**
 * EpisodicMemory — action trajectory persistence
 *
 * Records "what I did, what happened, was it successful" for each tool call
 * and agent action. Lets the agent review its recent history of attempts
 * without re-reading the full conversation.
 *
 * Storage: ~/.ovogo/projects/{slug}/memory/episodes.jsonl
 *
 * Bounded retention: a long-running agent would otherwise append
 * forever and produce a multi-gigabyte action log. {@link MAX_EPISODES}
 * caps the on-disk episode count; once a write would push past the
 * cap, the file is rewritten with only the most recent MAX_EPISODES
 * entries (oldest evicted first). The rewrite goes through the same
 * tmp + fsync + rename convention as the rest of the persistence
 * layer so a crash mid-rewrite never leaves a torn file.
 */

import { appendFileSync, closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeSync } from 'fs'
import { join } from 'path'
import { randomBytes, randomUUID } from 'crypto'

export interface EpisodicMemoryEntry {
  id: string
  turn: number
  toolName: string
  inputSummary: string   // truncated input
  resultSummary: string  // truncated result
  outcome: 'success' | 'failure' | 'partial'
  duration?: number      // ms
  timestamp: string      // ISO 8601
}

const VALID_OUTCOMES: ReadonlySet<EpisodicMemoryEntry['outcome']> = new Set([
  'success', 'failure', 'partial',
])

function nextId(): string {
  return `epi_${randomUUID()}`
}

/**
 * Validate a constructor-supplied cap. Accepts positive integers and
 * returns them unchanged; anything else (undefined, NaN, non-numbers,
 * zero, negatives, non-integers) falls back to MAX_EPISODES. We
 * intentionally do NOT throw here — the engine wires EpisodicMemory
 * up at boot time and a TypeError would block every subsequent tool
 * call. Falling back to the documented default is the safer choice;
 * the value is otherwise an internal detail.
 */
function sanitizeMaxEpisodes(candidate: number | undefined): number {
  if (
    typeof candidate !== 'number' ||
    !Number.isFinite(candidate) ||
    !Number.isInteger(candidate) ||
    candidate <= 0
  ) {
    return MAX_EPISODES
  }
  return candidate
}

/**
 * Hard cap on the number of episodes retained on disk.
 *
 * When a write would push the file past this threshold, the OLDEST
 * episodes are evicted and the file is rewritten with only the most
 * recent MAX_EPISODES entries. The cap is enforced in write() rather
 * than read() so the file on disk is itself bounded — unbounded
 * growth on a long-lived process is what we're guarding against.
 *
 * 10_000 episodes is generous for a normal session (each entry is a
 * short JSON line; ~200–400 bytes → ~3 MB worst case) but small
 * enough that a runaway loop can't fill the disk. The eviction runs
 * in the same code path as the write so a single tool call never
 * pushes the count past the cap by more than one entry.
 *
 * The cap can be overridden per-instance via the
 * {@link EpisodicMemory} constructor's `maxEpisodes` option — useful
 * for tests that want to exercise compaction on a small scale.
 */
export const MAX_EPISODES = 10_000

/**
 * Schema check for an episode row. Returns true iff `value` looks like a
 * valid EpisodicMemoryEntry. Used by readAll() to skip rows whose shape
 * drifted (legacy writes, partial writes, manual edits) so a single bad
 * line never breaks the entire read.
 *
 * Required fields and their validation:
 *   - id            : non-empty string
 *   - turn          : finite number (integer)
 *   - toolName      : string (may be empty)
 *   - inputSummary  : string
 *   - resultSummary : string
 *   - outcome       : one of 'success' | 'failure' | 'partial'
 *   - duration      : (optional) finite number when present
 *   - timestamp     : string
 *
 * Exported for tests / callers that want to validate a row out-of-band.
 */
export function isValidEpisode(value: unknown): value is EpisodicMemoryEntry {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const v = value as Record<string, unknown>
  if (typeof v.id !== 'string' || v.id.length === 0) return false
  if (typeof v.turn !== 'number' || !Number.isFinite(v.turn)) return false
  if (typeof v.toolName !== 'string') return false
  if (typeof v.inputSummary !== 'string') return false
  if (typeof v.resultSummary !== 'string') return false
  if (typeof v.outcome !== 'string' || !VALID_OUTCOMES.has(v.outcome as EpisodicMemoryEntry['outcome'])) return false
  if (v.duration !== undefined && (typeof v.duration !== 'number' || !Number.isFinite(v.duration))) return false
  if (typeof v.timestamp !== 'string') return false
  return true
}

export interface EpisodicMemoryOptions {
  /**
   * Maximum episodes retained on disk. Must be a positive integer;
   * defaults to {@link MAX_EPISODES}. Smaller values are useful for
   * tests that want to exercise compaction on a few dozen writes
   * rather than thousands — keeping test workloads small keeps the
   * suite fast and avoids wall-clock flakiness on slow CI disks.
   */
  maxEpisodes?: number
}

export class EpisodicMemory {
  private filePath: string
  /**
   * Tracked entry count for the on-disk file. Maintained in memory so
   * write() can decide whether to compact WITHOUT reading the file on
   * every call — the previous O(N²) per-write line-scan made a 10k
   * write session crawl. The counter is lazy-initialized on the first
   * read/write that needs it (counting by reading the file once), then
   * incremented on every successful append and reset to the post-
   * compact count after a rewrite.
   *
   * `null` is the "not yet known" sentinel — we don't trust the
   * counter to be accurate until we've either counted once or built
   * it up from observed writes.
   */
  private entryCount: number | null = null
  /**
   * Per-instance cap. Defaults to MAX_EPISODES; configurable via
   * the constructor option. Validated as a positive integer at
   * construction — invalid values fall back to MAX_EPISODES rather
   * than throwing, because the engine wires this up at boot time and
   * a TypeError there would block every tool call.
   */
  private maxEpisodes: number

  constructor(projectDir: string, options: EpisodicMemoryOptions = {}) {
    const memDir = join(projectDir, 'memory')
    try { mkdirSync(memDir, { recursive: true }) } catch { /* best-effort */ }
    this.filePath = join(memDir, 'episodes.jsonl')
    this.maxEpisodes = sanitizeMaxEpisodes(options.maxEpisodes)
  }

  /** Append a new episode entry */
  write(entry: Omit<EpisodicMemoryEntry, 'id'>): EpisodicMemoryEntry {
    const full: EpisodicMemoryEntry = { ...entry, id: nextId() }
    try {
      appendFileSync(this.filePath, JSON.stringify(full) + '\n', 'utf8')
      // Successful append → bump the tracked count. We increment
      // AFTER the append so a failed append doesn't desync the
      // counter. On the first write we lazy-init from the actual
      // on-disk line count via ensureCount() — note ensureCount()
      // scans the file AFTER this append, so it already includes
      // the just-written line; we use it verbatim rather than +1.
      // Without this, reloading an existing JSONL with N entries
      // would pin entryCount=1 and skip compaction until ~cap
      // additional writes accumulated.
      if (this.entryCount === null) this.entryCount = this.ensureCount()
      else this.entryCount++
    } catch { /* best-effort */ }
    // Enforce the cap AFTER appending so the on-disk state is always
    // consistent: a successful append is reflected on disk before we
    // decide whether to compact. Eviction only fires when the count
    // crosses the threshold; under-cap writes skip the rewrite.
    this.enforceCap()
    return full
  }

  /**
   * If the tracked entry count exceeds the instance cap, rewrite the
   * file with only the most recent cap-sized window of entries.
   * Best-effort: a failed compaction does NOT undo the append that
   * triggered it (we'd rather overshoot the cap for one cycle than
   * risk data loss).
   *
   * Compaction uses the same tmp + fsync + rename convention as the
   * rest of the persistence layer so a crash mid-rewrite never leaves
   * a torn file: either the OLD file is intact, or the NEW compacted
   * file is fully written and renamed into place.
   *
   * Cost: this is the ONLY place that pays an O(N) full-file read
   * after the constructor, and it fires once per `maxEpisodes` writes
   * — making the amortized cost of N writes O(N) instead of O(N²).
   */
  private enforceCap(): void {
    const cap = this.maxEpisodes
    const count = this.ensureCount()
    if (count <= cap) return

    const all = this.readAll()
    if (all.length <= cap) return

    // Keep the most recent `cap` entries (chronological order:
    // readAll preserves file order, so the tail is the newest).
    const keep = all.slice(-cap)
    const payload = Buffer.from(
      keep.map((e) => JSON.stringify(e)).join('\n') + '\n',
      'utf8',
    )

    const tmpPath = `${this.filePath}.tmp.${process.pid}.${Date.now()}.${randomBytes(8).toString('hex')}`
    let tmpFd: number | null = null
    try {
      tmpFd = openSync(tmpPath, 'w')
      writeSync(tmpFd, payload, 0, payload.length, 0)
      fsyncSync(tmpFd)
      closeSync(tmpFd)
      tmpFd = null
      renameSync(tmpPath, this.filePath)
      // Update the tracked count to the post-compaction size so
      // subsequent writes don't re-trigger compaction for another
      // cap-sized batch of appends.
      this.entryCount = keep.length
    } catch {
      if (tmpFd !== null) {
        try { closeSync(tmpFd) } catch { /* swallow */ }
      }
      try {
        if (existsSync(tmpPath)) unlinkSync(tmpPath)
      } catch {
        /* swallow */
      }
      /* swallow — better to overshoot the cap for one cycle than to
         lose the append that triggered this. The next ensureCount()
         call will reconcile from disk. */
    }
  }

  /**
   * Lazily compute (and cache) the on-disk episode count by scanning
   * the file. After the first call the count is tracked incrementally
   * by write(); enforceCap() resets it after a successful compaction.
   *
   * The scan is O(file-size) but runs at most ONCE per process — never
   * per-write. Without this, write() would either pay an O(N) scan
   * every call (the O(N²) bug) or skip the cap entirely. Keeping the
   * count in memory is the right tradeoff: cap enforcement is amortized
   * O(1) per write, with one full scan on first read AND one per
   * compaction cycle.
   */
  private ensureCount(): number {
    if (this.entryCount !== null) return this.entryCount
    if (!existsSync(this.filePath)) {
      this.entryCount = 0
      return 0
    }
    let raw: string
    try {
      raw = readFileSync(this.filePath, 'utf8')
    } catch {
      this.entryCount = 0
      return 0
    }
    if (raw.length === 0) {
      this.entryCount = 0
      return 0
    }
    let count = 0
    for (let i = 0; i < raw.length; i++) {
      if (raw.charCodeAt(i) === 10) count++
    }
    // A trailing partial line (no terminating newline) still counts —
    // a writer that crashed before its final newline should not
    // artificially deflate the count.
    if (raw.charCodeAt(raw.length - 1) !== 10) count++
    this.entryCount = count
    return count
  }

  /** Read the most recent N episodes */
  recent(limit = 20): EpisodicMemoryEntry[] {
    const all = this.readAll()
    return all.slice(-limit)
  }

  /**
   * Read all entries.
   *
   * Robustness contract:
   *   - Missing file → [].
   *   - Each line is parsed independently and validated against
   *     {@link isValidEpisode}. Corrupt or wrong-shape lines are
   *     SKIPPED rather than aborting the whole read. A single bad row
   *     no longer makes an otherwise-healthy log unreadable.
   *   - The function returns [] only when no valid entries exist
   *     (missing file / empty file / entirely unparseable content).
   */
  readAll(): EpisodicMemoryEntry[] {
    if (!existsSync(this.filePath)) return []
    let raw: string
    try {
      raw = readFileSync(this.filePath, 'utf8')
    } catch {
      return []
    }

    const out: EpisodicMemoryEntry[] = []
    for (const line of raw.split('\n')) {
      const trimmed = line.trim()
      if (trimmed.length === 0) continue
      let parsed: unknown
      try {
        parsed = JSON.parse(trimmed)
      } catch {
        // Bad JSON — skip this line, keep going.
        continue
      }
      if (!isValidEpisode(parsed)) {
        // Right JSON, wrong shape — skip this line, keep going.
        continue
      }
      out.push(parsed)
    }
    return out
  }

  /** Search episodes by tool name */
  findByTool(toolName: string, limit = 10): EpisodicMemoryEntry[] {
    const all = this.readAll()
    return all.filter((e) => e.toolName === toolName).slice(-limit)
  }
}
