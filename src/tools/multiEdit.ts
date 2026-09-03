/**
 * MultiEditTool — batch atomic file edits (v0.6.0).
 *
 * Inspired by Codex's multi-file atomic editing: apply a batch of edits
 * across multiple files in a single tool call. Either ALL edits succeed
 * (files are snapshotted, mutated, snapshots cleaned up) or NONE do
 * (every file is restored to its pre-edit state).
 *
 * This is a strict superset of FileEditTool — a single-edit batch is
 * equivalent to an Edit call, but MultiEdit adds:
 *   - Cross-file atomicity (no partial state on failure)
 *   - Unified diff summary
 *   - Per-edit validation (old_string uniqueness, file size limits)
 *
 * The tool reuses FileEditTool's validation logic internally so the
 * two tools stay in sync.
 */

import { readFile } from 'fs/promises'
import { existsSync } from 'fs'
import { isAbsolute, resolve } from 'path'
import { AtomicTransaction } from '../core/atomicTransaction.js'
import { FileEditTool } from './fileEdit.js'
import { isLoopDriverOwnedPath, containsNullByte } from '../core/pathSecurity.js'
import type { Tool, ToolContext, ToolDefinition, ToolResult } from '../core/types.js'
import type { ResourceClaim } from '../core/executionRun.js'

// ── Types ───────────────────────────────────────────────────────────────────

export interface SingleEdit {
  /** Absolute path to the file to edit */
  file_path: string
  /** Exact string to find (must be unique in the file unless replace_all=true) */
  old_string: string
  /** Replacement string */
  new_string: string
  /** Replace all occurrences (default: false) */
  replace_all?: boolean
}

export interface MultiEditInput {
  /** Array of edits to apply atomically */
  edits: SingleEdit[]
}

interface EditResult {
  file_path: string
  ok: boolean
  replacements: number
  error?: string
}

// ── Tool ────────────────────────────────────────────────────────────────────

export class MultiEditTool implements Tool {
  name = 'MultiEdit'
  metadata = {
    mutatesState: true,
    concurrencySafe: false,
    claims: (input: Record<string, unknown>): ResourceClaim[] => {
      const edits = (input as { edits?: unknown[] }).edits
      if (!Array.isArray(edits)) return []
      return edits
        .filter((e): e is Record<string, unknown> =>
          !!e && typeof e === 'object' && typeof (e as Record<string, unknown>).file_path === 'string')
        .map((e) => ({ type: 'file' as const, key: e.file_path as string, access: 'write' as const }))
    },
  }

  definition: ToolDefinition = {
    type: 'function',
    function: {
      name: 'MultiEdit',
      description:
        'Apply multiple file edits atomically — either ALL succeed or NONE do. ' +
        'Use this when you need to make coordinated changes across multiple files ' +
        'that must be consistent (e.g. rename a function and update all call sites). ' +
        'Each edit is an exact string replacement like the Edit tool. ' +
        'For single-file edits, prefer the Edit tool which is simpler.',
      parameters: {
        type: 'object',
        properties: {
          edits: {
            type: 'array',
            description:
              'Array of edits to apply atomically. ' +
              'Order matters: edits are applied in sequence, so later edits can reference ' +
              'content inserted by earlier edits in the same batch.',
            items: {
              type: 'object',
              properties: {
                file_path: {
                  type: 'string',
                  description: 'Absolute path to the file to edit',
                },
                old_string: {
                  type: 'string',
                  description:
                    'Exact string to find (must be unique in the file unless replace_all=true)',
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
            minItems: 1,
            maxItems: 20,
          },
        },
        required: ['edits'],
      },
    },
  }

  async execute(
    input: Record<string, unknown>,
    context: ToolContext,
  ): Promise<ToolResult> {
    const edits = (input as Partial<MultiEditInput>).edits
    if (!Array.isArray(edits) || edits.length === 0) {
      return { content: 'Error: edits must be a non-empty array', isError: true }
    }
    if (edits.length > 20) {
      return { content: 'Error: maximum 20 edits per batch (for safety)', isError: true }
    }

    const results: EditResult[] = []
    const txn = new AtomicTransaction()

    try {
      // Phase 1: validate all edits (fail-fast before any mutation)
      for (let i = 0; i < edits.length; i++) {
        const edit = edits[i]
        const validation = await this.validateEdit(edit, i)
        if (!validation.ok) {
          return { content: validation.error!, isError: true }
        }
      }

      // Phase 2: apply all edits sequentially
      // Round 27: track each distinct file ONCE in FileHistory before the
      // first mutation — previously MultiEdit bypassed trackEdit entirely
      // (AtomicTransaction rollback only), so /rewind + /undo never saw
      // these edits. Mirrors fileEdit.ts:253 / fileWrite.ts:139.
      const trackedFiles = new Set<string>()
      for (const edit of edits) {
        const p = String(edit.file_path)
        if (!trackedFiles.has(p)) {
          trackedFiles.add(p)
          try { context.fileHistory?.trackEdit(p) } catch { /* best-effort history */ }
        }
      }
      for (let i = 0; i < edits.length; i++) {
        const edit = edits[i]
        const result = await this.applyEdit(edit, txn, i)
        results.push(result)
        if (!result.ok) {
          // Rollback everything
          const rb = await txn.rollback()
          return {
            content: `MultiEdit FAILED at edit ${i + 1}/${edits.length}: ${result.error}\n` +
              `Rolled back ${rb.mutations} files.\n\n` +
              `Results so far:\n${this.formatResults(results)}`,
            isError: true,
          }
        }
      }

      // Phase 3: commit
      const commit = await txn.commit()
      return {
        content: `MultiEdit SUCCESS: ${commit.mutations} files changed across ${edits.length} edits.\n\n` +
          this.formatResults(results),
        isError: false,
      }
    } catch (err) {
      // Unexpected error — rollback
      try { await txn.abort() } catch { /* best-effort */ }
      return {
        content: `MultiEdit ERROR: ${(err as Error).message}`,
        isError: true,
      }
    }
  }

  // ── Private helpers ─────────────────────────────────────────────────────

  private async validateEdit(
    edit: SingleEdit,
    index: number,
  ): Promise<{ ok: boolean; error?: string }> {
    const prefix = `[edit ${index + 1}]`

    if (!edit.file_path || typeof edit.file_path !== 'string') {
      return { ok: false, error: `${prefix} file_path is required` }
    }

    // Security (M2): NUL bytes let hostile paths truncate inside C-backed
    // syscalls — reject outright (see pathSecurity.containsNullByte).
    if (containsNullByte(edit.file_path)) {
      return { ok: false, error: `${prefix} file_path contains a NUL byte — rejected` }
    }

    // ADR-007: .loop/ supervisor control files are driver-owned (see
    // pathSecurity.isLoopDriverOwnedPath). Reject before any read/stat so
    // a refused edit never touches the atomic transaction. MultiEdit must
    // enforce the same guard as FileEdit/FileWrite — without it the model
    // could forge .loop/DONE.flag or checkpoint.json via a batch edit.
    if (isLoopDriverOwnedPath(edit.file_path)) {
      return {
        ok: false,
        error: `${prefix} ${edit.file_path} is a loop supervisor control file — only the Driver may write it. ` +
          `To signal completion, write .loop/CANDIDATE_DONE.flag; the Supervisor verifies independently.`,
      }
    }

    if (!edit.old_string && edit.old_string !== '') {
      return { ok: false, error: `${prefix} old_string is required` }
    }
    if (edit.new_string === undefined || edit.new_string === null) {
      return { ok: false, error: `${prefix} new_string is required` }
    }

    if (!existsSync(edit.file_path)) {
      return { ok: false, error: `${prefix} file not found: ${edit.file_path}` }
    }

    // Check file size
    try {
      const { stat } = await import('fs/promises')
      const s = await stat(edit.file_path)
      if (s.size > FileEditTool.MAX_FILE_BYTES) {
        return {
          ok: false,
          error: `${prefix} file too large (${(s.size / 1024 / 1024).toFixed(1)} MB, max ${FileEditTool.MAX_FILE_BYTES / 1024 / 1024} MB). Use Write tool instead.`,
        }
      }
    } catch {
      return { ok: false, error: `${prefix} cannot stat file: ${edit.file_path}` }
    }

    // Check old_string uniqueness
    if (!edit.replace_all) {
      const content = await readFile(edit.file_path, 'utf8')
      const count = content.split(edit.old_string).length - 1
      if (count === 0) {
        return {
          ok: false,
          error: `${prefix} old_string not found in ${edit.file_path}. ` +
            `Make sure the string matches EXACTLY (including whitespace).`,
        }
      }
      if (count > 1) {
        return {
          ok: false,
          error: `${prefix} old_string appears ${count} times in ${edit.file_path}. ` +
            `Set replace_all: true to replace all occurrences, or make old_string more specific.`,
        }
      }
    }

    return { ok: true }
  }

  private async applyEdit(
    edit: SingleEdit,
    txn: AtomicTransaction,
    index: number,
  ): Promise<EditResult> {
    const prefix = `[edit ${index + 1}]`

    try {
      // Snapshot
      await txn.snapshot(edit.file_path)

      // Read
      const oldContent = await readFile(edit.file_path, 'utf8')

      // Replace
      let newContent: string
      let replacements: number
      if (edit.replace_all) {
        const parts = oldContent.split(edit.old_string)
        replacements = parts.length - 1
        newContent = parts.join(edit.new_string)
      } else {
        replacements = 1
        newContent = oldContent.replace(edit.old_string, edit.new_string)
      }

      if (replacements === 0) {
        return {
          file_path: edit.file_path,
          ok: false,
          replacements: 0,
          error: `${prefix} old_string not found (file may have changed between validation and edit)`,
        }
      }

      // Write
      await txn.mutate(edit.file_path, newContent)

      return { file_path: edit.file_path, ok: true, replacements }
    } catch (err) {
      return {
        file_path: edit.file_path,
        ok: false,
        replacements: 0,
        error: `${prefix} ${(err as Error).message}`,
      }
    }
  }

  private formatResults(results: EditResult[]): string {
    let out = ''
    for (let i = 0; i < results.length; i++) {
      const r = results[i]
      const status = r.ok ? '✓' : '✗'
      out += `  ${status} [${i + 1}] ${r.file_path}: ${r.replacements} replacement(s)`
      if (r.error) out += ` — ${r.error}`
      out += '\n'
    }
    return out
  }
}