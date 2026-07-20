import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import {
  addSnippet, removeSnippet, getSnippet, listSnippets,
  useSnippet, toggleFavorite, searchSnippets,
  getCategories, getAllTags, getSnippetStats,
  extractVariables, fillSnippet,
  formatSnippet, formatSnippetList, formatSnippetStats,
} from '../src/core/snippets.js'
import { mkdtempSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

function makeTempDir(): string {
  return mkdtempSync(join(tmpdir(), 'ovolv999-snip-'))
}

describe('Snippet Manager', () => {
  let cwd: string

  beforeEach(() => { cwd = makeTempDir() })
  afterEach(() => { rmSync(cwd, { recursive: true, force: true }) })

  describe('extractVariables', () => {
    it('extracts {{variable}} patterns', () => {
      expect(extractVariables('Hello {{name}}!')).toEqual(['name'])
    })

    it('extracts multiple unique variables', () => {
      const vars = extractVariables('{{a}} and {{b}} and {{a}}')
      expect(vars).toEqual(['a', 'b'])
    })

    it('returns empty for no variables', () => {
      expect(extractVariables('const x = 1')).toEqual([])
    })

    it('handles underscores in variable names', () => {
      expect(extractVariables('{{my_var}}')).toEqual(['my_var'])
    })
  })

  describe('fillSnippet', () => {
    it('replaces variables with values', () => {
      expect(fillSnippet('Hello {{name}}!', { name: 'World' })).toBe('Hello World!')
    })

    it('leaves unreplaced variables as-is', () => {
      expect(fillSnippet('{{a}} {{b}}', { a: 'X' })).toBe('X {{b}}')
    })

    it('handles multiple occurrences', () => {
      expect(fillSnippet('{{x}}+{{x}}', { x: '1' })).toBe('1+1')
    })
  })

  describe('addSnippet', () => {
    it('creates a snippet', () => {
      const s = addSnippet(cwd, {
        name: 'console-log',
        language: 'typescript',
        body: 'console.log({{value}})',
      })
      expect(s.id).toMatch(/^snip_/)
      expect(s.name).toBe('console-log')
      expect(s.variables).toEqual(['value'])
      expect(s.useCount).toBe(0)
      expect(s.favorite).toBe(false)
    })

    it('stores optional fields', () => {
      const s = addSnippet(cwd, {
        name: 'test',
        language: 'javascript',
        body: 'test({{name}})',
        description: 'Test snippet',
        category: 'testing',
        tags: ['unit', 'quick'],
        favorite: true,
      })
      expect(s.description).toBe('Test snippet')
      expect(s.category).toBe('testing')
      expect(s.tags).toEqual(['unit', 'quick'])
      expect(s.favorite).toBe(true)
    })

    it('upserts by name', () => {
      addSnippet(cwd, { name: 'test', language: 'ts', body: 'v1' })
      addSnippet(cwd, { name: 'test', language: 'ts', body: 'v2' })
      const all = listSnippets(cwd)
      expect(all).toHaveLength(1)
      expect(all[0].body).toBe('v2')
    })
  })

  describe('removeSnippet', () => {
    it('removes by id', () => {
      const s = addSnippet(cwd, { name: 'x', language: 'ts', body: 'x' })
      expect(removeSnippet(cwd, s.id)).toBe(true)
      expect(listSnippets(cwd)).toHaveLength(0)
    })

    it('removes by name', () => {
      addSnippet(cwd, { name: 'x', language: 'ts', body: 'x' })
      expect(removeSnippet(cwd, 'x')).toBe(true)
    })

    it('returns false for missing', () => {
      expect(removeSnippet(cwd, 'nope')).toBe(false)
    })
  })

  describe('getSnippet', () => {
    it('finds by name', () => {
      addSnippet(cwd, { name: 'my-snip', language: 'ts', body: 'x' })
      expect(getSnippet(cwd, 'my-snip')).not.toBeNull()
    })

    it('returns null for missing', () => {
      expect(getSnippet(cwd, 'nope')).toBeNull()
    })
  })

  describe('listSnippets with filters', () => {
    beforeEach(() => {
      addSnippet(cwd, { name: 'a', language: 'typescript', body: 'a', category: 'util', tags: ['sync'] })
      addSnippet(cwd, { name: 'b', language: 'python', body: 'b', category: 'util', tags: ['async'] })
      addSnippet(cwd, { name: 'c', language: 'typescript', body: 'c', category: 'test', tags: ['sync'] })
    })

    it('filters by category', () => {
      expect(listSnippets(cwd, { category: 'util' })).toHaveLength(2)
    })

    it('filters by language', () => {
      expect(listSnippets(cwd, { language: 'typescript' })).toHaveLength(2)
    })

    it('filters by tag', () => {
      expect(listSnippets(cwd, { tag: 'sync' })).toHaveLength(2)
    })

    it('filters favorites', () => {
      toggleFavorite(cwd, 'a')
      expect(listSnippets(cwd, { favoriteOnly: true })).toHaveLength(1)
    })
  })

  describe('useSnippet', () => {
    it('returns filled body', () => {
      addSnippet(cwd, { name: 'log', language: 'ts', body: 'console.log({{msg}})' })
      const result = useSnippet(cwd, 'log', { msg: '"hello"' })
      expect(result).toBe('console.log("hello")')
    })

    it('increments use count', () => {
      addSnippet(cwd, { name: 'log', language: 'ts', body: 'x' })
      useSnippet(cwd, 'log')
      useSnippet(cwd, 'log')
      const s = getSnippet(cwd, 'log')!
      expect(s.useCount).toBe(2)
      expect(s.lastUsed).not.toBeNull()
    })

    it('returns null for missing snippet', () => {
      expect(useSnippet(cwd, 'nope')).toBeNull()
    })
  })

  describe('toggleFavorite', () => {
    it('toggles favorite flag', () => {
      addSnippet(cwd, { name: 'x', language: 'ts', body: 'x' })
      const fav1 = toggleFavorite(cwd, 'x')
      expect(fav1?.favorite).toBe(true)
      const fav2 = toggleFavorite(cwd, 'x')
      expect(fav2?.favorite).toBe(false)
    })

    it('returns null for missing', () => {
      expect(toggleFavorite(cwd, 'nope')).toBeNull()
    })
  })

  describe('searchSnippets', () => {
    it('matches name', () => {
      addSnippet(cwd, { name: 'test-helper', language: 'ts', body: 'x' })
      addSnippet(cwd, { name: 'other', language: 'ts', body: 'y' })
      expect(searchSnippets(cwd, 'test')).toHaveLength(1)
    })

    it('matches body', () => {
      addSnippet(cwd, { name: 'a', language: 'ts', body: 'console.error(x)' })
      expect(searchSnippets(cwd, 'error')).toHaveLength(1)
    })

    it('matches category', () => {
      addSnippet(cwd, { name: 'a', language: 'ts', body: 'x', category: 'debugging' })
      expect(searchSnippets(cwd, 'debug')).toHaveLength(1)
    })

    it('matches tags', () => {
      addSnippet(cwd, { name: 'a', language: 'ts', body: 'x', tags: ['important'] })
      expect(searchSnippets(cwd, 'import')).toHaveLength(1)
    })
  })

  describe('getCategories and getAllTags', () => {
    it('returns unique sorted categories', () => {
      addSnippet(cwd, { name: 'a', language: 'ts', body: 'x', category: 'test' })
      addSnippet(cwd, { name: 'b', language: 'ts', body: 'x', category: 'util' })
      addSnippet(cwd, { name: 'c', language: 'ts', body: 'x', category: 'test' })
      expect(getCategories(cwd)).toEqual(['test', 'util'])
    })

    it('returns unique sorted tags', () => {
      addSnippet(cwd, { name: 'a', language: 'ts', body: 'x', tags: ['beta', 'alpha'] })
      addSnippet(cwd, { name: 'b', language: 'ts', body: 'x', tags: ['alpha'] })
      expect(getAllTags(cwd)).toEqual(['alpha', 'beta'])
    })
  })

  describe('getSnippetStats', () => {
    it('returns stats for empty store', () => {
      const stats = getSnippetStats(cwd)
      expect(stats.total).toBe(0)
      expect(stats.mostUsed).toBeNull()
    })

    it('counts by language and category', () => {
      addSnippet(cwd, { name: 'a', language: 'ts', body: 'x', category: 'util' })
      addSnippet(cwd, { name: 'b', language: 'ts', body: 'x', category: 'test' })
      addSnippet(cwd, { name: 'c', language: 'py', body: 'x' })
      const stats = getSnippetStats(cwd)
      expect(stats.total).toBe(3)
      expect(stats.byLanguage.ts).toBe(2)
      expect(stats.byLanguage.py).toBe(1)
      expect(stats.byCategory.util).toBe(1)
      expect(stats.byCategory.test).toBe(1)
    })

    it('tracks total uses', () => {
      addSnippet(cwd, { name: 'a', language: 'ts', body: 'x' })
      useSnippet(cwd, 'a')
      useSnippet(cwd, 'a')
      const stats = getSnippetStats(cwd)
      expect(stats.totalUses).toBe(2)
      expect(stats.mostUsed?.name).toBe('a')
    })

    it('counts favorites', () => {
      addSnippet(cwd, { name: 'a', language: 'ts', body: 'x', favorite: true })
      addSnippet(cwd, { name: 'b', language: 'ts', body: 'x' })
      const stats = getSnippetStats(cwd)
      expect(stats.favorites).toBe(1)
    })
  })

  describe('formatSnippet', () => {
    it('includes name, language, and body', () => {
      const s = addSnippet(cwd, { name: 'test', language: 'ts', body: 'const x = 1' })
      const out = formatSnippet(s)
      expect(out).toContain('test')
      expect(out).toContain('ts')
      expect(out).toContain('const x = 1')
    })

    it('shows star for favorites', () => {
      const s = addSnippet(cwd, { name: 'test', language: 'ts', body: 'x', favorite: true })
      expect(formatSnippet(s)).toContain('★')
    })

    it('shows variables', () => {
      const s = addSnippet(cwd, { name: 'test', language: 'ts', body: 'log({{msg}})' })
      expect(formatSnippet(s)).toContain('{{msg}}')
    })
  })

  describe('formatSnippetList', () => {
    it('shows empty message', () => {
      expect(formatSnippetList([])).toBe('No snippets found.')
    })

    it('lists snippets with preview', () => {
      addSnippet(cwd, { name: 'a', language: 'ts', body: 'const x = 1' })
      addSnippet(cwd, { name: 'b', language: 'ts', body: 'function foo() {}' })
      const out = formatSnippetList(listSnippets(cwd))
      expect(out).toContain('a')
      expect(out).toContain('b')
      expect(out).toContain('const x = 1')
    })
  })

  describe('formatSnippetStats', () => {
    it('includes key stats', () => {
      addSnippet(cwd, { name: 'a', language: 'ts', body: 'x', category: 'util', tags: ['quick'] })
      useSnippet(cwd, 'a')
      const stats = getSnippetStats(cwd)
      const out = formatSnippetStats(stats)
      expect(out).toContain('Total: 1')
      expect(out).toContain('ts')
      expect(out).toContain('util')
      expect(out).toContain('#quick')
    })
  })
})
