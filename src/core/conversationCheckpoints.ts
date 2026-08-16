/**
 * ConversationCheckpoints — per-turn rewind anchors.
 *
 * Round 28: conversation + file rewind anchors.
 * Round 30: created-file semantics, future-branch truncation, tail reads.
 * Round 31 (v2): CONTENT-SNAPSHOT identity — the anchor now stores, for
 * every session-tracked file, an exact copy of its live content at turn
 * end (`cp-snapshots/`) plus a sha256 identity. This closes three holes
 * the previous count-based scheme could not:
 *
 *   1. Version-cap silent skip (P1): FileHistory evicts at 50 versions
 *      per file, so `getVersions().length` saturates — "count unchanged"
 *      stopped meaning "content unchanged". Content hash cannot saturate.
 *   2. Untracked mutations (P1/P2): `rm x`, `sed -i`, formatters, script
 *      side-effects mutate files outside Write/Edit; the snapshot catches
 *      drift for every file the session tracks (edited OR created).
 *   3. rm-after-anchor revival: previous claim "edited-then-rm can be
 *      restored" was over-optimistic — the live content (never backed
 *      up) was lost. The snapshot IS the live content at anchor time.
 *
 * Deletion safety (P2): every destructive action (unlink, restore-into)
 * is boundary-checked against the anchor's project root (canonical
 * parent-path must sit inside anchor.cwd; a corrupt/tampered JSONL can
 * never reach outside the workspace). Compaction is byte-targeted (P2),
 * not a fixed anchor count. Legacy numeric anchors restore best-effort
 * via the old count algorithm.
 *
 * Storage: <sessionDir>/checkpoints.jsonl + <sessionDir>/cp-snapshots/.
 */

import { existsSync, readFileSync, appendFileSync, writeFileSync, renameSync, unlinkSync, statSync, openSync, readSync, closeSync, mkdirSync, copyFileSync, chmodSync, readdirSync, realpathSync, rmdirSync } from 'fs'
import { join, dirname, resolve as resolvePath } from 'path'
import { createHash, randomBytes } from 'crypto'
import type { FileHistory } from './fileHistory.js'
import type { OpenAIMessage } from './types.js'

/**
 * v2 per-file anchor entry. Legacy anchors store a plain number (version
 * count at turn end) — see {@link parseFileEntry}.
 */
export interface CheckpointFileEntry {
  /** backup path of the newest FileHistory version at anchor ('' = none) */
  tip: string
  /** snapshot file name inside cp-snapshots/ (live content at anchor) */
  snap?: string
  /** sha256 hex of the snapshot content — the stable identity */
  h?: string
  /** live stat at anchor [mtimeMs, size] — snapshot reuse fast path */
  st?: [number, number]
  /** live file mode at anchor (restore preserves permissions) */
  md?: number
  /** live file was ABSENT at anchor (rewind deletes a recreation) */
  absent?: boolean
  /** too big to snapshot — rewind degrades to tip-based restore */
  big?: boolean
}

export interface ConversationCheckpoint {
  turn: number
  /** Number of messages in the conversation at end of this turn. */
  historyLength: number
  /** absPath → v2 entry (legacy anchors: absPath → version-count number) */
  files: Record<string, CheckpointFileEntry | number>
  /** absPaths created by the session, cumulative through this turn. */
  createdFiles?: string[]
  /** Project root at anchor time — boundary for all destructive ops. */
  cwd?: string
  /** ISO timestamp for display. */
  at: string
  /** First 80 chars of the user prompt that started this turn. */
  prompt: string
}

const FILENAME = 'checkpoints.jsonl'
const SNAP_DIR = 'cp-snapshots'
/** Files above this size are not snapshotted (tip-based fallback). */
const MAX_SNAPSHOT_BYTES = 8 * 1024 * 1024
/** Compaction: keep newest anchors totalling ≤ this serialized size. */
const COMPACTION_TARGET_BYTES = 150 * 1024
/** Hard cap on anchor count regardless of bytes. */
const MAX_ANCHORS_HARD = 500

function checkpointsPath(sessionDir: string): string {
  return join(sessionDir, FILENAME)
}

function snapshotsDir(sessionDir: string): string {
  return join(sessionDir, SNAP_DIR)
}

type FileEntry = CheckpointFileEntry | number

function isV2Entry(e: FileEntry | undefined): e is CheckpointFileEntry {
  return typeof e === 'object' && e !== null
}

export function listCheckpoints(sessionDir: string): ConversationCheckpoint[] {
  const p = checkpointsPath(sessionDir)
  if (!existsSync(p)) return []
  const out: ConversationCheckpoint[] = []
  for (const line of readFileSync(p, 'utf8').split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    try {
      const parsed = JSON.parse(trimmed) as ConversationCheckpoint
      if (typeof parsed.turn === 'number' && typeof parsed.historyLength === 'number' && parsed.files && typeof parsed.files === 'object') {
        out.push(parsed)
      }
    } catch { /* torn/corrupt line — skip */ }
  }
  return out
}

/**
 * Read ONLY the last anchor (tail read — the append path must stay O(1)
 * I/O, not a full-file parse every turn). Returns null when none exist.
 */
function readLastCheckpoint(sessionDir: string): ConversationCheckpoint | null {
  const p = checkpointsPath(sessionDir)
  let fd: number | null = null
  try {
    const size = statSync(p).size
    if (size === 0) return null
    const readLen = Math.min(size, 8192)
    const buf = Buffer.alloc(readLen)
    fd = openSync(p, 'r')
    readSync(fd, buf, 0, readLen, size - readLen)
    const text = buf.toString('utf8')
    // The first line in the window may be torn — drop everything before
    // the first newline, then take the last complete anchor.
    const lines = text.split('\n').filter((l) => l.trim().length > 0)
    for (let i = lines.length - 1; i >= 0; i--) {
      try {
        const parsed = JSON.parse(lines[i]) as ConversationCheckpoint
        // Same anchor shape listCheckpoints validates — a parseable-but-
        // partial fragment must not inflate the numbering.
        if (
          typeof parsed.turn === 'number' &&
          typeof parsed.historyLength === 'number' &&
          parsed.files && typeof parsed.files === 'object'
        ) {
          return parsed
        }
      } catch { /* keep walking back */ }
    }
    // Window too small to find a complete line (one anchor > 8KB):
    // fall back to the full parse.
    const all = listCheckpoints(sessionDir)
    return all.length > 0 ? all[all.length - 1] : null
  } catch {
    return null
  } finally {
    if (fd !== null) {
      try { closeSync(fd) } catch { /* best-effort */ }
    }
  }
}

/** Normalize separators for cross-platform prefix comparison. Windows-
 *  style inputs (detected by drive-letter or backslash) normalize even
 *  when the HOST is POSIX — anchors may carry Windows paths on a POSIX
 *  machine (session synced across OSes) and vice versa. */
function toPosix(p: string): string {
  return p.replaceAll('\\', '/')
}

/** True when `path` sits inside `root`. Resolves the existing parent
 *  chain through realpathSync (a symlinked subdirectory cannot smuggle
 *  a destructive op outside the workspace), falling back to lexical
 *  resolution for not-yet-existing parents. Windows-safe: separator
 *  normalization + case-insensitive compare for drive-letter paths. */
export function isInsideWorkspace(path: string, root: string | undefined): boolean {
  if (!root) return true // legacy anchor without cwd — caller decides policy
  // Normalize the INPUT first — POSIX dirname/resolve on a Windows path
  // ('C:\proj\f.ts') collapses to '.'/<cwd> before we ever normalize.
  const pathN = toPosix(path)
  const rootN = toPosix(root)
  const canonical = (p: string): string => {
    // Windows-style (drive-letter) paths on a POSIX host: realpath/
    // resolve would cwd-prefix them into garbage — normalize lexically.
    if (/^[a-zA-Z]:\//.test(p)) return p
    try {
      return toPosix(realpathSync(p))
    } catch {
      return toPosix(resolvePath(p))
    }
  }
  const parent = canonical(dirname(pathN))
  const rootCanonical = canonical(rootN)
  // Case-insensitive compare when either side looks like a Windows
  // drive path (C:/...) — NTFS is case-insensitive; POSIX stays exact.
  const windowsish = /^[a-zA-Z]:\//.test(rootCanonical) || /^[a-zA-Z]:\//.test(parent)
  const pNorm = windowsish ? parent.toLowerCase() : parent
  const rNorm = windowsish ? rootCanonical.toLowerCase() : rootCanonical
  if (pNorm === rNorm) return true
  return pNorm.startsWith(rNorm + '/')
}

function sha256File(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

/**
 * Append the end-of-turn checkpoint. Best-effort — checkpointing must
 * never break the turn loop.
 */
export function appendCheckpoint(
  sessionDir: string,
  history: OpenAIMessage[],
  fileHistory: FileHistory | null,
  prompt: string,
  cwd?: string,
): void {
  try {
    const last = readLastCheckpoint(sessionDir)
    const lastEntries = last && typeof last.files === 'object' ? last.files : {}

    // TWO sets with different jobs (Round 31 audit F1 — conflating them
    // made rewind DELETE pre-existing files that were merely EDITED):
    //   trackedSet — everything the session touched (edited ∪ created ∪
    //     last anchor's created) → drives the SNAPSHOT loop.
    //   createdSet — files the session CREATED (live in-memory set ∪ last
    //     anchor's set, resume-safe) → drives the DELETION semantics.
    //     Edited-but-pre-existing files must never appear here.
    const createdSet = new Set<string>(last?.createdFiles ?? [])
    const files: Record<string, FileEntry> = {}

    if (fileHistory) {
      const trackedSet = new Set<string>(createdSet)
      for (const f of fileHistory.getEditedFiles()) trackedSet.add(f.path)
      for (const p of fileHistory.getCreatedFiles()) createdSet.add(p)
      for (const p of createdSet) trackedSet.add(p)

      const snapDir = snapshotsDir(sessionDir)
      let snapDirReady = false
      const ensureSnapDir = (): boolean => {
        if (!snapDirReady) {
          try { mkdirSync(snapDir, { recursive: true }) } catch { return false }
          snapDirReady = true
        }
        return true
      }

      for (const path of trackedSet) {
        const versions = fileHistory.getVersions(path)
        const tip = versions[versions.length - 1]?.backupPath ?? ''
        let stat: { mtimeMs: number; size: number; mode: number } | null = null
        try {
          const s = statSync(path)
          stat = { mtimeMs: s.mtimeMs, size: s.size, mode: s.mode }
        } catch {
          stat = null
        }

        if (!stat) {
          files[path] = { tip, absent: true }
          continue
        }
        if (stat.size > MAX_SNAPSHOT_BYTES) {
          files[path] = { tip, big: true, st: [stat.mtimeMs, stat.size] }
          continue
        }

        // Snapshot reuse — CONTENT-ADDRESSSED + verified (Round 32):
        // the previous anchor's identity is reused only when the LIVE
        // content hashes to the same digest. mtime+size alone had a
        // stale window (two same-size writes with identical coarse
        // mtimes on HFS+/FAT/network FS); hashing kills it. When the
        // hash differs we still avoid a second copy: the snapshot file
        // name IS the digest, so identical content across files/turns
        // dedupes for free.
        const liveHash = (() => {
          try {
            return sha256File(path)
          } catch {
            return null
          }
        })()
        const prev = lastEntries[path]
        if (
          liveHash &&
          isV2Entry(prev) && prev.snap && prev.h &&
          prev.st && prev.st[0] === stat.mtimeMs && prev.st[1] === stat.size &&
          prev.h === liveHash
        ) {
          files[path] = { tip, snap: prev.snap, h: prev.h, st: prev.st, md: stat.mode }
          continue
        }

        const snapName = `sha256-${liveHash ?? randomBytes(8).toString('hex')}`
        const snapPath = join(snapDir, snapName)
        try {
          if (!ensureSnapDir()) {
            files[path] = { tip, big: true, st: [stat.mtimeMs, stat.size] }
            continue
          }
          if (!existsSync(snapPath)) {
            // Content-addressed: same digest anywhere → same file.
            copyFileSync(path, snapPath)
            try { chmodSync(snapPath, stat.mode) } catch { /* best-effort */ }
          }
          files[path] = { tip, snap: snapName, h: liveHash ?? sha256File(snapPath), st: [stat.mtimeMs, stat.size], md: stat.mode }
        } catch {
          files[path] = { tip, big: true, st: [stat.mtimeMs, stat.size] }
        }
      }
    }

    const checkpoint: ConversationCheckpoint = {
      turn: (last?.turn ?? 0) + 1,
      historyLength: history.length,
      files,
      createdFiles: [...createdSet],
      ...(cwd ? { cwd } : {}),
      at: new Date().toISOString(),
      prompt: prompt.slice(0, 80),
    }

    const p = checkpointsPath(sessionDir)
    // Quarantine a torn final line (crash mid-write, no trailing newline):
    // without this, the append MERGES with the fragment and both lines
    // are lost to the parser.
    try {
      const size = statSync(p).size
      if (size > 0) {
        const lastByte = Buffer.alloc(1)
        const fd = openSync(p, 'r')
        try {
          readSync(fd, lastByte, 0, 1, size - 1)
        } finally {
          closeSync(fd)
        }
        if (lastByte[0] !== 0x0a) appendFileSync(p, '\n', 'utf8')
      }
    } catch { /* fresh file or unreadable — append below anyway */ }
    appendFileSync(p, JSON.stringify(checkpoint) + '\n', 'utf8')

    // Retention: BYTE-targeted (Round 31 P2 — a fixed anchor count could
    // still exceed the byte budget when anchors are large, forcing a full
    // parse + rewrite every turn).
    try {
      if (statSync(p).size > COMPACTION_TARGET_BYTES) {
        compactFile(sessionDir)
      }
    } catch { /* best-effort */ }
  } catch { /* best-effort */ }
}

/**
 * Byte-targeted compaction: keep the newest anchors whose cumulative
 * serialized size stays within {@link COMPACTION_TARGET_BYTES} (always at
 * least one, never more than {@link MAX_ANCHORS_HARD}). Orphaned
 * snapshots (referenced only by dropped anchors) are garbage-collected.
 */
function compactFile(sessionDir: string): void {
  const all = listCheckpoints(sessionDir)
  if (all.length <= 1) return
  const keep: ConversationCheckpoint[] = []
  let budget = 0
  for (let i = all.length - 1; i >= 0; i--) {
    const size = JSON.stringify(all[i]).length
    if (keep.length > 0 && budget + size > COMPACTION_TARGET_BYTES) break
    keep.unshift(all[i])
    budget += size
    if (keep.length >= MAX_ANCHORS_HARD) break
  }
  if (keep.length === all.length) return
  rewriteAnchors(sessionDir, keep)
}

function rewriteAnchors(sessionDir: string, anchors: ConversationCheckpoint[]): void {
  const p = checkpointsPath(sessionDir)
  const tmp = `${p}.tmp.${process.pid}.${Date.now()}`
  try {
    writeFileSync(tmp, anchors.map((c) => JSON.stringify(c)).join('\n') + '\n', 'utf8')
    renameSync(tmp, p)
    gcSnapshots(sessionDir, anchors)
  } catch {
    try { if (existsSync(tmp)) unlinkSync(tmp) } catch { /* best-effort */ }
  }
}

/** Delete snapshot files no longer referenced by any kept anchor. */
function gcSnapshots(sessionDir: string, anchors: ConversationCheckpoint[]): void {
  const referenced = new Set<string>()
  for (const a of anchors) {
    for (const e of Object.values(a.files ?? {})) {
      if (isV2Entry(e) && e.snap) referenced.add(e.snap)
    }
  }
  const dir = snapshotsDir(sessionDir)
  try {
    for (const name of readdirSync(dir)) {
      if (!referenced.has(name)) {
        try { unlinkSync(join(dir, name)) } catch { /* best-effort */ }
      }
    }
  } catch { /* dir missing — nothing to collect */ }
}

// ── Transactional rewind (Round 32): preflight / stage / commit ─────────────
//
// The single-shot rewind mixed read/decide/mutate: a failure halfway left
// SOME files restored and others not. The transactional shape:
//   preflight — pure: compute every planned mutation (delete/restore/skip)
//               with boundary checks; returns a plan, touches nothing.
//   stage     — copy each restore payload into <sessionDir>/rewind-stage/
//               (verifying readability). Nothing live is touched.
//   commit    — apply the plan: staged renames + deletes + anchor
//               truncation, honoring per-file rollback of staged artifacts.
// rewindToCheckpoint() now runs all three; partial failures are reported
// per-file instead of leaving an undefined mix.

export interface RewindPlanItem {
  path: string
  action: 'restore-snapshot' | 'restore-version' | 'delete' | 'skip-boundary' | 'noop'
  /** snapshot file name (restore-snapshot) */
  snap?: string
  /** FileHistory version index (restore-version) */
  version?: number
  mode?: number
  reason?: string
}

export interface RewindPlan {
  turn: number
  historyLength: number
  items: RewindPlanItem[]
  createdAfter: string[]
  futureCheckpoints: ConversationCheckpoint[]
  root: string | undefined
  message?: string
}

/** Phase 1 — pure planning. No filesystem mutation. */
export function planRewind(
  sessionDir: string,
  turn: number,
  history: OpenAIMessage[],
  fileHistory: FileHistory | null,
): RewindPlan | { error: string } {
  const checkpoints = listCheckpoints(sessionDir)
  const cpIndex = checkpoints.findIndex((c) => c.turn === turn)
  if (cpIndex === -1) {
    return {
      error: checkpoints.length === 0
        ? 'No checkpoints recorded this session.'
        : `No checkpoint for turn ${turn}. Recorded turns: ${checkpoints.map((c) => c.turn).join(', ')}.`,
    }
  }
  const cp = checkpoints[cpIndex]
  const futureCheckpoints = checkpoints.slice(cpIndex + 1)
  const cpCreated = new Set(cp.createdFiles ?? [])
  const posixSession = toPosix(sessionDir)
  const root = cp.cwd ?? (posixSession.includes('/sessions/')
    ? posixSession.slice(0, posixSession.lastIndexOf('/sessions/'))
    : undefined)

  const items: RewindPlanItem[] = []
  for (const [path, rawEntry] of Object.entries(cp.files ?? {})) {
    if (!isInsideWorkspace(path, root)) {
      items.push({ path, action: 'skip-boundary', reason: 'outside workspace root' })
      continue
    }
    if (!isV2Entry(rawEntry)) {
      const countAtTurn = typeof rawEntry === 'number' ? rawEntry : 0
      const versions = fileHistory?.getVersions(path) ?? []
      if (versions.length === countAtTurn && existsSync(path)) {
        items.push({ path, action: 'noop' })
        continue
      }
      const target = Math.min(countAtTurn, versions.length - 1)
      if (target < 0) {
        items.push({ path, action: 'noop' })
        continue
      }
      items.push({ path, action: 'restore-version', version: target })
      continue
    }
    const entry = rawEntry
    if (entry.absent) {
      if (existsSync(path)) items.push({ path, action: 'delete', reason: 'absent at anchor' })
      else items.push({ path, action: 'noop' })
      continue
    }
    if (entry.snap && entry.h) {
      let liveHash: string | null = null
      try {
        const st = statSync(path)
        if (st.size <= MAX_SNAPSHOT_BYTES) liveHash = sha256File(path)
      } catch { /* missing */ }
      if (liveHash === entry.h) {
        items.push({ path, action: 'noop' })
        continue
      }
      // Fallback plan (Round 32 audit F11): when the snapshot vanished
      // (GC race / corruption), the tip-identity version restore still
      // recovers content — 'recoverable content must be recovered'
      // (Round 31 F7 policy). Fallback executes only if staging fails.
      const versionsFb = fileHistory?.getVersions(path) ?? []
      const tipIdxFb = entry.tip ? versionsFb.findIndex((v) => v.backupPath === entry.tip) : -1
      const fbTarget = tipIdxFb >= 0
        ? tipIdxFb
        : (!entry.tip && versionsFb.length > 0 ? 0 : -1)
      items.push({
        path,
        action: 'restore-snapshot',
        snap: entry.snap,
        mode: entry.md,
        ...(fbTarget >= 0 ? { version: fbTarget } : {}),
      })
      continue
    }
    // tip-identity fallback
    const versions = fileHistory?.getVersions(path) ?? []
    const tipIdx = entry.tip ? versions.findIndex((v) => v.backupPath === entry.tip) : -1
    if (tipIdx === versions.length - 1 && existsSync(path)) {
      items.push({ path, action: 'noop' })
      continue
    }
    let target: number
    if (entry.tip && tipIdx >= 0) {
      target = tipIdx
    } else if (!entry.tip && versions.length > 0) {
      target = 0
    } else {
      if (versions.length > 0) target = 0
      else {
        items.push({ path, action: 'noop', reason: 'no snapshot, no versions' })
        continue
      }
    }
    items.push({ path, action: 'restore-version', version: target })
  }

  const createdAfter: string[] = []
  for (const future of futureCheckpoints) {
    for (const path of future.createdFiles ?? []) {
      if (cpCreated.has(path)) continue
      if (!isInsideWorkspace(path, root)) {
        items.push({ path, action: 'skip-boundary', reason: 'outside workspace root' })
        continue
      }
      if (!createdAfter.includes(path)) createdAfter.push(path)
    }
  }

  return {
    turn,
    historyLength: Math.min(cp.historyLength, history.length),
    items,
    createdAfter,
    futureCheckpoints,
    root,
  }
}

export interface RewindResult {
  ok: boolean
  historyLength: number
  restoredFiles: string[]
  failedFiles: string[]
  /** Files created after the anchor that were deleted by the rewind. */
  deletedFiles: string[]
  /** Destructive ops skipped by the workspace boundary guard. */
  skippedPaths: string[]
  /** Files whose exact-content snapshot was missing — degraded restore. */
  degradedFiles: string[]
  /** Anchors dropped from the future branch (stale after rewind). */
  truncatedCheckpoints: number
  message?: string
}

/** Restore `snapName` content onto `path` atomically (tmp + rename),
 *  preserving the anchored mode. Boundary check is the caller's. */
function restoreSnapshot(sessionDir: string, snapName: string, path: string, mode: number | undefined): boolean {
  try {
    const src = join(snapshotsDir(sessionDir), snapName)
    if (!existsSync(src)) return false
    const tmp = `${path}.rewind-tmp.${process.pid}.${randomBytes(4).toString('hex')}`
    copyFileSync(src, tmp)
    if (mode !== undefined) {
      try { chmodSync(tmp, mode) } catch { /* best-effort */ }
    }
    renameSync(tmp, path)
    return true
  } catch {
    return false
  }
}


/** Phase 2+3 — stage & commit. Runs preflight, materializes restore
 *  payloads into <sessionDir>/rewind-stage/, then applies. Per-file
 *  failures are reported; staged artifacts are cleaned whether commit
 *  succeeds or not. The caller owns the history mutation (setHistory).
 */
export function rewindToCheckpoint(
  sessionDir: string,
  turn: number,
  history: OpenAIMessage[],
  fileHistory: FileHistory | null,
): RewindResult {
  const planned = planRewind(sessionDir, turn, history, fileHistory)
  if ('error' in planned) {
    return {
      ok: false,
      historyLength: history.length,
      restoredFiles: [],
      failedFiles: [],
      deletedFiles: [],
      skippedPaths: [],
      degradedFiles: [],
      truncatedCheckpoints: 0,
      message: planned.error,
    }
  }

  const restoredFiles: string[] = []
  const failedFiles: string[] = []
  const deletedFiles: string[] = []
  const skippedPaths: string[] = []
  const degradedFiles: string[] = []

  // ── STAGE: copy every restore payload into rewind-stage/ first.
  // A snapshot that vanished (GC race) or an unreadable version backup
  // fails HERE, before anything live is touched.
  const stageDir = join(sessionDir, 'rewind-stage')
  const staged = new Map<string, string>() // planPath → staged file
  let stagingOk = true
  try {
    mkdirSync(stageDir, { recursive: true })
    for (const item of planned.items) {
      if (item.action !== 'restore-snapshot' && item.action !== 'restore-version') continue
      const stagedPath = join(stageDir, randomBytes(8).toString('hex'))
      try {
        if (item.action === 'restore-snapshot' && item.snap) {
          try {
            copyFileSync(join(snapshotsDir(sessionDir), item.snap), stagedPath)
          } catch {
            // F11 fallback: snapshot vanished — stage the planned
            // version payload instead (recoverable content recovered).
            if (item.version !== undefined) {
              const versions = fileHistory?.getVersions(item.path) ?? []
              copyFileSync(versions[item.version]?.backupPath ?? '', stagedPath)
              degradedFiles.push(item.path)
            } else {
              throw new Error('snapshot missing and no version fallback')
            }
          }
        } else if (item.action === 'restore-version' && item.version !== undefined) {
          const versions = fileHistory?.getVersions(item.path) ?? []
          copyFileSync(versions[item.version]?.backupPath ?? '', stagedPath)
        }
        staged.set(item.path, stagedPath)
      } catch {
        // Truly unstageable — report, never silently skip.
        failedFiles.push(item.path)
        if (item.action === 'restore-version') degradedFiles.push(item.path)
      }
    }
  } catch {
    stagingOk = false
  }

  if (!stagingOk) {
    // F12: staging infrastructure failed BEFORE any live file was
    // touched — report an aborted rewind honestly instead of the old
    // silent ok:true that still truncated anchors.
    return {
      ok: false,
      historyLength: history.length,
      restoredFiles: [],
      failedFiles: [...new Set(failedFiles)],
      deletedFiles: [],
      skippedPaths,
      degradedFiles,
      truncatedCheckpoints: 0,
      message: 'Rewind aborted during staging (session dir unwritable) — no files or checkpoints were touched.',
    }
  }

  // ── COMMIT: apply staged payloads, deletes, then anchor truncation.
  {
    for (const item of planned.items) {
      if (staged.has(item.path)) continue // already resolved during staging (failed)
      if (item.action === 'skip-boundary') {
        skippedPaths.push(item.path)
        continue
      }
      if (item.action === 'delete' || item.reason === 'absent at anchor') {
        try {
          if (item.action === 'delete' && existsSync(item.path)) {
            unlinkSync(item.path)
            deletedFiles.push(item.path)
          }
        } catch {
          failedFiles.push(item.path)
        }
        continue
      }
      if (item.action === 'noop') {
        if (item.reason) degradedFiles.push(item.path)
        continue
      }
    }
    for (const [path, stagedPath] of staged) {
      try {
        const mode = planned.items.find((i) => i.path === path)?.mode
        const tmp = `${path}.rewind-tmp.${process.pid}.${randomBytes(4).toString('hex')}`
        copyFileSync(stagedPath, tmp)
        if (mode !== undefined) {
          try { chmodSync(tmp, mode) } catch { /* best-effort */ }
        }
        renameSync(tmp, path)
        restoredFiles.push(path)
      } catch {
        failedFiles.push(path)
      }
    }

    // Created-after-anchor deletions (planned, boundary-checked).
    for (const path of planned.createdAfter) {
      try {
        if (existsSync(path)) {
          unlinkSync(path)
          deletedFiles.push(path)
        }
      } catch { /* best-effort */ }
    }
  }

  // Staging cleanup — staged payloads are transient by contract.
  // rmdirSync: unlink(2) cannot remove a DIRECTORY (F13 — the empty
  // rewind-stage/ dir used to leak after every rewind).
  try {
    for (const stagedPath of staged.values()) {
      try { unlinkSync(stagedPath) } catch { /* best-effort */ }
    }
    try { rmdirSync(stageDir) } catch { /* non-empty or missing */ }
  } catch { /* best-effort */ }

  // ── Truncate the future branch (report failure honestly)
  let truncated = planned.futureCheckpoints.length
  if (planned.futureCheckpoints.length > 0) {
    const checkpoints = listCheckpoints(sessionDir)
    const cpIndex = checkpoints.findIndex((c) => c.turn === turn)
    if (cpIndex >= 0) {
      rewriteAnchors(sessionDir, checkpoints.slice(0, cpIndex + 1))
      const after = listCheckpoints(sessionDir)
      if (after.some((c) => c.turn > turn)) truncated = 0
    }
  }

  const result: RewindResult = {
    ok: true,
    historyLength: planned.historyLength,
    restoredFiles,
    failedFiles,
    deletedFiles,
    skippedPaths,
    degradedFiles,
    truncatedCheckpoints: truncated,
  }
  if (truncated === 0 && planned.futureCheckpoints.length > 0) {
    result.message =
      'WARNING: failed to drop the stale future checkpoints (write error) — ' +
      'rewind again or restart the session before appending new turns.'
  }
  return result
}
