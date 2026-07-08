/**
 * FileEditTool — exact string replacement in files
 * Reference: src/tools/FileEditTool/
 *
 * File edits must be EXACT string matches (including whitespace/indentation).
 * This prevents accidental changes and makes diffs reviewable.
 */

import { readFile, writeFile } from 'fs/promises'
import { existsSync } from 'fs'
import { dirname } from 'path'
import { execSync } from 'child_process'
import type { Tool, ToolContext, ToolDefinition, ToolResult } from '../core/types.js'
import { EDIT_FILE_DESCRIPTION } from '../prompts/tools.js'
import { hasFileBeenRead } from '../core/fileState.js'

export interface EditFileInput {
  file_path: string
  old_string: string
  new_string: string
  replace_all?: boolean
}

export class FileEditTool implements Tool {
  name = 'Edit'

  definition: ToolDefinition = {
    type: 'function',
    function: {
      name: 'Edit',
      description: EDIT_FILE_DESCRIPTION,
      parameters: {
        type: 'object',
        properties: {
          file_path: {
            type: 'string',
            description: 'Absolute path to the file to edit',
          },
          old_string: {
            type: 'string',
            description: 'Exact string to find (must be unique in the file unless replace_all=true)',
          },
          new_string: {
            type: 'string',
            description: 'Replacement string',
          },
          replace_all: {
            type: 'boolean',
            description: 'Replace all occurrences (default: false)',
          },
        },
        required: ['file_path', 'old_string', 'new_string'],
      },
    },
  }

  async execute(input: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
    const { file_path, old_string, new_string, replace_all } = input as unknown as EditFileInput

    if (!file_path || typeof file_path !== 'string') {
      return { content: 'Error: file_path is required', isError: true }
    }
    if (typeof old_string !== 'string') {
      return { content: 'Error: old_string must be a string', isError: true }
    }
    if (typeof new_string !== 'string') {
      return { content: 'Error: new_string must be a string', isError: true }
    }
    if (old_string === new_string) {
      return { content: 'Error: old_string and new_string are identical — no change needed', isError: true }
    }

    // Enforce read-before-edit (like Claude Code — prevents blind edits)
    if (existsSync(file_path) && !hasFileBeenRead(file_path)) {
      return {
        content: `Error: You must Read ${file_path} before editing it. Use the Read tool first to see the current contents.`,
        isError: true,
      }
    }

    try {
      const content = await readFile(file_path, 'utf8')

      const occurrences = countOccurrences(content, old_string)

      if (occurrences === 0) {
        // Provide diagnostic info to help the LLM fix its edit
        const suggestion = findClosestMatch(content, old_string)
        return {
          content: `Error: old_string not found in ${file_path}.\n${suggestion}`,
          isError: true,
        }
      }

      if (!replace_all && occurrences > 1) {
        return {
          content: `Error: old_string appears ${occurrences} times in ${file_path}. Provide more surrounding context to make it unique, or use replace_all=true.`,
          isError: true,
        }
      }

      const newContent = replace_all
        ? content.split(old_string).join(new_string)
        : content.replace(old_string, () => new_string) // arrow fn prevents $ pattern interpretation

      // Back up the file before modifying (undo/checkpoint support)
      context.fileHistory?.trackEdit(file_path)

      await writeFile(file_path, newContent, 'utf8')

      // Auto-format: detect prettier/eslint config in project and run after edit
      // Walk up from file's directory to find project root (where config files live)
      let projectRoot = dirname(file_path)
      for (let i = 0; i < 10; i++) {
        if (existsSync(`${projectRoot}/.prettierrc`) || existsSync(`${projectRoot}/.prettierrc.js`) ||
            existsSync(`${projectRoot}/eslint.config.js`) || existsSync(`${projectRoot}/.eslintrc`) ||
            existsSync(`${projectRoot}/.eslintrc.js`) || existsSync(`${projectRoot}/package.json`)) {
          break
        }
        const parent = dirname(projectRoot)
        if (parent === projectRoot) break
        projectRoot = parent
      }
      let formatNote = ''
      try {
        if (existsSync(`${projectRoot}/.prettierrc`) || existsSync(`${projectRoot}/.prettierrc.js`) || existsSync(`${projectRoot}/prettier.config.js`)) {
          execSync(`npx prettier --write "${file_path}" 2>&1`, { cwd: projectRoot, encoding: 'utf8', timeout: 10_000 })
          formatNote = ' (formatted with prettier)'
        } else if (existsSync(`${projectRoot}/.eslintrc`) || existsSync(`${projectRoot}/.eslintrc.js`) || existsSync(`${projectRoot}/eslint.config.js`)) {
          execSync(`npx eslint --fix "${file_path}" 2>&1`, { cwd: projectRoot, encoding: 'utf8', timeout: 10_000 })
          formatNote = ' (fixed with eslint)'
        }
      } catch { /* best-effort format — don't fail the edit */ }

      // Build a simple diff for display
      const oldLines = old_string.split('\n')
      const newLines = new_string.split('\n')
      const diffLines: string[] = []
      const maxLines = Math.max(oldLines.length, newLines.length)
      for (let i = 0; i < maxLines; i++) {
        const o = oldLines[i]
        const n = newLines[i]
        if (o !== undefined) diffLines.push(`- ${o}`)
        if (n !== undefined && n !== o) diffLines.push(`+ ${n}`)
      }
      const diff = diffLines.length > 0 ? `\n${diffLines.join('\n')}` : ''

      const count = replace_all ? occurrences : 1
      return {
        content: `Edited ${file_path}: replaced ${count} occurrence${count !== 1 ? 's' : ''}${formatNote}${diff}`,
        isError: false,
      }
    } catch (err: unknown) {
      const error = err as NodeJS.ErrnoException
      if (error.code === 'ENOENT') {
        return { content: `File not found: ${file_path}. Use Glob to locate it, or create it with Write first.`, isError: true }
      }
      return { content: `Error editing file: ${error.message} (code: ${error.code ?? 'unknown'})`, isError: true }
    }
  }
}

function countOccurrences(haystack: string, needle: string): number {
  if (!needle) return 0
  let count = 0
  let pos = 0
  while ((pos = haystack.indexOf(needle, pos)) !== -1) {
    count++
    pos += needle.length
  }
  return count
}

/**
 * Find a close match to help the LLM understand why the exact match failed.
 * Strips leading/trailing whitespace and checks if that version exists.
 */
function findClosestMatch(content: string, target: string): string {
  const trimmed = target.trim()
  if (content.includes(trimmed)) {
    return `Hint: A version with different whitespace was found. Check indentation — old_string must match exactly.`
  }

  // Try to find first non-trivial line of the target
  const firstLine = trimmed.split('\n')[0]?.trim()
  if (firstLine && firstLine.length > 10 && content.includes(firstLine)) {
    return `Hint: The first line "${firstLine.slice(0, 60)}..." exists in the file, but the surrounding context doesn't match. Read the file around that line to get the exact content.`
  }

  return `Hint: Use Read to view the current file content and ensure old_string matches exactly.`
}
