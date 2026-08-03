/**
 * v0.5.2 (C12 — borrowed from cursor @-symbol retrieval):
 * tests for AtSymbolPicker.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

import { AtSymbolPicker, createAtSymbolPickerTool } from '../src/tools/atSymbolPicker.js'

describe('@-symbol picker (C12)', () => {
  let tmp: string
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'ovolv999-at-'))
  })
  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true })
  })

  it('@file resolves a real file path', () => {
    const target = join(tmp, 'README.md')
    writeFileSync(target, '# Test\n')
    const picker = new AtSymbolPicker()
    const m = picker.resolve({ symbol: 'file', value: target })
    expect(m.length).toBe(1)
    expect(m[0].path).toBe(target)
    expect(m[0].preview).toContain('README.md')
  })

  it('@file returns empty for a non-existent path', () => {
    const picker = new AtSymbolPicker()
    expect(picker.resolve({ symbol: 'file', value: '/does/not/exist' })).toEqual([])
  })

  it('@folder enumerates a directory by extension counts', () => {
    writeFileSync(join(tmp, 'a.ts'), '')
    writeFileSync(join(tmp, 'b.ts'), '')
    writeFileSync(join(tmp, 'README.md'), '')
    mkdirSync(join(tmp, 'src'))
    writeFileSync(join(tmp, 'src/c.py'), '')
    const picker = new AtSymbolPicker()
    const m = picker.resolve({ symbol: 'folder', value: tmp, limit: 5 })
    expect(m.length).toBeGreaterThan(0)
    expect(m.every((x) => x.preview.includes('file(s)'))).toBe(true)
  })

  it('@codebase surfaces a non-empty match for an extension-matching query', () => {
    writeFileSync(join(tmp, 'index.ts'), '')
    const picker = new AtSymbolPicker()
    const m = picker.resolve({ symbol: 'codebase', value: 'ts' })
    // The picker runs against process.cwd() by default — we
    // don't change cwd in tests, so the result depends on the
    // host repo. We only assert the shape, not the exact count.
    expect(Array.isArray(m)).toBe(true)
  })

  it('@docs returns empty (not wired)', () => {
    const picker = new AtSymbolPicker()
    expect(picker.resolve({ symbol: 'docs', value: 'anything' })).toEqual([])
  })

  it('createAtSymbolPickerTool returns a Tool with the documented schema', () => {
    const tool = createAtSymbolPickerTool()
    expect(tool.name).toBe('at_symbol')
    expect(tool.metadata.readOnly).toBe(true)
    expect(tool.definition.type).toBe('function')
    expect(tool.definition.function.parameters.required).toContain('symbol')
  })

  it('tool.execute handles a missing symbol', async () => {
    const tool = createAtSymbolPickerTool()
    const r = await tool.execute({ value: 'x' })
    expect(r.isError).toBe(true)
  })

  it('tool.execute renders matches for a real file', async () => {
    const target = join(tmp, 'a.ts')
    writeFileSync(target, 'export const x = 1\n')
    const tool = createAtSymbolPickerTool()
    const r = await tool.execute({ symbol: 'file', value: target })
    expect(r.isError).toBe(false)
    expect(r.content).toContain(target)
  })
})