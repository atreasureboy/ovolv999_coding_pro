/**
 * FileReadTool — read file contents with line numbers
 * Reference: src/tools/FileReadTool/
 */

import { readFile, stat } from 'fs/promises'
import { readdirSync, openSync, readSync, closeSync } from 'fs'
import { isAbsolute, resolve, dirname, basename, join, extname } from 'path'
import type { Tool, ToolContext, ToolDefinition, ToolResult } from '../core/types.js'
import { containsNullByte } from '../core/pathSecurity.js'
import type { ResourceClaim } from '../core/executionRun.js'
import { READ_FILE_DESCRIPTION } from '../prompts/tools.js'
import { markFileRead, hasFileChanged, hasFileBeenRead } from '../core/fileState.js'

export interface ReadFileInput {
  file_path: string
  offset?: number
  limit?: number
}

const MAX_LINES_DEFAULT = 2000
const MAX_FILE_SIZE_BYTES = 25_000_000 // 25MB — refuse larger, point to offset/limit
/**
 * Round 37 (opencode read hardening): one 100KB minified line would
 * otherwise flow verbatim into the context window. Lines beyond this many
 * characters are truncated with a marker; the full file stays reachable
 * via Bash.
 */
const MAX_LINE_CHARS = 2000
/** Sample size for the pre-read binary sniff (bytes). */
const BINARY_SNIFF_BYTES = 1024

/** Extensions that are binary by definition — skip the sniff entirely. */
const BINARY_EXTENSIONS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico', '.bmp', '.tiff',
  '.pdf', '.zip', '.gz', '.tgz', '.tar', '.7z', '.rar', '.bz2', '.xz',
  '.exe', '.dll', '.so', '.dylib', '.bin', '.o', '.a', '.class', '.jar',
  '.pyc', '.pyo', '.wasm', '.mp3', '.mp4', '.mov', '.avi', '.webm',
  '.ogg', '.flac', '.ttf', '.otf', '.woff', '.woff2', '.eot',
  '.sqlite', '.db', '.pack', '.idx',
])

/**
 * Sniff the first BINARY_SNIFF_BYTES of a file for NUL bytes without
 * loading the whole thing — a 25MB binary previously rode readFile into
 * memory before the in-content check could reject it. Best-effort: any
 * I/O failure falls through to the normal read path.
 */
function sniffBinary(filePath: string): boolean | null {
  let fd: number | null = null
  try {
    fd = openSync(filePath, 'r')
    const buf = Buffer.alloc(BINARY_SNIFF_BYTES)
    const n = readSync(fd, buf, 0, BINARY_SNIFF_BYTES, 0)
    return buf.subarray(0, Math.max(0, n)).includes(0)
  } catch {
    return null
  } finally {
    if (fd !== null) {
      try { closeSync(fd) } catch { /* best-effort */ }
    }
  }
}

/**
 * Levenshtein distance (classic DP, bounded early-exit). Used only for
 * the ENOENT "did you mean" hint, so paths stay short and the O(n*m)
 * cost is trivial.
 */
function levenshtein(a: string, b: string, cap: number): number {
  if (Math.abs(a.length - b.length) > cap) return cap + 1
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i)
  for (let i = 1; i <= a.length; i++) {
    const curr: number[] = [i]
    let rowMin = i
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1
      const v = Math.min(prev[j] + 1, curr[j - 1] + 1, (prev[j - 1] ?? 0) + cost)
      curr.push(v)
      if (v < rowMin) rowMin = v
    }
    if (rowMin > cap) return cap + 1
    prev = curr
  }
  return prev[b.length] ?? cap + 1
}

/**
 * Suggest a sibling of `target` from its parent directory when the names
 * are close (typo tolerance, opencode's "Did you mean" pattern). Returns
 * an absolute path, or undefined when the parent is unreadable, empty, or
 * nothing is similar enough — a wrong guess is worse than no guess.
 */
function suggestSimilarPath(target: string): string | undefined {
  try {
    const parent = dirname(target)
    const wanted = basename(target)
    if (!wanted) return undefined
    let entries: string[]
    try {
      entries = readdirSync(parent)
    } catch {
      return undefined
    }
    const cap = Math.max(1, Math.min(3, Math.floor(wanted.length / 3)))
    let best: string | undefined
    let bestDist = cap + 1
    for (const entry of entries.slice(0, 1000)) {
      if (entry === wanted) return undefined // exists but unreadable → not a typo
      const d = levenshtein(wanted.toLowerCase(), entry.toLowerCase(), cap)
      if (d < bestDist) {
        bestDist = d
        best = entry
      }
    }
    return best ? join(parent, best) : undefined
  } catch {
    return undefined
  }
}

/** Async, best-effort LSP warmup — see the call site for the contract. */
async function warmLsp(filePath: string, cwd: string): Promise<void> {
  try {
    const { warmLspForFile } = await import('./lspTool.js')
    warmLspForFile(filePath, cwd)
  } catch {
    /* best-effort */
  }
}

export class FileReadTool implements Tool {
  name = 'Read'
  metadata = {
    readOnly: true,
    concurrencySafe: true,
    // GAP-D: per-input claim. Read tools take a 'read' lease on the
    // target file so they serialize against 'write'/'exclusive'
    // holders (Edit, Write, Bash touching the same path).
    claims: (input: Record<string, unknown>): ResourceClaim[] => {
      const p = input.file_path
      return typeof p === 'string' && p
        ? [{ type: 'file', key: p, access: 'read' }]
        : []
    },
  }

  definition: ToolDefinition = {
    type: 'function',
    function: {
      name: 'Read',
      description: READ_FILE_DESCRIPTION,
      parameters: {
        type: 'object',
        properties: {
          file_path: {
            type: 'string',
            description: 'Absolute path to the file to read',
          },
          offset: {
            type: 'number',
            description: 'Line number to start reading from (1-indexed)',
          },
          limit: {
            type: 'number',
            description: 'Maximum number of lines to read',
          },
        },
        required: ['file_path'],
      },
    },
  }

  async execute(input: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
    const { file_path: rawPath, offset, limit } = input as Partial<ReadFileInput>

    // Round 32 (F20): relative paths resolve against the context cwd —
    // parity with Write/Edit (worktree-resident children).
    const file_path = rawPath && !isAbsolute(rawPath) ? resolve(context.cwd, rawPath) : rawPath

    if (!file_path || typeof file_path !== 'string') {
      return { content: 'Error: file_path is required', isError: true }
    }

    if (containsNullByte(file_path)) {
      return { content: 'Error: file_path contains a NUL byte — rejected', isError: true }
    }

    try {
      // File unchanged detection (Claude Code pattern) — skip re-reading if not modified
      // Only applies to full reads (no offset/limit) of previously-read files.
      // Use === undefined (not falsy) so offset:0 is treated as "read from line 0"
      if (offset === undefined && limit === undefined && hasFileBeenRead(file_path) && !hasFileChanged(file_path)) {
        return {
          content: `File: ${file_path}\nFile unchanged since last read. The content from the earlier Read is still current.`,
          isError: false,
        }
      }

      // Size guard — prevent OOM on very large files (binary detection reads
      // the entire file into memory, so we must check size first)
      let fileSize: number | undefined
      try {
        const fstat = await stat(file_path)
        fileSize = fstat.size
      } catch { /* will be caught by readFile below */ }
      if (fileSize !== undefined && fileSize > MAX_FILE_SIZE_BYTES) {
        return {
          content: `File: ${file_path} (${(fileSize / 1_000_000).toFixed(1)}MB) is too large to read in full. Use offset and limit parameters to read a portion, e.g. Read({ file_path: "${file_path}", offset: 1, limit: 200 }).`,
          isError: true,
        }
      }

      // Round 37: binary rejection BEFORE lifting content into memory —
      // extension fast path, then a 1KB magic-byte sniff. The in-content
      // NUL check below stays as the safety net.
      const binaryNotice = `File: ${file_path}\n(Binary file — not displayed. Use Bash to process: \`xxd\`, \`file\`, or \`strings\`)`
      if (BINARY_EXTENSIONS.has(extname(file_path).toLowerCase())) {
        markFileRead(file_path)
        return { content: binaryNotice, isError: false }
      }
      if (sniffBinary(file_path) === true) {
        markFileRead(file_path)
        return { content: binaryNotice, isError: false }
      }

      const raw0 = await readFile(file_path, 'utf8')
      // Round 43 (polish): strip a UTF-8 BOM — the model copies rendered
      // lines verbatim into Edit's old_string; a hidden \uFEFF makes that
      // exact match fail forever with no visible reason.
      const raw = raw0.charCodeAt(0) === 0xFEFF ? raw0.slice(1) : raw0

      // Binary file detection — check for null bytes in first 8000 chars.
      // For binary files we still mark as read (so hasFileBeenRead works)
      // but skip the content-hash layer — hashing a Buffer-as-utf8 distorts
      // the byte content vs how a later Writer would re-hash it.
      const sample = raw.slice(0, 8000)
      if (sample.includes('\0')) {
        markFileRead(file_path)
        return {
          content: `File: ${file_path}\n(Binary file — not displayed. Use Bash to process: \`xxd\`, \`file\`, or \`strings\`)`,
          isError: false,
        }
      }

      const lines = raw.split('\n')
      const total = lines.length

      // Handle empty files — don't render a phantom "1\t" line. Pass the
      // empty string so the cache hash matches a later "" write.
      if (total === 1 && lines[0] === '') {
        markFileRead(file_path, raw)
        return {
          content: `File: ${file_path} (empty file, 0 bytes)`,
          isError: false,
        }
      }

      const startLine = typeof offset === 'number' ? Math.max(1, offset) : 1
      const maxLines = typeof limit === 'number' ? limit : MAX_LINES_DEFAULT
      const endLine = Math.min(startLine - 1 + maxLines, total)

      const slice = lines.slice(startLine - 1, endLine)
      const numbered = slice
        .map((line, i) => {
          let shown: string
          if (line.length > MAX_LINE_CHARS) {
            // Round 41 audit fix: never split a surrogate pair at the cut
            // — a lone high surrogate rendered as a replacement char.
            let cut = MAX_LINE_CHARS
            const boundary = line.charCodeAt(cut - 1)
            if (boundary >= 0xD800 && boundary <= 0xDBFF) cut--
            shown = `${line.slice(0, cut)} … [line truncated — ${line.length.toLocaleString()} chars total]`
          } else {
            shown = line
          }
          return `${startLine + i}\t${shown}`
        })
        .join('\n')

      const header =
        total > maxLines
          ? `File: ${file_path} (showing lines ${startLine}-${endLine} of ${total})\nUse offset=${endLine + 1} to read next page.\n`
          : `File: ${file_path}\n`

      markFileRead(file_path, raw)

      // Round 40 (opencode read→LSP warmup): fire-and-forget background
      // warmup of the matching language server. Dynamic import keeps the
      // eager tool path light (LSP machinery stays lazy); one attempt per
      // (cwd, server); failures never touch the Read result.
      void warmLsp(file_path, context.cwd)

      return { content: header + numbered, isError: false }
    } catch (err: unknown) {
      const error = err as NodeJS.ErrnoException
      if (error.code === 'ENOENT') {
        const hint = suggestSimilarPath(file_path)
        const didYouMean = hint ? ` Did you mean: ${hint}?` : ''
        return { content: `File not found: ${file_path}.${didYouMean} Use Glob with a broad pattern (e.g. "**/<basename>") to locate the correct path.`, isError: true }
      }
      if (error.code === 'EACCES') {
        return { content: `Permission denied: ${file_path}. Hint: check file permissions with Bash 'ls -la ${file_path}'.`, isError: true }
      }
      if (error.code === 'EISDIR') {
        return { content: `Path is a directory, not a file: ${file_path}. Use Glob to list directory contents.`, isError: true }
      }
      return { content: `Error reading file: ${error.message} (code: ${error.code ?? 'unknown'}). Hint: try Bash 'file ${file_path}' to check the file type.`, isError: true }
    }
  }
}
