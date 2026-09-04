import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import {
  addBookmark,
  removeBookmark,
  getBookmark,
  visitBookmark,
  getBookmarksByFile,
  getBookmarksByTag,
  searchBookmarks,
  getRecentBookmarks,
  getMostVisited,
  formatBookmarkList,
  formatBookmarkDetail,
  formatBookmarkStats,
  loadBookmarks,
  saveBookmarks,
  getBookmarksPath,
  
} from '../src/core/bookmarks.js'
import { mkdtempSync, rmSync, existsSync, mkdirSync, writeFileSync, readFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

function makeTempDir(): string {
  return mkdtempSync(join(tmpdir(), 'ovolv999-bm-'))
}

describe('Bookmark System', () => {
  let cwd: string

  beforeEach(() => {
    cwd = makeTempDir()
  })

  afterEach(() => {
    rmSync(cwd, { recursive: true, force: true })
  })

  describe('persistence', () => {
    it('loads empty store when no bookmarks file', () => {
      const store = loadBookmarks(cwd)
      expect(store.bookmarks).toEqual([])
    })

    it('saves and loads bookmarks', () => {
      addBookmark(cwd, 'src/index.ts', 10, 'entry point')
      const store = loadBookmarks(cwd)
      expect(store.bookmarks).toHaveLength(1)
      expect(store.bookmarks[0].note).toBe('entry point')
    })

    it('creates .ovolv999 directory on save', () => {
      addBookmark(cwd, 'foo.ts', 1, 'test')
      expect(existsSync(getBookmarksPath(cwd))).toBe(true)
    })

    it('returns malformed JSON as empty store', () => {
      saveBookmarks(cwd, { bookmarks: [] })
      // Write invalid JSON directly
      const { writeFileSync } = require('fs')
      writeFileSync(getBookmarksPath(cwd), '{invalid', 'utf8')
      const store = loadBookmarks(cwd)
      expect(store.bookmarks).toEqual([])
    })
  })

  describe('addBookmark', () => {
    it('creates a new bookmark with unique id', () => {
      const bm = addBookmark(cwd, 'src/a.ts', 5, 'note A')
      expect(bm.id).toMatch(/^bm_\d+_/)
      expect(bm.note).toBe('note A')
      expect(bm.line).toBe(5)
      expect(bm.visitCount).toBe(0)
      expect(bm.lastVisited).toBeNull()
    })

    it('updates existing bookmark at same location', () => {
      addBookmark(cwd, 'src/a.ts', 5, 'original')
      const updated = addBookmark(cwd, 'src/a.ts', 5, 'updated note')
      expect(updated.note).toBe('updated note')
      const store = loadBookmarks(cwd)
      expect(store.bookmarks).toHaveLength(1)
    })

    it('stores optional fields', () => {
      const bm = addBookmark(cwd, 'src/a.ts', 5, 'test', {
        endLine: 10, column: 3, tags: ['important', 'review'],
      })
      expect(bm.endLine).toBe(10)
      expect(bm.column).toBe(3)
      expect(bm.tags).toEqual(['important', 'review'])
    })

    it('resolves relative paths to absolute', () => {
      const bm = addBookmark(cwd, 'src/a.ts', 1, 'test')
      expect(bm.path).toBe(join(cwd, 'src/a.ts'))
    })
  })

  describe('removeBookmark', () => {
    it('removes by id', () => {
      const bm = addBookmark(cwd, 'a.ts', 1, 'test')
      const removed = removeBookmark(cwd, bm.id)
      expect(removed).toBe(true)
      expect(loadBookmarks(cwd).bookmarks).toHaveLength(0)
    })

    it('removes by note (case-insensitive)', () => {
      addBookmark(cwd, 'a.ts', 1, 'Important Code')
      const removed = removeBookmark(cwd, 'important code')
      expect(removed).toBe(true)
    })

    it('returns false when not found', () => {
      expect(removeBookmark(cwd, 'nonexistent')).toBe(false)
    })
  })

  describe('getBookmark', () => {
    it('finds bookmark by id', () => {
      const bm = addBookmark(cwd, 'a.ts', 1, 'test')
      const found = getBookmark(cwd, bm.id)
      expect(found?.note).toBe('test')
    })

    it('returns null for missing id', () => {
      expect(getBookmark(cwd, 'nope')).toBeNull()
    })
  })

  describe('visitBookmark', () => {
    it('increments visit count', () => {
      const bm = addBookmark(cwd, 'a.ts', 1, 'test')
      visitBookmark(cwd, bm.id)
      visitBookmark(cwd, bm.id)
      const found = getBookmark(cwd, bm.id)
      expect(found?.visitCount).toBe(2)
      expect(found?.lastVisited).not.toBeNull()
    })

    it('returns null for missing bookmark', () => {
      expect(visitBookmark(cwd, 'nope')).toBeNull()
    })
  })

  describe('getBookmarksByFile', () => {
    it('filters by file path', () => {
      addBookmark(cwd, 'a.ts', 1, 'one')
      addBookmark(cwd, 'a.ts', 10, 'two')
      addBookmark(cwd, 'b.ts', 1, 'three')
      const results = getBookmarksByFile(cwd, 'a.ts')
      expect(results).toHaveLength(2)
    })
  })

  describe('getBookmarksByTag', () => {
    it('filters by tag', () => {
      addBookmark(cwd, 'a.ts', 1, 'one', { tags: ['bug'] })
      addBookmark(cwd, 'b.ts', 2, 'two', { tags: ['review', 'bug'] })
      addBookmark(cwd, 'c.ts', 3, 'three', { tags: ['review'] })
      const bugs = getBookmarksByTag(cwd, 'bug')
      expect(bugs).toHaveLength(2)
    })
  })

  describe('searchBookmarks', () => {
    it('matches note content', () => {
      addBookmark(cwd, 'a.ts', 1, 'fix auth bug')
      addBookmark(cwd, 'b.ts', 2, 'update docs')
      const results = searchBookmarks(cwd, 'auth')
      expect(results).toHaveLength(1)
    })

    it('matches path content', () => {
      addBookmark(cwd, 'src/auth/login.ts', 1, 'login')
      addBookmark(cwd, 'src/utils/math.ts', 2, 'math')
      const results = searchBookmarks(cwd, 'auth')
      expect(results).toHaveLength(1)
    })

    it('matches tag content', () => {
      addBookmark(cwd, 'a.ts', 1, 'note', { tags: ['critical'] })
      const results = searchBookmarks(cwd, 'crit')
      expect(results).toHaveLength(1)
    })
  })

  describe('getRecentBookmarks', () => {
    it('returns sorted by last visited', async () => {
      addBookmark(cwd, 'a.ts', 1, 'older')
      await new Promise(r => setTimeout(r, 10))
      const bm2 = addBookmark(cwd, 'b.ts', 2, 'newer')
      await new Promise(r => setTimeout(r, 10))
      visitBookmark(cwd, bm2.id)
      const recent = getRecentBookmarks(cwd)
      expect(recent[0].id).toBe(bm2.id)
    })

    it('respects limit', () => {
      for (let i = 0; i < 5; i++) {
        addBookmark(cwd, `file${i}.ts`, i, `note ${i}`)
      }
      expect(getRecentBookmarks(cwd, 3)).toHaveLength(3)
    })
  })

  describe('getMostVisited', () => {
    it('returns sorted by visit count', () => {
      const bm1 = addBookmark(cwd, 'a.ts', 1, 'one')
      const bm2 = addBookmark(cwd, 'b.ts', 2, 'two')
      visitBookmark(cwd, bm1.id)
      visitBookmark(cwd, bm2.id)
      visitBookmark(cwd, bm2.id)
      const most = getMostVisited(cwd)
      expect(most[0].id).toBe(bm2.id)
      expect(most[0].visitCount).toBe(2)
    })

    it('excludes unvisited bookmarks', () => {
      addBookmark(cwd, 'a.ts', 1, 'unvisited')
      expect(getMostVisited(cwd)).toHaveLength(0)
    })
  })

  describe('formatBookmarkList', () => {
    it('shows empty message when no bookmarks', () => {
      expect(formatBookmarkList([])).toBe('No bookmarks found.')
    })

    it('includes index, path, note, and id', () => {
      const bm = addBookmark(cwd, 'a.ts', 5, 'test note')
      const out = formatBookmarkList([bm], cwd)
      expect(out).toContain('1.')
      expect(out).toContain('a.ts:5')
      expect(out).toContain('test note')
      expect(out).toContain(bm.id)
    })

    it('includes tags and visit count when present', () => {
      const bm = addBookmark(cwd, 'a.ts', 1, 'test', { tags: ['bug'] })
      visitBookmark(cwd, bm.id)
      const visited = getBookmark(cwd, bm.id)!
      const out = formatBookmarkList([visited], cwd)
      expect(out).toContain('[bug]')
      expect(out).toContain('(1 visits)')
    })

    it('shows line range when endLine is set', () => {
      const bm = addBookmark(cwd, 'a.ts', 5, 'test', { endLine: 10 })
      const out = formatBookmarkList([bm], cwd)
      expect(out).toContain(':5-10')
    })
  })

  describe('formatBookmarkDetail', () => {
    it('includes all bookmark details', () => {
      const bm = addBookmark(cwd, 'src/app.ts', 42, 'main entry', {
        column: 3, tags: ['critical', 'entry'],
      })
      const out = formatBookmarkDetail(bm, cwd)
      expect(out).toContain('main entry')
      // v0.6.0 (audit): relative path uses platform separator.
      expect(out.replace(/\\/g, '/')).toContain('src/app.ts')
      expect(out).toContain('Line: 42')
      expect(out).toContain('Column: 3')
      expect(out).toContain('critical, entry')
      expect(out).toContain('ID:')
    })
  })

  describe('formatBookmarkStats', () => {
    it('shows total count', () => {
      addBookmark(cwd, 'a.ts', 1, 'one')
      addBookmark(cwd, 'a.ts', 2, 'two')
      addBookmark(cwd, 'b.ts', 1, 'three')
      const store2 = loadBookmarks(cwd)
      const out = formatBookmarkStats(store2)
      expect(out).toContain('Total: 3')
      expect(out).toContain('a.ts')
      expect(out).toContain('Top files')
    })

    it('shows tag counts when present', () => {
      addBookmark(cwd, 'a.ts', 1, 'one', { tags: ['bug', 'urgent'] })
      addBookmark(cwd, 'b.ts', 2, 'two', { tags: ['bug'] })
      const store = loadBookmarks(cwd)
      const out = formatBookmarkStats(store)
      expect(out).toContain('bug: 2')
      expect(out).toContain('urgent: 1')
    })

    it('shows visit stats when present', () => {
      const bm = addBookmark(cwd, 'a.ts', 1, 'test')
      visitBookmark(cwd, bm.id)
      visitBookmark(cwd, bm.id)
      const store = loadBookmarks(cwd)
      const out = formatBookmarkStats(store)
      expect(out).toContain('Total visits: 2')
    })
  })
})

describe('bookmark store corruption guard', () => {
  let cwd: string
  beforeEach(() => { cwd = makeTempDir() })
  afterEach(() => { rmSync(cwd, { recursive: true, force: true }) })

  it('preserves a corrupt store before resetting, and bookmarks still work', () => {
    const path = join(cwd, '.ovolv999', 'bookmarks.json')
    const backup = `${path}.corrupt`
    mkdirSync(join(path, '..'), { recursive: true })
    writeFileSync(path, '{"bookmarks": [{"id": "torn"}', 'utf8')

    expect(loadBookmarks(cwd)).toEqual({ bookmarks: [] })
    expect(readFileSync(backup, 'utf8')).toBe('{"bookmarks": [{"id": "torn"}')

    addBookmark(cwd, '/tmp/a.ts', 12, 'note-a')
    expect(getBookmarksByFile(cwd, '/tmp/a.ts').length).toBe(1)
    expect(readFileSync(backup, 'utf8')).toBe('{"bookmarks": [{"id": "torn"}')
  })

  it('treats an entry missing read-path fields as corrupt', () => {
    const path = join(cwd, '.ovolv999', 'bookmarks.json')
    mkdirSync(join(path, '..'), { recursive: true })
    writeFileSync(path, '{"bookmarks": [{"id": "x"}]}', 'utf8')
    expect(loadBookmarks(cwd)).toEqual({ bookmarks: [] })
    expect(existsSync(`${path}.corrupt`)).toBe(true)
  })
})
