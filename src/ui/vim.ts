/**
 * Vim Mode — modal editing state machine for the prompt input.
 *
 * Supports the most common Vim motions and operators:
 *   - Normal mode: h/j/k/l, w/b/e, 0/$, gg/G, i/a/A/o/O, x, dd, dw, u, p
 *   - Insert mode: ESC returns to normal
 *   - Visual mode: v + motion, then d/x/y
 *
 * This is a PURE module — no React, no DOM. It takes the current state
 * (text, cursor, mode) and a key input, then returns the new state.
 * PromptInput integrates it conditionally when vim mode is enabled.
 *
 * Inspired by Vim and Claude Code's vim.ts.
 */

// ── Types ───────────────────────────────────────────────────────────────────

export type VimMode = 'insert' | 'normal' | 'visual'

export interface VimState {
  mode: VimMode
  text: string
  /** Cursor position (character offset from start) */
  cursor: number
  /** Start of visual selection (inclusive) */
  visualStart?: number
  /** Accumulated count prefix (e.g. "3" before "w" = move 3 words) */
  count?: number
  /** Pending operator (d, c, y) waiting for a motion */
  pendingOperator?: 'd' | 'c' | 'y'
  /** Last find motion (for ; and ,) */
  lastFind?: { char: string; direction: 'next' | 'prev' }
  /** Last yanked/deleted text (for paste) */
  register?: string
  /** Whether the last change was linewise (for paste behavior) */
  registerLinewise?: boolean
}

export interface VimResult {
  state: VimState
  /** Message to display in status line (mode indicator) */
  statusLine?: string
  /** Whether the key was handled (false = ignore) */
  handled: boolean
}

// ── Helpers ─────────────────────────────────────────────────────────────────

const WORD_CHARS = /[a-zA-Z0-9_]/

function isWordChar(ch: string): boolean {
  return WORD_CHARS.test(ch)
}

function isWhitespace(ch: string): boolean {
  return /\s/.test(ch)
}

/** Find the start of the next word from position */
function nextWordStart(text: string, pos: number): number {
  if (pos >= text.length) return text.length
  const startType = charType(text[pos])
  let i = pos
  // Skip current word
  while (i < text.length && charType(text[i]) === startType && startType !== 'space') i++
  // Skip whitespace
  while (i < text.length && charType(text[i]) === 'space') i++
  return i
}

/** Find the start of the previous word from position */
function prevWordStart(text: string, pos: number): number {
  if (pos <= 0) return 0
  let i = pos - 1
  // Skip whitespace before cursor
  while (i > 0 && charType(text[i]) === 'space') i--
  if (i <= 0) return 0
  const type = charType(text[i])
  // Move to start of this word
  while (i > 0 && charType(text[i - 1]) === type) i--
  return i
}

/** Find the end of the current/next word */
function wordEnd(text: string, pos: number): number {
  if (pos >= text.length - 1) return text.length - 1
  let i = pos + 1
  // Skip whitespace
  while (i < text.length && charType(text[i]) === 'space') i++
  if (i >= text.length) return text.length - 1
  const type = charType(text[i])
  // Move to end of this word (last char of the type)
  while (i < text.length - 1 && charType(text[i + 1]) === type) i++
  return i
}

type CharType = 'word' | 'punct' | 'space'
function charType(ch: string): CharType {
  if (isWordChar(ch)) return 'word'
  if (isWhitespace(ch)) return 'space'
  return 'punct'
}

/** Get the start of the current line (for multi-line text) */
function lineStart(text: string, pos: number): number {
  const before = text.slice(0, pos)
  const lastNl = before.lastIndexOf('\n')
  return lastNl + 1
}

/** Get the end of the current line (before newline) */
function lineEnd(text: string, pos: number): number {
  const after = text.slice(pos)
  const nlIdx = after.indexOf('\n')
  return nlIdx === -1 ? text.length - 1 : pos + nlIdx - 1
}

/** Get the current line number */
function lineNumber(text: string, pos: number): number {
  return text.slice(0, pos).split('\n').length - 1
}

/** Get position at the start of a specific line */
function linePosStart(text: string, line: number): number {
  if (line <= 0) return 0
  let current = 0
  let lineNum = 0
  while (lineNum < line && current < text.length) {
    const nl = text.indexOf('\n', current)
    if (nl === -1) return text.length
    current = nl + 1
    lineNum++
  }
  return current
}

/** Count total lines in text */
function totalLines(text: string): number {
  return text.split('\n').length
}

// ── Normal mode handler ─────────────────────────────────────────────────────

function handleNormalMode(state: VimState, input: string): VimResult {
  const { text, cursor } = state
  const count = state.count ?? 1

  // Digit prefix: 1-9 starts a count, 0 extends count if one is active
  if (/^[1-9]$/.test(input) || (input === '0' && state.count)) {
    return {
      state: { ...state, count: (state.count ?? 0) * 10 + parseInt(input, 10) },
      handled: true,
    }
  }

  // Pending operator waiting for a motion
  if (state.pendingOperator) {
    return handleOperatorMotion(state, input)
  }

  // ── Motions ───────────────────────────────────────────────────────────────

  switch (input) {
    case 'h': // Left
    case 'left':
      return { state: { ...state, cursor: Math.max(0, cursor - count), count: undefined }, handled: true }

    case 'l': // Right
    case 'right':
      return { state: { ...state, cursor: Math.min(text.length - 1, cursor + count), count: undefined }, handled: true }

    case 'j': // Down
    case 'down': {
      const line = lineNumber(text, cursor)
      const lineStartPos = lineStart(text, cursor)
      const col = cursor - lineStartPos
      const targetLine = Math.min(totalLines(text) - 1, line + count)
      const targetLineStart = linePosStart(text, targetLine)
      const targetLineEnd = lineEnd(text, targetLineStart)
      return {
        state: { ...state, cursor: Math.min(targetLineStart + col, targetLineEnd), count: undefined },
        handled: true,
      }
    }

    case 'k': // Up
    case 'up': {
      const line = lineNumber(text, cursor)
      const lineStartPos = lineStart(text, cursor)
      const col = cursor - lineStartPos
      const targetLine = Math.max(0, line - count)
      const targetLineStart = linePosStart(text, targetLine)
      const targetLineEnd = lineEnd(text, targetLineStart)
      return {
        state: { ...state, cursor: Math.min(targetLineStart + col, targetLineEnd), count: undefined },
        handled: true,
      }
    }

    case 'w': // Next word start
      return { state: { ...state, cursor: applyRepeat(nextWordStart, text, cursor, count), count: undefined }, handled: true }

    case 'b': // Previous word start
      return { state: { ...state, cursor: applyRepeat(prevWordStart, text, cursor, count), count: undefined }, handled: true }

    case 'e': // Word end
      return { state: { ...state, cursor: applyRepeat(wordEnd, text, cursor, count), count: undefined }, handled: true }

    case '0': // Start of line
      return { state: { ...state, cursor: lineStart(text, cursor), count: undefined }, handled: true }

    case '$': // End of line
      return { state: { ...state, cursor: lineEnd(text, cursor), count: undefined }, handled: true }

    case 'g':
      // gg = go to first line
      return {
        state: { ...state, pendingOperator: undefined, count: undefined },
        handled: true,
        statusLine: 'g...',
      }

    case 'G': // Last line
      return { state: { ...state, cursor: linePosStart(text, totalLines(text) - 1), count: undefined }, handled: true }

    // ── Enter insert mode ─────────────────────────────────────────────────────

    case 'i': // Insert before cursor
      return { state: { ...state, mode: 'insert', count: undefined }, statusLine: '-- INSERT --', handled: true }

    case 'a': // Append after cursor
      return {
        state: { ...state, mode: 'insert', cursor: Math.min(text.length, cursor + 1), count: undefined },
        statusLine: '-- INSERT --', handled: true,
      }

    case 'A': // Append at end of line
      return {
        state: { ...state, mode: 'insert', cursor: lineEnd(text, cursor) + 1, count: undefined },
        statusLine: '-- INSERT --', handled: true,
      }

    case 'I': // Insert at start of line (after whitespace)
      return {
        state: { ...state, mode: 'insert', cursor: lineStart(text, cursor), count: undefined },
        statusLine: '-- INSERT --', handled: true,
      }

    case 'o': { // Open new line below
      const le = lineEnd(text, cursor)
      const newText = text.slice(0, le + 1) + '\n' + text.slice(le + 1)
      return {
        state: { ...state, mode: 'insert', text: newText, cursor: le + 2, count: undefined },
        statusLine: '-- INSERT --', handled: true,
      }
    }

    case 'O': { // Open new line above
      const ls = lineStart(text, cursor)
      const newText = text.slice(0, ls) + '\n' + text.slice(ls)
      return {
        state: { ...state, mode: 'insert', text: newText, cursor: ls, count: undefined },
        statusLine: '-- INSERT --', handled: true,
      }
    }

    // ── Editing ───────────────────────────────────────────────────────────────

    case 'x': { // Delete character under cursor
      if (text.length === 0) return { state, handled: true }
      const newText = text.slice(0, cursor) + text.slice(cursor + count)
      return {
        state: {
          ...state,
          text: newText,
          cursor: Math.min(cursor, newText.length - 1),
          register: text.slice(cursor, cursor + count),
          registerLinewise: false,
          count: undefined,
        },
        handled: true,
      }
    }

    case 'd': // Delete operator (wait for motion)
      return { state: { ...state, pendingOperator: 'd' }, handled: true }

    case 'c': // Change operator (wait for motion)
      return { state: { ...state, pendingOperator: 'c' }, handled: true }

    case 'y': // Yank operator (wait for motion)
      return { state: { ...state, pendingOperator: 'y' }, handled: true }

    case 'u': { // Undo — not implemented (PromptInput handles undo)
      return { state: { ...state, count: undefined }, handled: false }
    }

    case 'p': { // Paste after cursor
      if (!state.register) return { state, handled: true }
      const insertPos = cursor + 1
      const newText = text.slice(0, insertPos) + state.register + text.slice(insertPos)
      return {
        state: { ...state, text: newText, cursor: insertPos + state.register.length - 1, count: undefined },
        handled: true,
      }
    }

    case 'v': // Enter visual mode
      return {
        state: { ...state, mode: 'visual', visualStart: cursor, count: undefined },
        statusLine: '-- VISUAL --', handled: true,
      }

    case '\x1b': // ESC — stay in normal
      return { state: { ...state, count: undefined, pendingOperator: undefined }, handled: true }

    default:
      return { state, handled: false }
  }
}

function handleOperatorMotion(state: VimState, input: string): VimResult {
  const { text, cursor } = state
  const op = state.pendingOperator!
  const count = state.count ?? 1

  let target: number
  let linewise = false

  switch (input) {
    case 'w': target = applyRepeat(nextWordStart, text, cursor, count); break
    case 'b': target = applyRepeat(prevWordStart, text, cursor, count); break
    case 'e': target = applyRepeat(wordEnd, text, cursor, count) + 1; break
    case '0': target = lineStart(text, cursor); break
    case '$': target = lineEnd(text, cursor) + 1; break
    case 'd': // dd = delete line
    case 'c': // cc = change line
    case 'y': // yy = yank line
      target = -1
      linewise = true
      break
    case '\x1b': // Cancel operator
      return { state: { ...state, pendingOperator: undefined, count: undefined }, handled: true }
    default:
      return { state, handled: false }
  }

  if (linewise) {
    const ls = lineStart(text, cursor)
    const le = text.indexOf('\n', cursor)
    const realEnd = le === -1 ? text.length : le + 1
    const deleted = text.slice(ls, realEnd)
    const newText = text.slice(0, ls) + text.slice(realEnd)
    return {
      state: {
        ...state,
        text: newText,
        cursor: Math.min(ls, newText.length - 1),
        register: deleted,
        registerLinewise: true,
        pendingOperator: undefined,
        count: undefined,
        mode: op === 'c' ? 'insert' : state.mode,
      },
      statusLine: op === 'c' ? '-- INSERT --' : undefined,
      handled: true,
    }
  }

  // Range-based delete/change/yank
  const start = Math.min(cursor, target)
  const end = Math.max(cursor, target)
  const deleted = text.slice(start, end)
  const newText = op === 'y' ? text : text.slice(0, start) + text.slice(end)

  return {
    state: {
      ...state,
      text: newText,
      cursor: op === 'y' ? cursor : Math.min(start, newText.length - 1),
      register: deleted,
      registerLinewise: false,
      pendingOperator: undefined,
      count: undefined,
      mode: op === 'c' ? 'insert' : state.mode,
    },
    statusLine: op === 'c' ? '-- INSERT --' : undefined,
    handled: true,
  }
}

// ── Visual mode handler ─────────────────────────────────────────────────────

function handleVisualMode(state: VimState, input: string): VimResult {
  const { text, cursor, visualStart } = state
  if (visualStart === undefined) return { state, handled: true }

  // ESC — exit visual mode (must be checked BEFORE motion delegation)
  if (input === '\x1b') {
    return {
      state: { ...state, mode: 'normal', visualStart: undefined, count: undefined },
      handled: true,
    }
  }

  // Operators on selection
  if (input === 'd' || input === 'x' || input === 'y') {
    const start = Math.min(cursor, visualStart)
    const end = Math.max(cursor, visualStart) + 1
    const selected = text.slice(start, end)
    const newText = input === 'y' ? text : text.slice(0, start) + text.slice(end)
    return {
      state: {
        ...state,
        text: newText,
        cursor: Math.min(start, Math.max(0, newText.length - 1)),
        mode: 'normal',
        visualStart: undefined,
        register: selected,
        registerLinewise: false,
        count: undefined,
      },
      handled: true,
    }
  }

  // Motions extend/shrink the selection
  const motionResult = handleNormalMode({ ...state, mode: 'normal' }, input)
  if (motionResult.handled && !motionResult.state.pendingOperator) {
    // Update cursor position from the motion, stay in visual
    return {
      state: { ...motionResult.state, mode: 'visual', visualStart },
      statusLine: '-- VISUAL --',
      handled: true,
    }
  }

  return motionResult
}

// ── Insert mode handler ─────────────────────────────────────────────────────

function handleInsertMode(state: VimState, input: string, key: { ctrl?: boolean; backspace?: boolean; leftArrow?: boolean; rightArrow?: boolean }): VimResult {
  const { text, cursor } = state

  // ESC — return to normal mode
  if (input === '\x1b') {
    return {
      state: { ...state, mode: 'normal', cursor: Math.max(0, cursor - 1) },
      statusLine: '',
      handled: true,
    }
  }

  // Backspace
  if (key.backspace) {
    if (cursor > 0) {
      return {
        state: {
          ...state,
          text: text.slice(0, cursor - 1) + text.slice(cursor),
          cursor: cursor - 1,
        },
        handled: true,
      }
    }
    return { state, handled: true }
  }

  // Arrows — move without leaving insert mode
  if (key.leftArrow) return { state: { ...state, cursor: Math.max(0, cursor - 1) }, handled: true }
  if (key.rightArrow) return { state: { ...state, cursor: Math.min(text.length, cursor + 1) }, handled: true }

  // Printable character — insert at cursor
  if (input && !key.ctrl && input !== '\r' && input !== '\n') {
    return {
      state: {
        ...state,
        text: text.slice(0, cursor) + input + text.slice(cursor),
        cursor: cursor + 1,
      },
      handled: true,
    }
  }

  return { state, handled: false }
}

// ── Main entry point ────────────────────────────────────────────────────────

/**
 * Process a key input in the current vim state.
 * Returns the new state and whether the key was handled.
 */
export function handleVimKey(
  state: VimState,
  input: string,
  key: { ctrl?: boolean; backspace?: boolean; leftArrow?: boolean; rightArrow?: boolean } = {},
): VimResult {
  // Ctrl combinations always pass through (except Ctrl+[ = ESC)
  if (key.ctrl && input !== '\x1b') {
    return { state, handled: false }
  }

  switch (state.mode) {
    case 'normal':
      return handleNormalMode(state, input)
    case 'insert':
      return handleInsertMode(state, input, key)
    case 'visual':
      return handleVisualMode(state, input)
    default:
      return { state, handled: false }
  }
}

/** Create initial vim state */
export function createVimState(mode: VimMode = 'insert'): VimState {
  return { mode, text: '', cursor: 0 }
}

/** Get the mode indicator for status line */
export function modeIndicator(mode: VimMode): string {
  switch (mode) {
    case 'insert': return '-- INSERT --'
    case 'normal': return ''
    case 'visual': return '-- VISUAL --'
  }
}

// ── Utility ─────────────────────────────────────────────────────────────────

function applyRepeat(fn: (text: string, pos: number) => number, text: string, pos: number, count: number): number {
  let result = pos
  for (let i = 0; i < count; i++) {
    result = fn(text, result)
  }
  return result
}
