/**
 * Tests for the @-mention expansion utility.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { expandAtMentions } from '../expandAtMentions.js'
import { writeFileSync, mkdirSync, rmSync } from 'fs'
import { join } from 'path'
import { mkdtempSync } from 'fs'
import { tmpdir } from 'os'

describe('expandAtMentions', () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'ovolv-test-'))
  })

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it('returns text unchanged when no @mentions', () => {
    const result = expandAtMentions('hello world', tmpDir)
    expect(result.text).toBe('hello world')
    expect(result.mentions).toEqual([])
  })

  it('expands a file mention', () => {
    writeFileSync(join(tmpDir, 'test.ts'), 'const x = 42')
    const result = expandAtMentions('Fix @test.ts', tmpDir)
    expect(result.mentions).toHaveLength(1)
    expect(result.mentions[0].found).toBe(true)
    expect(result.mentions[0].path).toBe('test.ts')
    expect(result.text).toContain('<file_content path="test.ts">')
    expect(result.text).toContain('const x = 42')
  })

  it('expands multiple file mentions', () => {
    writeFileSync(join(tmpDir, 'a.ts'), 'aaa')
    writeFileSync(join(tmpDir, 'b.ts'), 'bbb')
    const result = expandAtMentions('Fix @a.ts and @b.ts', tmpDir)
    expect(result.mentions).toHaveLength(2)
    expect(result.text).toContain('aaa')
    expect(result.text).toContain('bbb')
  })

  it('handles non-existent files gracefully', () => {
    const result = expandAtMentions('Fix @nonexistent.ts', tmpDir)
    expect(result.mentions).toHaveLength(1)
    expect(result.mentions[0].found).toBe(false)
    expect(result.text).toBe('Fix @nonexistent.ts')
  })

  it('truncates large files', () => {
    const large = 'x'.repeat(10000)
    writeFileSync(join(tmpDir, 'big.ts'), large)
    const result = expandAtMentions('@big.ts', tmpDir)
    expect(result.mentions[0].truncated).toBe(true)
    expect(result.text).toContain('truncated')
  })

  it('skips directories', () => {
    mkdirSync(join(tmpDir, 'mydir'))
    const result = expandAtMentions('@mydir', tmpDir)
    expect(result.mentions).toHaveLength(0)
  })

  it('handles nested paths', () => {
    mkdirSync(join(tmpDir, 'src'))
    writeFileSync(join(tmpDir, 'src', 'util.ts'), 'export const util = 1')
    const result = expandAtMentions('Fix @src/util.ts', tmpDir)
    expect(result.mentions[0].found).toBe(true)
    expect(result.text).toContain('export const util = 1')
  })

  it('does not expand email-like patterns', () => {
    const result = expandAtMentions('Contact me at user@example.com', tmpDir)
    expect(result.mentions).toEqual([])
  })

  it('handles @ at start of text', () => {
    writeFileSync(join(tmpDir, 'test.ts'), 'hello')
    const result = expandAtMentions('@test.ts', tmpDir)
    expect(result.mentions).toHaveLength(1)
    expect(result.mentions[0].found).toBe(true)
  })

  it('preserves original text in output', () => {
    writeFileSync(join(tmpDir, 'test.ts'), 'hello')
    const result = expandAtMentions('Fix the @test.ts file', tmpDir)
    expect(result.text.startsWith('Fix the @test.ts file')).toBe(true)
  })

  it('handles repeated mentions of same file', () => {
    writeFileSync(join(tmpDir, 'test.ts'), 'hello')
    const result = expandAtMentions('@test.ts and @test.ts again', tmpDir)
    // Only one file should be expanded (deduplication)
    const openTags = result.text.match(/<file_content/g)
    expect(openTags === null || openTags.length === 1).toBe(true)
  })
})
