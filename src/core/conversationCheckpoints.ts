/**
 * ConversationCheckpoints — per-turn rewind anchors.
 *
 * Round 28 (CC /rewind parity, conversation half): file restore alone
 * rewinds the workspace but the conversation still "remembers" doing the
 * work. Claude Code rewinds BOTH. Each completed turn appends a checkpoint:
 *
 *   { turn, historyLength, files: { <absPath>: versionCountAtTurnEnd } }
 *
 * Rewinding to turn N then does BOTH:
 *   - conversation: history.slice(0, historyLength)  (setHistory)
 *   - files:        restoreVersion(path, count-1)    (FileHistory)
 *
 * Storage: <sessionDir>/checkpoints.jsonl — append-only JSONL, same
 * durability conventions as the session manager (atomic per-line appends;
 * a torn last line is skipped on read).
 */

import { existsSync, readFileSync, appendFileSync } from 'fs'
import { join } from 'path'
import type { FileHistory } from './fileHistory.js'
import type { OpenAIMessage } from './types.js'

export interface ConversationCheckpoint {
  turn: number
  /** Number of messages in the conversation at end of this turn. */
  historyLength: number
  /** absPath → number of FileHistory versions that existed at turn end. */
  files: Record<string, number>
  /** ISO timestamp for display. */
  at: string
  /** First 80 chars of the user prompt that started this turn. */
  prompt: string
}

const FILENAME = 'checkpoints.jsonl'
const MAX_CHECKPOINTS = 500

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
    if (fileHistory) {
      for (const f of fileHistory.getEditedFiles()) {
        files[f.path] = fileHistory.getVersions(f.path).length
      }
    }
    const existing = listCheckpoints(sessionDir)
    const checkpoint: ConversationCheckpoint = {
      turn: existing.length + 1,
      historyLength: history.length,
      files,
      at: new Date().toISOString(),
      prompt: prompt.slice(0, 80),
    }
    appendFileSync(checkpointsPath(sessionDir), JSON.stringify(checkpoint) + '\n', 'utf8')
  } catch { /* best-effort */ }
}

export interface RewindResult {
  ok: boolean
  historyLength: number
  restoredFiles: string[]
  failedFiles: string[]
  message?: string
}

/** Rewind BOTH conversation + files to the end of `turn`. The caller
 *  owns the history mutation (returns the target length) because the
 *  slash-command context is the only place with setHistory. */
export function rewindToCheckpoint(
  sessionDir: string,
  turn: number,
  history: OpenAIMessage[],
  fileHistory: FileHistory | null,
): RewindResult {
  const checkpoints = listCheckpoints(sessionDir)
  const cp = checkpoints.find((c) => c.turn === turn)
  if (!cp) {
    return {
      ok: false,
      historyLength: history.length,
      restoredFiles: [],
      failedFiles: [],
      message: checkpoints.length === 0
        ? 'No checkpoints recorded this session.'
        : `No checkpoint for turn ${turn}. Recorded turns: ${checkpoints.map((c) => c.turn).join(', ')}.`,
    }
  }
  const restoredFiles: string[] = []
  const failedFiles: string[] = []
  if (fileHistory) {
    for (const [path, countAtTurn] of Object.entries(cp.files)) {
      const versions = fileHistory.getVersions(path)
      // Version semantics: trackEdit snapshots content BEFORE each edit,
      // so version k = "content after edit k" (snapshotted when edit k+1
      // ran). End-of-turn-N state with k versions therefore maps to:
      //   - current count == k  → no later edit; live file already IS the
      //     target state → skip (nothing to do).
      //   - current count >  k  → version k holds the target → restore k.
      //   - current count <  k  → retention eviction shrank history below
      //     the anchor → best effort, restore oldest available.
      if (versions.length === countAtTurn) continue
      const target = Math.min(countAtTurn, versions.length - 1)
      if (target < 0) continue
      if (fileHistory.restoreVersion(path, target)) {
        restoredFiles.push(path)
      } else {
        failedFiles.push(path)
      }
    }
  }
  // History: truncate to the recorded length (cap at current — compaction
  // may have shortened history below the checkpoint).
  const targetLength = Math.min(cp.historyLength, history.length)
  return { ok: true, historyLength: targetLength, restoredFiles, failedFiles }
}
