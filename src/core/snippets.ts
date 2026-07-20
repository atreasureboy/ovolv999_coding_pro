/**
 * Snippet Manager
 *
 * Save, organize, and insert reusable code snippets.
 * Supports categories, tags, variables/placeholders, and search.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { join, resolve } from 'path'

// ── Types ───────────────────────────────────────────────────────────────────

export interface Snippet {
  /** Unique ID */
  id: string
  /** Short name/trigger */
  name: string
  /** Language for syntax highlighting */
  language: string
  /** The code content (may contain {{variables}}) */
  body: string
  /** Description */
  description?: string
  /** Category for grouping */
  category?: string
  /** Tags for searching */
  tags?: string[]
  /** Variable names found in body */
  variables: string[]
  /** Whether snippet is a favorite */
  favorite: boolean
  /** Usage count */
  useCount: number
  /** When created */
  createdAt: string
  /** When last used */
  lastUsed: string | null
}

export interface SnippetStore {
  snippets: Snippet[]
}

// ── Persistence ─────────────────────────────────────────────────────────────

export function getSnippetPath(cwd: string): string {
  return join(resolve(cwd), '.ovolv999', 'snippets.json')
}

export function loadSnippets(cwd: string): SnippetStore {
  const path = getSnippetPath(cwd)
  if (!existsSync(path)) return { snippets: [] }
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as SnippetStore
  } catch {
    return { snippets: [] }
  }
}

export function saveSnippets(cwd: string, store: SnippetStore): void {
  const dir = join(resolve(cwd), '.ovolv999')
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  writeFileSync(getSnippetPath(cwd), JSON.stringify(store, null, 2), 'utf8')
}

// ── Variable Extraction ─────────────────────────────────────────────────────

export function extractVariables(body: string): string[] {
  const regex = /\{\{(\w+)\}\}/g
  const vars: string[] = []
  let match: RegExpExecArray | null
  while ((match = regex.exec(body)) !== null) {
    if (!vars.includes(match[1])) vars.push(match[1])
  }
  return vars
}

export function fillSnippet(body: string, values: Record<string, string>): string {
  return body.replace(/\{\{(\w+)\}\}/g, (_, name: string) => values[name] ?? `{{${name}}}`)
}

// ── CRUD ────────────────────────────────────────────────────────────────────

export function addSnippet(
  cwd: string,
  params: {
    name: string
    language: string
    body: string
    description?: string
    category?: string
    tags?: string[]
    favorite?: boolean
  },
): Snippet {
  const store = loadSnippets(cwd)
  const variables = extractVariables(params.body)

  const snippet: Snippet = {
    id: `snip_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    name: params.name,
    language: params.language,
    body: params.body,
    description: params.description,
    category: params.category,
    tags: params.tags,
    variables,
    favorite: params.favorite ?? false,
    useCount: 0,
    createdAt: new Date().toISOString(),
    lastUsed: null,
  }

  // Replace existing with same name
  const existingIdx = store.snippets.findIndex(s => s.name === params.name)
  if (existingIdx >= 0) {
    store.snippets[existingIdx] = snippet
  } else {
    store.snippets.push(snippet)
  }

  saveSnippets(cwd, store)
  return snippet
}

export function removeSnippet(cwd: string, idOrName: string): boolean {
  const store = loadSnippets(cwd)
  const before = store.snippets.length
  store.snippets = store.snippets.filter(
    s => s.id !== idOrName && s.name !== idOrName,
  )
  if (store.snippets.length === before) return false
  saveSnippets(cwd, store)
  return true
}

export function getSnippet(cwd: string, idOrName: string): Snippet | null {
  const store = loadSnippets(cwd)
  return store.snippets.find(s => s.id === idOrName || s.name === idOrName) ?? null
}

export function listSnippets(cwd: string, filter?: {
  category?: string
  tag?: string
  language?: string
  favoriteOnly?: boolean
}): Snippet[] {
  const store = loadSnippets(cwd)
  let snippets = store.snippets

  if (filter?.category) {
    snippets = snippets.filter(s => s.category === filter.category)
  }
  if (filter?.tag) {
    snippets = snippets.filter(s => s.tags?.includes(filter.tag!))
  }
  if (filter?.language) {
    snippets = snippets.filter(s => s.language === filter.language)
  }
  if (filter?.favoriteOnly) {
    snippets = snippets.filter(s => s.favorite)
  }

  return snippets
}

// ── Using Snippets ──────────────────────────────────────────────────────────

export function useSnippet(
  cwd: string,
  idOrName: string,
  variables: Record<string, string> = {},
): string | null {
  const snippet = getSnippet(cwd, idOrName)
  if (!snippet) return null

  const store = loadSnippets(cwd)
  const found = store.snippets.find(s => s.id === snippet.id)
  if (found) {
    found.useCount++
    found.lastUsed = new Date().toISOString()
    saveSnippets(cwd, store)
  }

  return fillSnippet(snippet.body, variables)
}

export function toggleFavorite(cwd: string, idOrName: string): Snippet | null {
  const store = loadSnippets(cwd)
  const snippet = store.snippets.find(s => s.id === idOrName || s.name === idOrName)
  if (!snippet) return null

  snippet.favorite = !snippet.favorite
  saveSnippets(cwd, store)
  return snippet
}

// ── Search ──────────────────────────────────────────────────────────────────

export function searchSnippets(cwd: string, query: string): Snippet[] {
  const store = loadSnippets(cwd)
  const lower = query.toLowerCase()
  return store.snippets.filter(s =>
    s.name.toLowerCase().includes(lower) ||
    s.body.toLowerCase().includes(lower) ||
    s.description?.toLowerCase().includes(lower) ||
    s.category?.toLowerCase().includes(lower) ||
    s.tags?.some(t => t.toLowerCase().includes(lower)),
  )
}

// ── Categories ──────────────────────────────────────────────────────────────

export function getCategories(cwd: string): string[] {
  const store = loadSnippets(cwd)
  const cats = new Set<string>()
  for (const s of store.snippets) {
    if (s.category) cats.add(s.category)
  }
  return [...cats].sort()
}

export function getAllTags(cwd: string): string[] {
  const store = loadSnippets(cwd)
  const tags = new Set<string>()
  for (const s of store.snippets) {
    for (const tag of s.tags ?? []) tags.add(tag)
  }
  return [...tags].sort()
}

// ── Stats ───────────────────────────────────────────────────────────────────

export interface SnippetStats {
  total: number
  favorites: number
  byCategory: Record<string, number>
  byLanguage: Record<string, number>
  byTag: Record<string, number>
  totalUses: number
  mostUsed: Snippet | null
  leastUsed: Snippet | null
  recentlyUsed: Snippet[]
}

export function getSnippetStats(cwd: string): SnippetStats {
  const store = loadSnippets(cwd)
  const snippets = store.snippets

  const byCategory: Record<string, number> = {}
  const byLanguage: Record<string, number> = {}
  const byTag: Record<string, number> = {}

  for (const s of snippets) {
    if (s.category) byCategory[s.category] = (byCategory[s.category] ?? 0) + 1
    byLanguage[s.language] = (byLanguage[s.language] ?? 0) + 1
    for (const tag of s.tags ?? []) {
      byTag[tag] = (byTag[tag] ?? 0) + 1
    }
  }

  const sorted = [...snippets].sort((a, b) => b.useCount - a.useCount)
  const recentlyUsed = snippets
    .filter(s => s.lastUsed)
    .sort((a, b) => new Date(b.lastUsed!).getTime() - new Date(a.lastUsed!).getTime())
    .slice(0, 5)

  return {
    total: snippets.length,
    favorites: snippets.filter(s => s.favorite).length,
    byCategory,
    byLanguage,
    byTag,
    totalUses: snippets.reduce((sum, s) => sum + s.useCount, 0),
    mostUsed: sorted[0] ?? null,
    leastUsed: sorted[sorted.length - 1] ?? null,
    recentlyUsed,
  }
}

// ── Formatting ──────────────────────────────────────────────────────────────

export function formatSnippet(snippet: Snippet): string {
  const lines: string[] = [
    `${snippet.favorite ? '★ ' : ''}${snippet.name} (${snippet.language})`,
  ]
  if (snippet.description) lines.push(`  ${snippet.description}`)
  if (snippet.category) lines.push(`  Category: ${snippet.category}`)
  if (snippet.tags?.length) lines.push(`  Tags: ${snippet.tags.join(', ')}`)
  if (snippet.variables.length > 0) {
    lines.push(`  Variables: ${snippet.variables.map(v => `{{${v}}}`).join(', ')}`)
  }
  lines.push(`  Uses: ${snippet.useCount}`)
  lines.push(`  ---`)
  lines.push(snippet.body)
  return lines.join('\n')
}

export function formatSnippetList(snippets: Snippet[]): string {
  if (snippets.length === 0) return 'No snippets found.'

  const lines: string[] = [`Snippets (${snippets.length}):`]
  for (let i = 0; i < snippets.length; i++) {
    const s = snippets[i]
    const star = s.favorite ? '★ ' : ''
    const cat = s.category ? ` [${s.category}]` : ''
    const vars = s.variables.length > 0 ? ` {${s.variables.length} vars}` : ''
    const uses = s.useCount > 0 ? ` (${s.useCount} uses)` : ''
    const preview = s.body.split('\n')[0].slice(0, 40)

    lines.push(`  ${i + 1}. ${star}${s.name} (${s.language})${cat}${vars}${uses}`)
    lines.push(`     ${preview}${s.body.length > 40 ? '...' : ''}`)
  }

  return lines.join('\n')
}

export function formatSnippetStats(stats: SnippetStats): string {
  const lines: string[] = [
    'Snippet Statistics:',
    `  Total: ${stats.total}`,
    `  Favorites: ${stats.favorites}`,
    `  Total uses: ${stats.totalUses}`,
  ]

  if (stats.mostUsed) {
    lines.push(`  Most used: ${stats.mostUsed.name} (${stats.mostUsed.useCount} uses)`)
  }

  const cats = Object.entries(stats.byCategory).sort((a, b) => b[1] - a[1])
  if (cats.length > 0) {
    lines.push('  By category:')
    for (const [cat, count] of cats) lines.push(`    ${cat}: ${count}`)
  }

  const langs = Object.entries(stats.byLanguage).sort((a, b) => b[1] - a[1])
  if (langs.length > 0) {
    lines.push('  By language:')
    for (const [lang, count] of langs) lines.push(`    ${lang}: ${count}`)
  }

  const tags = Object.entries(stats.byTag).sort((a, b) => b[1] - a[1])
  if (tags.length > 0) {
    lines.push('  By tag:')
    for (const [tag, count] of tags) lines.push(`    #${tag}: ${count}`)
  }

  return lines.join('\n')
}
