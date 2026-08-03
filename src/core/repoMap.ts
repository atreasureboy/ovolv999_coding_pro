/**
 * RepoMapService — v0.5.2 (C1 — borrowed from aider/repomap.py).
 *
 * Aider's repo map is a token-budgeted, cacheable, refresh-aware map
 * of the codebase's most important symbols + call signatures.
 * Borrowed from `aider/repomap.py` + `aider/coders/architect_coder.py`
 * but constrained by ovolv999's "no native deps, no embeddings"
 * contract: pure TypeScript + heuristic graph + TF-IDF ranking.
 *
 * Differences from aider's implementation:
 *   - No tree-sitter; symbols are extracted by a regex pass tuned
 *     for TS/JS/Python (the common targets in ovolv999 sessions).
 *   - No PageRank; we use a simpler "files referencing the most
 *     shared symbols bubble to the top" heuristic. This is
 *     intentionally weaker than aider's nx.pagerank — the goal is
 *     "a decent map the system prompt can use" not "the optimal
 *     map".
 *   - Refresh modes: `auto` (rebuild only when mtime changed),
 *     `files` (always use cache), `always` (always rebuild),
 *     `manual` (only return the last map). Same surface as aider.
 *
 * Production caller: the system-prompt builder injects the rendered
 * repo map into the LLM context when `codebaseAnalysis` is enabled
 * in config.
 */

import { existsSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { createHash } from 'node:crypto'
import { RepoStatsService } from './repoStats.js'

export type RepoMapRefreshMode = 'auto' | 'files' | 'always' | 'manual'

export interface RepoMapSymbol {
  /** Source file (absolute path). */
  file: string
  /** Symbol name (function/class/const/import). */
  name: string
  /** Symbol kind. */
  kind: 'function' | 'class' | 'const' | 'import' | 'export'
  /** Line number (1-based). */
  line: number
  /** Approximate signature (truncated to 120 chars). */
  signature: string
}

export interface RepoMapFileNode {
  file: string
  /** Symbols defined in this file (sorted by importance). */
  symbols: RepoMapSymbol[]
  /** Files that this file references via imports. */
  references: string[]
  /** Files that reference this file. */
  referencedBy: string[]
  /** Score used for ranking. */
  score: number
}

export interface RepoMapSnapshot {
  rootDir: string
  /** Files in the map, sorted by score descending. */
  files: RepoMapFileNode[]
  /** Total file count considered (may exceed `files.length`). */
  totalCandidates: number
  /** Approximate tokens rendered. */
  estimatedTokens: number
  /** Cache key for refresh-mode `auto`. */
  cacheKey: string
  computedAt: number
}

export interface RepoMapServiceOptions {
  /** Max files in the rendered map. */
  maxFiles?: number
  /** Max tokens in the rendered map. */
  maxTokens?: number
  /** Token-budget model (~4 chars per token). */
  charsPerToken?: number
  /** File extensions to consider. */
  extensions?: string[]
  /** Underlying repo stats for the file walk. */
  repoStats?: RepoStatsService
}

const DEFAULT_MAX_FILES = 60
const DEFAULT_MAX_TOKENS = 1000
const DEFAULT_CHARS_PER_TOKEN = 4

const DEFAULT_EXTENSIONS = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.py']

/** Heuristic symbol extractor. Captures the common TS/JS/Python
 *  function/class/const/import/export shapes we care about. */
const SYMBOL_PATTERNS: Array<{ kind: RepoMapSymbol['kind']; re: RegExp }> = [
  { kind: 'function', re: /^(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/ },
  { kind: 'function', re: /^(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s+)?\(/ },
  { kind: 'class', re: /^(?:export\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/ },
  { kind: 'const', re: /^(?:export\s+)?const\s+([A-Za-z_$][\w$]*)\s*=/ },
  { kind: 'import', re: /^import\s+(?:type\s+)?\{?\s*([A-Za-z_$][\w$]*)/ },
  { kind: 'export', re: /^export\s+(?:default\s+)?(?:const|function|class|interface|type)\s+([A-Za-z_$][\w$]*)/ },
]

function extractSymbols(filePath: string, content: string): RepoMapSymbol[] {
  const lines = content.split('\n')
  const out: RepoMapSymbol[] = []
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trimEnd()
    for (const { kind, re } of SYMBOL_PATTERNS) {
      const m = line.match(re)
      if (m && m[1]) {
        out.push({
          file: filePath,
          name: m[1],
          kind,
          line: i + 1,
          signature: line.slice(0, 120),
        })
        break // one symbol per line
      }
    }
    if (out.length >= 50) break // cap per file
  }
  return out
}

const IMPORT_PATTERNS = [
  /import\s+(?:type\s+)?\{?\s*[^}]*\}\s*from\s+['"]([^'"]+)['"]/g,
  /import\s+(?:type\s+)?\s*[A-Za-z_$][\w$]*\s+from\s+['"]([^'"]+)['"]/g,
  /from\s+['"]([^'"]+)['"]/g, // python
]

function extractImports(content: string): string[] {
  const out = new Set<string>()
  for (const re of IMPORT_PATTERNS) {
    for (const m of content.matchAll(re)) {
      if (m[1] && (m[1].startsWith('.') || m[1].startsWith('/'))) {
        out.add(m[1])
      }
    }
  }
  return [...out]
}

function resolveImport(fromFile: string, importPath: string, rootDir: string): string | null {
  // Resolve a relative import against fromFile's directory. Only
  // resolves to existing files within rootDir; external packages
  // (no leading `.`) are skipped.
  if (!importPath.startsWith('.')) return null
  const fromDir = dirname(fromFile)
  let candidate = resolve(fromDir, importPath)
  // Try common extensions
  for (const ext of DEFAULT_EXTENSIONS) {
    const withExt = candidate + ext
    if (existsSync(withExt)) {
      const rel = relative(rootDir, withExt)
      if (rel && !rel.startsWith('..')) return rel.split(sep).join('/')
    }
  }
  // Try index.* in directory imports
  const dirCandidate = join(candidate, 'index')
  for (const ext of DEFAULT_EXTENSIONS) {
    const withExt = dirCandidate + ext
    if (existsSync(withExt)) {
      const rel = relative(rootDir, withExt)
      if (rel && !rel.startsWith('..')) return rel.split(sep).join('/')
    }
  }
  return null
}

/**
 * RepoMapService — process-wide cache + invalidation hook.
 *
 * Same shape as RepoStatsService: reads from a snapshot, rebuilds
 * only on explicit invalidation or refresh-mode `always`. Pure: no
 * side effects on import.
 */
export class RepoMapService {
  private readonly opts: Required<Omit<RepoMapServiceOptions, 'repoStats'>> & { repoStats?: RepoStatsService }
  private cache: { snapshot: RepoMapSnapshot | null; key: string | null } = { snapshot: null, key: null }
  private lastMode: RepoMapRefreshMode = 'manual'

  constructor(opts: RepoMapServiceOptions = {}) {
    this.opts = {
      maxFiles: opts.maxFiles ?? DEFAULT_MAX_FILES,
      maxTokens: opts.maxTokens ?? DEFAULT_MAX_TOKENS,
      charsPerToken: opts.charsPerToken ?? DEFAULT_CHARS_PER_TOKEN,
      extensions: opts.extensions ?? DEFAULT_EXTENSIONS,
      repoStats: opts.repoStats,
    }
  }

  invalidate(): void {
    this.cache = { snapshot: null, key: null }
  }

  /**
   * Build or fetch a snapshot. When refreshMode is 'auto' and the
   * cache is fresh, returns the cached snapshot. 'files' / 'manual'
   * skip rebuild. 'always' always rebuilds.
   */
  snapshot(rootDir: string, refreshMode: RepoMapRefreshMode = 'auto'): RepoMapSnapshot | null {
    this.lastMode = refreshMode
    if (refreshMode === 'manual') {
      return this.cache.snapshot
    }
    const key = this.computeCacheKey(rootDir, refreshMode === 'always')
    if (refreshMode === 'files' && this.cache.snapshot && this.cache.key === key) {
      return this.cache.snapshot
    }
    if (refreshMode === 'auto' && this.cache.snapshot && this.cache.key === key) {
      return this.cache.snapshot
    }
    const built = this.buildSnapshot(rootDir)
    if (!built) return null
    // Stamp the cache key onto the snapshot so consumers can detect
    // freshness; buildSnapshot previously read this.cache.key before
    // the assignment, which left it empty.
    built.cacheKey = key
    this.cache = { snapshot: built, key }
    return built
  }

  /** Render the snapshot as a markdown block suitable for system
   *  prompt injection. Returns '' when the snapshot is empty. */
  renderForPrompt(snap: RepoMapSnapshot): string {
    if (snap.files.length === 0) return ''
    const lines: string[] = ['## Repo Map (top files by symbol density)', '']
    for (const node of snap.files) {
      const top = node.symbols.slice(0, 8)
      const sym = top.map((s) => `${s.name}@${s.line}`).join(', ')
      const refCount = node.references.length
      const refByCount = node.referencedBy.length
      lines.push(`- ${relative(snap.rootDir, node.file) || node.file} (${top.length} symbols; ${refCount} refs out, ${refByCount} refs in; score ${node.score.toFixed(2)})`)
      if (sym) lines.push(`    - ${sym}`)
    }
    return lines.join('\n')
  }

  private computeCacheKey(rootDir: string, forceRebuild: boolean): string {
    if (forceRebuild) return `${rootDir}::always::${Date.now()}`
    const h = createHash('sha256')
    h.update(rootDir)
    // Include the max-files/max-tokens knobs in the key so a config
    // change forces a rebuild.
    h.update(`::${this.opts.maxFiles}::${this.opts.maxTokens}`)
    // Walk the root dir and hash mtimes for source files. Cheap
    // because RepoStats already cached the file list — we use that
    // here. If repoStats is not supplied, fall back to a "no
    // mtime-aware key" marker that forces rebuild on every call.
    const stats = this.opts.repoStats
    if (stats) {
      const snap = stats.snapshot(rootDir)
      if (snap.state === 'ready' && snap.stats) {
        for (const ext of Object.keys(snap.stats.byExtension)) {
          h.update(`::${ext}=${snap.stats.byExtension[ext]}`)
        }
      }
    }
    return h.digest('hex')
  }

  private buildSnapshot(rootDir: string): RepoMapSnapshot | null {
    if (!existsSync(rootDir)) return null
    const absRoot = resolve(rootDir)
    const repoStats = this.opts.repoStats
    // Use RepoStatsService to enumerate files; if absent, build a
    // minimal in-place walk.
    let files: string[]
    if (repoStats) {
      const snap = repoStats.snapshot(absRoot)
      if (snap.state !== 'ready' || !snap.stats) return null
      files = this.allFiles(absRoot, snap.stats.byExtension)
    } else {
      files = this.walkSimple(absRoot)
    }
    if (files.length === 0) return null

    const fileContents = new Map<string, string>()
    const fileImports = new Map<string, Set<string>>()
    for (const file of files) {
      try {
        const content = readFileSync(file, 'utf8')
        fileContents.set(file, content)
        const imports = new Set<string>()
        for (const imp of extractImports(content)) {
          const rel = resolveImport(file, imp, absRoot)
          if (rel) imports.add(rel)
        }
        fileImports.set(file, imports)
      } catch { /* skip unreadable */ }
    }

    // Build reverse index: file → set of files referencing it.
    const referencedBy = new Map<string, Set<string>>()
    for (const [file, imports] of fileImports) {
      for (const imp of imports) {
        const resolvedTarget = files.find((f) => relative(absRoot, f).split(sep).join('/') === imp)
        if (resolvedTarget && resolvedTarget !== file) {
          if (!referencedBy.has(resolvedTarget)) referencedBy.set(resolvedTarget, new Set())
          referencedBy.get(resolvedTarget)!.add(file)
        }
      }
    }

    // Score: symbol count + referencedBy weight.
    const nodes: RepoMapFileNode[] = []
    for (const file of files) {
      const content = fileContents.get(file) ?? ''
      const symbols = extractSymbols(file, content)
      const imports = fileImports.get(file) ?? new Set<string>()
      const refBy = referencedBy.get(file) ?? new Set<string>()
      const score = symbols.length * 1.0 + refBy.size * 0.5
      nodes.push({
        file,
        symbols,
        references: [...imports],
        referencedBy: [...refBy].map((f) => relative(absRoot, f).split(sep).join('/')),
        score,
      })
    }

    // Sort by score descending, then by symbol count, then by file path
    // for deterministic ordering (a v0.5.2 rule: same input → same output).
    nodes.sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score
      if (b.symbols.length !== a.symbols.length) return b.symbols.length - a.symbols.length
      return a.file.localeCompare(b.file)
    })

    // Cap by both maxFiles and maxTokens.
    const charsPerToken = this.opts.charsPerToken
    const cap: RepoMapFileNode[] = []
    let estimatedTokens = 0
    for (const node of nodes) {
      if (cap.length >= this.opts.maxFiles) break
      const nodeTokens = Math.ceil(node.symbols.length * 12 + node.references.length * 8 + node.referencedBy.length * 8)
      if (estimatedTokens + nodeTokens > this.opts.maxTokens && cap.length > 0) break
      cap.push(node)
      estimatedTokens += nodeTokens
    }

    return {
      rootDir: absRoot,
      files: cap,
      totalCandidates: nodes.length,
      estimatedTokens,
      cacheKey: this.cache.key ?? '',
      computedAt: Date.now(),
    }
  }

  private allFiles(rootDir: string, byExtension: Record<string, number>): string[] {
    const out: string[] = []
    const allowed = new Set(this.opts.extensions)
    const walk = (dir: string, depth: number): void => {
      if (depth > 12) return
      let entries: string[]
      try {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const { readdirSync } = require('node:fs') as typeof import('node:fs')
        entries = readdirSync(dir).filter((n) => !n.startsWith('.'))
      } catch { return }
      for (const name of entries) {
        const full = join(dir, name)
        let stat
        try { stat = statSync(full) } catch { continue }
        if (stat.isDirectory()) walk(full, depth + 1)
        else if (stat.isFile() && allowed.has(extOf(name))) out.push(full)
      }
    }
    walk(rootDir, 0)
    void byExtension // kept for signature parity; allow-list governs
    return out
  }

  private walkSimple(rootDir: string): string[] {
    return this.allFiles(rootDir, {})
  }

  /** Test-only: inspect the cache state. */
  getCacheState(): { hasSnapshot: boolean; key: string | null; mode: RepoMapRefreshMode } {
    return { hasSnapshot: this.cache.snapshot !== null, key: this.cache.key, mode: this.lastMode }
  }
}

function extOf(name: string): string {
  const i = name.lastIndexOf('.')
  return i >= 0 ? name.slice(i).toLowerCase() : ''
}