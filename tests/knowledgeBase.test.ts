import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import {
  loadKnowledge,
  saveKnowledge,
  addEntry,
  removeEntry,
  getEntry,
  getByCategory,
  searchKnowledge,
  extractKnowledgeFromText,
  formatEntry,
  formatKnowledgeList,
  formatSearchResults,
  formatStats,
  CATEGORY_ICONS,
  type KnowledgeCategory,
} from '../src/core/knowledgeBase.js'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

describe('knowledgeBase', () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'kb-test-'))
  })

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true })
  })

  describe('loadKnowledge / saveKnowledge', () => {
    it('returns empty store for non-existent file', () => {
      expect(loadKnowledge(tmpDir)).toEqual({ entries: [] })
    })

    it('round-trips data', () => {
      const store = { entries: [{
        id: 'kn_1', category: 'file' as KnowledgeCategory,
        key: 'test.ts', value: 'a test file',
        createdAt: '2024-01-15T10:00:00Z', updatedAt: '2024-01-15T10:00:00Z',
      }] }
      saveKnowledge(tmpDir, store)
      const loaded = loadKnowledge(tmpDir)
      expect(loaded.entries.length).toBe(1)
      expect(loaded.entries[0].key).toBe('test.ts')
    })

    it('creates .ovolv999 directory', () => {
      saveKnowledge(tmpDir, { entries: [] })
      const { existsSync } = require('fs')
      expect(existsSync(join(tmpDir, '.ovolv999'))).toBe(true)
    })
  })

  describe('addEntry', () => {
    it('creates new entry', () => {
      const entry = addEntry(tmpDir, 'file', 'src/engine.ts', 'main engine')
      expect(entry.id).toMatch(/^kn_\d+_/)
      expect(entry.category).toBe('file')
      expect(entry.key).toBe('src/engine.ts')
      expect(entry.value).toBe('main engine')
      expect(entry.createdAt).toBeDefined()
      expect(entry.updatedAt).toBeDefined()
    })

    it('updates existing entry with same key+category', () => {
      addEntry(tmpDir, 'file', 'test.ts', 'old description')
      addEntry(tmpDir, 'file', 'test.ts', 'new description')
      const store = loadKnowledge(tmpDir)
      expect(store.entries.length).toBe(1)
      expect(store.entries[0].value).toBe('new description')
    })

    it('allows same key with different category', () => {
      addEntry(tmpDir, 'file', 'test.ts', 'file description')
      addEntry(tmpDir, 'gotcha', 'test.ts', 'gotcha description')
      const store = loadKnowledge(tmpDir)
      expect(store.entries.length).toBe(2)
    })

    it('stores optional fields', () => {
      const entry = addEntry(tmpDir, 'decision', 'use vitest', 'fast and modern', {
        source: 'session_123',
        tags: ['testing', 'tools'],
        confidence: 0.9,
      })
      expect(entry.source).toBe('session_123')
      expect(entry.tags).toEqual(['testing', 'tools'])
      expect(entry.confidence).toBe(0.9)
    })
  })

  describe('removeEntry', () => {
    it('removes by id', () => {
      const entry = addEntry(tmpDir, 'file', 'test.ts', 'desc')
      expect(removeEntry(tmpDir, entry.id)).toBe(true)
      expect(loadKnowledge(tmpDir).entries.length).toBe(0)
    })

    it('removes by key', () => {
      addEntry(tmpDir, 'file', 'test.ts', 'desc')
      expect(removeEntry(tmpDir, 'test.ts')).toBe(true)
      expect(loadKnowledge(tmpDir).entries.length).toBe(0)
    })

    it('returns false for unknown', () => {
      expect(removeEntry(tmpDir, 'nonexistent')).toBe(false)
    })
  })

  describe('getEntry', () => {
    it('finds by key', () => {
      addEntry(tmpDir, 'file', 'test.ts', 'desc')
      const entry = getEntry(tmpDir, 'test.ts')
      expect(entry).not.toBeNull()
      expect(entry!.value).toBe('desc')
    })

    it('returns null for unknown', () => {
      expect(getEntry(tmpDir, 'unknown')).toBeNull()
    })
  })

  describe('getByCategory', () => {
    it('filters by category', () => {
      addEntry(tmpDir, 'file', 'a.ts', 'desc a')
      addEntry(tmpDir, 'file', 'b.ts', 'desc b')
      addEntry(tmpDir, 'gotcha', 'warning', 'be careful')
      const files = getByCategory(tmpDir, 'file')
      expect(files.length).toBe(2)
    })
  })

  describe('searchKnowledge', () => {
    beforeEach(() => {
      addEntry(tmpDir, 'file', 'src/engine.ts', 'main execution engine')
      addEntry(tmpDir, 'file', 'src/parser.ts', 'handles parsing')
      addEntry(tmpDir, 'decision', 'use vitest', 'fast testing framework', {
        tags: ['test', 'vitest'],
      })
    })

    it('matches in key', () => {
      const results = searchKnowledge(tmpDir, 'engine')
      expect(results.length).toBe(1)
      expect(results[0].key).toContain('engine')
    })

    it('matches in value', () => {
      const results = searchKnowledge(tmpDir, 'parsing')
      expect(results.length).toBe(1)
      expect(results[0].key).toBe('src/parser.ts')
    })

    it('matches in tags', () => {
      const results = searchKnowledge(tmpDir, 'vitest')
      expect(results.length).toBe(1)
    })

    it('filters by category', () => {
      const results = searchKnowledge(tmpDir, 'vitest', { category: 'file' })
      expect(results.length).toBe(0)
    })

    it('returns empty for no matches', () => {
      expect(searchKnowledge(tmpDir, 'nonexistent').length).toBe(0)
    })

    it('respects limit', () => {
      const results = searchKnowledge(tmpDir, '', { limit: 2 })
      expect(results.length).toBeLessThanOrEqual(2)
    })

    it('is case insensitive', () => {
      const results = searchKnowledge(tmpDir, 'ENGINE')
      expect(results.length).toBe(1)
    })
  })

  describe('extractKnowledgeFromText', () => {
    it('extracts file descriptions', () => {
      const text = "The file src/engine.ts manages the execution loop"
      const results = extractKnowledgeFromText(text)
      expect(results.length).toBeGreaterThan(0)
      expect(results[0].category).toBe('file')
      expect(results[0].key).toContain('engine.ts')
    })

    it('extracts dependencies', () => {
      const text = "engine.ts depends on the parser module"
      const results = extractKnowledgeFromText(text)
      expect(results.some(r => r.category === 'dependency')).toBe(true)
    })

    it('extracts gotchas', () => {
      const text = "Don't edit the dist folder because it's auto-generated"
      const results = extractKnowledgeFromText(text)
      expect(results.some(r => r.category === 'gotcha')).toBe(true)
    })

    it('extracts decisions', () => {
      const text = "We decided to use TypeScript for the entire project"
      const results = extractKnowledgeFromText(text)
      expect(results.some(r => r.category === 'decision')).toBe(true)
    })

    it('returns empty for irrelevant text', () => {
      expect(extractKnowledgeFromText('hello world')).toEqual([])
    })

    it('provides confidence scores', () => {
      const results = extractKnowledgeFromText("file test.ts does something important")
      for (const r of results) {
        expect(r.confidence).toBeGreaterThan(0)
        expect(r.confidence).toBeLessThanOrEqual(1)
      }
    })
  })

  describe('formatting', () => {
    it('formatEntry includes icon and key', () => {
      const entry = {
        id: 'kn_1', category: 'file' as KnowledgeCategory,
        key: 'test.ts', value: 'test file',
        createdAt: '2024-01-15T10:00:00Z', updatedAt: '2024-01-15T10:00:00Z',
      }
      const out = formatEntry(entry)
      expect(out).toContain('📄')
      expect(out).toContain('test.ts')
      expect(out).toContain('test file')
    })

    it('formatEntry includes confidence', () => {
      const entry = {
        id: 'kn_1', category: 'file' as KnowledgeCategory,
        key: 'test.ts', value: 'test',
        createdAt: '', updatedAt: '',
        confidence: 0.85,
      }
      expect(formatEntry(entry)).toContain('85%')
    })

    it('formatEntry includes tags', () => {
      const entry = {
        id: 'kn_1', category: 'general' as KnowledgeCategory,
        key: 'test', value: 'val',
        createdAt: '', updatedAt: '',
        tags: ['a', 'b'],
      }
      expect(formatEntry(entry)).toContain('[a, b]')
    })

    it('formatKnowledgeList groups by category', () => {
      const entries = [
        { id: '1', category: 'file' as KnowledgeCategory, key: 'a.ts', value: 'a', createdAt: '', updatedAt: '' },
        { id: '2', category: 'file' as KnowledgeCategory, key: 'b.ts', value: 'b', createdAt: '', updatedAt: '' },
        { id: '3', category: 'gotcha' as KnowledgeCategory, key: 'warn', value: 'w', createdAt: '', updatedAt: '' },
      ]
      const out = formatKnowledgeList(entries)
      expect(out).toContain('file')
      expect(out).toContain('gotcha')
      expect(out).toContain('3 entries')
    })

    it('formatKnowledgeList handles empty', () => {
      expect(formatKnowledgeList([])).toContain('No knowledge entries')
    })

    it('formatSearchResults shows count', () => {
      const results = [
        { id: '1', category: 'file' as KnowledgeCategory, key: 'a', value: 'v', createdAt: '', updatedAt: '' },
      ]
      expect(formatSearchResults(results, 'test')).toContain('1 match')
    })

    it('formatSearchResults handles no results', () => {
      expect(formatSearchResults([], 'test')).toContain('No matches')
    })

    it('formatStats shows totals', () => {
      const store = {
        entries: [
          { id: '1', category: 'file' as KnowledgeCategory, key: 'a', value: 'v', createdAt: '', updatedAt: '' },
          { id: '2', category: 'file' as KnowledgeCategory, key: 'b', value: 'v', createdAt: '', updatedAt: '' },
          { id: '3', category: 'gotcha' as KnowledgeCategory, key: 'c', value: 'v', createdAt: '', updatedAt: '' },
        ],
      }
      const out = formatStats(store)
      expect(out).toContain('3 total')
      expect(out).toContain('file: 2')
      expect(out).toContain('gotcha: 1')
    })
  })

  describe('CATEGORY_ICONS', () => {
    it('has icon for all categories', () => {
      const categories: KnowledgeCategory[] = [
        'file', 'pattern', 'decision', 'gotcha',
        'dependency', 'convention', 'architecture', 'general',
      ]
      for (const cat of categories) {
        expect(CATEGORY_ICONS[cat]).toBeDefined()
        expect(CATEGORY_ICONS[cat].length).toBeGreaterThan(0)
      }
    })
  })
})
