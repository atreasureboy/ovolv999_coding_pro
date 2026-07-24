/**
 * Structured Diff Browser
 *
 * Parses git diff output into a structured format with file list,
 * per-file hunk details, and statistics. Supports both unified diff
 * and summary views.
 *
 * Usage:
 *   const diff = parseGitDiff(gitDiffOutput)
 *   formatFileList(diff)        // summary view
 *   formatFileDetail(diff, 0)   // drill into specific file
 *   formatDiffStat(diff)        // histogram
 */

import { execSync } from 'child_process'

// ── Types ───────────────────────────────────────────────────────────────────

export interface DiffHunk {
  /** Original start line */
  oldStart: number
  /** Original line count */
  oldCount: number
  /** New start line */
  newStart: number
  /** New line count */
  newCount: number
  /** Hunk header (e.g., "@@ -10,5 +10,7 @@") */
  header: string
  /** Section header text after @@ */
  section?: string
  /** Lines in the hunk */
  lines: DiffLine[]
}

export interface DiffLine {
  type: 'context' | 'add' | 'remove' | 'no-newline'
  oldLineNo: number | null
  newLineNo: number | null
  content: string
}

export interface DiffFile {
  /** Original path (before rename) */
  oldPath: string
  /** New path (after rename) */
  newPath: string
  /** File status: added, modified, deleted, renamed, copied */
  status: FileStatus
  /** Old file mode (e.g., 100644) */
  oldMode?: string
  /** New file mode */
  newMode?: string
  /** Hunks for this file */
  hunks: DiffHunk[]
  /** Lines added */
  additions: number
  /** Lines removed */
  deletions: number
  /** Binary file flag */
  isBinary: boolean
}

export type FileStatus = 'added' | 'modified' | 'deleted' | 'renamed' | 'copied' | 'unmerged'

export interface StructuredDiff {
  files: DiffFile[]
  totalAdditions: number
  totalDeletions: number
  totalFiles: number
}

// ── Parser ──────────────────────────────────────────────────────────────────

/**
 * Parse `git diff` output into structured form.
 */
export function parseGitDiff(diffOutput: string): StructuredDiff {
  const files: DiffFile[] = []
  const lines = diffOutput.split('\n')

  let currentFile: DiffFile | null = null
  let currentHunk: DiffHunk | null = null
  let oldLine = 0
  let newLine = 0

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]

    // File header: diff --git a/path b/path
    if (line.startsWith('diff --git ')) {
      if (currentFile) files.push(currentFile)
      currentFile = parseFileHeader(line, lines, i)
      // Skip ahead past mode/index lines
      continue
    }

    // Old file path: --- a/path
    if (line.startsWith('--- ') && currentFile) {
      const path = line.slice(4)
      currentFile.oldPath = path === '/dev/null' ? '/dev/null' : path.replace(/^a\//, '')
      continue
    }

    // New file path: +++ b/path
    if (line.startsWith('+++ ') && currentFile) {
      const path = line.slice(4)
      currentFile.newPath = path === '/dev/null' ? '/dev/null' : path.replace(/^b\//, '')
      continue
    }

    // Hunk header: @@ -oldStart,oldCount +newStart,newCount @@ section
    const hunkMatch = line.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/)
    if (hunkMatch && currentFile) {
      if (currentHunk) currentFile.hunks.push(currentHunk)
      currentHunk = {
        oldStart: parseInt(hunkMatch[1], 10),
        oldCount: hunkMatch[2] ? parseInt(hunkMatch[2], 10) : 1,
        newStart: parseInt(hunkMatch[3], 10),
        newCount: hunkMatch[4] ? parseInt(hunkMatch[4], 10) : 1,
        header: line,
        section: hunkMatch[5]?.trim() || undefined,
        lines: [],
      }
      oldLine = currentHunk.oldStart
      newLine = currentHunk.newStart
      continue
    }

    // Binary files indicator
    if (line.startsWith('Binary files') && currentFile) {
      currentFile.isBinary = true
      continue
    }

    // Diff lines
    if (currentHunk) {
      if (line.startsWith(' ')) {
        currentHunk.lines.push({ type: 'context', oldLineNo: oldLine++, newLineNo: newLine++, content: line.slice(1) })
      } else if (line.startsWith('+')) {
        currentHunk.lines.push({ type: 'add', oldLineNo: null, newLineNo: newLine++, content: line.slice(1) })
        if (currentFile) currentFile.additions++
      } else if (line.startsWith('-')) {
        currentHunk.lines.push({ type: 'remove', oldLineNo: oldLine++, newLineNo: null, content: line.slice(1) })
        if (currentFile) currentFile.deletions++
      } else if (line.includes('No newline at end of file')) {
        currentHunk.lines.push({ type: 'no-newline', oldLineNo: null, newLineNo: null, content: '(no newline at end of file)' })
      }
    }
  }

  // Push last file/hunk
  if (currentHunk && currentFile) currentFile.hunks.push(currentHunk)
  if (currentFile) files.push(currentFile)

  // Compute status from paths
  for (const file of files) {
    file.status = inferStatus(file)
  }

  return {
    files,
    totalAdditions: files.reduce((s, f) => s + f.additions, 0),
    totalDeletions: files.reduce((s, f) => s + f.deletions, 0),
    totalFiles: files.length,
  }
}

function parseFileHeader(line: string, _lines: string[], _i: number): DiffFile {
  // diff --git a/path b/path
  const match = line.match(/^diff --git a\/(.+?) b\/(.+)$/)
  const oldPath = match?.[1] ?? 'unknown'
  const newPath = match?.[2] ?? 'unknown'

  return {
    oldPath,
    newPath,
    status: 'modified',
    hunks: [],
    additions: 0,
    deletions: 0,
    isBinary: false,
  }
}

function inferStatus(file: DiffFile): FileStatus {
  if (file.oldPath === '/dev/null') return 'added'
  if (file.newPath === '/dev/null') return 'deleted'
  if (file.oldPath !== file.newPath) return 'renamed'
  return 'modified'
}

// ── Git Integration ─────────────────────────────────────────────────────────

/**
 * Get the current git diff (unstaged changes).
 */
export function getGitDiff(cwd: string, staged = false): string {
  try {
    const cmd = staged ? 'git diff --cached' : 'git diff'
    return execSync(cmd, {
      cwd, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'],
      maxBuffer: 10 * 1024 * 1024,
    })
  } catch {
    return ''
  }
}

/**
 * Get diff between HEAD and working tree.
 */
export function getFullDiff(cwd: string): string {
  try {
    return execSync('git diff HEAD', {
      cwd, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'],
      maxBuffer: 10 * 1024 * 1024,
    })
  } catch {
    return ''
  }
}

/**
 * Get diff for a specific file.
 */
export function getFileDiff(cwd: string, filePath: string): string {
  try {
    return execSync(`git diff -- "${filePath}"`, {
      cwd, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'],
      maxBuffer: 10 * 1024 * 1024,
    })
  } catch {
    return ''
  }
}

// ── Formatting ──────────────────────────────────────────────────────────────

const STATUS_ICONS: Record<FileStatus, string> = {
  added: '✚',
  modified: '✎',
  deleted: '✖',
  renamed: '➜',
  copied: '⧉',
  unmerged: '⚠',
}

const STATUS_COLORS: Record<FileStatus, string> = {
  added: '\x1b[32m',     // green
  modified: '\x1b[33m',  // yellow
  deleted: '\x1b[31m',   // red
  renamed: '\x1b[35m',   // magenta
  copied: '\x1b[35m',    // magenta
  unmerged: '\x1b[31m',  // red
}

/**
 * Format a summary of all changed files (file list view).
 */
export function formatFileList(diff: StructuredDiff): string {
  if (diff.totalFiles === 0) {
    return 'No changes detected.'
  }

  const lines: string[] = [
    `Changes: ${diff.totalFiles} file(s), +${diff.totalAdditions} -${diff.totalDeletions}`,
    '',
  ]

  for (let i = 0; i < diff.files.length; i++) {
    const file = diff.files[i]
    const icon = STATUS_ICONS[file.status]
    const color = STATUS_COLORS[file.status]
    const reset = '\x1b[0m'
    const add = `\x1b[32m+${file.additions}${reset}`
    const del = `\x1b[31m-${file.deletions}${reset}`
    const path = file.status === 'renamed'
      ? `${file.oldPath} → ${file.newPath}`
      : file.newPath

    lines.push(`  ${color}${icon}${reset} ${i + 1}. ${path} ${add} ${del}`)

    if (file.isBinary) {
      lines.push(`     ${color}(binary)${reset}`)
    }
  }

  lines.push('')
  lines.push('\x1b[2mUse /diff <n> to view details for a specific file\x1b[0m')

  return lines.join('\n')
}

/**
 * Format detailed view of a specific file's diff.
 */
export function formatFileDetail(diff: StructuredDiff, fileIndex: number): string {
  if (fileIndex < 0 || fileIndex >= diff.files.length) {
    return `Invalid file index: ${fileIndex}. Range: 0-${diff.files.length - 1}`
  }

  const file = diff.files[fileIndex]
  const lines: string[] = []

  const icon = STATUS_ICONS[file.status]
  const color = STATUS_COLORS[file.status]
  const reset = '\x1b[0m'

  lines.push(`${color}${icon} ${file.newPath}${reset}`)
  lines.push(`  ${file.additions} addition(s), ${file.deletions} deletion(s), ${file.hunks.length} hunk(s)`)
  lines.push('')

  if (file.isBinary) {
    lines.push('  (Binary file — no textual diff)')
    return lines.join('\n')
  }

  for (const hunk of file.hunks) {
    lines.push(`\x1b[36m${hunk.header}\x1b[0m`)

    for (const dl of hunk.lines) {
      switch (dl.type) {
        case 'add':
          lines.push(`\x1b[32m+${dl.newLineNo ?? ''}\x1b[0m ${dl.content}`)
          break
        case 'remove':
          lines.push(`\x1b[31m-${dl.oldLineNo ?? ''}\x1b[0m ${dl.content}`)
          break
        case 'context':
          lines.push(`\x1b[2m ${dl.oldLineNo ?? ''}\x1b[0m ${dl.content}`)
          break
        case 'no-newline':
          lines.push(`\x1b[2m${dl.content}\x1b[0m`)
          break
      }
    }
    lines.push('')
  }

  return lines.join('\n')
}

/**
 * Format a diffstat histogram.
 * Each file shows a bar like: src/engine.ts | 15 +++++++++++++++
 */
export function formatDiffStat(diff: StructuredDiff): string {
  if (diff.totalFiles === 0) return 'No changes.'

  // Calculate max filename length for alignment
  const maxNameLen = Math.max(...diff.files.map(f => f.newPath.length), 10)

  const lines: string[] = [` ${'File'.padEnd(maxNameLen)} | ${'Changes'}`]
  lines.push(` ${'─'.repeat(maxNameLen)}─┼─${'─'.repeat(20)}`)

  for (const file of diff.files) {
    const name = file.newPath.padEnd(maxNameLen)
    const total = file.additions + file.deletions
    lines.push(` ${name} | ${total} \x1b[32m${'+'.repeat(Math.min(file.additions, 20))}\x1b[0m\x1b[31m${'-'.repeat(Math.min(file.deletions, 20))}\x1b[0m`)
  }

  lines.push(` ${'─'.repeat(maxNameLen)}─┴─${'─'.repeat(20)}`)
  lines.push(` ${diff.totalFiles} file(s) changed, ${diff.totalAdditions} insertion(s)(+), ${diff.totalDeletions} deletion(s)(-)`)

  return lines.join('\n')
}

/**
 * Get a brief one-line summary.
 */
export function formatBriefSummary(diff: StructuredDiff): string {
  if (diff.totalFiles === 0) return 'clean'
  return `${diff.totalFiles} file(s): +${diff.totalAdditions} -${diff.totalDeletions}`
}
