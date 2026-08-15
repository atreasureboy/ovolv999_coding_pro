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

import { existsSync, readFileSync, appendFileSync, writeFileSync, renameSync, unlinkSync, statSync, openSync, readSync, closeSync, mkdirSync, copyFileSync, chmodSync, readdirSync, realpathSync } from 'fs'
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

/** True when `path` sits inside `root`. Resolves the existing parent
 *  chain through realpathSync (a symlinked subdirectory cannot smuggle
 *  a destructive op outside the workspace), falling back to lexical
 *  resolution for not-yet-existing parents. */
export function isInsideWorkspace(path: string, root: string | undefined): boolean {
  if (!root) return true // legacy anchor without cwd — caller decides policy
  const canonical = (p: string): string => {
    try {
      return realpathSync(p)
    } catch {
      return resolvePath(p)
    }
  }
  const parent = canonical(dirname(path))
  const rootCanonical = canonical(root)
  return parent === rootCanonical || parent.startsWith(rootCanonical + '/')
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

        // Snapshot reuse fast path: unchanged since the last anchor
        // (mtime+size match and the previous entry has a snapshot).
        const prev = lastEntries[path]
        if (
          isV2Entry(prev) && prev.snap && prev.h && prev.st &&
          prev.st[0] === stat.mtimeMs && prev.st[1] === stat.size
        ) {
          files[path] = { tip, snap: prev.snap, h: prev.h, st: prev.st, md: stat.mode }
          continue
        }

        const snapName = `t${(last?.turn ?? 0) + 1}-${randomBytes(6).toString('hex')}`
        const snapPath = join(snapDir, snapName)
        try {
          if (!ensureSnapDir()) {
            files[path] = { tip, big: true, st: [stat.mtimeMs, stat.size] }
            continue
          }
          copyFileSync(path, snapPath)
          try { chmodSync(snapPath, stat.mode) } catch { /* best-effort */ }
          const h = sha256File(snapPath)
          files[path] = { tip, snap: snapName, h, st: [stat.mtimeMs, stat.size], md: stat.mode }
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

/** Rewind BOTH conversation + files to the end of `turn`. The caller
 *  owns the history mutation (returns the target length) because the
 *  slash-command context is the only place with setHistory. On success
 *  the JSONL is truncated past `turn`; snapshot storage is GC'd. */
export function rewindToCheckpoint(
  sessionDir: string,
  turn: number,
  history: OpenAIMessage[],
  fileHistory: FileHistory | null,
): RewindResult {
  const checkpoints = listCheckpoints(sessionDir)
  const cpIndex = checkpoints.findIndex((c) => c.turn === turn)
  if (cpIndex === -1) {
    return {
      ok: false,
      historyLength: history.length,
      restoredFiles: [],
      failedFiles: [],
      deletedFiles: [],
      skippedPaths: [],
      degradedFiles: [],
      truncatedCheckpoints: 0,
      message: checkpoints.length === 0
        ? 'No checkpoints recorded this session.'
        : `No checkpoint for turn ${turn}. Recorded turns: ${checkpoints.map((c) => c.turn).join(', ')}.`,
    }
  }
  const cp = checkpoints[cpIndex]
  const futureCheckpoints = checkpoints.slice(cpIndex + 1)
  const cpCreated = new Set(cp.createdFiles ?? [])

  // Workspace boundary: anchor's own cwd, else derive from the session
  // layout (<projectRoot>/sessions/<id>) as a best-effort fallback.
  const root = cp.cwd ?? (sessionDir.includes('/sessions/') ? sessionDir.slice(0, sessionDir.lastIndexOf('/sessions/')) : undefined)

  const restoredFiles: string[] = []
  const failedFiles: string[] = []
  const deletedFiles: string[] = []
  const skippedPaths: string[] = []
  const degradedFiles: string[] = []

  // ── Per-file state restore (v2 snapshot identity; legacy counts best-effort)
  for (const [path, rawEntry] of Object.entries(cp.files ?? {})) {
    if (!isInsideWorkspace(path, root)) {
      skippedPaths.push(path)
      continue
    }

    if (!isV2Entry(rawEntry)) {
      // Legacy numeric anchor: pre-v2 count semantics.
      const countAtTurn = typeof rawEntry === 'number' ? rawEntry : 0
      const versions = fileHistory?.getVersions(path) ?? []
      if (versions.length === countAtTurn && existsSync(path)) continue
      const target = Math.min(countAtTurn, versions.length - 1)
      if (target < 0) continue
      if (fileHistory?.restoreVersion(path, target)) restoredFiles.push(path)
      else failedFiles.push(path)
      continue
    }
    const entry = rawEntry

    if (entry.absent) {
      // Anchor-time truth: the file did not exist. A later recreation
      // (bash script re-generating it, etc.) is rewound away.
      if (existsSync(path)) {
        try {
          unlinkSync(path)
          deletedFiles.push(path)
        } catch {
          failedFiles.push(path)
        }
      }
      continue
    }

    if (entry.snap && entry.h) {
      // Exact-content restore: compare live hash, act only on drift.
      // This is the version-cap-proof and untracked-mutation-proof path.
      let liveHash: string | null = null
      try {
        const s = statSync(path)
        if (s.size <= MAX_SNAPSHOT_BYTES) liveHash = sha256File(path)
      } catch { /* missing file */ }
      if (liveHash === entry.h) continue
      if (restoreSnapshot(sessionDir, entry.snap, path, entry.md)) {
        restoredFiles.push(path)
        continue
      }
      // Round 31 audit F7: snapshot missing (GC'd / write failed) —
      // fall through to the tip-based restore below instead of hard-
      // failing; recoverable content must be recovered.
      degradedFiles.push(path)
    }

    // No snapshot (big file, snapshot write failed, or pre-snap anchor):
    // degrade to tip-identity version restore. `tip` is a stable
    // backup-path identity — unlike a count it cannot saturate at the
    // 50-version retention cap.
    const versions = fileHistory?.getVersions(path) ?? []
    const tipIdx = entry.tip ? versions.findIndex((v) => v.backupPath === entry.tip) : -1
    if (tipIdx === versions.length - 1 && existsSync(path)) continue // unchanged
    let target: number
    if (entry.tip && tipIdx >= 0) {
      target = tipIdx
    } else if (!entry.tip && versions.length > 0) {
      target = 0 // no versions at anchor → pre-first-edit content
    } else {
      // tip evicted by retention, or file missing with nothing to
      // restore from — honest degradation, never a silent skip.
      degradedFiles.push(path)
      if (versions.length > 0) target = 0
      else {
        if (!existsSync(path)) failedFiles.push(path)
        continue
      }
    }
    if (fileHistory?.restoreVersion(path, target)) {
      restoredFiles.push(path)
    } else {
      failedFiles.push(path)
    }
  }

  // ── Created-after-anchor files: delete (they did not exist at turn N).
  for (const future of futureCheckpoints) {
    for (const path of future.createdFiles ?? []) {
      if (cpCreated.has(path)) continue
      if (!isInsideWorkspace(path, root)) {
        skippedPaths.push(path)
        continue
      }
      try {
        if (existsSync(path)) {
          unlinkSync(path)
          deletedFiles.push(path)
        }
      } catch { /* best-effort */ }
    }
  }

  // ── Truncate the future branch (report failure honestly)
  let truncated = futureCheckpoints.length
  if (futureCheckpoints.length > 0) {
    rewriteAnchors(sessionDir, checkpoints.slice(0, cpIndex + 1))
    // Detect failure: anchors still present past cpIndex?
    const after = listCheckpoints(sessionDir)
    if (after.some((c) => c.turn > turn)) truncated = 0
  }

  const targetLength = Math.min(cp.historyLength, history.length)
  const result: RewindResult = {
    ok: true,
    historyLength: targetLength,
    restoredFiles,
    failedFiles,
    deletedFiles,
    skippedPaths,
    degradedFiles,
    truncatedCheckpoints: truncated,
  }
  if (truncated === 0 && futureCheckpoints.length > 0) {
    result.message =
      'WARNING: failed to drop the stale future checkpoints (write error) — ' +
      'rewind again or restart the session before appending new turns.'
  }
  return result
}
