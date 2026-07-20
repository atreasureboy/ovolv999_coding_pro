/**
 * Command History
 *
 * Tracks and searches past user prompts and slash commands.
 * Supports fuzzy search, filtering by type, and deduplication.
 *
 * Persisted to ~/.ovolv999/command-history.json (global) or
 * .ovolv999/command-history.json (project-level).
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync } from 'fs'
import { join, resolve } from 'path'
import { homedir } from 'os'

// ── Types ───────────────────────────────────────────────────────────────────

export type HistoryEntryType = 'prompt' | 'command' | 'pipe'

export interface HistoryEntry {
  /** The input text */
  text: string
  /** Entry type */
  type: HistoryEntryType
  /** ISO timestamp */
  timestamp: string
  /** Working directory when entered */
  cwd: string
  /** Whether this was part of a resumed session */
  resumed?: boolean
  /** Optional tags */
  tags?: string[]
}

export interface HistoryStore {
  entries: HistoryEntry[]
}

export interface SearchOptions {
  /** Filter by type */
  type?: HistoryEntryType
  /** Filter by tags */
  tags?: string[]
  /** Case sensitive */
  caseSensitive?: boolean
  /** Max results */
  limit?: number
  /** Only exact matches */
  exact?: boolean
}

// ── Persistence ─────────────────────────────────────────────────────────────

export function getGlobalHistoryPath(): string {
  return join(homedir(), '.ovolv999', 'command-history.json')
}

export function getProjectHistoryPath(cwd: string): string {
  return join(resolve(cwd), '.ovolv999', 'command-history.json')
}

export function loadHistory(path: string): HistoryStore {
  if (!existsSync(path)) {
    return { entries: [] }
  }
  try {
    const raw = readFileSync(path, 'utf8')
    return JSON.parse(raw) as HistoryStore
  } catch {
    return { entries: [] }
  }
}

export function saveHistory(path: string, store: HistoryStore): void {
  const dir = resolve(path, '..')
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true })
  }
  writeFileSync(path, JSON.stringify(store, null, 2), 'utf8')
}

// ── Entry Management ────────────────────────────────────────────────────────

const MAX_HISTORY_ENTRIES = 10000

export function addEntry(
  path: string,
  text: string,
  type: HistoryEntryType = 'prompt',
  cwd: string = process.cwd(),
  tags?: string[],
): HistoryEntry {
  const store = loadHistory(path)
  const entry: HistoryEntry = {
    text,
    type,
    timestamp: new Date().toISOString(),
    cwd,
    tags,
  }

  // Deduplicate: don't add if the last entry has the same text and type
  const last = store.entries[store.entries.length - 1]
  if (last && last.text === text && last.type === type) {
    return last
  }

  store.entries.push(entry)

  // Cap at max entries (keep most recent)
  if (store.entries.length > MAX_HISTORY_ENTRIES) {
    store.entries = store.entries.slice(-MAX_HISTORY_ENTRIES)
  }

  saveHistory(path, store)
  return entry
}

export function clearHistory(path: string): number {
  const store = loadHistory(path)
  const count = store.entries.length
  store.entries = []
  saveHistory(path, store)
  return count
}

// ── Search ──────────────────────────────────────────────────────────────────

/**
 * Fuzzy search through history entries.
 * Matches substrings, word boundaries, and fuzzy character sequences.
 */
export function searchHistory(store: HistoryStore, query: string, options: SearchOptions = {}): HistoryEntry[] {
  if (!query.trim()) {
    // Return all entries (filtered)
    let results = store.entries
    if (options.type) results = results.filter(e => e.type === options.type)
    if (options.tags?.length) {
      results = results.filter(e => options.tags!.some(t => e.tags?.includes(t)))
    }
    return results.slice(-(options.limit ?? 50)).reverse()
  }

  const limit = options.limit ?? 20
  const lowerQuery = options.caseSensitive ? query : query.toLowerCase()

  // Score each entry by relevance
  const scored: Array<{ entry: HistoryEntry; score: number }> = []

  for (const entry of store.entries) {
    // Filter by type
    if (options.type && entry.type !== options.type) continue
    // Filter by tags
    if (options.tags?.length) {
      if (!options.tags.some(t => entry.tags?.includes(t))) continue
    }

    const text = options.caseSensitive ? entry.text : entry.text.toLowerCase()

    let score = 0

    if (options.exact) {
      if (text === lowerQuery) score = 100
      else continue
    } else if (text === lowerQuery) {
      score = 100 // exact match
    } else if (text.startsWith(lowerQuery)) {
      score = 80 // prefix match
    } else if (text.includes(lowerQuery)) {
      score = 60 // substring match
    } else if (fuzzyMatch(text, lowerQuery)) {
      score = 40 // fuzzy match
    } else {
      continue
    }

    // Boost recent entries
    const ageDays = (Date.now() - new Date(entry.timestamp).getTime()) / (1000 * 60 * 60 * 24)
    score += Math.max(0, 10 - ageDays)

    // Boost commands slightly
    if (entry.type === 'command') score += 5

    scored.push({ entry, score })
  }

  // Sort by score (descending), then by timestamp (most recent first)
  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score
    return new Date(b.entry.timestamp).getTime() - new Date(a.entry.timestamp).getTime()
  })

  return scored.slice(0, limit).map(s => s.entry)
}

/**
 * Simple fuzzy match: check if all chars of query appear in order in text.
 */
export function fuzzyMatch(text: string, query: string): boolean {
  if (!query) return true
  let qi = 0
  for (let ti = 0; ti < text.length && qi < query.length; ti++) {
    if (text[ti] === query[qi]) qi++
  }
  return qi === query.length
}

/**
 * Get unique texts from history (for autocomplete suggestions).
 */
export function getUniqueTexts(store: HistoryStore, prefix: string = '', limit = 20): string[] {
  const seen = new Set<string>()
  const results: string[] = []
  const lower = prefix.toLowerCase()

  // Iterate in reverse (most recent first)
  for (let i = store.entries.length - 1; i >= 0; i--) {
    const text = store.entries[i].text
    if (seen.has(text)) continue
    if (prefix && !text.toLowerCase().startsWith(lower)) continue
    seen.add(text)
    results.push(text)
    if (results.length >= limit) break
  }

  return results
}

// ── Statistics ──────────────────────────────────────────────────────────────

export interface HistoryStats {
  totalEntries: number
  uniqueTexts: number
  byType: Record<HistoryEntryType, number>
  mostUsed: Array<{ text: string; count: number }>
  firstEntry: string | null
  lastEntry: string | null
}

export function getHistoryStats(store: HistoryStore): HistoryStats {
  const byType: Record<HistoryEntryType, number> = {
    prompt: 0,
    command: 0,
    pipe: 0,
  }
  const textCounts = new Map<string, number>()

  for (const entry of store.entries) {
    byType[entry.type]++
    textCounts.set(entry.text, (textCounts.get(entry.text) ?? 0) + 1)
  }

  const mostUsed = [...textCounts.entries()]
    .map(([text, count]) => ({ text, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 10)

  return {
    totalEntries: store.entries.length,
    uniqueTexts: textCounts.size,
    byType,
    mostUsed,
    firstEntry: store.entries[0]?.timestamp ?? null,
    lastEntry: store.entries[store.entries.length - 1]?.timestamp ?? null,
  }
}

// ── Formatting ──────────────────────────────────────────────────────────────

export function formatHistoryResults(entries: HistoryEntry[]): string {
  if (entries.length === 0) return 'No history matches.'
  const lines: string[] = [`Found ${entries.length} match(s):`]
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i]
    const icon = entry.type === 'command' ? '/' : entry.type === 'pipe' ? '|' : '>'
    const time = new Date(entry.timestamp).toLocaleDateString()
    const preview = entry.text.length > 80
      ? entry.text.slice(0, 77) + '...'
      : entry.text
    lines.push(`  ${i + 1}. ${icon} ${preview} \x1b[2m(${time})\x1b[0m`)
  }
  return lines.join('\n')
}

export function formatHistoryStats(stats: HistoryStats): string {
  const lines: string[] = [
    `Command History:`,
    `  Total entries: ${stats.totalEntries}`,
    `  Unique: ${stats.uniqueTexts}`,
    `  Prompts: ${stats.byType.prompt}`,
    `  Commands: ${stats.byType.command}`,
    `  Pipe: ${stats.byType.pipe}`,
  ]
  if (stats.firstEntry) lines.push(`  First: ${stats.firstEntry}`)
  if (stats.lastEntry) lines.push(`  Last: ${stats.lastEntry}`)
  if (stats.mostUsed.length > 0) {
    lines.push('')
    lines.push('  Most used:')
    for (const { text, count } of stats.mostUsed.slice(0, 5)) {
      const preview = text.length > 60 ? text.slice(0, 57) + '...' : text
      lines.push(`    ${count}x ${preview}`)
    }
  }
  return lines.join('\n')
}
