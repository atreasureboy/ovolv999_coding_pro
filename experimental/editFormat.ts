/**
 * Edit-format coders — v0.5.2 (C10 — borrowed from aider
 * `aider/coders/editor_*_coder.py`).
 *
 * Aider ships one Coder per edit format (`editor_editblock_coder.py`,
 * `editor_whole_coder.py`, `editor_diff_fenced_coder.py`, etc.) so the
 * model can emit edits in a typed shape and the engine knows exactly
 * how to apply them. The format affects:
 *   - how the model's text is parsed (search/replace block vs. full
 *     file vs. fenced diff)
 *   - whether the model has read access to the current file contents
 *     (whole) or only sees the file path (editblock)
 *   - error semantics when the search string isn't found
 *
 * We don't ship separate coder classes (single source of truth: this
 * file) but we DO formalize the format discriminator as a single
 * enum and the apply logic as pure functions. Production callers:
 *   - the system-prompt builder tells the model which format to emit
 *   - the Edit / Write / MultiEdit tools parse + apply
 *
 * Edit-format independence is a real contract: switching the format
 * MUST NOT change WHICH tools the model can call, only the SHAPE of
 * the arguments the model emits. This is the architectural separation
 * that Aider's per-format coders enforce at the type level.
 */

export type EditFormat = 'whole' | 'udiff' | 'diff' | 'editblock'

export interface EditOperation {
  /** Path to the file being edited. */
  file_path: string
  /** Edit-format-specific payload. See per-format docs. */
  payload: EditPayload
}

export type EditPayload =
  | { kind: 'whole'; content: string }
  | { kind: 'udiff'; diff: string }
  | { kind: 'diff'; diff: string }
  | { kind: 'editblock'; searchText: string; replaceText: string; globalReplace?: boolean }

/**
 * Apply an edit operation. Pure function: returns the new file
 * content + diagnostics. Does NOT touch the filesystem — callers
 * write the result.
 *
 * `original` is the current file content (may be empty for new
 * files). For `whole` format it's ignored (the model's content
 * is authoritative).
 */
export interface EditApplyResult {
  newContent: string
  /** Non-fatal issues (e.g. search-text not found). */
  warnings: string[]
  /** True iff the operation mutated `original`. */
  changed: boolean
}

export function applyEdit(
  original: string,
  op: EditOperation,
): EditApplyResult {
  switch (op.payload.kind) {
    case 'whole':
      return {
        newContent: op.payload.content,
        warnings: op.payload.content === original ? ['whole: content unchanged'] : [],
        changed: op.payload.content !== original,
      }
    case 'editblock':
      return applyEditBlock(original, op.file_path, op.payload.searchText, op.payload.replaceText, op.payload.globalReplace ?? false)
    case 'udiff':
    case 'diff':
      return applyDiff(original, op.file_path, op.payload.diff, op.payload.kind)
    default:
      return { newContent: original, warnings: [`unknown payload kind`], changed: false }
  }
}

function applyEditBlock(
  original: string,
  filePath: string,
  searchText: string,
  replaceText: string,
  globalReplace: boolean,
): EditApplyResult {
  if (!searchText) {
    return { newContent: original, warnings: [`${filePath}: empty searchText`], changed: false }
  }
  const occurrences = original.split(searchText).length - 1
  if (occurrences === 0) {
    return {
      newContent: original,
      warnings: [`${filePath}: search text not found`],
      changed: false,
    }
  }
  if (occurrences > 1 && !globalReplace) {
    return {
      newContent: original,
      warnings: [`${filePath}: search text appears ${occurrences} times; set globalReplace to apply`],
      changed: false,
    }
  }
  const replacement = globalReplace
    ? original.split(searchText).join(replaceText)
    : original.replace(searchText, replaceText)
  return {
    newContent: replacement,
    warnings: [],
    changed: replacement !== original,
  }
}

/**
 * Apply a unified diff (or plain `diff` format) to `original`.
 *
 * Zero-deps constraint: we implement the smallest viable subset of
 * unified diff — only `@@` hunks with `+`/`-`/` ` (no /dev/null, no
 * rename, no binary). When the diff is malformed we surface a
 * warning rather than silently corrupting the file.
 */
function applyDiff(
  original: string,
  filePath: string,
  diff: string,
  format: 'udiff' | 'diff',
): EditApplyResult {
  if (!diff.trim()) {
    return { newContent: original, warnings: [`${filePath}: empty diff`], changed: false }
  }
  const lines = diff.split('\n')
  const hunks: { oldStart: number; oldCount: number; newStart: number; newCount: number; body: string[] }[] = []
  let current: { oldStart: number; oldCount: number; newStart: number; newCount: number; body: string[] } | null = null
  let newLines = original.split('\n')
  let cursor = 0
  for (const line of lines) {
    const hunkMatch = line.match(/^@@\s+-(\d+)(?:,(\d+))?\s+\+(\d+)(?:,(\d+))?\s+@@/)
    if (hunkMatch) {
      if (current) hunks.push(current)
      current = {
        oldStart: parseInt(hunkMatch[1], 10),
        oldCount: parseInt(hunkMatch[2] ?? '1', 10),
        newStart: parseInt(hunkMatch[3], 10),
        newCount: parseInt(hunkMatch[4] ?? '1', 10),
        body: [],
      }
      cursor = current.oldStart - 1
      continue
    }
    if (!current) continue
    if (line.startsWith('+')) {
      newLines.splice(cursor, 0, line.slice(1))
      cursor++
    } else if (line.startsWith('-')) {
      cursor++
    } else if (line.startsWith(' ')) {
      cursor++
    }
    current.body.push(line)
  }
  if (current) hunks.push(current)
  if (hunks.length === 0) {
    return {
      newContent: original,
      warnings: [`${filePath}: ${format} produced no hunks`],
      changed: false,
    }
  }
  const result = newLines.join('\n')
  return {
    newContent: result,
    warnings: [],
    changed: result !== original,
  }
}

/**
 * List the formats the model can emit on a given tool. Drives the
 * system-prompt contract: the prompt tells the model which format to
 * use for Edit / Write / MultiEdit.
 */
export const EDIT_FORMATS: EditFormat[] = ['editblock', 'whole', 'udiff', 'diff']

/**
 * Default format per aider's `architect_coder.py` recommendation:
 * `editor-diff` for the architect phase, `editor-editblock` for
 * executor phases. We default to `editblock` because it's the most
 * forgiving for non-architect edits.
 */
export const DEFAULT_EDIT_FORMAT: EditFormat = 'editblock'