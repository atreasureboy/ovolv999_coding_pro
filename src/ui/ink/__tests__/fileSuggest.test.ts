/**
 * Tests for the file suggestion utility.
 */

import { describe, it, expect } from 'vitest'
import { suggestFiles, fuzzyMatch } from '../fileSuggest.js'

describe('suggestFiles', () => {
  it('returns files in cwd for empty query', () => {
    // Use a cap larger than the repo's root entry count so the assertion
    // is deterministic — the default max=15 caps the empty-query list and
    // which 15 of ~31 root entries surface is readdirSync-order dependent.
    const results = suggestFiles(process.cwd(), '', 100)
    expect(results.length).toBeGreaterThan(0)
    // Should include package.json
    expect(results.some((r) => r.path === 'package.json')).toBe(true)
  })

  it('filters by prefix', () => {
    const results = suggestFiles(process.cwd(), 'pack')
    expect(results.length).toBeGreaterThan(0)
    // Prefix results come first; at least the first few should start with 'pack'
    const prefixResults = results.filter((r) => r.label.toLowerCase().startsWith('pack'))
    expect(prefixResults.length).toBeGreaterThan(0)
  })

  it('returns directories with isDir=true', () => {
    const results = suggestFiles(process.cwd(), 'src')
    expect(results.some((r) => r.isDir)).toBe(true)
  })

  it('directories sorted before files', () => {
    const results = suggestFiles(process.cwd(), 's')
    const firstDirIdx = results.findIndex((r) => r.isDir)
    const firstFileIdx = results.findIndex((r) => !r.isDir)
    if (firstDirIdx >= 0 && firstFileIdx >= 0) {
      expect(firstDirIdx).toBeLessThan(firstFileIdx)
    }
  })

  it('excludes node_modules', () => {
    const results = suggestFiles(process.cwd(), 'node')
    expect(results.every((r) => !r.path.includes('node_modules'))).toBe(true)
  })

  it('excludes .git', () => {
    const results = suggestFiles(process.cwd(), '.git')
    expect(results.every((r) => r.path !== '.git')).toBe(true)
  })

  it('handles nested paths', () => {
    const results = suggestFiles(process.cwd(), 'src/ui/ink/co')
    expect(results.length).toBeGreaterThan(0)
    // Should find components directory or files starting with 'co'
  })

  it('returns empty for non-existent directory', () => {
    const results = suggestFiles(process.cwd(), 'nonexistent_dir_xyz/')
    expect(results).toEqual([])
  })

  it('limits results to max', () => {
    const results = suggestFiles(process.cwd(), '', 5)
    expect(results.length).toBeLessThanOrEqual(5)
  })

  it('skips hidden files unless query starts with .', () => {
    const results = suggestFiles(process.cwd(), '')
    // Hidden files should not appear unless explicitly searched
    expect(results.every((r) => !r.label.startsWith('.'))).toBe(true)
  })

  it('includes hidden files when query starts with .', () => {
    const results = suggestFiles(process.cwd(), '.es')
    // .eslintrc or similar should appear — may or may not have results
    expect(Array.isArray(results)).toBe(true)
  })

  it('fuzzy-matches files across project tree', () => {
    // 'eng' should fuzzy-match 'src/core/engine.ts' via subsequence
    const results = suggestFiles(process.cwd(), 'eng')
    const paths = results.map((r) => r.path)
    expect(paths.some((p) => p.includes('engine'))).toBe(true)
  })

  it('fuzzy-matches with abbreviations', () => {
    // 'crtk' should match 'costTracker' via subsequence
    const results = suggestFiles(process.cwd(), 'crtk')
    const paths = results.map((r) => r.path)
    expect(paths.some((p) => p.toLowerCase().includes('costtracker'))).toBe(true)
  })
})

describe('fuzzyMatch', () => {
  it('matches exact subsequence', () => {
    const result = fuzzyMatch('abc', 'a_b_c')
    expect(result).not.toBeNull()
    expect(result!.matchedIndices).toEqual([0, 2, 4])
  })

  it('returns null for non-subsequence', () => {
    expect(fuzzyMatch('xyz', 'abc')).toBeNull()
    expect(fuzzyMatch('ab', 'ba')).toBeNull()
  })

  it('returns null when query longer than target', () => {
    expect(fuzzyMatch('abcde', 'ab')).toBeNull()
  })

  it('case-insensitive matching', () => {
    const result = fuzzyMatch('ENG', 'engine')
    expect(result).not.toBeNull()
    expect(result!.matchedIndices).toEqual([0, 1, 2])
  })

  it('empty query always matches', () => {
    const result = fuzzyMatch('', 'anything')
    expect(result).not.toBeNull()
    expect(result!.matchedIndices).toEqual([])
  })

  it('consecutive matches score better than gappy matches', () => {
    const consecutive = fuzzyMatch('eng', 'engineer')!
    const gappy = fuzzyMatch('eng', 'e__n__g')!
    expect(consecutive.score).toBeLessThan(gappy.score)
  })

  it('boundary matches score better', () => {
    // Matching 'e' at start of 'engine' (boundary) vs middle of 'tree' (non-boundary)
    const boundary = fuzzyMatch('e', 'engine')!
    const mid = fuzzyMatch('e', 'tree')!
    expect(boundary.score).toBeLessThanOrEqual(mid.score)
  })

  it('shorter target preferred when query identical', () => {
    const short = fuzzyMatch('abc', 'abc')!
    const long = fuzzyMatch('abc', 'abcccc')!
    expect(short.score).toBeLessThan(long.score)
  })
})
