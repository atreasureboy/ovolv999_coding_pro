/**
 * CodeReviewTool — deterministic code review of changed files.
 *
 * Reviews a set of file changes (paths + optional new content) using
 * pure heuristics: secrets, debug leftovers, unsafe patterns, markers,
 * nesting depth, duplication, swallowed errors. No LLM call — instant
 * and deterministic. Use after MultiEdit/Edit to catch issues before
 * the agent moves on.
 */

import type { Tool, ToolDefinition, ToolResult, ToolContext } from '../core/types.js'
import { reviewChanges, formatReviewReport, readChangesFromDisk } from '../core/codeReview.js'

export interface CodeReviewInput {
  /** Files to review. Each entry: { file: relative path, newContent?: string } */
  files: Array<{ file: string; newContent?: string }>
  /** Base directory for resolving relative paths. Default cwd. */
  baseDir?: string
}

export class CodeReviewTool implements Tool {
  name = 'CodeReview'
  metadata = {
    readOnly: true,
    concurrencySafe: true,
    searchHint: 'review inspect changed code for secrets bugs safety quality',
  }

  definition: ToolDefinition = {
    type: 'function',
    function: {
      name: 'CodeReview',
      description: `Deterministically review code changes for common issues before finalizing work.

Scans the given files (or all changed files if none specified) for:
- Hardcoded secrets / API keys / tokens (BLOCKER)
- Unsafe patterns: eval(), shell injection, innerHTML, shell=True (BLOCKER)
- Debug leftovers: console.log, debugger, print(), fmt.Println (WARNING)
- Excessive nesting depth > 8 (WARNING)
- Duplicated code blocks (WARNING)
- Empty catch blocks swallowing errors (WARNING)
- TODO/FIXME/HACK markers (INFO)

Input:
- files: array of { file: relative path, newContent?: optional new content }.
  If newContent is omitted, the current on-disk content is reviewed.
- baseDir: directory for resolving relative file paths (default: cwd).

Returns a review score (0-100) plus severity-ranked findings.
Read-only and instant (no LLM call) — run it after editing to self-check.`,
      parameters: {
        type: 'object',
        properties: {
          files: {
            type: 'array',
            description: 'Files to review as {file, newContent?} objects',
            items: {
              type: 'object',
              properties: {
                file: { type: 'string' },
                newContent: { type: 'string' },
              },
            },
          },
          baseDir: { type: 'string' },
        },
      },
    },
  }

  async execute(input: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
    const { files, baseDir } = input as unknown as CodeReviewInput
    const cwd = (context as { cwd?: string }).cwd ?? process.cwd()
    const root = baseDir ?? cwd

    if (!Array.isArray(files) || files.length === 0) {
      return { content: 'Error: files must be a non-empty array', isError: true }
    }
    if (files.length > 50) {
      return { content: 'Error: maximum 50 files per review', isError: true }
    }

    // Build changes: read on-disk content when newContent omitted.
    const changes = readChangesFromDisk(root, files)
    const report = reviewChanges(changes)
    const text = formatReviewReport(report, root)

    return { content: text, isError: false }
  }
}
