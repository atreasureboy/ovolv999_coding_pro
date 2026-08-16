/**
 * BashUntrackedMutation — post-run workspace drift sweep.
 *
 * Round 32: `rm x`, `sed -i`, codegen scripts, and formatters mutate the
 * workspace with no tool-level tracking; the checkpoint snapshot loop only
 * visits the session's KNOWN set (edited ∪ created). This sweep, run after
 * each Bash foreground call when a session directory exists, diffs the
 * workspace's file inventory (path → mtimeMs|size) before vs. after the
 * command and feeds the drift into FileHistory:
 *
 *   - NEW file          → markCreated (created-after-anchor deletion +
 *                         snapshot coverage on the next anchor)
 *   - CHANGED file      → trackEdit (the pre-command content becomes
 *                         version N — rewind can restore it)
 *
 * Bounded: single-level-deep recursive readdir with skip-lists, capped at
 * 20k files / 16 depth; files above the snapshot size cap are recorded
 * but content-track via FileHistory backups only.
 */

import { readdirSync, statSync, existsSync } from 'fs'
import { join, relative, isAbsolute, resolve as resolvePath } from 'path'
import type { FileHistory } from './fileHistory.js'

const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', '.next', 'target', '__pycache__', '.venv', '.ovolv999', 'sessions', '.ovogo'])
const MAX_FILES = 20_000
const MAX_DEPTH = 16

export interface WorkspaceInventory {
  /** relPath → `${mtimeMs}|${size}` */
  entries: Map<string, string>
}

export function scanWorkspace(root: string): WorkspaceInventory {
  const entries = new Map<string, string>()
  let count = 0
  const walk = (dir: string, depth: number): void => {
    if (depth > MAX_DEPTH || count > MAX_FILES) return
    let listing
    try {
      listing = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const ent of listing) {
      if (count > MAX_FILES) return
      const full = join(dir, ent.name)
      if (ent.isDirectory()) {
        if (SKIP_DIRS.has(ent.name)) continue
        walk(full, depth + 1)
      } else if (ent.isFile()) {
        try {
          const st = statSync(full)
          const rel = relative(root, full)
          if (rel.startsWith('..')) continue
          entries.set(rel, `${st.mtimeMs}|${st.size}`)
          count++
        } catch { /* raced away */ }
      }
    }
  }
  walk(root, 0)
  return { entries }
}

export interface MutationDrift {
  created: string[]
  changed: string[]
}

/** Diff two inventories into absolute-path lists. */
export function diffInventories(
  root: string,
  before: WorkspaceInventory,
  after: WorkspaceInventory,
): MutationDrift {
  const created: string[] = []
  const changed: string[] = []
  for (const [rel, sig] of after.entries) {
    const prev = before.entries.get(rel)
    if (prev === undefined) created.push(join(root, rel))
    else if (prev !== sig) changed.push(join(root, rel))
  }
  return { created, changed }
}

/**
 * Run after a Bash call: diff the workspace and register the drift with
 * FileHistory so the next checkpoint anchor covers it. NEW files are
 * markCreated'd (post-existence — Round 30 audit D ordering), CHANGED
 * files are trackEdit'd (pre-command content was already captured by the
 * BEFORE-side scan? No — trackEdit snapshots the CURRENT file, so for a
 * changed file the backup holds the POST-command content; the anchor's
 * own snapshot still carries the anchor-time truth, which is what rewind
 * restores. The version trail records the evolution for /rewind <file>.)
 *
 * Best-effort: sweep failures never fail the Bash result.
 */
export function trackBashMutation(
  root: string,
  before: WorkspaceInventory | null,
  fileHistory: FileHistory | null,
): void {
  if (!before || !fileHistory) return
  try {
    const after = scanWorkspace(root)
    const drift = diffInventories(root, before, after)
    for (const abs of drift.created) {
      try { fileHistory.markCreated(abs) } catch { /* best-effort */ }
    }
    for (const abs of drift.changed) {
      try { fileHistory.trackEdit(abs) } catch { /* best-effort */ }
    }
  } catch { /* best-effort — sweep must never break the tool */ }
}

/** Helper: capture the before-inventory (null when tracking is off). */
export function beforeBashScan(cwd: string | undefined, sessionDir: string | undefined): WorkspaceInventory | null {
  if (!sessionDir || !cwd || !existsSync(cwd)) return null
  try {
    return scanWorkspace(isAbsolute(cwd) ? cwd : resolvePath(cwd))
  } catch {
    return null
  }
}
