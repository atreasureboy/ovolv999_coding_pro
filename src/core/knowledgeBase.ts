/**
 * Project Knowledge Base
 *
 * Persistent storage for project-specific facts that the LLM discovers
 * during sessions. Unlike OVOGO.md (user-authored instructions) or
 * SemanticMemory (auto-generated semantic memories), this is a
 * structured key-value store for concrete facts:
 *   - File purposes ("src/engine.ts" → "Main execution engine")
 *   - Patterns ("error handling" → "wrap with try-catch and log")
 *   - Decisions ("use vitest" → "decided in 2024-01-15 meeting")
 *   - Gotchas ("don't edit dist/" → "it's auto-generated")
 *
 * Stored in .ovolv999/knowledge.json
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { join, resolve } from 'path'

// ── Types ───────────────────────────────────────────────────────────────────

export type KnowledgeCategory =
  | 'file'
  | 'pattern'
  | 'decision'
  | 'gotcha'
  | 'dependency'
  | 'convention'
  | 'architecture'
  | 'general'

export interface KnowledgeEntry {
  /** Unique ID */
  id: string
  /** Category for grouping */
  category: KnowledgeCategory
  /** Short key/title (e.g., "src/engine.ts", "error handling") */
  key: string
  /** The fact/value */
  value: string
  /** When this was recorded */
  createdAt: string
  /** Last updated */
  updatedAt: string
  /** Optional source (session ID, user, auto-discovered) */
  source?: string
  /** Optional tags for search */
  tags?: string[]
  /** Confidence 0-1 */
  confidence?: number
}

export interface KnowledgeStore {
  entries: KnowledgeEntry[]
}

// ── Store Path ──────────────────────────────────────────────────────────────

export function getKnowledgePath(cwd: string): string {
  return join(resolve(cwd), '.ovolv999', 'knowledge.json')
}

export function loadKnowledge(cwd: string): KnowledgeStore {
  const path = getKnowledgePath(cwd)
  if (!existsSync(path)) {
    return { entries: [] }
  }
  try {
    const raw = readFileSync(path, 'utf8')
    return JSON.parse(raw) as KnowledgeStore
  } catch {
    return { entries: [] }
  }
}

export function saveKnowledge(cwd: string, store: KnowledgeStore): void {
  const dir = join(resolve(cwd), '.ovolv999')
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true })
  }
  writeFileSync(getKnowledgePath(cwd), JSON.stringify(store, null, 2), 'utf8')
}

// ── CRUD Operations ─────────────────────────────────────────────────────────

export function addEntry(
  cwd: string,
  category: KnowledgeCategory,
  key: string,
  value: string,
  options: { source?: string; tags?: string[]; confidence?: number } = {},
): KnowledgeEntry {
  const store = loadKnowledge(cwd)
  const now = new Date().toISOString()

  // Check for existing entry with same key+category
  const existing = store.entries.find(
    e => e.category === category && e.key === key,
  )

  if (existing) {
    existing.value = value
    existing.updatedAt = now
    if (options.source) existing.source = options.source
    if (options.tags) existing.tags = options.tags
    if (options.confidence !== undefined) existing.confidence = options.confidence
    saveKnowledge(cwd, store)
    return existing
  }

  const entry: KnowledgeEntry = {
    id: `kn_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    category,
    key,
    value,
    createdAt: now,
    updatedAt: now,
    source: options.source,
    tags: options.tags,
    confidence: options.confidence,
  }

  store.entries.push(entry)
  saveKnowledge(cwd, store)
  return entry
}

export function removeEntry(cwd: string, idOrKey: string): boolean {
  const store = loadKnowledge(cwd)
  const before = store.entries.length
  store.entries = store.entries.filter(
    e => e.id !== idOrKey && e.key !== idOrKey,
  )
  if (store.entries.length === before) return false
  saveKnowledge(cwd, store)
  return true
}

export function getEntry(cwd: string, key: string): KnowledgeEntry | null {
  const store = loadKnowledge(cwd)
  return store.entries.find(e => e.key === key) ?? null
}

export function getByCategory(cwd: string, category: KnowledgeCategory): KnowledgeEntry[] {
  const store = loadKnowledge(cwd)
  return store.entries.filter(e => e.category === category)
}

// ── Search ──────────────────────────────────────────────────────────────────

export function searchKnowledge(
  cwd: string,
  query: string,
  options: { category?: KnowledgeCategory; limit?: number } = {},
): KnowledgeEntry[] {
  const store = loadKnowledge(cwd)
  const lower = query.toLowerCase()
  const limit = options.limit ?? 20

  let results = store.entries.filter(e => {
    if (options.category && e.category !== options.category) return false
    return (
      e.key.toLowerCase().includes(lower) ||
      e.value.toLowerCase().includes(lower) ||
      e.tags?.some(t => t.toLowerCase().includes(lower))
    )
  })

  // Sort by relevance (key match > value match > tag match)
  results.sort((a, b) => {
    const aKey = a.key.toLowerCase().includes(lower) ? 3 : 0
    const aValue = a.value.toLowerCase().includes(lower) ? 2 : 0
    const aTag = a.tags?.some(t => t.toLowerCase().includes(lower)) ? 1 : 0
    const bKey = b.key.toLowerCase().includes(lower) ? 3 : 0
    const bValue = b.value.toLowerCase().includes(lower) ? 2 : 0
    const bTag = b.tags?.some(t => t.toLowerCase().includes(lower)) ? 1 : 0
    return (bKey + bValue + bTag) - (aKey + aValue + aTag)
  })

  return results.slice(0, limit)
}

// ── Auto-Discovery ──────────────────────────────────────────────────────────

/**
 * Extract potential knowledge from a conversation.
 * Looks for patterns like:
 *   - "The file X does Y"
 *   - "X depends on Y"
 *   - "Don't do X because Y"
 *
 * Returns suggested entries that the user can confirm.
 */
export function extractKnowledgeFromText(text: string): Array<{
  category: KnowledgeCategory
  key: string
  value: string
  confidence: number
}> {
  const suggestions: Array<{ category: KnowledgeCategory; key: string; value: string; confidence: number }> = []

  // "The file <path> <does/is/contains> <description>"
  const fileMatch = text.match(/(?:the )?file\s+([^\s]+\.\w+)\s+(?:does|is|contains|handles|manages|implements)\s+(.{10,200})/i)
  if (fileMatch) {
    suggestions.push({
      category: 'file',
      key: fileMatch[1],
      value: fileMatch[2].trim(),
      confidence: 0.6,
    })
  }

  // "X depends on Y"
  const depMatch = text.match(/(\w+(?:\.\w+)+)\s+depends\s+on\s+(.{5,100})/i)
  if (depMatch) {
    suggestions.push({
      category: 'dependency',
      key: depMatch[1],
      value: depMatch[2].trim(),
      confidence: 0.5,
    })
  }

  // "Don't <action> because <reason>"
  const gotchaMatch = text.match(/don't\s+(.{5,100})\s+because\s+(.{5,200})/i)
  if (gotchaMatch) {
    suggestions.push({
      category: 'gotcha',
      key: gotchaMatch[1].trim(),
      value: gotchaMatch[2].trim(),
      confidence: 0.7,
    })
  }

  // "We decided to <action>"
  const decisionMatch = text.match(/(?:we\s+)?decided\s+to\s+(.{5,200})/i)
  if (decisionMatch) {
    suggestions.push({
      category: 'decision',
      key: 'recent decision',
      value: decisionMatch[1].trim(),
      confidence: 0.5,
    })
  }

  return suggestions
}

// ── Formatting ──────────────────────────────────────────────────────────────

export const CATEGORY_ICONS: Record<KnowledgeCategory, string> = {
  file: '📄',
  pattern: '🔄',
  decision: '✅',
  gotcha: '⚠️',
  dependency: '📦',
  convention: '📏',
  architecture: '🏗️',
  general: '📝',
}

export function formatEntry(entry: KnowledgeEntry): string {
  const icon = CATEGORY_ICONS[entry.category]
  const tags = entry.tags?.length ? ` [${entry.tags.join(', ')}]` : ''
  const confidence = entry.confidence !== undefined
    ? ` (${Math.round(entry.confidence * 100)}%)`
    : ''
  return `${icon} ${entry.key}${confidence}${tags}\n   ${entry.value}`
}

export function formatKnowledgeList(entries: KnowledgeEntry[]): string {
  if (entries.length === 0) return 'No knowledge entries found.'

  // Group by category
  const byCategory = new Map<KnowledgeCategory, KnowledgeEntry[]>()
  for (const entry of entries) {
    const list = byCategory.get(entry.category) ?? []
    list.push(entry)
    byCategory.set(entry.category, list)
  }

  const lines: string[] = [`Knowledge Base (${entries.length} entries):`]
  for (const [category, list] of byCategory) {
    lines.push('')
    lines.push(`── ${category} (${list.length}) ──`)
    for (const entry of list) {
      lines.push(formatEntry(entry))
    }
  }

  return lines.join('\n')
}

export function formatSearchResults(results: KnowledgeEntry[], query: string): string {
  if (results.length === 0) return `No matches for "${query}".`
  const lines = [`Found ${results.length} match(s) for "${query}":`]
  for (const entry of results) {
    lines.push(formatEntry(entry))
  }
  return lines.join('\n')
}

export function formatStats(store: KnowledgeStore): string {
  const byCategory = new Map<KnowledgeCategory, number>()
  for (const entry of store.entries) {
    byCategory.set(entry.category, (byCategory.get(entry.category) ?? 0) + 1)
  }
  const lines = [`Knowledge Base: ${store.entries.length} total entries`]
  for (const [cat, count] of byCategory) {
    lines.push(`  ${CATEGORY_ICONS[cat]} ${cat}: ${count}`)
  }
  return lines.join('\n')
}
