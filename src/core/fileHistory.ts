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
 *   2. getEditedFiles() lists all modified files
 *   3. restoreOriginal(filePath) reverts a file to its pre-first-edit state
 *   4. getVersions(filePath) lists all backup versions with timestamps
 *
 * This gives the engine an "undo" capability — if the LLM makes bad edits,
 * the user can rewind to a known-good state.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync, statSync, copyFileSync, chmodSync } from 'fs'
import { join, resolve } from 'path'
import { createHash } from 'crypto'

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

// ── FileHistory ─────────────────────────────────────────────────────────────

export class FileHistory {
  private historyDir: string
  /** filePath → array of backup paths (chronological, [0] = original) */
  private edits = new Map<string, string[]>()

  constructor(sessionDir: string) {
    this.historyDir = join(sessionDir, 'file-history')
    try {
      mkdirSync(this.historyDir, { recursive: true })
    } catch {
      /* best-effort */
    }
  }

  /**
   * Back up a file BEFORE it's modified. Call from Write/Edit tools.
   * If the file doesn't exist yet (new file), this is a no-op.
   */
  trackEdit(filePath: string): void {
    const absPath = resolve(filePath)
    if (!existsSync(absPath)) return // new file — nothing to back up

    try {
      // Use copyFile (not read+write) to avoid loading the entire file into
      // the JS heap — prevents OOM on large tracked files (e.g. minified JS,
      // data files). Preserves file permissions via chmod sync.
      const hash = createHash('md5').update(absPath).digest('hex').slice(0, 16)
      const dir = join(this.historyDir, hash)
      mkdirSync(dir, { recursive: true })

      const timestamp = Date.now()
      const backupPath = join(dir, `v${timestamp}`)
      copyFileSync(absPath, backupPath) // atomic file-level copy, no heap pressure

      // Preserve file permissions on the backup
      try {
        const stat = statSync(absPath)
        chmodSync(backupPath, stat.mode)
      } catch { /* best-effort */ }

      const versions = this.edits.get(absPath) ?? []
      versions.push(backupPath)
      this.edits.set(absPath, versions)
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

  /** Get all backup versions for a file. Version 0 = original (pre-first-edit). */
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

  /** Restore a file to its original (pre-first-edit) state. */
  restoreOriginal(filePath: string): boolean {
    return this.restoreVersion(filePath, 0)
  }

  /** Restore a file to its Nth backup version. Returns false if not found. */
  restoreVersion(filePath: string, version: number): boolean {
    const absPath = resolve(filePath)
    const versions = this.edits.get(absPath)
    if (!versions || version < 0 || version >= versions.length) return false

    try {
      const content = readFileSync(versions[version])
      writeFileSync(absPath, content)
      return true
    } catch {
      return false
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
  }
}
