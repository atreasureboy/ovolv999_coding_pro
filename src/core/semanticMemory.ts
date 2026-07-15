/**
 * SemanticMemory — cross-turn knowledge persistence with incremental index.
 *
 * Improvements over the previous version:
 * 1. In-memory index — entries are tracked as they're written; disk reads are
 *    lazy (only on first query or after explicit reload).
 * 2. Deduplication — entries with the same content hash are not duplicated;
 *    newer entries update the confidence/timestamp of existing ones.
 * 3. Tag index — a Map<tag, Set<entryId>> for O(1) tag lookups without
 *    scanning all entries.
 * 4. mtime/size-based reload — every read consults the on-disk file's
 *    (mtimeMs, size) tuple and reloads from disk when an external
 *    writer (another ovogogogo process, a manual edit, a recovery
 *    tool) has touched the file. Without this, two processes pointing
 *    at the same project dir would silently disagree about what's
 *    known.
 *
 * Storage: ~/.ovogo/projects/{slug}/memory/semantic.jsonl
 */

import { appendFileSync, closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeSync } from 'fs'
import { join } from 'path'
import { createHash, randomBytes, randomUUID } from 'crypto'

export interface SemanticMemoryEntry {
  id: string
  content: string
  tags: string[]
  source: string // tool name or module that wrote this
  timestamp: string // ISO 8601
  confidence: number // 0–1, how confident we are this is correct
}

interface TagIndex {
  [tag: string]: Set<string> // tag → set of entry IDs
}

function nextId(): string {
  return `sem_${randomUUID()}`
}

// Source priority for conflict resolution (AgentOS pattern):
// user_stated(3) > agent_inferred/consolidation(2) > tool_observed(1)
const SOURCE_PRIORITY: Record<string, number> = {
  user_stated: 3,
  agent_inferred: 2,
  consolidation: 2,
  tool_observed: 1,
}

function sourceRank(source: string): number {
  return SOURCE_PRIORITY[source] ?? 1
}

function contentHash(content: string): string {
  return createHash('md5').update(content).digest('hex').slice(0, 12)
}

export class SemanticMemory {
  private filePath: string
  private entries: Map<string, SemanticMemoryEntry> = new Map()
  private tagIndex: TagIndex = {}
  private loaded = false
  /**
   * Cached (mtimeMs, size) tuple captured the last time we read the
   * file. We compare the CURRENT stat against this on every access;
   * a mismatch means an external writer (another process, a recovery
   * tool, a manual edit) has touched the file, so we re-read and
   * rebuild the in-memory index. Both fields are inspected because
   * mtime alone is unreliable (some filesystems clamp to second
   * resolution and `cp` can preserve mtime) and size alone misses
   * same-size overwrites.
   *
   * `-1` is the "we haven't loaded yet" sentinel; both real mtime and
   * size are non-negative.
   */
  private lastLoadedMtimeMs = -1
  private lastLoadedSize = -1

  constructor(projectDir: string) {
    const memDir = join(projectDir, 'memory')
    try {
      mkdirSync(memDir, { recursive: true })
    } catch {
      /* best-effort */
    }
    this.filePath = join(memDir, 'semantic.jsonl')
  }

  /**
   * Lazy-load from disk on first access, AND reload on external
   * mutation. The (mtimeMs, size) tuple is the canonical "did anyone
   * outside this process touch the file?" check; a mismatch triggers
   * a full reload even on a process that has already loaded once.
   *
   * Edge cases that motivate the reload-on-mtime policy:
   *   - Two ovogogogo processes pointing at the same projectDir: A
   *     writes, B reads stale state until the file's stat changes.
   *   - Recovery tooling rewrites the file: A's in-memory index must
   *     not silently keep the old shape.
   *   - A manual `truncate -s 0` clears the file: A's index must
   *     converge on empty, not stay populated.
   *
   * Failure modes:
   *   - File deleted between writes: treat as empty index, do not
   *     throw. Callers that NEED the file to exist can `existsSync`
   *     separately.
   *   - File unreadable: keep whatever the previous in-memory state
   *     was — a transient read failure shouldn't blow away data we
   *     already have. The next successful read will reconcile.
   */
  private ensureLoaded(): void {
    let stat: { mtimeMs: number; size: number } | null = null
    if (existsSync(this.filePath)) {
      try {
        const s = statSync(this.filePath)
        stat = { mtimeMs: s.mtimeMs, size: s.size }
      } catch {
        /* file present but unstatable — treat as "no fresh data" */
      }
    }

    if (this.loaded) {
      if (stat === null) {
        // File disappeared since last load. Reconcile to empty so the
        // in-memory index doesn't claim knowledge that no longer has
        // an on-disk source of truth.
        if (this.lastLoadedSize !== 0) {
          this.entries.clear()
          this.tagIndex = {}
          this.lastLoadedMtimeMs = -1
          this.lastLoadedSize = 0
        }
        return
      }
      if (
        stat.mtimeMs === this.lastLoadedMtimeMs &&
        stat.size === this.lastLoadedSize
      ) {
        return
      }
    }

    // Fresh load OR reload: drop the in-memory state and rebuild from
    // the current file. A reload always replaces — we never merge an
    // external file with our local cache because merging would risk
    // resurrecting entries that the external writer deliberately
    // removed.
    this.entries.clear()
    this.tagIndex = {}
    this.loaded = true
    this.lastLoadedMtimeMs = stat?.mtimeMs ?? -1
    this.lastLoadedSize = stat?.size ?? 0

    if (stat === null) return

    try {
      const lines = readFileSync(this.filePath, 'utf8').trim().split('\n').filter(Boolean)
      for (const line of lines) {
        try {
          const entry = JSON.parse(line) as SemanticMemoryEntry
          this.entries.set(entry.id, entry)
          for (const tag of entry.tags) {
            if (!this.tagIndex[tag]) this.tagIndex[tag] = new Set()
            this.tagIndex[tag].add(entry.id)
          }
        } catch {
          // skip corrupt line
        }
      }
    } catch {
      // file unreadable — keep the cleared in-memory state. The next
      // successful read will repopulate it.
    }
  }

  /** Append a new memory entry. Deduplicates by content hash. */
  write(entry: Omit<SemanticMemoryEntry, 'id'>): SemanticMemoryEntry {
    this.ensureLoaded()

    const hash = contentHash(entry.content)

    // Check for duplicate content — resolve by source priority
    for (const [id, existing] of this.entries) {
      if (contentHash(existing.content) === hash) {
        // Source priority conflict resolution (AgentOS pattern)
        if (sourceRank(entry.source) < sourceRank(existing.source)) {
          // Lower priority can't override higher — keep existing
          return existing
        }
        // Same or higher priority → update
        const updated: SemanticMemoryEntry = {
          ...existing,
          confidence: Math.max(existing.confidence, entry.confidence),
          timestamp: new Date().toISOString(),
          source: entry.source,
        }
        this.entries.set(id, updated)
        this.persistAll()
        return updated
      }
    }

    const full: SemanticMemoryEntry = { ...entry, id: nextId() }
    this.entries.set(full.id, full)

    // Update tag index
    for (const tag of full.tags) {
      if (!this.tagIndex[tag]) this.tagIndex[tag] = new Set()
      this.tagIndex[tag].add(full.id)
    }

    // Synchronous, inline appendFileSync. Node.js executes JavaScript on a
    // single thread, so a synchronous I/O call here CANNOT interleave with
    // another write() call on the same instance — write() only returns
    // after the bytes are committed. We deliberately keep the append
    // path simple and synchronous rather than wrapping it in a Promise
    // queue: deferring the write would change the API contract (data not
    // on disk when write() returns) and would silently drop the line if
    // the process exited before the microtask ran.
    try {
      appendFileSync(this.filePath, JSON.stringify(full) + '\n', 'utf8')
      // Refresh the (mtime, size) cache so the very next ensureLoaded()
      // doesn't reload what we just appended. Catching the stat failure
      // is non-fatal — a missing cache just costs one reload, which is
      // safe because the in-memory state is already authoritative.
      try {
        const s = statSync(this.filePath)
        this.lastLoadedMtimeMs = s.mtimeMs
        this.lastLoadedSize = s.size
      } catch {
        /* best-effort */
      }
    } catch {
      /* best-effort */
    }
    return full
  }

  /**
   * Persist all entries to disk (rewrite entire file for consistency).
   *
   * Uses an atomic tmp + flush + rename pattern so a crash mid-write
   * can never leave a half-written semantic.jsonl on disk:
   *
   *   1. Write payload to a uniquely-suffixed tmp file IN THE SAME
   *      directory as the target (cross-directory rename is not atomic
   *      on POSIX, so the same-directory requirement is load-bearing).
   *      The suffix combines pid + Date.now() + 8 random bytes so two
   *      concurrent rewrites (from this process or another process
   *      racing on the same projectDir) can never collide on the tmp
   *      name — only the LAST successful rename wins.
   *   2. fsync the tmp file so its bytes are on stable storage before
   *      the rename publishes it.
   *   3. rename tmp → target. Atomic on POSIX within the same FS.
   *   4. Always unlink the tmp in a `finally`, whether the write /
   *      fsync / rename succeeded or failed — otherwise a failed
   *      rewrite leaks the tmp onto disk forever.
   *
   * The whole operation is synchronous and inline — by the time
   * persistAll() returns, the bytes are on disk. No Promise queue is
   * involved (deferred writes would change the API and lose data on
   * process exit; the single-threaded JS event loop already serializes
   * these sync calls against each other).
   */
  private persistAll(): void {
    const tmpPath = `${this.filePath}.tmp.${process.pid}.${Date.now()}.${randomBytes(8).toString('hex')}`
    let tmpFd: number | null = null
    try {
      const lines = Array.from(this.entries.values())
        .map((e) => JSON.stringify(e))
        .join('\n')
      const payload = Buffer.from(lines + '\n', 'utf8')

      // Open + write + fsync + close. Going through the fd directly
      // (instead of writeFileSync) gives us an explicit fsync so the
      // rename that follows is guaranteed to publish fully-committed
      // bytes.
      tmpFd = openSync(tmpPath, 'w')
      writeSync(tmpFd, payload, 0, payload.length, 0)
      fsyncSync(tmpFd)
      closeSync(tmpFd)
      tmpFd = null

      renameSync(tmpPath, this.filePath)
      // Refresh the (mtime, size) cache so the next ensureLoaded()
      // sees the file as "freshly loaded" and doesn't reload what we
      // just rewrote. Without this, every search()/readAll() after a
      // rewrite would re-read the file.
      try {
        const s = statSync(this.filePath)
        this.lastLoadedMtimeMs = s.mtimeMs
        this.lastLoadedSize = s.size
      } catch {
        /* best-effort */
      }
    } catch {
      /* best-effort — do not let a write failure escape this method */
    } finally {
      // Best-effort cleanup of the tmp file (and its fd) so a failed
      // rewrite does not leak the tmp onto disk and a half-open fd
      // does not survive past this call. unlinkSync on an already-
      // renamed (i.e. missing) path is a no-op ENOENT — safe to call
      // unconditionally after a successful rename.
      if (tmpFd !== null) {
        try { closeSync(tmpFd) } catch { /* swallow */ }
      }
      try {
        if (existsSync(tmpPath)) unlinkSync(tmpPath)
      } catch {
        /* swallow */
      }
    }
  }

  /** Read all entries from the in-memory index */
  readAll(): SemanticMemoryEntry[] {
    this.ensureLoaded()
    return Array.from(this.entries.values())
  }

  /** Search by tags and/or keywords in content */
  search(options: {
    tags?: string[]
    keywords?: string[]
    limit?: number
  }): SemanticMemoryEntry[] {
    this.ensureLoaded()
    let results: SemanticMemoryEntry[]

    // Fast path: use tag index
    if (options.tags && options.tags.length > 0) {
      const candidateIds = new Set<string>()
      for (const tag of options.tags) {
        const ids = this.tagIndex[tag]
        if (ids) {
          for (const id of ids) candidateIds.add(id)
        }
      }
      results = Array.from(candidateIds)
        .map((id) => this.entries.get(id))
        .filter((e): e is SemanticMemoryEntry => e !== undefined)
    } else {
      results = Array.from(this.entries.values())
    }

    // Keyword filter (still needs full scan)
    if (options.keywords && options.keywords.length > 0) {
      const lowerKeywords = options.keywords.map((k) => k.toLowerCase())
      results = results.filter((e) =>
        lowerKeywords.some((kw) => e.content.toLowerCase().includes(kw)),
      )
    }

    // Sort by confidence descending, then by timestamp descending
    results.sort((a, b) => {
      if (b.confidence !== a.confidence) return b.confidence - a.confidence
      return b.timestamp.localeCompare(a.timestamp)
    })

    const limit = options.limit ?? 20
    return results.slice(0, limit)
  }
}
