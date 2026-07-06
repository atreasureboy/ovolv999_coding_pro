/**
 * File State Cache — tracks which files have been Read and their content state.
 * Claude Code pattern: track file content + mtime so re-reads of unchanged files
 * return "File unchanged" instead of wasting context tokens.
 */

import { resolve } from 'path'
import { statSync } from 'fs'

interface FileState {
  mtime: number  // last known modification time (ms)
  size: number   // last known file size
}

const _readFiles = new Set<string>()
const _fileStates = new Map<string, FileState>()

export function markFileRead(filePath: string): void {
  const normalized = resolve(filePath)
  _readFiles.add(normalized)
  try {
    const stat = statSync(normalized)
    _fileStates.set(normalized, { mtime: stat.mtimeMs, size: stat.size })
  } catch { /* best-effort */ }
}

export function hasFileBeenRead(filePath: string): boolean {
  return _readFiles.has(resolve(filePath))
}

/**
 * Check if a file has changed since it was last read.
 * Returns true if the file is new or modified since last Read.
 */
export function hasFileChanged(filePath: string): boolean {
  const normalized = resolve(filePath)
  const cached = _fileStates.get(normalized)
  if (!cached) return true  // never read → treat as changed
  try {
    const stat = statSync(normalized)
    return stat.mtimeMs !== cached.mtime || stat.size !== cached.size
  } catch {
    return true  // file might be deleted
  }
}

export function clearFileState(): void {
  _readFiles.clear()
  _fileStates.clear()
}
