/**
 * FileReadTool — read file contents with line numbers
 * Reference: src/tools/FileReadTool/
 */

import { readFile, stat } from 'fs/promises'
import type { Tool, ToolContext, ToolDefinition, ToolResult } from '../core/types.js'
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

  async execute(input: Record<string, unknown>, _context: ToolContext): Promise<ToolResult> {
    const { file_path, offset, limit } = input as unknown as ReadFileInput

    if (!file_path || typeof file_path !== 'string') {
      return { content: 'Error: file_path is required', isError: true }
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

      const raw = await readFile(file_path, 'utf8')

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
        .map((line, i) => `${startLine + i}\t${line}`)
        .join('\n')

      const header =
        total > maxLines
          ? `File: ${file_path} (showing lines ${startLine}-${endLine} of ${total})\nUse offset=${endLine + 1} to read next page.\n`
          : `File: ${file_path}\n`

      markFileRead(file_path, raw)

      return { content: header + numbered, isError: false }
    } catch (err: unknown) {
      const error = err as NodeJS.ErrnoException
      if (error.code === 'ENOENT') {
        return { content: `File not found: ${file_path}. Use Glob with a broad pattern (e.g. "**/<basename>") to locate the correct path.`, isError: true }
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
