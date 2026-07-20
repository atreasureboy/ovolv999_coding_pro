import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import {
  loadHistory,
  saveHistory,
  addEntry,
  clearHistory,
  searchHistory,
  fuzzyMatch,
  getUniqueTexts,
  getHistoryStats,
  formatHistoryResults,
  formatHistoryStats,
  getGlobalHistoryPath,
  getProjectHistoryPath,
  type HistoryStore,
  type HistoryEntryType,
} from '../src/core/commandHistory.js'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

describe('commandHistory', () => {
  let tmpDir: string
  let historyPath: string

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'hist-test-'))
    historyPath = join(tmpDir, 'history.json')
  })

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true })
  })

  const createStore = (entries: HistoryStore['entries']): HistoryStore => ({ entries })

  describe('loadHistory / saveHistory', () => {
    it('returns empty store for non-existent file', () => {
      expect(loadHistory(historyPath)).toEqual({ entries: [] })
    })

    it('round-trips data', () => {
      const store = createStore([
        { text: 'hello', type: 'prompt', timestamp: '2024-01-15T10:00:00Z', cwd: '/test' },
      ])
      saveHistory(historyPath, store)
      const loaded = loadHistory(historyPath)
      expect(loaded.entries.length).toBe(1)
      expect(loaded.entries[0].text).toBe('hello')
    })

    it('creates parent directory', () => {
      const nestedPath = join(tmpDir, 'nested/dir/history.json')
      saveHistory(nestedPath, { entries: [] })
      // Should not throw
    })
  })

  describe('addEntry', () => {
    it('adds a new entry', () => {
      addEntry(historyPath, 'test prompt')
      const store = loadHistory(historyPath)
      expect(store.entries.length).toBe(1)
      expect(store.entries[0].text).toBe('test prompt')
      expect(store.entries[0].type).toBe('prompt')
    })

    it('sets timestamp', () => {
      addEntry(historyPath, 'test')
      const store = loadHistory(historyPath)
      expect(store.entries[0].timestamp).toBeTruthy()
    })

    it('deduplicates consecutive identical entries', () => {
      addEntry(historyPath, 'same')
      addEntry(historyPath, 'same')
      const store = loadHistory(historyPath)
      expect(store.entries.length).toBe(1)
    })

    it('allows non-consecutive duplicates', () => {
      addEntry(historyPath, 'a')
      addEntry(historyPath, 'b')
      addEntry(historyPath, 'a')
      const store = loadHistory(historyPath)
      expect(store.entries.length).toBe(3)
    })

    it('supports different types', () => {
      addEntry(historyPath, 'cmd', 'command')
      addEntry(historyPath, 'pipe input', 'pipe')
      const store = loadHistory(historyPath)
      expect(store.entries[0].type).toBe('command')
      expect(store.entries[1].type).toBe('pipe')
    })

    it('stores optional fields', () => {
      addEntry(historyPath, 'test', 'prompt', '/custom', ['tag1', 'tag2'])
      const store = loadHistory(historyPath)
      expect(store.entries[0].cwd).toBe('/custom')
      expect(store.entries[0].tags).toEqual(['tag1', 'tag2'])
    })
  })

  describe('clearHistory', () => {
    it('removes all entries', () => {
      addEntry(historyPath, 'a')
      addEntry(historyPath, 'b')
      const count = clearHistory(historyPath)
      expect(count).toBe(2)
      expect(loadHistory(historyPath).entries.length).toBe(0)
    })

    it('returns 0 for empty store', () => {
      expect(clearHistory(historyPath)).toBe(0)
    })
  })

  describe('searchHistory', () => {
    beforeEach(() => {
      addEntry(historyPath, 'fix the bug in engine', 'prompt')
      addEntry(historyPath, 'add unit tests', 'prompt')
      addEntry(historyPath, '/commit', 'command')
      addEntry(historyPath, 'fix linting errors', 'prompt')
      addEntry(historyPath, '/diff', 'command')
    })

    it('finds substring matches', () => {
      const store = loadHistory(historyPath)
      const results = searchHistory(store, 'fix')
      expect(results.length).toBe(2)
    })

    it('is case insensitive by default', () => {
      const store = loadHistory(historyPath)
      const results = searchHistory(store, 'FIX')
      expect(results.length).toBe(2)
    })

    it('supports case sensitive search', () => {
      const store = loadHistory(historyPath)
      const results = searchHistory(store, 'FIX', { caseSensitive: true })
      expect(results.length).toBe(0)
    })

    it('filters by type', () => {
      const store = loadHistory(historyPath)
      const results = searchHistory(store, '', { type: 'command' })
      expect(results.length).toBe(2)
      expect(results.every(r => r.type === 'command')).toBe(true)
    })

    it('supports exact match', () => {
      const store = loadHistory(historyPath)
      const results = searchHistory(store, '/commit', { exact: true })
      expect(results.length).toBe(1)
    })

    it('respects limit', () => {
      const store = loadHistory(historyPath)
      const results = searchHistory(store, '', { limit: 2 })
      expect(results.length).toBeLessThanOrEqual(2)
    })

    it('returns recent entries for empty query', () => {
      const store = loadHistory(historyPath)
      const results = searchHistory(store, '')
      expect(results.length).toBeGreaterThan(0)
    })

    it('uses fuzzy matching for partial queries', () => {
      const store = loadHistory(historyPath)
      const results = searchHistory(store, 'fxbg') // fuzzy for "fix bug"
      expect(results.length).toBeGreaterThanOrEqual(1)
    })

    it('returns empty for no matches', () => {
      const store = loadHistory(historyPath)
      const results = searchHistory(store, 'nonexistent_query_xyz')
      expect(results.length).toBe(0)
    })

    it('filters by tags', () => {
      // Add an entry with tags
      saveHistory(historyPath, createStore([
        { text: 'tagged entry', type: 'prompt', timestamp: '2024-01-15T10:00:00Z', cwd: '/test', tags: ['important'] },
        { text: 'untagged', type: 'prompt', timestamp: '2024-01-15T10:00:00Z', cwd: '/test' },
      ]))
      const store = loadHistory(historyPath)
      const results = searchHistory(store, '', { tags: ['important'] })
      expect(results.length).toBe(1)
      expect(results[0].text).toBe('tagged entry')
    })
  })

  describe('fuzzyMatch', () => {
    it('matches exact characters in order', () => {
      expect(fuzzyMatch('hello world', 'hlo')).toBe(true)
    })

    it('matches when query is empty', () => {
      expect(fuzzyMatch('hello', '')).toBe(true)
    })

    it('matches when query equals text', () => {
      expect(fuzzyMatch('hello', 'hello')).toBe(true)
    })

    it('fails when chars not in order', () => {
      expect(fuzzyMatch('hello', 'leh')).toBe(false)
    })

    it('fails when char not present', () => {
      expect(fuzzyMatch('hello', 'helloz')).toBe(false)
    })

    it('handles short text', () => {
      expect(fuzzyMatch('ab', 'abc')).toBe(false)
    })

    it('handles repeated chars', () => {
      expect(fuzzyMatch('aabbcc', 'abc')).toBe(true)
    })
  })

  describe('getUniqueTexts', () => {
    it('returns deduplicated texts', () => {
      saveHistory(historyPath, createStore([
        { text: 'a', type: 'prompt', timestamp: '2024-01-15T10:00:00Z', cwd: '/' },
        { text: 'b', type: 'prompt', timestamp: '2024-01-15T10:01:00Z', cwd: '/' },
        { text: 'a', type: 'prompt', timestamp: '2024-01-15T10:02:00Z', cwd: '/' },
      ]))
      const store = loadHistory(historyPath)
      const unique = getUniqueTexts(store)
      expect(unique.length).toBe(2)
      expect(unique).toContain('a')
      expect(unique).toContain('b')
    })

    it('filters by prefix', () => {
      saveHistory(historyPath, createStore([
        { text: 'test a', type: 'prompt', timestamp: '2024-01-15T10:00:00Z', cwd: '/' },
        { text: 'test b', type: 'prompt', timestamp: '2024-01-15T10:01:00Z', cwd: '/' },
        { text: 'other', type: 'prompt', timestamp: '2024-01-15T10:02:00Z', cwd: '/' },
      ]))
      const store = loadHistory(historyPath)
      const unique = getUniqueTexts(store, 'test')
      expect(unique.length).toBe(2)
    })

    it('respects limit', () => {
      const entries: HistoryStore['entries'] = []
      for (let i = 0; i < 20; i++) {
        entries.push({ text: `entry${i}`, type: 'prompt', timestamp: '2024-01-15T10:00:00Z', cwd: '/' })
      }
      saveHistory(historyPath, createStore(entries))
      const store = loadHistory(historyPath)
      const unique = getUniqueTexts(store, '', 5)
      expect(unique.length).toBe(5)
    })
  })

  describe('getHistoryStats', () => {
    it('computes stats correctly', () => {
      saveHistory(historyPath, createStore([
        { text: 'a', type: 'prompt', timestamp: '2024-01-15T10:00:00Z', cwd: '/' },
        { text: 'b', type: 'command', timestamp: '2024-01-15T10:01:00Z', cwd: '/' },
        { text: 'a', type: 'prompt', timestamp: '2024-01-15T10:02:00Z', cwd: '/' },
      ]))
      const store = loadHistory(historyPath)
      const stats = getHistoryStats(store)
      expect(stats.totalEntries).toBe(3)
      expect(stats.uniqueTexts).toBe(2)
      expect(stats.byType.prompt).toBe(2)
      expect(stats.byType.command).toBe(1)
    })

    it('identifies most used', () => {
      saveHistory(historyPath, createStore([
        { text: 'popular', type: 'prompt', timestamp: '2024-01-15T10:00:00Z', cwd: '/' },
        { text: 'popular', type: 'prompt', timestamp: '2024-01-15T10:01:00Z', cwd: '/' },
        { text: 'popular', type: 'prompt', timestamp: '2024-01-15T10:02:00Z', cwd: '/' },
        { text: 'rare', type: 'prompt', timestamp: '2024-01-15T10:03:00Z', cwd: '/' },
      ]))
      const store = loadHistory(historyPath)
      const stats = getHistoryStats(store)
      expect(stats.mostUsed[0].text).toBe('popular')
      expect(stats.mostUsed[0].count).toBe(3)
    })

    it('provides timestamps', () => {
      saveHistory(historyPath, createStore([
        { text: 'a', type: 'prompt', timestamp: '2024-01-15T10:00:00Z', cwd: '/' },
        { text: 'b', type: 'prompt', timestamp: '2024-01-16T10:00:00Z', cwd: '/' },
      ]))
      const store = loadHistory(historyPath)
      const stats = getHistoryStats(store)
      expect(stats.firstEntry).toBe('2024-01-15T10:00:00Z')
      expect(stats.lastEntry).toBe('2024-01-16T10:00:00Z')
    })
  })

  describe('formatting', () => {
    it('formatHistoryResults shows entries', () => {
      const store = createStore([
        { text: 'test command', type: 'prompt', timestamp: '2024-01-15T10:00:00Z', cwd: '/' },
      ])
      const out = formatHistoryResults(store.entries)
      expect(out).toContain('1 match')
      expect(out).toContain('test command')
    })

    it('formatHistoryResults handles empty', () => {
      expect(formatHistoryResults([])).toContain('No history matches')
    })

    it('formatHistoryStats shows counts', () => {
      const store = createStore([
        { text: 'a', type: 'prompt', timestamp: '2024-01-15T10:00:00Z', cwd: '/' },
        { text: 'b', type: 'command', timestamp: '2024-01-15T10:01:00Z', cwd: '/' },
      ])
      const stats = getHistoryStats(store)
      const out = formatHistoryStats(stats)
      expect(out).toContain('Total entries: 2')
      expect(out).toContain('Prompts: 1')
      expect(out).toContain('Commands: 1')
    })
  })

  describe('path helpers', () => {
    it('getGlobalHistoryPath returns a path', () => {
      expect(getGlobalHistoryPath()).toContain('command-history.json')
    })

    it('getProjectHistoryPath returns a path', () => {
      expect(getProjectHistoryPath('/test')).toContain('command-history.json')
    })
  })
})
