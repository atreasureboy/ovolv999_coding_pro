/**
 * Smart File Detection
 *
 * Detects file references in user prompts and provides file content
 * as automatic context. Supports:
 *   - Absolute paths: /path/to/file.ts
 *   - Relative paths: src/engine.ts
 *   - Bare filenames: engine.ts
 *   - Line ranges: file.ts:10-20
 *   - Multiple files: a.ts, b.ts, c.ts
 *
 * Unlike @-mention (which is explicit), this is automatic — the user
 * just types naturally and we detect file references.
 */

import { existsSync, readFileSync, statSync } from 'fs'
import { join, resolve, extname, basename, relative, dirname } from 'path'
import { execSync } from 'child_process'

// ── Types ───────────────────────────────────────────────────────────────────

export interface FileReference {
  /** The matched text in the prompt */
  raw: string
  /** Resolved absolute path */
  path: string
  /** Start offset in original text */
  start: number
  /** End offset */
  end: number
  /** Optional line range */
  lineStart?: number
  lineEnd?: number
  /** Whether the file exists */
  exists: boolean
  /** Whether it's a directory */
  isDirectory: boolean
  /** Whether it was found by bare name (not a path) */
  isBareName: boolean
}

export interface FileContext {
  /** File reference */
  reference: FileReference
  /** Content (null for binary or non-existent files) */
  content: string | null
  /** Line count */
  lineCount: number
  /** File extension */
  extension: string
  /** Whether content was truncated */
  truncated: boolean
  /** Error message if couldn't read */
  error?: string
}

export interface DetectionOptions {
  /** Working directory */
  cwd?: string
  /** Max file size to include (bytes, default 100KB) */
  maxFileSize?: number
  /** Max lines per file (default 500) */
  maxLines?: number
  /** Whether to search for bare names via git ls-files */
  searchBareNames?: boolean
  /** Extensions to consider as code files */
  codeExtensions?: Set<string>
}

export const DEFAULT_OPTIONS: Required<DetectionOptions> = {
  cwd: process.cwd(),
  maxFileSize: 100 * 1024,
  maxLines: 500,
  searchBareNames: true,
  codeExtensions: new Set([
    '.ts', '.tsx', '.js', '.jsx', '.py', '.rb', '.go', '.rs',
    '.java', '.c', '.cpp', '.h', '.hpp', '.cs', '.php',
    '.json', '.yaml', '.yml', '.toml', '.md', '.txt', '.sh',
  ]),
}

// ── Detection ───────────────────────────────────────────────────────────────

/**
 * Detect file references in a text prompt.
 */
export function detectFileReferences(text: string, options: DetectionOptions = {}): FileReference[] {
  const opts = { ...DEFAULT_OPTIONS, ...options }
  const refs: FileReference[] = []

  // Pattern 1: Path with line range — file.ext:10-20 or file.ext:10
  const lineRangePattern = /\b([\w./-]+\.\w+):(\d+)(?:-(\d+))?\b/g

  // Pattern 2: Path-like strings — src/path/file.ext or /abs/path/file.ext
  const pathPattern = /(?<=[\s'"`(]|^)(\.?\/?[\w-]+(?:\/[\w-]+)+\.\w+)/g

  // Pattern 3: Bare filenames — file.ext (at word boundaries)
  const bareNamePattern = /\b([\w-]+\.\w{1,10})\b/g

  const found = new Set<string>()

  // Try line range pattern first (most specific)
  let match: RegExpExecArray | null
  while ((match = lineRangePattern.exec(text)) !== null) {
    const raw = match[0]
    if (found.has(raw)) continue
    found.add(raw)

    const filePath = match[1]
    const lineStart = parseInt(match[2], 10)
    const lineEnd = match[3] ? parseInt(match[3], 10) : lineStart

    const resolved = resolvePath(filePath, opts.cwd)
    if (resolved) {
      refs.push({
        raw,
        path: resolved.path,
        start: match.index,
        end: match.index + raw.length,
        lineStart,
        lineEnd,
        exists: resolved.exists,
        isDirectory: resolved.isDirectory,
        isBareName: false,
      })
    }
  }

  // Try path pattern (multi-segment paths)
  while ((match = pathPattern.exec(text)) !== null) {
    const raw = match[0]
    if (found.has(raw)) continue
    found.add(raw)

    const resolved = resolvePath(raw, opts.cwd)
    if (resolved && resolved.exists) {
      refs.push({
        raw,
        path: resolved.path,
        start: match.index,
        end: match.index + raw.length,
        exists: true,
        isDirectory: resolved.isDirectory,
        isBareName: false,
      })
    }
  }

  // Try bare names (less specific, only if file exists)
  if (opts.searchBareNames) {
    const gitFiles = getGitFiles(opts.cwd)
    while ((match = bareNamePattern.exec(text)) !== null) {
      const raw = match[0]
      if (found.has(raw)) continue

      const ext = extname(raw).toLowerCase()
      if (!opts.codeExtensions.has(ext)) continue

      // Try to find this file via git ls-files
      const matching = gitFiles.filter(f => basename(f) === raw)
      if (matching.length === 1) {
        found.add(raw)
        const fullPath = join(opts.cwd, matching[0])
        try {
          const stat = statSync(fullPath)
          refs.push({
            raw,
            path: fullPath,
            start: match.index,
            end: match.index + raw.length,
            exists: true,
            isDirectory: stat.isDirectory(),
            isBareName: true,
          })
        } catch { /* skip */ }
      } else if (matching.length > 1) {
        // Ambiguous — skip (could disambiguate later)
      } else {
        // Try direct path
        const directPath = join(opts.cwd, raw)
        if (existsSync(directPath)) {
          found.add(raw)
          refs.push({
            raw,
            path: directPath,
            start: match.index,
            end: match.index + raw.length,
            exists: true,
            isDirectory: false,
            isBareName: true,
          })
        }
      }
    }
  }

  // Sort by position
  refs.sort((a, b) => a.start - b.start)

  // Remove overlapping (keep longer match)
  return removeOverlaps(refs)
}

function resolvePath(input: string, cwd: string): { path: string; exists: boolean; isDirectory: boolean } | null {
  let abs: string
  if (input.startsWith('/')) {
    abs = input
  } else if (input.startsWith('./') || input.startsWith('../')) {
    abs = resolve(cwd, input)
  } else {
    abs = resolve(cwd, input)
  }

  const exists = existsSync(abs)
  if (!exists) return null

  try {
    const stat = statSync(abs)
    return { path: abs, exists: true, isDirectory: stat.isDirectory() }
  } catch {
    return null
  }
}

function removeOverlaps(refs: FileReference[]): FileReference[] {
  const result: FileReference[] = []
  let lastEnd = 0
  for (const ref of refs) {
    if (ref.start >= lastEnd) {
      result.push(ref)
      lastEnd = ref.end
    }
  }
  return result
}

// ── Git Files Cache ─────────────────────────────────────────────────────────

let gitFilesCache: { cwd: string; files: string[]; time: number } | null = null
const GIT_FILES_CACHE_MS = 5000

function getGitFiles(cwd: string): string[] {
  if (gitFilesCache && gitFilesCache.cwd === cwd && Date.now() - gitFilesCache.time < GIT_FILES_CACHE_MS) {
    return gitFilesCache.files
  }

  try {
    const output = execSync('git ls-files', {
      cwd, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 3000,
    }).trim()
    const files = output ? output.split('\n') : []
    gitFilesCache = { cwd, files, time: Date.now() }
    return files
  } catch {
    gitFilesCache = null
    return []
  }
}

// ── Context Loading ─────────────────────────────────────────────────────────

/**
 * Load file content for detected references.
 */
export function loadFileContext(refs: FileReference[], options: DetectionOptions = {}): FileContext[] {
  const opts = { ...DEFAULT_OPTIONS, ...options }
  const contexts: FileContext[] = []

  for (const ref of refs) {
    if (!ref.exists || ref.isDirectory) {
      contexts.push({
        reference: ref,
        content: null,
        lineCount: 0,
        extension: extname(ref.path),
        truncated: false,
        error: ref.isDirectory ? 'Is a directory' : 'File not found',
      })
      continue
    }

    try {
      const stat = statSync(ref.path)
      if (stat.size > opts.maxFileSize) {
        contexts.push({
          reference: ref,
          content: null,
          lineCount: 0,
          extension: extname(ref.path),
          truncated: true,
          error: `File too large (${(stat.size / 1024).toFixed(1)}KB)`,
        })
        continue
      }

      const raw = readFileSync(ref.path, 'utf8')
      const allLines = raw.split('\n')

      // Apply line range if specified
      let lines = allLines
      let truncated = false
      if (ref.lineStart && ref.lineEnd) {
        lines = allLines.slice(ref.lineStart - 1, ref.lineEnd)
      } else if (ref.lineStart) {
        lines = [allLines[ref.lineStart - 1] ?? '']
      }

      // Truncate if too many lines
      if (lines.length > opts.maxLines) {
        lines = lines.slice(0, opts.maxLines)
        truncated = true
      }

      contexts.push({
        reference: ref,
        content: lines.join('\n'),
        lineCount: lines.length,
        extension: extname(ref.path),
        truncated,
      })
    } catch (err) {
      contexts.push({
        reference: ref,
        content: null,
        lineCount: 0,
        extension: extname(ref.path),
        truncated: false,
        error: (err as Error).message,
      })
    }
  }

  return contexts
}

// ── Prompt Augmentation ─────────────────────────────────────────────────────

/**
 * Augment a user prompt with detected file content.
 * Returns the original prompt with file context appended.
 */
export function augmentPromptWithFiles(prompt: string, options: DetectionOptions = {}): {
  augmentedPrompt: string
  detectedFiles: FileContext[]
  summary: string
} {
  const refs = detectFileReferences(prompt, options)
  const contexts = loadFileContext(refs, options)

  if (contexts.length === 0) {
    return { augmentedPrompt: prompt, detectedFiles: [], summary: 'No files detected.' }
  }

  const readable = contexts.filter(c => c.content !== null)
  if (readable.length === 0) {
    return {
      augmentedPrompt: prompt,
      detectedFiles: contexts,
      summary: `${contexts.length} file(s) detected but none readable`,
    }
  }

  // Build augmented prompt
  const parts: string[] = [prompt, '', '--- Detected File Context ---']

  for (const ctx of readable) {
    const relPath = relative(options.cwd ?? process.cwd(), ctx.reference.path)
    const lineInfo = ctx.reference.lineStart
      ? ` (lines ${ctx.reference.lineStart}${ctx.reference.lineEnd ? `-${ctx.reference.lineEnd}` : ''})`
      : ''
    parts.push(``)
    parts.push(`File: ${relPath}${lineInfo}`)
    parts.push('```')
    parts.push(ctx.content!)
    parts.push('```')
    if (ctx.truncated) {
      parts.push('(truncated)')
    }
  }

  const summary = `${contexts.length} file(s) detected: ${readable.map(c => relative(options.cwd ?? process.cwd(), c.reference.path)).join(', ')}`

  return {
    augmentedPrompt: parts.join('\n'),
    detectedFiles: contexts,
    summary,
  }
}

// ── Highlighting ────────────────────────────────────────────────────────────

/**
 * Highlight file references in text for display.
 */
export function highlightFileReferences(text: string, refs: FileReference[]): string {
  if (refs.length === 0) return text

  // Sort by position descending (replace from end)
  const sorted = [...refs].sort((a, b) => b.start - a.start)
  const chars = text.split('')

  for (const ref of sorted) {
    const highlight = ref.exists ? '\x1b[36m' : '\x1b[33m'
    const replacement = `${highlight}${ref.raw}\x1b[0m`
    chars.splice(ref.start, ref.end - ref.start, replacement)
  }

  return chars.join('')
}
