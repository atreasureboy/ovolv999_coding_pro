/**
 * Bookmark System
 *
 * Save and manage file/line bookmarks for quick navigation.
 * Persisted to .ovolv999/bookmarks.json.
 *
 * Bookmarks are like IDE "favorites" — save a location with a note
 * and jump back to it later.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { join, resolve, relative, isAbsolute } from 'path'

// ── Types ───────────────────────────────────────────────────────────────────

export interface Bookmark {
  /** Unique ID */
  id: string
  /** File path (absolute) */
  path: string
  /** Line number (1-based) */
  line: number
  /** Optional end line for ranges */
  endLine?: number
  /** User note/description */
  note: string
  /** Optional column */
  column?: number
  /** When created */
  createdAt: string
  /** Tags for categorization */
  tags?: string[]
  /** Whether this bookmark has been visited */
  visitCount: number
  /** Last visited timestamp */
  lastVisited: string | null
}

export interface BookmarkStore {
  bookmarks: Bookmark[]
}

// ── Persistence ─────────────────────────────────────────────────────────────

export function getBookmarksPath(cwd: string): string {
  return join(resolve(cwd), '.ovolv999', 'bookmarks.json')
}

export function loadBookmarks(cwd: string): BookmarkStore {
  const path = getBookmarksPath(cwd)
  if (!existsSync(path)) {
    return { bookmarks: [] }
  }
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as BookmarkStore
  } catch {
    return { bookmarks: [] }
  }
}

export function saveBookmarks(cwd: string, store: BookmarkStore): void {
  const dir = join(resolve(cwd), '.ovolv999')
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true })
  }
  writeFileSync(getBookmarksPath(cwd), JSON.stringify(store, null, 2), 'utf8')
}

// ── CRUD ────────────────────────────────────────────────────────────────────

export function addBookmark(
  cwd: string,
  filePath: string,
  line: number,
  note: string,
  options: { endLine?: number; column?: number; tags?: string[] } = {},
): Bookmark {
  const store = loadBookmarks(cwd)
  const absPath = resolve(cwd, filePath)

  // Check for existing bookmark at same location
  const existing = store.bookmarks.find(
    b => b.path === absPath && b.line === line,
  )

  if (existing) {
    existing.note = note
    existing.endLine = options.endLine
    existing.column = options.column
    existing.tags = options.tags
    saveBookmarks(cwd, store)
    return existing
  }

  const bookmark: Bookmark = {
    id: `bm_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    path: absPath,
    line,
    endLine: options.endLine,
    note,
    column: options.column,
    createdAt: new Date().toISOString(),
    tags: options.tags,
    visitCount: 0,
    lastVisited: null,
  }

  store.bookmarks.push(bookmark)
  saveBookmarks(cwd, store)
  return bookmark
}

export function removeBookmark(cwd: string, idOrNote: string): boolean {
  const store = loadBookmarks(cwd)
  const before = store.bookmarks.length
  store.bookmarks = store.bookmarks.filter(
    b => b.id !== idOrNote && !b.note.toLowerCase().includes(idOrNote.toLowerCase()),
  )
  if (store.bookmarks.length === before) return false
  saveBookmarks(cwd, store)
  return true
}

export function getBookmark(cwd: string, id: string): Bookmark | null {
  const store = loadBookmarks(cwd)
  return store.bookmarks.find(b => b.id === id) ?? null
}

export function visitBookmark(cwd: string, id: string): Bookmark | null {
  const store = loadBookmarks(cwd)
  const bookmark = store.bookmarks.find(b => b.id === id)
  if (!bookmark) return null
  bookmark.visitCount++
  bookmark.lastVisited = new Date().toISOString()
  saveBookmarks(cwd, store)
  return bookmark
}

// ── Querying ────────────────────────────────────────────────────────────────

export function getBookmarksByFile(cwd: string, filePath: string): Bookmark[] {
  const store = loadBookmarks(cwd)
  const absPath = resolve(cwd, filePath)
  return store.bookmarks.filter(b => b.path === absPath)
}

export function getBookmarksByTag(cwd: string, tag: string): Bookmark[] {
  const store = loadBookmarks(cwd)
  return store.bookmarks.filter(b => b.tags?.includes(tag))
}

export function searchBookmarks(cwd: string, query: string): Bookmark[] {
  const store = loadBookmarks(cwd)
  const lower = query.toLowerCase()
  return store.bookmarks.filter(b =>
    b.note.toLowerCase().includes(lower) ||
    b.path.toLowerCase().includes(lower) ||
    b.tags?.some(t => t.toLowerCase().includes(lower)),
  )
}

export function getRecentBookmarks(cwd: string, limit = 10): Bookmark[] {
  const store = loadBookmarks(cwd)
  return [...store.bookmarks]
    .sort((a, b) => {
      // Sort by lastVisited (most recent first), fall back to createdAt
      const aTime = a.lastVisited ?? a.createdAt
      const bTime = b.lastVisited ?? b.createdAt
      return new Date(bTime).getTime() - new Date(aTime).getTime()
    })
    .slice(0, limit)
}

export function getMostVisited(cwd: string, limit = 5): Bookmark[] {
  const store = loadBookmarks(cwd)
  return [...store.bookmarks]
    .filter(b => b.visitCount > 0)
    .sort((a, b) => b.visitCount - a.visitCount)
    .slice(0, limit)
}

// ── Formatting ──────────────────────────────────────────────────────────────

export function formatBookmarkList(bookmarks: Bookmark[], cwd?: string): string {
  if (bookmarks.length === 0) return 'No bookmarks found.'

  const lines: string[] = [`Bookmarks (${bookmarks.length}):`]
  for (let i = 0; i < bookmarks.length; i++) {
    const b = bookmarks[i]
    // v0.6.0 (audit): relative() corrupts already-relative bookmark
    // paths (e.g. 'src/app.ts' stored relative → '..\..\src\app.ts').
    // Only relativize absolute paths; keep stored relative paths as-is.
    const displayPath = cwd && isAbsolute(b.path) ? relative(cwd, b.path) : b.path
    const lineRange = b.endLine ? `:${b.line}-${b.endLine}` : `:${b.line}`
    const tags = b.tags?.length ? ` [${b.tags.join(', ')}]` : ''
    const visits = b.visitCount > 0 ? ` (${b.visitCount} visits)` : ''

    lines.push(`  ${i + 1}. ${displayPath}${lineRange}${tags}${visits}`)
    lines.push(`     "${b.note}"`)
    lines.push(`     id: ${b.id}`)
  }

  return lines.join('\n')
}

export function formatBookmarkDetail(bookmark: Bookmark, cwd?: string): string {
  // v0.6.0 (audit): same relative-path guard as formatBookmarkList.
  const displayPath = cwd && isAbsolute(bookmark.path) ? relative(cwd, bookmark.path) : bookmark.path
  const lines: string[] = [
    `Bookmark: ${bookmark.note}`,
    `  File: ${displayPath}`,
    `  Line: ${bookmark.line}${bookmark.endLine ? `-${bookmark.endLine}` : ''}`,
  ]
  if (bookmark.column) lines.push(`  Column: ${bookmark.column}`)
  if (bookmark.tags?.length) lines.push(`  Tags: ${bookmark.tags.join(', ')}`)
  lines.push(`  Created: ${bookmark.createdAt}`)
  lines.push(`  Visits: ${bookmark.visitCount}`)
  if (bookmark.lastVisited) lines.push(`  Last visited: ${bookmark.lastVisited}`)
  lines.push(`  ID: ${bookmark.id}`)
  return lines.join('\n')
}

export function formatBookmarkStats(store: BookmarkStore): string {
  const lines: string[] = [
    `Bookmark Statistics:`,
    `  Total: ${store.bookmarks.length}`,
  ]

  // By file
  const byFile = new Map<string, number>()
  for (const b of store.bookmarks) {
    byFile.set(b.path, (byFile.get(b.path) ?? 0) + 1)
  }
  const topFiles = [...byFile.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5)
  if (topFiles.length > 0) {
    lines.push('  Top files:')
    for (const [path, count] of topFiles) {
      const name = path.split('/').pop() ?? path
      lines.push(`    ${name}: ${count}`)
    }
  }

  // By tag
  const byTag = new Map<string, number>()
  for (const b of store.bookmarks) {
    for (const tag of b.tags ?? []) {
      byTag.set(tag, (byTag.get(tag) ?? 0) + 1)
    }
  }
  if (byTag.size > 0) {
    lines.push('  Tags:')
    for (const [tag, count] of [...byTag.entries()].sort((a, b) => b[1] - a[1])) {
      lines.push(`    ${tag}: ${count}`)
    }
  }

  const totalVisits = store.bookmarks.reduce((s, b) => s + b.visitCount, 0)
  if (totalVisits > 0) {
    lines.push(`  Total visits: ${totalVisits}`)
  }

  return lines.join('\n')
}
