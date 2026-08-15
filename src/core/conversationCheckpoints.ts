/**
 * ConversationCheckpoints — per-turn rewind anchors.
 *
 * Round 28 (CC /rewind parity, conversation half): file restore alone
 * rewinds the workspace but the conversation still "remembers" doing the
 * work. Claude Code rewinds BOTH. Each completed turn appends a checkpoint:
 *
 *   { turn, historyLength, files: {<absPath>: versionCountAtTurnEnd},
 *     createdFiles: [<absPath>…], at, prompt }
 *
 * Rewinding to turn N does ALL of:
 *   - conversation: history.slice(0, historyLength)         (setHistory)
 *   - edited files: restoreVersion(path, countAtTurn)        (FileHistory)
 *   - created files created AFTER N: unlink (they did not exist then)
 *   - future anchors: truncate the JSONL past turn N (stale branch removal)
 *
 * Storage: <sessionDir>/checkpoints.jsonl — append-only JSONL. The append
 * path reads only the file TAIL (last ~8KB) to number the next anchor;
 * a full parse happens only on rewind / listing / size-triggered
 * compaction (anchors are capped; the file is compacted when it grows
 * past ~200KB, keeping the newest 450).
 */

import { existsSync, readFileSync, appendFileSync, writeFileSync, renameSync, unlinkSync, statSync, openSync, readSync, closeSync } from 'fs'
import { join } from 'path'
import type { FileHistory } from './fileHistory.js'
import type { OpenAIMessage } from './types.js'

export interface ConversationCheckpoint {
  turn: number
  /** Number of messages in the conversation at end of this turn. */
  historyLength: number
  /** absPath → number of FileHistory versions that existed at turn end.
   *  Absent = the file had no tracked versions yet at that turn. */
  files: Record<string, number>
  /** absPaths created by the session, cumulative through this turn.
   *  Optional for anchors written before the field existed. */
  createdFiles?: string[]
  /** ISO timestamp for display. */
  at: string
  /** First 80 chars of the user prompt that started this turn. */
  prompt: string
}

const FILENAME = 'checkpoints.jsonl'
/** Full-parse triggers: rewind, listing, and compaction above this size. */
const COMPACTION_THRESHOLD_BYTES = 200 * 1024
const KEEP_ON_COMPACTION = 450

function checkpointsPath(sessionDir: string): string {
  return join(sessionDir, FILENAME)
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
    // the first newline, then take the last non-empty line.
    const lines = text.split('\n').filter((l) => l.trim().length > 0)
    for (let i = lines.length - 1; i >= 0; i--) {
      try {
        const parsed = JSON.parse(lines[i]) as ConversationCheckpoint
        // Require the same anchor shape listCheckpoints validates — a
        // parseable-but-partial fragment must not inflate the numbering.
        if (
          typeof parsed.turn === 'number' &&
          typeof parsed.historyLength === 'number' &&
          parsed.files && typeof parsed.files === 'object'
        ) {
          return parsed
        }
      } catch { /* keep walking back */ }
    }
    // Window too small to find a complete line (one anchor > 8KB — e.g.
    // hundreds of edited files): fall back to the full parse.
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

/** Atomic rewrite keeping the newest `keep` anchors. */
function compactFile(sessionDir: string, keep: number): void {
  const all = listCheckpoints(sessionDir)
  if (all.length <= keep) return
  const p = checkpointsPath(sessionDir)
  const tmp = `${p}.tmp.${process.pid}.${Date.now()}`
  try {
    writeFileSync(tmp, all.slice(-keep).map((c) => JSON.stringify(c)).join('\n') + '\n', 'utf8')
    renameSync(tmp, p)
  } catch {
    try { if (existsSync(tmp)) unlinkSync(tmp) } catch { /* best-effort */ }
  }
}

/** Append the end-of-turn checkpoint. Best-effort — checkpointing must
 *  never break the turn loop. */
export function appendCheckpoint(
  sessionDir: string,
  history: OpenAIMessage[],
  fileHistory: FileHistory | null,
  prompt: string,
): void {
  try {
    const files: Record<string, number> = {}
    let createdFiles: string[] = []
    if (fileHistory) {
      for (const f of fileHistory.getEditedFiles()) {
        files[f.path] = fileHistory.getVersions(f.path).length
      }
      createdFiles = fileHistory.getCreatedFiles()
      // Created files with ZERO versions so far must still be recorded
      // (count 0) — otherwise rewinding to this anchor can't tell "no
      // tracked versions yet" from "file first edited after this turn".
      for (const path of createdFiles) {
        if (!(path in files)) files[path] = 0
      }
    }
    const last = readLastCheckpoint(sessionDir)
    const checkpoint: ConversationCheckpoint = {
      turn: (last?.turn ?? 0) + 1,
      historyLength: history.length,
      files,
      createdFiles,
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

    // Retention: size-triggered (one statSync per append). Compaction is
    // the only full parse on this path, and it runs at most once per
    // ~50 anchors in practice.
    try {
      if (statSync(checkpointsPath(sessionDir)).size > COMPACTION_THRESHOLD_BYTES) {
        compactFile(sessionDir, KEEP_ON_COMPACTION)
      }
    } catch { /* best-effort */ }
  } catch { /* best-effort */ }
}

export interface RewindResult {
  ok: boolean
  historyLength: number
  restoredFiles: string[]
  failedFiles: string[]
  /** Files created after the anchor that were deleted by the rewind. */
  deletedFiles: string[]
  /** Anchors dropped from the future branch (stale after rewind). */
  truncatedCheckpoints: number
  message?: string
}

/** Rewind BOTH conversation + files to the end of `turn`. The caller
 *  owns the history mutation (returns the target length) because the
 *  slash-command context is the only place with setHistory. On success
 *  the JSONL is truncated past `turn` — a rewound branch must not leave
 *  stale future anchors that a later rewind could accidentally target. */
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
      truncatedCheckpoints: 0,
      message: checkpoints.length === 0
        ? 'No checkpoints recorded this session.'
        : `No checkpoint for turn ${turn}. Recorded turns: ${checkpoints.map((c) => c.turn).join(', ')}.`,
    }
  }
  const cp = checkpoints[cpIndex]
  const futureCheckpoints = checkpoints.slice(cpIndex + 1)
  const cpCreated = new Set(cp.createdFiles ?? [])

  const restoredFiles: string[] = []
  const failedFiles: string[] = []
  const deletedFiles: string[] = []

  if (fileHistory) {
    // Edited files: version k = content after the k-th tracked mutation
    // (captured when mutation k+1 ran). count==k → unchanged since the
    // anchor → skip; count>k → later edits exist → restore versions[k];
    // count<k → retention eviction → best-effort oldest.
    for (const [path, countAtTurn] of Object.entries(cp.files)) {
      const versions = fileHistory.getVersions(path)
      if (versions.length === countAtTurn) continue
      const target = Math.min(countAtTurn, versions.length - 1)
      if (target < 0) continue
      if (fileHistory.restoreVersion(path, target)) {
        restoredFiles.push(path)
      } else {
        failedFiles.push(path)
      }
    }

    // Created-after-anchor files did not exist at end of turn N — delete.
    // The created-after set is derived from the FUTURE anchors (works
    // cross-process, no in-memory state needed): any path that appears in
    // a later anchor's cumulative createdFiles but not in the target's.
    for (const future of futureCheckpoints) {
      for (const path of future.createdFiles ?? []) {
        if (cpCreated.has(path)) continue
        try {
          if (existsSync(path)) {
            unlinkSync(path)
            deletedFiles.push(path)
          }
        } catch { /* best-effort */ }
      }
    }
  }

  // Truncate the future branch so a subsequent /rewind can never land on
  // a pre-rewind anchor (its historyLength/file state describe a timeline
  // that no longer exists). Atomic rewrite; on failure we REPORT the
  // miss instead of claiming success (Round 30 audit C3) — the caller
  // surfaces it and the user knows the anchors are stale.
  let truncated = futureCheckpoints.length
  if (futureCheckpoints.length > 0) {
    const p = checkpointsPath(sessionDir)
    const tmp = `${p}.tmp.${process.pid}.${Date.now()}`
    try {
      writeFileSync(tmp, checkpoints.slice(0, cpIndex + 1).map((c) => JSON.stringify(c)).join('\n') + '\n', 'utf8')
      renameSync(tmp, p)
    } catch {
      truncated = 0
      try { if (existsSync(tmp)) unlinkSync(tmp) } catch { /* best-effort */ }
    }
  }

  // History: truncate to the recorded length (cap at current — compaction
  // may have shortened history below the checkpoint).
  const targetLength = Math.min(cp.historyLength, history.length)
  const result: RewindResult = {
    ok: true,
    historyLength: targetLength,
    restoredFiles,
    failedFiles,
    deletedFiles,
    truncatedCheckpoints: truncated,
  }
  if (truncated === 0 && futureCheckpoints.length > 0) {
    result.message =
      'WARNING: failed to drop the stale future checkpoints (write error) — ' +
      'rewind again or restart the session before appending new turns.'
  }
  return result
}
