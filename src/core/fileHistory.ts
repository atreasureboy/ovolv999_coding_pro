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

import { existsSync, readFileSync, mkdirSync, statSync, copyFileSync, chmodSync, closeSync, fsyncSync, openSync, renameSync, unlinkSync, writeSync, writeFileSync, readdirSync } from 'fs'
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
  /**
   * True when the backup records "the file did NOT exist" (undo/redo of
   * creations and deletions). The backup file itself is an empty marker;
   * applying it removes the live file instead of writing content.
   */
  deleted?: boolean
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

/**
 * Persistent redo-stack index — `<historyDir>/redo-index.json`, same shape
 * as index.json (`{version: 1, entries: path → backupPath[]}`). Redo
 * entries live in the SAME hash buckets as version backups but use an
 * `r<ts>_<n>` filename prefix so rebuildIndexFromTree (which only matches
 * `v<ts>_<n>`) never mistakes them for edit versions. The redo stack is
 * best-effort across restarts: if this index is lost, /redo simply has
 * nothing to redo — version history is untouched.
 */
const REDO_INDEX_FILENAME = 'redo-index.json'

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
  private redoIndexPath: string
  /** filePath → array of backup paths (chronological, [0] = original) */
  private edits = new Map<string, string[]>()
  /**
   * Redo stacks per file (undo/redo pair semantics). An entry is popped by
   * redoEdit(); entries are pushed by undoEdit() capturing the live state
   * it is about to replace. Persisted to redo-index.json so /redo works
   * across process restarts; a new edit (trackEdit) invalidates the stack.
   */
  private redoEntries = new Map<string, string[]>()
  /**
   * Paths whose trackEdit ran while the file did NOT exist — i.e. files
   * CREATED by this session's Write tool. In-memory only: the checkpoint
   * anchors persist the cumulative created-set per turn, which is what a
   * cross-process rewind consults; this set serves the live session's
   * append path.
   */
  private createdThisSession = new Set<string>()
  private versionCounter = 0

  constructor(sessionDir: string) {
    this.historyDir = join(sessionDir, 'file-history')
    this.indexPath = join(this.historyDir, INDEX_FILENAME)
    this.redoIndexPath = join(this.historyDir, REDO_INDEX_FILENAME)
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
    this.loadRedoIndexFromDisk()
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
    return this.readSidecar(backupPath)?.originalPath ?? null
  }

  /**
   * Read the full per-backup sidecar (original path + optional deleted
   * marker). Returns null when the sidecar is missing or unparseable —
   * callers must drop the backup rather than guess.
   */
  private readSidecar(backupPath: string): BackupSidecar | null {
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
    const deleted = (parsed as Record<string, unknown>).deleted
    return {
      originalPath: candidate,
      ...(deleted === true ? { deleted: true } : {}),
    }
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
  private writeSidecarToDisk(backupPath: string, sidecar: BackupSidecar): void {
    const sidecarPath = sidecarFor(backupPath)
    const payload = Buffer.from(
      JSON.stringify(sidecar),
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
    const scan = (lists: Iterable<string[]>): void => {
      for (const backups of lists) {
        for (const p of backups) {
          const m = /_(\d+)$/.exec(p)
          if (m) {
            const n = Number(m[1])
            if (Number.isFinite(n) && n > max) max = n
          }
        }
      }
    }
    scan(this.edits.values())
    scan(this.redoEntries.values())
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
      this.writeSidecarToDisk(backupPath, { originalPath: absPath })

      const versions = this.edits.get(absPath) ?? []
      versions.push(backupPath)

      // A fresh edit invalidates the redo stack for this file — the
      // "undone futures" it captured no longer follow from the current
      // timeline. Drop the captured states from disk too so the bucket
      // doesn't accumulate dead redo backups.
      this.clearRedoStack(absPath)

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

  /** Paths created by this session (via {@link markCreated} after a
   *  successful Write). In-memory only — see {@link createdThisSession}
   *  for the persistence story. */
  getCreatedFiles(): string[] {
    return [...this.createdThisSession]
  }

  /**
   * Record that this session CREATED `filePath`. MUST be called only
   * AFTER the creating write succeeded — marking pre-write would let a
   * failed write + a user hand-created file at the same path be silently
   * deleted by /rewind (Round 30 audit finding D).
   */
  markCreated(filePath: string): void {
    this.createdThisSession.add(resolve(filePath))
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
    if (!backupPath) return false

    // Round 41 audit fix: the state being replaced is captured on the REDO
    // stack (the old code CLEARED redo, so the pre-rewind state was
    // unreachable forever). Versions themselves are NOT truncated —
    // /rewind <file> <n> is a version BROWSER (users restore 0 → 1 → 2 in
    // any order); after a rewind, /redo steps back to the pre-rewind state
    // instead of /undo jumping forward with no way back.
    this.clearRedoStack(absPath)
    const redoBackup = this.writeStateSnapshot(absPath, 'r')
    if (redoBackup === null) return false
    const stack = this.redoEntries.get(absPath) ?? []
    stack.push(redoBackup)
    this.redoEntries.set(absPath, stack)

    if (!this.applyBackup(absPath, backupPath)) {
      stack.pop()
      if (stack.length === 0) this.redoEntries.delete(absPath)
      this.unlinkBackupQuietly(redoBackup)
      this.saveRedoIndexToDisk()
      return false
    }
    this.saveRedoIndexToDisk()
    return true
  }

  /**
   * Apply a backup to the live path. Reads the backup's sidecar: a
   * `deleted: true` marker removes the live file (restoring "the file did
   * not exist"), otherwise content + mode are restored atomically.
   *
   * Atomic write: writes to a uniquely-suffixed tmp file IN THE SAME
   * DIRECTORY as the live target, fsyncs it, then renames it over the live
   * file. A crash mid-restore can never leave a half-written file at the
   * live path — readers always see EITHER the previous content OR the
   * fully-restored content, never a torn mix.
   *
   * Mode rewind semantics: we capture the BACKUP's mode (trackEdit
   * already chmod'd the backup to match the live file at backup time) and
   * re-apply it, so BOTH content AND mode revert to the snapshot.
   *
   * All failure modes return false and never throw; the live file is left
   * untouched whenever the restore cannot complete.
   */
  private applyBackup(absPath: string, backupPath: string): boolean {
    const sidecar = this.readSidecar(backupPath)
    if (sidecar?.deleted) {
      try {
        if (existsSync(absPath)) unlinkSync(absPath)
        return true
      } catch {
        return false
      }
    }

    let content: Buffer
    try {
      content = readFileSync(backupPath)
    } catch {
      return false
    }

    // Capture the backup's mode. If statSync fails (defensive — should not
    // happen since we just read the same path), the umask default applies.
    let backupMode: number | undefined
    try {
      backupMode = statSync(backupPath).mode
    } catch {
      /* best-effort — see comment above */
    }

    const tmpPath = `${absPath}.restore.tmp.${process.pid}.${Date.now()}.${randomBytes(8).toString('hex')}`
    let tmpFd: number | null = null
    try {
      tmpFd = openSync(tmpPath, 'w')
      writeSync(tmpFd, content, 0, content.length, 0)
      fsyncSync(tmpFd)
      closeSync(tmpFd)
      tmpFd = null
      // chmod BEFORE the rename so the renamed file already has the
      // rewound mode the moment it appears at the live path.
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

  // ── undo / redo stack ─────────────────────────────────────────────────────

  /**
   * Capture the current live state of `absPath` as a backup in the given
   * bucket directory with the given filename prefix ('v' for versions,
   * 'r' for redo entries). Records a `deleted: true` sidecar marker when
   * the file does not exist, so creation/deletion round-trips through
   * undo/redo as well. Returns the backup path, or null on failure
   * (the caller treats a failed snapshot as a failed undo/redo step —
   * we never restore without first securing the state being replaced).
   */
  private writeStateSnapshot(absPath: string, prefix: 'v' | 'r'): string | null {
    try {
      const hash = createHash('sha256').update(absPath).digest('hex').slice(0, HISTORY_DIR_HASH_LEN)
      const dir = join(this.historyDir, hash)
      mkdirSync(dir, { recursive: true })
      const backupPath = join(dir, `${prefix}${Date.now()}_${this.versionCounter++}`)

      if (existsSync(absPath)) {
        copyFileSync(absPath, backupPath)
        try {
          const stat = statSync(absPath)
          chmodSync(backupPath, stat.mode)
        } catch { /* best-effort */ }
        this.writeSidecarToDisk(backupPath, { originalPath: absPath })
      } else {
        // Deletion marker — empty file; the sidecar carries the truth.
        writeFileSync(backupPath, '')
        this.writeSidecarToDisk(backupPath, { originalPath: absPath, deleted: true })
      }
      return backupPath
    } catch {
      return null
    }
  }

  /**
   * Single-step undo: restore the live file to the MOST RECENT backup and
   * pop that backup from the version list, pushing the replaced live state
   * onto the redo stack. Unlike restoreOriginal (a full rewind to version
   * 0), this pairs with redoEdit() for symmetric undo/redo navigation.
   * Returns false when no versions are tracked or the snapshot fails.
   */
  undoEdit(filePath: string): boolean {
    const absPath = resolve(filePath)
    const versions = this.edits.get(absPath)
    if (!versions || versions.length === 0) return false
    const backupPath = versions[versions.length - 1]
    if (!backupPath) return false

    const redoBackup = this.writeStateSnapshot(absPath, 'r')
    if (redoBackup === null) return false
    const stack = this.redoEntries.get(absPath) ?? []
    stack.push(redoBackup)
    this.redoEntries.set(absPath, stack)

    if (!this.applyBackup(absPath, backupPath)) {
      // Roll back the redo entry — the live file is untouched, so the
      // captured "replaced state" never happened.
      stack.pop()
      if (stack.length === 0) this.redoEntries.delete(absPath)
      this.unlinkBackupQuietly(redoBackup)
      this.saveRedoIndexToDisk()
      return false
    }

    versions.pop()
    if (versions.length === 0) this.edits.delete(absPath)
    // Round 41 audit fix: a consumed version backup must leave the disk
    // tree too — otherwise a later index rebuild (the exact scenario
    // rebuildIndexFromTree exists for) resurrected it as an undead step
    // and /undo appeared to repeat the same state.
    this.unlinkBackupQuietly(backupPath)
    this.saveIndexToDisk()
    this.saveRedoIndexToDisk()
    return true
  }

  /**
   * Single-step redo: re-apply the most recently undone state. The current
   * live state is pushed onto the version list first, so a subsequent
   * undoEdit() returns to exactly where we are now — the two stacks stay
   * symmetric across any undo/redo interleaving, including file creation
   * and deletion. Returns false when the redo stack is empty.
   */
  redoEdit(filePath: string): boolean {
    const absPath = resolve(filePath)
    const stack = this.redoEntries.get(absPath)
    if (!stack || stack.length === 0) return false
    const redoBackup = stack[stack.length - 1]
    if (!redoBackup) return false
    const sidecar = this.readSidecar(redoBackup)
    if (!sidecar) return false

    // Secure the current live state as a version backup before applying
    // the redo — if this fails we abort rather than lose undo capability.
    const versionBackup = this.writeStateSnapshot(absPath, 'v')
    if (versionBackup === null) return false
    const versions = this.edits.get(absPath) ?? []
    versions.push(versionBackup)
    this.edits.set(absPath, versions)

    if (!this.applyBackup(absPath, redoBackup)) {
      versions.pop()
      if (versions.length === 0) this.edits.delete(absPath)
      this.unlinkBackupQuietly(versionBackup)
      this.saveIndexToDisk()
      return false
    }

    stack.pop()
    if (stack.length === 0) this.redoEntries.delete(absPath)
    this.unlinkBackupQuietly(redoBackup)
    this.saveIndexToDisk()
    this.saveRedoIndexToDisk()
    return true
  }

  /** Number of redo steps currently available for a file. */
  getRedoDepth(filePath: string): number {
    return this.redoEntries.get(resolve(filePath))?.length ?? 0
  }

  /** Drop the redo stack for a file (disk + memory) and persist. */
  private clearRedoStack(absPath: string): void {
    const stack = this.redoEntries.get(absPath)
    if (!stack || stack.length === 0) return
    for (const b of stack) this.unlinkBackupQuietly(b)
    this.redoEntries.delete(absPath)
    this.saveRedoIndexToDisk()
  }

  /** Unlink a backup and its sidecar; failures are swallowed. */
  private unlinkBackupQuietly(backupPath: string): void {
    try {
      if (existsSync(backupPath)) unlinkSync(backupPath)
    } catch { /* best-effort */ }
    try {
      const sidecar = sidecarFor(backupPath)
      if (existsSync(sidecar)) unlinkSync(sidecar)
    } catch { /* best-effort */ }
  }

  /**
   * Persist the redo stacks to `<historyDir>/redo-index.json`. Same
   * fd+fsync+rename convention as the version index. Failures are
   * swallowed: the in-memory stack stays authoritative for this process.
   */
  private saveRedoIndexToDisk(): void {
    const entries: Record<string, string[]> = {}
    for (const [filePath, stack] of this.redoEntries) {
      entries[filePath] = stack.slice()
    }
    const payload = Buffer.from(JSON.stringify({ version: 1, entries }), 'utf8')
    const tmpPath = `${this.redoIndexPath}.tmp.${process.pid}.${Date.now()}.${randomBytes(8).toString('hex')}`
    let tmpFd: number | null = null
    try {
      tmpFd = openSync(tmpPath, 'w')
      writeSync(tmpFd, payload, 0, payload.length, 0)
      fsyncSync(tmpFd)
      closeSync(tmpFd)
      tmpFd = null
      renameSync(tmpPath, this.redoIndexPath)
    } catch {
      if (tmpFd !== null) {
        try { closeSync(tmpFd) } catch { /* swallow */ }
      }
      try { if (existsSync(tmpPath)) unlinkSync(tmpPath) } catch { /* swallow */ }
    }
  }

  /**
   * Load redo-index.json. Missing/corrupt index → empty stacks (redo is
   * best-effort across restarts; version history is never affected).
   */
  private loadRedoIndexFromDisk(): void {
    if (!existsSync(this.redoIndexPath)) return
    let raw: string
    try {
      raw = readFileSync(this.redoIndexPath, 'utf8')
    } catch {
      return
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch {
      return
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return
    const entries = (parsed as Record<string, unknown>).entries
    if (!entries || typeof entries !== 'object' || Array.isArray(entries)) return
    for (const [filePath, stack] of Object.entries(entries as Record<string, unknown>)) {
      if (typeof filePath !== 'string' || filePath.length === 0) continue
      if (!Array.isArray(stack)) continue
      const valid = stack.filter((b): b is string => typeof b === 'string' && b.length > 0 && existsSync(b))
      if (valid.length > 0) this.redoEntries.set(filePath, valid)
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
    for (const stack of this.redoEntries.values()) {
      for (const b of stack) this.unlinkBackupQuietly(b)
    }
    this.redoEntries.clear()
    try {
      if (existsSync(this.redoIndexPath)) unlinkSync(this.redoIndexPath)
    } catch {
      /* swallow */
    }
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
