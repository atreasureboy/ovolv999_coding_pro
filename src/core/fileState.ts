/**
 * File State Cache — tracks which files have been Read and their content state.
 * Claude Code pattern: track file content + mtime so re-reads of unchanged files
 * return "File unchanged" instead of wasting context tokens.
 *
 * We store THREE pieces of state per file:
 *   - mtime + size (cheap metadata, fast O(1) check)
 *   - content hash (SHA-256 of the last-seen text/bytes)
 *
 * The hash layer closes the same-mtime / same-size replacement hole that
 * mtime+size alone cannot detect (e.g. an in-place formatter that saves
 * within the same millisecond on a fast disk). Without it, an external
 * writer that preserves length could be silently overwritten by Write/Edit.
 *
 * Backwards compatibility: markFileRead() and hasFileChanged() both keep
 * their old signatures (no required args). Files marked without content
 * fall back to mtime+size only — exactly the prior behavior. Tools that
 * have the content in hand should pass it to markFileRead to enable the
 * hash layer.
 */

import { resolve } from 'path'
import { statSync } from 'fs'
import { createHash } from 'crypto'

interface FileState {
  mtime: number  // last known modification time (ms)
  size: number   // last known file size
  /**
   * SHA-256 hex digest of the last-seen content. Undefined for files
   * marked without content (legacy call sites, binary files where the
   * caller didn't pass a Buffer). When undefined, hasFileChanged()
   * degrades to mtime+size only.
   */
  hash?: string
}

const _readFiles = new Set<string>()
const _fileStates = new Map<string, FileState>()

/**
 * SHA-256 of a UTF-8 string. Hex digest is 64 chars — cheap to store and
 * compare, and collision-resistant in practice (any collision here would
 * mean SHA-256 is broken).
 *
 * Round 43: BOM-invariant. Read strips a leading \uFEFF before rendering,
 * so the content it registers must hash the same way as the raw bytes the
 * Edit path reads — otherwise every BOM'd file reads as "modified since
 * last read" on first edit.
 */
function hashText(content: string): string {
  const normalized = content.charCodeAt(0) === 0xFEFF ? content.slice(1) : content
  return createHash('sha256').update(normalized, 'utf8').digest('hex')
}

/**
 * Mark a file as read and cache its current state.
 *
 * Pass `content` when you already have it in memory (e.g. FileRead just
 * finished reading the file). Caching the hash avoids re-reading on the
 * next staleness check AND closes the same-mtime/same-size replacement
 * hole. Without `content`, only mtime+size are cached — same as before
 * this change.
 *
 * Best-effort: stat failures (ENOENT, EACCES) are swallowed. The set
 * membership (hasFileBeenRead) still updates so a later successful read
 * can populate the state.
 */
export function markFileRead(filePath: string, content?: string): void {
  const normalized = resolve(filePath)
  _readFiles.add(normalized)
  try {
    const stat = statSync(normalized)
    const state: FileState = { mtime: stat.mtimeMs, size: stat.size }
    if (content !== undefined) {
      state.hash = hashText(content)
    }
    _fileStates.set(normalized, state)
  } catch { /* best-effort — file may have been deleted between Read and mark */ }
}

export function hasFileBeenRead(filePath: string): boolean {
  return _readFiles.has(resolve(filePath))
}

/**
 * Check if a file has changed since it was last read.
 *
 * Layered detection:
 *   1. mtime+size — fast O(1); catches most external writers
 *   2. SHA-256 hash — only when caller passes currentContent AND the cache
 *      has a stored hash. Catches same-mtime/same-size replacements that
 *      slip past layer 1.
 *
 * Returns true (treat as changed) when the file was never read or has
 * been deleted since the last read.
 */
export function hasFileChanged(filePath: string, currentContent?: string): boolean {
  const normalized = resolve(filePath)
  const cached = _fileStates.get(normalized)
  if (!cached) return true  // never read → treat as changed

  let stat
  try {
    stat = statSync(normalized)
  } catch {
    return true  // file deleted or inaccessible
  }

  // Fast path — mtime+size unchanged, most likely identical content.
  if (stat.mtimeMs === cached.mtime && stat.size === cached.size) {
    // Hash layer: only useful when both sides have a hash to compare.
    // Without currentContent we can't compute a fresh hash, and without a
    // cached hash there's nothing to compare against — fall through.
    if (cached.hash !== undefined && currentContent !== undefined) {
      const currentHash = hashText(currentContent)
      if (currentHash !== cached.hash) return true
    }
    return false
  }
  return true
}

export function clearFileState(): void {
  _readFiles.clear()
  _fileStates.clear()
}
