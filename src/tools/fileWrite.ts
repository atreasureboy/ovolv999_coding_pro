/**
 * FileWriteTool — write/create files
 * Reference: src/tools/FileWriteTool/
 */

import { existsSync } from 'fs'
import { readFile } from 'fs/promises'
import type { Tool, ToolContext, ToolDefinition, ToolResult } from '../core/types.js'
import type { ResourceClaim } from '../core/executionRun.js'
import { WRITE_FILE_DESCRIPTION } from '../prompts/tools.js'
import { hasFileBeenRead, hasFileChanged, markFileRead } from '../core/fileState.js'
import { atomicWrite } from '../core/atomicWrite.js'

export interface WriteFileInput {
  file_path: string
  content: string
}

export class FileWriteTool implements Tool {
  name = 'Write'
  metadata = {
    mutatesState: true,
    concurrencySafe: false,
    // GAP-D: per-input claim. Writes need an exclusive lease on the
    // target file to prevent concurrent Read/Edit/Write from racing.
    claims: (input: Record<string, unknown>): ResourceClaim[] => {
      const p = input.file_path
      return typeof p === 'string' && p
        ? [{ type: 'file', key: p, access: 'write' }]
        : []
    },
  }

  definition: ToolDefinition = {
    type: 'function',
    function: {
      name: 'Write',
      description: WRITE_FILE_DESCRIPTION,
      parameters: {
        type: 'object',
        properties: {
          file_path: {
            type: 'string',
            description: 'Absolute path to write to',
          },
          content: {
            type: 'string',
            description: 'Content to write',
          },
        },
        required: ['file_path', 'content'],
      },
    },
  }

  async execute(input: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
    const { file_path, content } = input as unknown as WriteFileInput

    if (!file_path || typeof file_path !== 'string') {
      return { content: 'Error: file_path is required', isError: true }
    }
    if (typeof content !== 'string') {
      return { content: 'Error: content must be a string', isError: true }
    }

    // Enforce read-before-overwrite for existing files (like Claude Code)
    if (existsSync(file_path) && !hasFileBeenRead(file_path)) {
      return {
        content: `Error: ${file_path} already exists. You must Read it first before overwriting. Use the Read tool.`,
        isError: true,
      }
    }

    // Staleness detection — two layers, mtime+size THEN content hash.
    //
    // ── TOCTOU window coverage map ──────────────────────────────────────
    // FileWrite has a NARROWER TOCTOU window than FileEdit (it's overwrite,
    // not read-modify-write), but the cache-level check below is the ONLY
    // barrier against external writers silently being overwritten. We
    // must be especially thorough here: read the file, pass its content
    // to hasFileChanged, and let the hash layer catch same-mtime/same-size
    // replacements.
    //
    //   A. before this function   → user-side FileRead populates the cache
    //   B. between readFile here
    //      and atomicWrite below → NOT GUARDED. Closing this would
    //                              require file-locking or a CAS retry
    //                              loop. We accept this microsecond gap
    //                              because the cost of locking on every
    //                              Write is high.
    //
    // If the readFile itself fails (EACCES / EISDIR / ENOENT-race), we
    // refuse outright rather than fall through — overwriting a file we
    // couldn't verify is exactly the silent-overwrite scenario this guard
    // exists to prevent.
    // ─────────────────────────────────────────────────────────────────────
    if (existsSync(file_path) && hasFileBeenRead(file_path)) {
      let currentContent: string
      try {
        currentContent = await readFile(file_path, 'utf8')
      } catch (err) {
        const error = err as NodeJS.ErrnoException
        return {
          content:
            `Error: cannot read ${file_path} to verify it has not changed ` +
            `(${error.message}, code: ${error.code ?? 'unknown'}). ` +
            `Refusing to overwrite without staleness check.`,
          isError: true,
        }
      }
      if (hasFileChanged(file_path, currentContent)) {
        return {
          content: `Error: ${file_path} has been modified since you last read it (by a linter, formatter, or the user). Read the file again before overwriting to avoid losing changes.`,
          isError: true,
        }
      }
    }

    // Back up the file before modifying (undo/checkpoint support)
    context.fileHistory?.trackEdit(file_path)

    try {
      // Atomic write: write to a uniquely-suffixed tmp file in the same
      // directory, then rename over the target. The rename is atomic on POSIX,
      // so a crash mid-write never leaves the target half-written.
      await atomicWrite(file_path, content)

      // Refresh the file-state cache with the just-written content so:
      //   - subsequent Read sees "File unchanged" without re-reading
      //   - subsequent Write/Edit hash-checks against this baseline
      // Pass `content` (the bytes we just wrote) to populate the hash.
      markFileRead(file_path, content)

      // Line count: strip one trailing newline so "hello\n" = 1 line, not 2
      const lines = content.endsWith('\n') ? content.slice(0, -1).split('\n').length : content.split('\n').length
      return {
        content: `File written: ${file_path} (${lines} lines, ${content.length} bytes)`,
        isError: false,
      }
    } catch (err: unknown) {
      const error = err as NodeJS.ErrnoException
      if (error.code === 'EISDIR') {
        return { content: `Error: ${file_path} is a directory, not a file.`, isError: true }
      }
      return { content: `Error writing file: ${error.message} (code: ${error.code ?? 'unknown'})`, isError: true }
    }
  }
}
