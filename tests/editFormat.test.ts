/**
 * v0.5.2 (C10 — borrowed from aider editor_*_coder.py):
 * tests for the EditFormat contract.
 */
import { describe, it, expect } from 'vitest'
import { applyEdit, EDIT_FORMATS, DEFAULT_EDIT_FORMAT } from '../src/core/editFormat.js'

describe('EditFormat contract (C10)', () => {
  it('lists the four formats in canonical order', () => {
    expect(EDIT_FORMATS).toEqual(['editblock', 'whole', 'udiff', 'diff'])
    expect(DEFAULT_EDIT_FORMAT).toBe('editblock')
  })

  it('whole format replaces the entire content', () => {
    const r = applyEdit('old content', {
      file_path: 'a.ts',
      payload: { kind: 'whole', content: 'new content' },
    })
    expect(r.changed).toBe(true)
    expect(r.newContent).toBe('new content')
  })

  it('editblock finds and replaces a single occurrence', () => {
    const r = applyEdit('foo bar baz', {
      file_path: 'a.ts',
      payload: { kind: 'editblock', searchText: 'bar', replaceText: 'BAR' },
    })
    expect(r.changed).toBe(true)
    expect(r.newContent).toBe('foo BAR baz')
  })

  it('editblock warns when search text is not found', () => {
    const r = applyEdit('foo bar baz', {
      file_path: 'a.ts',
      payload: { kind: 'editblock', searchText: 'missing', replaceText: 'X' },
    })
    expect(r.changed).toBe(false)
    expect(r.warnings.some((w) => w.includes('not found'))).toBe(true)
  })

  it('editblock refuses multiple matches without globalReplace', () => {
    const r = applyEdit('foo foo foo', {
      file_path: 'a.ts',
      payload: { kind: 'editblock', searchText: 'foo', replaceText: 'BAR' },
    })
    expect(r.changed).toBe(false)
    expect(r.warnings[0]).toMatch(/3 times/)
  })

  it('editblock globalReplace replaces every occurrence', () => {
    const r = applyEdit('foo foo foo', {
      file_path: 'a.ts',
      payload: { kind: 'editblock', searchText: 'foo', replaceText: 'BAR', globalReplace: true },
    })
    expect(r.changed).toBe(true)
    expect(r.newContent).toBe('BAR BAR BAR')
  })

  it('udiff applies a single hunk', () => {
    const original = 'line1\nline2\nline3'
    const diff = '@@ -1,3 +1,3 @@\n line1\n-line2\n+LINE2\n line3'
    const r = applyEdit(original, {
      file_path: 'a.ts',
      payload: { kind: 'udiff', diff },
    })
    expect(r.changed).toBe(true)
    expect(r.newContent).toContain('LINE2')
  })

  it('empty diff is a no-op with warning', () => {
    const r = applyEdit('original', {
      file_path: 'a.ts',
      payload: { kind: 'udiff', diff: '' },
    })
    expect(r.changed).toBe(false)
    expect(r.warnings[0]).toMatch(/empty/)
  })

  it('whole format unchanged returns a warning, not an error', () => {
    const r = applyEdit('same', {
      file_path: 'a.ts',
      payload: { kind: 'whole', content: 'same' },
    })
    expect(r.changed).toBe(false)
    expect(r.warnings[0]).toMatch(/unchanged/)
  })
})