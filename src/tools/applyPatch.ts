/**
 * ApplyPatchTool — unified multi-file patch application (codex style).
 *
 * Applies patches in the `*** Begin Patch ... *** End Patch` format used
 * by OpenAI Codex / apply_patch models. One patch may add, update, and
 * delete several files atomically-per-file:
 *
 *   *** Begin Patch
 *   *** Add File: path/to/new.ts
 *   +export const x = 1
 *   *** Update File: path/to/existing.ts
 *   @@
 *    context line kept
 *   -line removed
 *   +line added
 *   *** Delete File: path/to/obsolete.ts
 *   *** End Patch
 *
 * Update hunks are matched as line sequences: every non-'+', non-'@@'
 * hunk line (context and '-' lines) must appear contiguously in the
 * target file; '-' lines are removed, '+' lines inserted at their
 * position. Matching is exact (whitespace significant) and sequential
 * per file. Empty old-string errors carry a hint for the model.
 */

import { existsSync, readFileSync, unlinkSync } from 'fs'
import { isAbsolute, resolve } from 'path'
import type { Tool, ToolContext, ToolDefinition, ToolResult } from '../core/types.js'
import type { ResourceClaim } from '../core/executionRun.js'
import { atomicWrite } from '../core/atomicWrite.js'
import { markFileRead } from '../core/fileState.js'
import { isLoopDriverOwnedPath, containsNullByte } from '../core/pathSecurity.js'

export type PatchOp =
  | { type: 'add'; path: string; lines: string[] }
  | { type: 'update'; path: string; hunks: PatchHunk[] }
  | { type: 'delete'; path: string }

export interface PatchHunk {
  /** Lines to locate in the file: context (' ') + removal ('-') lines. */
  find: string[]
  /** Lines to replace them with: context (' ') + addition ('+') lines. */
  replace: string[]
}

export interface ParsedPatch {
  ops: PatchOp[]
}

/**
 * Parse an apply_patch document. Returns { ops } on success or throws
 * Error with a model-actionable message (line number where possible).
 */
export function parseApplyPatch(patch: string): ParsedPatch {
  // Round 41 audit fix: strip CR left by CRLF documents — directive lines
  // like "*** Update File: x\r" matched nothing and the whole patch was
  // rejected with a misleading error on the FIRST directive.
  const lines = patch.split('\n').map((l) => l.replace(/\r$/, ''))
  let i = 0
  // Skip leading blank lines before the Begin marker.
  while (i < lines.length && !(lines[i] ?? '').trim()) i++

  if ((lines[i] ?? '').trim() !== '*** Begin Patch') {
    throw new Error('Patch must start with "*** Begin Patch"')
  }
  i++

  const ops: PatchOp[] = []
  let current: PatchOp | null = null
  let sawEnd = false

  const flush = (): void => {
    if (!current) return
    if (current.type === 'update' && current.hunks.length === 0) {
      throw new Error(`"*** Update File: ${current.path}" has no @@ hunks`)
    }
    ops.push(current)
    current = null
  }

  for (; i < lines.length; i++) {
    const line = lines[i] ?? ''

    if (line.startsWith('*** ')) {
      flush()
      const header = line.slice(4)
      if (header === 'End Patch') {
        sawEnd = true
        break
      }
      const addMatch = /^Add File:\s*(.+)$/.exec(header)
      const updateMatch = /^Update File:\s*(.+)$/.exec(header)
      const deleteMatch = /^Delete File:\s*(.+)$/.exec(header)
      if (addMatch?.[1]) {
        current = { type: 'add', path: addMatch[1].trim(), lines: [] }
      } else if (updateMatch?.[1]) {
        current = { type: 'update', path: updateMatch[1].trim(), hunks: [] }
      } else if (deleteMatch?.[1]) {
        current = { type: 'delete', path: deleteMatch[1].trim() }
      } else {
        throw new Error(`Unknown patch directive at line ${i + 1}: "${line}"`)
      }
      continue
    }

    if (!current) {
      if (line.trim()) throw new Error(`Content outside any file section at line ${i + 1}`)
      continue
    }

    if (current.type === 'add') {
      // '+' prefix is canonical; tolerate unprefixed lines so a model
      // that emits the file body verbatim still applies cleanly.
      current.lines.push(line.startsWith('+') ? line.slice(1) : line)
      continue
    }

    if (current.type === 'update') {
      // Round 41 audit fix: only a BARE '@@' is a hunk separator. A
      // context line that literally starts with '@@' (diff-like files,
      // '@@interface' markers) previously got eaten as a separator and
      // silently vanished from the result.
      if (line === '@@') {
        current.hunks.push({ find: [], replace: [] })
        continue
      }
      const hunk = current.hunks[current.hunks.length - 1]
      if (!hunk) {
        throw new Error(`"*** Update File: ${current.path}" needs an @@ hunk before content (line ${i + 1})`)
      }
      if (line.startsWith('+')) {
        hunk.replace.push(line.slice(1))
      } else if (line.startsWith('-')) {
        hunk.find.push(line.slice(1))
      } else {
        // Context line — a leading single space is the canonical prefix,
        // but an unprefixed line is also accepted as context.
        const ctx = line.startsWith(' ') ? line.slice(1) : line
        hunk.find.push(ctx)
        hunk.replace.push(ctx)
      }
      continue
    }

    // delete: no body allowed
    if (line.trim()) {
      throw new Error(`"*** Delete File: ${current.path}" must have no body (line ${i + 1})`)
    }
  }

  if (!sawEnd) throw new Error('Patch is missing the "*** End Patch" terminator')
  flush()
  if (ops.length === 0) throw new Error('Patch contains no file operations')
  return { ops }
}

/** Extract the file paths a patch touches (best-effort pre-parse for claims). */
export function patchTouchPaths(patch: string): string[] {
  try {
    return parseApplyPatch(patch).ops.map((op) => op.path)
  } catch {
    return []
  }
}

/**
 * Apply a single update op's hunks to file content. Throws with a
 * model-actionable message when any hunk fails to match.
 */
function applyUpdateHunks(path: string, content: string, hunks: PatchHunk[]): string {
  const fileLines = content.split('\n')
  let cursor = 0
  for (let h = 0; h < hunks.length; h++) {
    const hunk = hunks[h]
    if (!hunk) continue
    if (hunk.find.length === 0) {
      throw new Error(
        `Hunk ${h + 1} of ${path} has no context or '-' lines — include at least one ` +
        `surrounding context line so the hunk can be anchored.`,
      )
    }
    const found = findSequence(fileLines, hunk.find, cursor)
    if (found < 0) {
      throw new Error(
        `Hunk ${h + 1} of ${path} does not match the file content. ` +
        `Re-read the file and regenerate the patch with exact context lines (whitespace matters).`,
      )
    }
    fileLines.splice(found, hunk.find.length, ...hunk.replace)
    cursor = found + hunk.replace.length
  }
  return fileLines.join('\n')
}

/** Find `needle` lines contiguously in `haystack` at or after `from`. */
function findSequence(haystack: string[], needle: string[], from: number): number {
  if (needle.length === 0) return -1
  const last = haystack.length - needle.length
  for (let i = Math.max(0, from); i <= last; i++) {
    let ok = true
    for (let j = 0; j < needle.length; j++) {
      if (haystack[i + j] !== needle[j]) {
        ok = false
        break
      }
    }
    if (ok) return i
  }
  return -1
}

const APPLY_PATCH_DESCRIPTION = `Apply a structured multi-file patch (codex apply_patch format).

The patch is a single string:
*** Begin Patch
*** Add File: path/to/new-file.ts
+<each line of the new file, prefixed with '+'>
*** Update File: path/to/existing.ts
@@
 <context line to keep, prefix with a space>
-<line to remove>
+<line to add>
*** Delete File: path/to/obsolete.ts
*** End Patch

Rules:
- One patch may touch many files; all hunks of an Update must match exactly (whitespace significant).
- Include enough context lines in each @@ hunk to anchor it uniquely.
- Multiple @@ hunks per file are applied top-to-bottom.
- Use Add for new files, Delete for removals, Update for modifications.`

export class ApplyPatchTool implements Tool {
  name = 'apply_patch'
  metadata = {
    mutatesState: true,
    concurrencySafe: false,
    searchHint: 'apply unified diff patch to multiple files',
    claims: (input: Record<string, unknown>): ResourceClaim[] => {
      const p = input.patch
      if (typeof p !== 'string' || !p) return []
      // Round 41 audit fix: patch paths are usually RELATIVE while
      // Edit/Write claim the model-supplied ABSOLUTE path — exact key
      // comparison saw no conflict and both tools raced the same file.
      // Claim BOTH forms (raw + resolved against the host cwd) so the
      // scheduler serializes against either spelling.
      const raw = patchTouchPaths(p)
      const keys = new Set<string>()
      for (const k of raw) {
        if (typeof k !== 'string' || k.length === 0) continue
        keys.add(k)
        try {
          keys.add(resolve(k))
        } catch {
          /* unresolvable path — the raw key still covers it */
        }
      }
      return [...keys].map((key) => ({ type: 'file' as const, key, access: 'write' as const }))
    },
  }

  definition: ToolDefinition = {
    type: 'function',
    function: {
      name: 'apply_patch',
      description: APPLY_PATCH_DESCRIPTION,
      parameters: {
        type: 'object',
        properties: {
          patch: {
            type: 'string',
            description: 'The full patch document (*** Begin Patch ... *** End Patch)',
          },
        },
        required: ['patch'],
      },
    },
  }

  async execute(input: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
    const patch = input.patch
    if (typeof patch !== 'string' || !patch.trim()) {
      return { content: 'Error: patch is required and must be a non-empty string', isError: true }
    }

    let ops: PatchOp[]
    try {
      ops = parseApplyPatch(patch).ops
    } catch (err) {
      return { content: `Error: ${'patch is malformed — ' + (err as Error).message}`, isError: true }
    }

    const results: string[] = []
    let anyError = false

    for (const op of ops) {
      const path = op.path && !isAbsolute(op.path) ? resolve(context.cwd, op.path) : op.path
      if (!path || typeof path !== 'string') {
        results.push(`✗ empty file path in patch`)
        anyError = true
        continue
      }
      if (containsNullByte(path)) {
        results.push(`✗ ${op.path}: path contains a NUL byte — rejected`)
        anyError = true
        continue
      }
      if (isLoopDriverOwnedPath(path)) {
        results.push(`✗ ${op.path}: loop supervisor control file — only the Driver may write it`)
        anyError = true
        continue
      }

      try {
        if (op.type === 'add') {
          if (existsSync(path)) {
            results.push(`✗ ${op.path}: file already exists — use Update instead of Add`)
            anyError = true
            continue
          }
          const content = op.lines.join('\n') + (op.lines.length > 0 ? '\n' : '')
          await atomicWrite(path, content)
          markFileRead(path, content)
          // Round 41 audit fix: register created files so /rewind turn
          // cleanup can remove them (same contract as Write's markCreated).
          context.fileHistory?.markCreated(path)
          results.push(`+ ${op.path} (${op.lines.length} line${op.lines.length === 1 ? '' : 's'})`)
        } else if (op.type === 'delete') {
          if (!existsSync(path)) {
            results.push(`✗ ${op.path}: file does not exist — nothing to delete`)
            anyError = true
            continue
          }
          context.fileHistory?.trackEdit(path)
          unlinkSync(path)
          results.push(`- ${op.path} (deleted)`)
        } else {
          if (!existsSync(path)) {
            results.push(`✗ ${op.path}: file does not exist — use Add for new files`)
            anyError = true
            continue
          }
          const content = readFileSync(path, 'utf8')
          const updated = applyUpdateHunks(op.path, content, op.hunks)
          if (updated === content) {
            results.push(`= ${op.path} (no change)`)
            continue
          }
          context.fileHistory?.trackEdit(path)
          await atomicWrite(path, updated)
          markFileRead(path, updated)
          results.push(`~ ${op.path} (${op.hunks.length} hunk${op.hunks.length === 1 ? '' : 's'})`)
        }
      } catch (err) {
        results.push(`✗ ${op.path}: ${(err as Error).message}`)
        anyError = true
      }
    }

    return {
      content: anyError
        ? `Patch applied with errors:\n${results.join('\n')}`
        : `Patch applied successfully:\n${results.join('\n')}`,
      isError: anyError,
    }
  }
}
