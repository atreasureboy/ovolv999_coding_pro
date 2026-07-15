/**
 * File History — undo / checkpoint system for file edits
 *
 * Inspired by Claude Code's utils/fileHistory.ts (1115 lines).
 * Simplified to the core: back up files before modification, track
 * versions, support restore-to-original.
 *
 * How it works:
 *   1. Before Write/Edit modifies a file, trackEdit(filePath) backs up
 *      the current content to sessionDir/file-history/<hash>/v<timestamp>
 *      and writes a sidecar file `<backup>.meta.json` recording the
 *      ORIGINAL absolute path of the file (the path the user code wrote
 *      out, not the hash-derived bucket name).
 *   2. getEditedFiles() lists all modified files
 *   3. restoreOriginal(filePath) reverts a file to its pre-first-edit state
 *   4. getVersions(filePath) lists all backup versions with timestamps
 *
 * This gives the engine an "undo" capability — if the LLM makes bad edits,
 * the user can rewind to a known-good state.
 *
 * The on-disk hash directory is purely a bucket — it is NEVER to be
 * confused with the file path. The hash distributes two unrelated files
 * that happen to share a prefix across distinct buckets, and the
 * ORIGINAL absolute path is recovered from the per-backup sidecar (or
 * the persistent index when present). Treating the hash as a path would
 * silently rewrite unrelated files on restore.
 *
 * Bounded retention: a single file with thousands of edits would otherwise
 * produce thousands of full-content copies on disk — unbounded disk
 * pressure on long sessions. {@link MAX_VERSIONS_PER_FILE} caps the
 * versions kept per file; oldest copies are unlinked from disk and
 * removed from the in-memory index when the cap is exceeded.
 */

import { existsSync, readFileSync, mkdirSync, statSync, copyFileSync, chmodSync, closeSync, fsyncSync, openSync, renameSync, unlinkSync, writeSync, readdirSync } from 'fs'
import { join, resolve } from 'path'
import { createHash, randomBytes } from 'crypto'

// ── Types ───────────────────────────────────────────────────────────────────

export interface FileVersion {
  version: number
  timestamp: number
  /** Size in bytes of the backup */
  size: number
  /** The backup file path on disk */
  backupPath: string
}

export interface EditedFileInfo {
  path: string
  versions: number
  originalSize: number | null
  currentSize: number | null
  lastModified: number | null
}

/**
 * Sidecar content written alongside every backup. Records the
 * ORIGINAL absolute file path that produced the backup — i.e. the path
 * the caller passed to `trackEdit`, resolved to an absolute form before
 * the SHA-256 hashing step. Without this sidecar, a rebuild from the
 * backup tree would see only the bucket hash and would have to guess
 * (or fabricate) the original path. The hash is a BUCKET, never a
 * path — confusing the two would restore the wrong file on undo.
 *
 * Persisted to `<backupPath>.meta.json` so each backup carries its own
 * truth. If the file is missing or unparseable on rebuild, the backup
 * is dropped (not guessed).
 */
export interface BackupSidecar {
  /** Original absolute path of the file at the moment of trackEdit. */
  originalPath: string
}

// ── Constants ───────────────────────────────────────────────────────────────

/**
 * Maximum number of backup versions retained per tracked file.
 *
 * When trackEdit() pushes a new version and the count exceeds this cap,
 * the OLDEST backup is unlinked from disk and removed from the
 * in-memory version index. Subsequent restores can no longer reach the
 * evicted version — the oldest still-recoverable version becomes the
 * new "original" (i.e. restoreOriginal() returns it).
 *
 * 50 was chosen so a typical coding session (~tens of edits per file)
 * stays well under the cap, while a runaway edit loop on a large file
 * can never blow up disk usage.
 */
export const MAX_VERSIONS_PER_FILE = 50

/** Length of the per-file hash used as the on-disk directory name. */
const HISTORY_DIR_HASH_LEN = 32

/**
 * Persistent index filename — sits in `<historyDir>/index.json` so a fresh
 * FileHistory instance on the same sessionDir can rebuild the in-memory
 * map of `filePath → backupPath[]` without re-scanning the backup tree.
 *
 * Why a separate file rather than a sidecar alongside every backup?
 *   - One read on construction, one write per mutation — cheap.
 *   - The backup tree may grow with usage; scanning it on every process
 *     restart is unnecessary when we already know which files we were
 *     tracking.
 *   - The index is best-effort: if it's missing or unreadable, we rebuild
 *     from the backup tree + per-backup sidecars (see
 *     {@link FileHistory.constructor}).
 */
const INDEX_FILENAME = 'index.json'

/** Suffix on a backup that marks its per-backup sidecar. */
const SIDECAR_SUFFIX = '.meta.json'

/**
 * Resolve a backup filename to its sidecar path. Centralized so the
 * trackEdit write path and the rebuild read path agree on the same
 * suffix convention; if this constant ever changes, both move together.
 */
function sidecarFor(backupPath: string): string {
  return `${backupPath}${SIDECAR_SUFFIX}`
}

// ── FileHistory ─────────────────────────────────────────────────────────────

export class FileHistory {
  private historyDir: string
  private indexPath: string
  /** filePath → array of backup paths (chronological, [0] = original) */
  private edits = new Map<string, string[]>()
  private versionCounter = 0

  constructor(sessionDir: string) {
    this.historyDir = join(sessionDir, 'file-history')
    this.indexPath = join(this.historyDir, INDEX_FILENAME)
    try {
      mkdirSync(this.historyDir, { recursive: true })
    } catch {
      /* best-effort */
    }
    // Load the persistent index if present, otherwise rebuild it from
    // whatever backup tree exists on disk. Order matters: try the index
    // first (cheap, exact), fall back to a rebuild (more I/O, but still
    // O(N) over the existing tree).
    if (!this.loadIndexFromDisk()) {
      this.rebuildIndexFromTree()
    }
    // Sync versionCounter past any counters we already saw so new backup
    // filenames can't collide with an old one in the same directory.
    this.syncVersionCounter()
  }

  /**
   * Atomically persist the in-memory edit map to `<historyDir>/index.json`.
   *
   * Uses the same fd+fsync+rename convention as the rest of this codebase
   * (see sessionManager.saveSession, semanticMemory.persistAll) so the
   * index survives a crash mid-write without losing the entire history.
   *
   * Failure is swallowed: a missing index is recoverable by rebuildIndex
   * on the next construction, so we'd rather keep the in-memory state
   * intact than throw out of trackEdit/getEditedFiles.
   */
  private saveIndexToDisk(): void {
    const entries: Record<string, string[]> = {}
    for (const [filePath, versions] of this.edits) {
      // Defensive copy — never expose the live array reference.
      entries[filePath] = versions.slice()
    }
    const payload = Buffer.from(JSON.stringify({ version: 1, entries }), 'utf8')
    const tmpPath = `${this.indexPath}.tmp.${process.pid}.${Date.now()}.${randomBytes(8).toString('hex')}`
    let tmpFd: number | null = null
    try {
      tmpFd = openSync(tmpPath, 'w')
      writeSync(tmpFd, payload, 0, payload.length, 0)
      fsyncSync(tmpFd)
      closeSync(tmpFd)
      tmpFd = null
      renameSync(tmpPath, this.indexPath)
    } catch {
      if (tmpFd !== null) {
        try { closeSync(tmpFd) } catch { /* swallow */ }
      }
      try { if (existsSync(tmpPath)) unlinkSync(tmpPath) } catch { /* swallow */ }
      /* swallow — in-memory state is the source of truth */
    }
  }

  /**
   * Load `<historyDir>/index.json` into `this.edits`. Returns true iff the
   * index existed and was parseable. Bad-shape JSON or wrong entry types
   * are treated as a missing index (caller falls back to a rebuild) — we
   * never crash the constructor over a corrupt sidecar.
   */
  private loadIndexFromDisk(): boolean {
    if (!existsSync(this.indexPath)) return false
    let raw: string
    try {
      raw = readFileSync(this.indexPath, 'utf8')
    } catch {
      return false
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch {
      return false
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return false
    const entries = (parsed as Record<string, unknown>).entries
    if (!entries || typeof entries !== 'object' || Array.isArray(entries)) return false
    this.edits.clear()
    for (const [filePath, backups] of Object.entries(entries as Record<string, unknown>)) {
      if (typeof filePath !== 'string' || filePath.length === 0) continue
      if (!Array.isArray(backups)) continue
      const valid: string[] = []
      for (const b of backups) {
        if (typeof b === 'string' && b.length > 0) valid.push(b)
      }
      if (valid.length > 0) this.edits.set(filePath, valid)
    }
    return true
  }

  /**
   * Rebuild the in-memory index by scanning `<historyDir>/<hash>/v<ts>_<n>`
   * backup directories. Used as a fallback when the index file is missing
   * or unreadable (e.g. a session pre-dating the index feature, or a
   * corrupt sidecar after a crash).
   *
   * Each subdirectory under `<historyDir>/` is treated as a hash bucket;
   * the files inside are sorted by their filename (`v<timestamp>_<n>`)
   * which preserves the chronological insertion order produced by
   * trackEdit. For every backup we read its per-backup sidecar
   * (`<backup>.meta.json`) to recover the ORIGINAL absolute file path —
   * the hash directory name is a BUCKET, never a path. A backup with no
   * parseable sidecar is dropped from the rebuilt index rather than
   * being keyed on the hash, because keying it on the hash would mean
   * treating the hash as a path (forbidden) AND would mix unrelated
   * files that happen to share a bucket.
   *
   * After a clean restart that DOES have an index file, loadIndexFromDisk
   * returns true first and we never reach this path.
   */
  private rebuildIndexFromTree(): void {
    let bucketDirs: string[]
    try {
      bucketDirs = readdirSync(this.historyDir)
    } catch {
      return
    }
    for (const bucket of bucketDirs) {
      if (bucket === INDEX_FILENAME) continue
      if (bucket.endsWith('.tmp')) continue // never resurrect a half-written tmp
      const bucketDir = join(this.historyDir, bucket)
      let bucketStat
      try {
        bucketStat = statSync(bucketDir)
      } catch {
        continue
      }
      if (!bucketStat.isDirectory()) continue
      let backups: string[]
      try {
        backups = readdirSync(bucketDir)
      } catch {
        continue
      }
      // Filter to v<ts>_<n> files (skip partial / unrelated files and
      // skip sidecars — they're keyed off the backup filename) and
      // sort lexicographically. The format `v<timestamp>_<counter>`
      // sorts by timestamp first — same chronological order trackEdit
      // uses — so the first element is the original.
      const validBackups = backups
        .filter((n) => /^v\d+_/.test(n) && !n.endsWith(SIDECAR_SUFFIX))
        .sort()
      if (validBackups.length === 0) continue

      for (const name of validBackups) {
        const backupPath = join(bucketDir, name)
        const originalPath = this.readSidecarOriginalPath(backupPath)
        if (originalPath === null) {
          // No trustworthy sidecar — refuse to associate this backup
          // with the hash (which is not a path). Drop it; user loses
          // this version's restore capability, but they NEVER get a
          // wrong-file restore on the back of a guess.
          continue
        }
        const versions = this.edits.get(originalPath) ?? []
        versions.push(backupPath)
        this.edits.set(originalPath, versions)
      }
    }
  }

  /**
   * Read the per-backup sidecar and return the recorded original path,
   * or `null` if the sidecar is missing or unparseable. Centralized so
   * trackEdit (write path) and rebuildIndexFromTree (read path) agree
   * on what counts as a valid sidecar.
   *
   * Validation is deliberately strict: the path must be a non-empty
   * string. We do NOT verify that the path still resolves to a real
   * file — files legitimately disappear during a session, and the
   * history is the record of what WAS there, not what IS there now.
   */
  private readSidecarOriginalPath(backupPath: string): string | null {
    const sidecarPath = sidecarFor(backupPath)
    if (!existsSync(sidecarPath)) return null
    let raw: string
    try {
      raw = readFileSync(sidecarPath, 'utf8')
    } catch {
      return null
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch {
      return null
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
    const candidate = (parsed as Record<string, unknown>).originalPath
    if (typeof candidate !== 'string' || candidate.length === 0) return null
    return candidate
  }

  /**
   * Atomically write the per-backup sidecar `<backupPath>.meta.json`.
   *
   * The sidecar records the ORIGINAL absolute path of the file. This
   * is the load-bearing record that lets a future rebuild (after the
   * primary index is lost or corrupt) recover the original path from
   * the backup tree alone — without it the rebuild would see only the
   * SHA-256 bucket name and have to guess.
   *
   * Uses the same fd + writeSync + fsyncSync + closeSync + renameSync
   * convention as the index write so a crash mid-write never leaves a
   * torn JSON object on disk that could be read back as garbage.
   * Best-effort: failures are swallowed because the primary index also
   * records the path, so a missing sidecar only matters in the rebuild
   * path. We'd rather skip a backup's metadata than block the edit.
   */
  private writeSidecarToDisk(backupPath: string, originalPath: string): void {
    const sidecarPath = sidecarFor(backupPath)
    const payload = Buffer.from(
      JSON.stringify({ originalPath }),
      'utf8',
    )
    // Same-directory tmp so the rename is atomic on POSIX. The suffix
    // combines pid + ms + 8 random bytes — collision-free under any
    // realistic concurrency.
    const tmpPath = `${sidecarPath}.tmp.${process.pid}.${Date.now()}.${randomBytes(8).toString('hex')}`
    let tmpFd: number | null = null
    try {
      tmpFd = openSync(tmpPath, 'w')
      writeSync(tmpFd, payload, 0, payload.length, 0)
      fsyncSync(tmpFd)
      closeSync(tmpFd)
      tmpFd = null
      renameSync(tmpPath, sidecarPath)
    } catch {
      if (tmpFd !== null) {
        try { closeSync(tmpFd) } catch { /* swallow */ }
      }
      try {
        if (existsSync(tmpPath)) unlinkSync(tmpPath)
      } catch {
        /* swallow */
      }
      /* swallow — primary index is still authoritative for the in-memory
         state, and a missing sidecar only degrades the rebuild path */
    }
  }

  /**
   * Walk the index and bump `versionCounter` past any trailing `<n>` we
   * see in existing backup filenames. This prevents trackEdit from
   * reusing a name (and thus overwriting an existing backup) when the
   * session is resumed across processes.
   */
  private syncVersionCounter(): void {
    let max = -1
    for (const backups of this.edits.values()) {
      for (const p of backups) {
        const m = /_(\d+)$/.exec(p)
        if (m) {
          const n = Number(m[1])
          if (Number.isFinite(n) && n > max) max = n
        }
      }
    }
    if (max >= this.versionCounter) this.versionCounter = max + 1
  }

  /**
   * Back up a file BEFORE it's modified. Call from Write/Edit tools.
   * If the file doesn't exist yet (new file), this is a no-op.
   *
   * For each new backup we write TWO on-disk artefacts:
   *   1. The backup content at `<hashDir>/v<ts>_<n>`.
   *   2. A sidecar `<backupPath>.meta.json` recording the ORIGINAL
   *      absolute path of the file. The hash directory is a BUCKET
   *      for collision-safe distribution — it is NEVER to be confused
   *      with the file path. The sidecar is the load-bearing record
   *      that lets a future rebuild recover the original path from the
   *      backup tree alone, even when the primary index is gone.
   *
   * On eviction (cap exceeded) we unlink BOTH the backup AND its
   * sidecar so disk state stays consistent with the in-memory map.
   */
  trackEdit(filePath: string): void {
    const absPath = resolve(filePath)
    if (!existsSync(absPath)) return // new file — nothing to back up

    try {
      // Use copyFile (not read+write) to avoid loading the entire file into
      // the JS heap — prevents OOM on large tracked files (e.g. minified JS,
      // data files). Preserves file permissions via chmod sync.
      //
      // SHA-256 (instead of MD5) so a backup directory name has a much
      // wider collision space. The directory is keyed on the absolute
      // file path, so a collision would mix two unrelated files'
      // backups under the same directory — recovered via
      // restoreOriginal on the wrong file would return garbage.
      // 32 hex chars of SHA-256 is enough for any realistic session.
      const hash = createHash('sha256').update(absPath).digest('hex').slice(0, HISTORY_DIR_HASH_LEN)
      const dir = join(this.historyDir, hash)
      mkdirSync(dir, { recursive: true })

      const timestamp = Date.now()
      const backupPath = join(dir, `v${timestamp}_${this.versionCounter++}`)
      copyFileSync(absPath, backupPath) // atomic file-level copy, no heap pressure

      // Preserve file permissions on the backup
      try {
        const stat = statSync(absPath)
        chmodSync(backupPath, stat.mode)
      } catch { /* best-effort */ }

      // Record the ORIGINAL absolute path in a per-backup sidecar. This
      // is what makes a future rebuild (when the index is gone) able to
      // tell WHICH file a backup belonged to. Without this sidecar the
      // rebuild would see only the hash bucket and have to either
      // refuse the backup or — worse — treat the hash as a path.
      this.writeSidecarToDisk(backupPath, absPath)

      const versions = this.edits.get(absPath) ?? []
      versions.push(backupPath)

      // Bound retention: when the cap is exceeded, evict the OLDEST
      // backup from disk and from the in-memory index. Eviction runs
      // in a loop (not a single step) so trackEdit remains correct even
      // if the cap ever shrinks across versions. BOTH the backup and
      // its sidecar are unlinked so disk state stays consistent with
      // the in-memory map.
      while (versions.length > MAX_VERSIONS_PER_FILE) {
        const evicted = versions.shift()
        if (evicted !== undefined) {
          try {
            unlinkSync(evicted)
          } catch {
            /* best-effort — missing backups are already surfaced as
               null stats in getVersions() */
          }
          try {
            const sidecarPath = sidecarFor(evicted)
            if (existsSync(sidecarPath)) unlinkSync(sidecarPath)
          } catch {
            /* best-effort — a missing sidecar only degrades the rebuild
               path; the primary index still records the path */
          }
        }
      }

      this.edits.set(absPath, versions)
      // Persist the updated edit map so a fresh FileHistory instance on
      // the same sessionDir sees this edit without re-scanning the tree.
      this.saveIndexToDisk()
    } catch {
      /* best-effort — never block the edit */
    }
  }

  /** List all files that have been edited (tracked). */
  getEditedFiles(): EditedFileInfo[] {
    const result: EditedFileInfo[] = []
    for (const [filePath, versions] of this.edits) {
      let originalSize: number | null = null
      let currentSize: number | null = null
      let lastModified: number | null = null

      try {
        originalSize = statSync(versions[0]).size
      } catch { /* backup deleted */ }
      try {
        const stat = statSync(filePath)
        currentSize = stat.size
        lastModified = stat.mtimeMs
      } catch { /* file deleted */ }

      result.push({
        path: filePath,
        versions: versions.length,
        originalSize,
        currentSize,
        lastModified,
      })
    }
    return result.sort((a, b) => a.path.localeCompare(b.path))
  }

  /** Get all backup versions for a file. Version 0 = oldest still-tracked. */
  getVersions(filePath: string): FileVersion[] {
    const absPath = resolve(filePath)
    const versions = this.edits.get(absPath) ?? []
    return versions.map((backupPath, i) => {
      let size = 0
      let timestamp = 0
      try {
        const stat = statSync(backupPath)
        size = stat.size
        timestamp = stat.mtimeMs
      } catch { /* backup deleted */ }
      return { version: i, timestamp, size, backupPath }
    })
  }

  /** Restore a file to its oldest still-tracked version. */
  restoreOriginal(filePath: string): boolean {
    return this.restoreVersion(filePath, 0)
  }

  /**
   * Restore a file to its Nth backup version. Returns false if not found.
   *
   * Atomic write: writes the backup to a uniquely-suffixed tmp file IN
   * THE SAME DIRECTORY as the live target, fsyncs it, then renames it
   * over the live file. This means a crash mid-restore can never leave
   * a half-written file at the live path — readers always see EITHER
   * the previous content OR the fully-restored content, never a torn
   * mix. The tmp suffix (pid + ms + 8 random bytes) prevents two
   * concurrent restores from clobbering each other.
   *
   * Mode rewind (rewind semantics): we capture the BACKUP's mode (the
   * mode the live file had at the moment of trackEdit, since trackEdit
   * already chmod'd the backup to match) and re-apply it to the tmp
   * just before the rename. This makes restoreVersion a true rewind:
   * BOTH content AND mode revert to the snapshot — restoring a 0755
   * executable script after the user accidentally chmod'd it to 0644
   * brings the executable bit back. Reading the BACKUP's mode (rather
   * than the live file's current mode) is the right invariant because
   * the backup is the authoritative "what the file was" record.
   *
   * Failure modes (all return false, never throw):
   *   - readFileSync of the backup fails → live file untouched.
   *   - write/fsync/close of the tmp fails → tmp unlinked in `finally`,
   *     live file untouched.
   *   - rename fails → tmp unlinked in `finally`, live file untouched.
   *   - On success, any leftover tmp from a previous failed attempt
   *     is replaced by the rename (the unlink in `finally` is a no-op
   *     on a missing path).
   */
  restoreVersion(filePath: string, version: number): boolean {
    const absPath = resolve(filePath)
    const versions = this.edits.get(absPath)
    if (!versions || version < 0 || version >= versions.length) return false

    const backupPath = versions[version]
    let content: Buffer
    try {
      content = readFileSync(backupPath)
    } catch {
      return false
    }

    // Capture the backup's mode. trackEdit already chmod'd the backup
    // to match the live file's mode at backup time, so this is exactly
    // the mode the live file SHOULD have after a rewind. If statSync
    // fails (defensive — should not happen since we just read the
    // same path), we fall through and let the umask default apply.
    let backupMode: number | undefined
    try {
      backupMode = statSync(backupPath).mode
    } catch {
      /* best-effort — see comment above */
    }

    // Unique tmp in the SAME directory as the target so the rename is
    // atomic on POSIX (cross-directory rename isn't). Suffix combines
    // pid + Date.now() ms + 8 random bytes hex — collision-free under
    // any realistic concurrency.
    const tmpPath = `${absPath}.restore.tmp.${process.pid}.${Date.now()}.${randomBytes(8).toString('hex')}`
    let tmpFd: number | null = null
    try {
      tmpFd = openSync(tmpPath, 'w')
      writeSync(tmpFd, content, 0, content.length, 0)
      fsyncSync(tmpFd)
      closeSync(tmpFd)
      tmpFd = null
      // chmod BEFORE the rename so the renamed file already has the
      // rewound mode the moment it appears at the live path. chmodSync
      // is sync on purpose — the gap between closeSync and chmod is
      // already serial on this process; making it async would just
      // add a microtask boundary.
      if (backupMode !== undefined) {
        chmodSync(tmpPath, backupMode)
      }
      renameSync(tmpPath, absPath)
      return true
    } catch {
      return false
    } finally {
      // Best-effort cleanup: close a half-open fd and unlink the tmp
      // on any failure path so we don't leak either onto disk.
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

  /** Get a diff-style summary: "3 files edited, 12 versions tracked" */
  getSummary(): string {
    const files = this.getEditedFiles()
    if (files.length === 0) return 'No file edits tracked.'
    const totalVersions = files.reduce((sum, f) => sum + f.versions, 0)
    const lines = files.map((f) => {
      const sizeInfo =
        f.originalSize !== null && f.currentSize !== null
          ? `${f.originalSize}→${f.currentSize} bytes`
          : f.currentSize !== null
            ? `${f.currentSize} bytes`
            : '(deleted)'
      return `  ${f.path} — ${f.versions} version(s), ${sizeInfo}`
    })
    return `${files.length} file(s) edited, ${totalVersions} version(s) tracked:\n${lines.join('\n')}`
  }

  /** Clear all history (for new sessions / tests). */
  clear(): void {
    this.edits.clear()
    // Drop the persistent index too — otherwise a "fresh" session
    // restored from disk would re-load the cleared entries on next
    // construction. Best-effort; an unlink failure leaves the index on
    // disk but the in-memory state is the source of truth for this
    // process.
    try {
      if (existsSync(this.indexPath)) unlinkSync(this.indexPath)
    } catch {
      /* swallow */
    }
    // Also unlink any leftover backup directories and sidecars so a
    // /clear really starts from a clean slate. We attempt this but do
    // not fail the call on errors — the in-memory state is the source
    // of truth for this process.
    try {
      const entries = readdirSync(this.historyDir)
      for (const name of entries) {
        const sub = join(this.historyDir, name)
        let st
        try {
          st = statSync(sub)
        } catch {
          continue
        }
        if (!st.isDirectory()) continue
        try {
          for (const f of readdirSync(sub)) {
            try { unlinkSync(join(sub, f)) } catch { /* swallow */ }
          }
          unlinkSync(sub)
        } catch {
          /* swallow */
        }
      }
    } catch {
      /* swallow */
    }
  }
}
