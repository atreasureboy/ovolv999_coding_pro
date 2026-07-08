/**
 * FileWriteTool — write/create files
 * Reference: src/tools/FileWriteTool/
 */

import { writeFile, mkdir } from 'fs/promises'
import { existsSync } from 'fs'
import { dirname } from 'path'
import type { Tool, ToolContext, ToolDefinition, ToolResult } from '../core/types.js'
import { WRITE_FILE_DESCRIPTION } from '../prompts/tools.js'
import { hasFileBeenRead, hasFileChanged } from '../core/fileState.js'

export interface WriteFileInput {
  file_path: string
  content: string
}

export class FileWriteTool implements Tool {
  name = 'Write'

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

    // Staleness detection: reject if file was modified externally since last Read
    // (prevents silent overwrite of linter/formatter/user changes)
    if (existsSync(file_path) && hasFileBeenRead(file_path) && hasFileChanged(file_path)) {
      return {
        content: `Error: ${file_path} has been modified since you last read it (by a linter, formatter, or the user). Read the file again before overwriting to avoid losing changes.`,
        isError: true,
      }
    }

    // Back up the file before modifying (undo/checkpoint support)
    context.fileHistory?.trackEdit(file_path)

    try {
      // Ensure parent directory exists
      await mkdir(dirname(file_path), { recursive: true })
      await writeFile(file_path, content, 'utf8')

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
