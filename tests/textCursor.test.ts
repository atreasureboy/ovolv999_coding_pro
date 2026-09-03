/**
 * The composer's cursor used to be stepped by raw ±1 UTF-16 code units, so
 * astral-plane input (emoji) broke three ways: backspace split the surrogate
 * pair (one press removed half an emoji and rendered a lone surrogate), the
 * arrow keys parked the cursor mid-pair, and the end-of-line cursor cell
 * rendered `text.at(-1)` — the low surrogate alone. textCursor steps by a
 * whole code point while keeping the code-unit index space.
 */
import { describe, it, expect } from 'vitest'
import { prevCursor, nextCursor } from '../src/ui/ink/textCursor.js'

const EMOJI = '😀' // U+1F600, 2 UTF-16 code units
const HAND = '🤘' // U+1F918, 2 code units

describe('prevCursor', () => {
  it('steps 1 unit through BMP text', () => {
    expect(prevCursor('abc', 3)).toBe(2)
    expect(prevCursor('abc', 1)).toBe(0)
  })

  it('clamps at 0', () => {
    expect(prevCursor('abc', 0)).toBe(0)
    expect(prevCursor('', 0)).toBe(0)
  })

  it('steps over a full surrogate pair', () => {
    expect(prevCursor(EMOJI, 2)).toBe(0)
    expect(prevCursor(`a${EMOJI}b`, 3)).toBe(1)
    expect(prevCursor(`${EMOJI}${EMOJI}`, 4)).toBe(2)
  })
})

describe('nextCursor', () => {
  it('steps 1 unit through BMP text', () => {
    expect(nextCursor('abc', 0)).toBe(1)
    expect(nextCursor('abc', 2)).toBe(3)
  })

  it('clamps at length', () => {
    expect(nextCursor('abc', 3)).toBe(3)
    expect(nextCursor('', 0)).toBe(0)
  })

  it('steps over a full surrogate pair', () => {
    expect(nextCursor(EMOJI, 0)).toBe(2)
    expect(nextCursor(`a${EMOJI}b`, 1)).toBe(3)
    expect(nextCursor(`${EMOJI}${HAND}`, 2)).toBe(4)
  })
})

describe('pair integrity under editing', () => {
  it('backspace removes the whole emoji, not half of it', () => {
    const text = `fix ${EMOJI}`
    const cursor = text.length
    const prev = prevCursor(text, cursor)
    const next = text.slice(0, prev) + text.slice(cursor)
    expect(next).toBe('fix ')
    expect(next.length).toBe(4)
  })

  it('backspacing two emoji takes two presses and leaves no lone surrogates', () => {
    let text = `${EMOJI}${HAND}`
    let cursor = text.length
    const p1 = prevCursor(text, cursor)
    text = text.slice(0, p1) + text.slice(cursor)
    cursor = p1
    expect(text).toBe(EMOJI)
    expect(cursor).toBe(2)
    const p2 = prevCursor(text, cursor)
    text = text.slice(0, p2) + text.slice(cursor)
    cursor = p2
    expect(text).toBe('')
    expect(cursor).toBe(0)
  })

  it('a full left/right round trip preserves the boundary invariant', () => {
    const text = `a${EMOJI}b${HAND}c`
    let cursor = text.length
    const visited: number[] = []
    while (cursor > 0) {
      cursor = prevCursor(text, cursor)
      visited.push(cursor)
    }
    expect(visited).toEqual([6, 4, 3, 1, 0])
    for (const pos of [...visited, text.length]) {
      // No cursor position may sit between the halves of a surrogate pair.
      const at = pos < text.length ? text.charCodeAt(pos) : 0
      expect(at >= 0xdc00 && at <= 0xdfff).toBe(false)
    }
  })

  it('the end-of-line cursor cell renders the full trailing character', () => {
    const text = `done ${EMOJI}`
    const tailStart = prevCursor(text, text.length)
    expect(text.slice(tailStart)).toBe(EMOJI)
    expect(text.slice(0, tailStart)).toBe('done ')
  })

  it('the mid-line cursor cell renders the full character under the cursor', () => {
    const text = `a${EMOJI}b`
    const end = nextCursor(text, 1)
    expect(text.slice(1, end)).toBe(EMOJI)
    expect(text.slice(end)).toBe('b')
  })
})

describe('degenerate input', () => {
  it('reversed surrogate order is not a pair — steps as single units', () => {
    const reversed = String.fromCharCode(0xdc00, 0xd800)
    expect(prevCursor(reversed, 2)).toBe(1)
    expect(nextCursor(reversed, 0)).toBe(1)
  })
})
