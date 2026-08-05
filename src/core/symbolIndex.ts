/**
 * SymbolIndex (v0.6.0) — codebase-wide symbol index for fast lookup.
 *
 * Inspired by Codex's tree-sitter symbol indexing and LSP's
 * workspace/symbol. Builds a lightweight in-memory index of every
 * exported/declared symbol (function, class, interface, type, enum,
 * variable, import) across the codebase, so the agent can answer
 * "where is X defined?" and "what depends on X?" without grepping.
 *
 * Design:
 *   - Pure TypeScript, zero native deps (reuses codeStructure.ts parsing)
 *   - Incremental: index once, then update per-file on change
 *   - TTL-based staleness: files older than N seconds are re-read
 *   - Query API: byName (exact/prefix), byFile, byKind, findReferences
 *
 * The index is process-local; persisted snapshots are out of scope
 * (the session checkpoint system covers cross-session state).
 */

import { existsSync, readFileSync, statSync } from 'fs'
import { join, relative, extname } from 'path'
import { extractSymbols, type CodeSymbol } from './codeStructure.js'

// ── Types ───────────────────────────────────────────────────────────────────

export interface IndexedFile {
  path: string          // absolute
  relativePath: string  // relative to index root
  mtimeMs: number
  symbols: CodeSymbol[]
}

export interface SymbolLookup {
  name: string
  kind: CodeSymbol['kind']
  file: string
  relativePath: string
  line: number
  column: number
  exported: boolean
  signature: string
}

export interface ReferenceHit {
  file: string
  relativePath: string
  line: number
  column: number
  snippet: string
}

// ── Index implementation ────────────────────────────────────────────────────

const DEFAULT_MAX_FILES = 2000
const DEFAULT_TTL_MS = 30_000
const SOURCE_EXTS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'])
const EXCLUDE_DIRS = new Set(['node_modules', '.git', 'dist', 'build', 'coverage', '.next', '.cache', 'vendor', '__pycache__'])

export class SymbolIndex {
  private files = new Map<string, IndexedFile>()
  private byName = new Map<string, SymbolLookup[]>()
  private readonly root: string
  private readonly maxFiles: number
  private readonly ttlMs: number
  private building: Promise<void> | null = null

  constructor(root: string, opts: { maxFiles?: number; ttlMs?: number } = {}) {
    this.root = root
    this.maxFiles = opts.maxFiles ?? DEFAULT_MAX_FILES
    this.ttlMs = opts.ttlMs ?? DEFAULT_TTL_MS
  }

  /** Index the whole codebase (idempotent; concurrent calls coalesce). */
  async build(): Promise<void> {
    if (this.building) return this.building
    this.building = this.doBuild().finally(() => { this.building = null })
    return this.building
  }

  private async doBuild(): Promise<void> {
    const files = this.walk()
    for (const f of files) {
      if (this.files.size >= this.maxFiles) break
      this.indexFile(f)
    }
  }

  private walk(): string[] {
    const out: string[] = []
    const stack: string[] = [this.root]
    while (stack.length > 0 && out.length < this.maxFiles) {
      const dir = stack.pop()!
      let entries
      try {
        entries = require('fs').readdirSync(dir, { withFileTypes: true }) as Array<{ name: string; isDirectory(): boolean; isFile(): boolean }>
      } catch {
        continue
      }
      for (const e of entries) {
        if (e.isDirectory()) {
          if (!EXCLUDE_DIRS.has(e.name)) stack.push(join(dir, e.name))
        } else if (e.isFile() && SOURCE_EXTS.has(extname(e.name))) {
          out.push(join(dir, e.name))
        }
      }
    }
    return out
  }

  /** (Re)index a single file. Returns true if it changed the index. */
  indexFile(absPath: string): boolean {
    let stat
    try { stat = statSync(absPath) } catch { return false }
    const existing = this.files.get(absPath)
    if (existing && existing.mtimeMs === stat.mtimeMs) return false

    let content: string
    try { content = readFileSync(absPath, 'utf8') } catch { return false }
    const symbols = extractSymbols(absPath, content)

    // Remove old entries for this file.
    if (existing) {
      for (const s of existing.symbols) {
        const list = this.byName.get(s.name)
        if (list) this.byName.set(s.name, list.filter(x => x.file !== absPath))
      }
    }

    this.files.set(absPath, {
      path: absPath,
      relativePath: relative(this.root, absPath),
      mtimeMs: stat.mtimeMs,
      symbols,
    })

    // Add new entries.
    for (const s of symbols) {
      const entry: SymbolLookup = {
        name: s.name,
        kind: s.kind,
        file: absPath,
        relativePath: relative(this.root, absPath),
        line: s.line,
        column: s.column,
        exported: s.exported,
        signature: s.signature,
      }
      const list = this.byName.get(s.name)
      if (list) list.push(entry)
      else this.byName.set(s.name, [entry])
    }
    return true
  }

  /** Refresh a file if its mtime changed (incremental). */
  refreshFile(absPath: string): void {
    if (!existsSync(absPath)) {
      this.files.delete(absPath)
      return
    }
    this.indexFile(absPath)
  }

  /** Re-check all indexed files for staleness (cheap stat-based). */
  refreshStale(): number {
    let refreshed = 0
    const now = Date.now()
    for (const [path, file] of this.files) {
      try {
        const stat = statSync(path)
        if (stat.mtimeMs !== file.mtimeMs && now - stat.mtimeMs < this.ttlMs) {
          if (this.indexFile(path)) refreshed++
        }
      } catch {
        this.files.delete(path)
      }
    }
    return refreshed
  }

  // ── Queries ───────────────────────────────────────────────────────────────

  /** Exact symbol lookup. */
  lookup(name: string): SymbolLookup[] {
    return this.byName.get(name) ?? []
  }

  /** Prefix search across symbol names. */
  search(prefix: string, limit = 20): SymbolLookup[] {
    const out: SymbolLookup[] = []
    const lower = prefix.toLowerCase()
    for (const [name, entries] of this.byName) {
      if (name.toLowerCase().startsWith(lower)) {
        for (const e of entries) {
          out.push(e)
          if (out.length >= limit) return out
        }
      }
    }
    return out
  }

  /** Symbols declared in a specific file. */
  symbolsInFile(absPath: string): SymbolLookup[] {
    const file = this.files.get(absPath)
    if (!file) return []
    return file.symbols.map(s => ({
      name: s.name,
      kind: s.kind,
      file: absPath,
      relativePath: file.relativePath,
      line: s.line,
      column: s.column,
      exported: s.exported,
      signature: s.signature,
    }))
  }

  /** All symbols of a given kind. */
  byKind(kind: CodeSymbol['kind']): SymbolLookup[] {
    const out: SymbolLookup[] = []
    for (const entries of this.byName.values()) {
      for (const e of entries) {
        if (e.kind === kind) out.push(e)
      }
    }
    return out
  }

  /**
   * Find references to a symbol across all indexed files (string-based
   * heuristic — fast, no false negatives for simple identifiers).
   */
  findReferences(name: string, limit = 50): ReferenceHit[] {
    const hits: ReferenceHit[] = []
    const wordRe = new RegExp(`\\b${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'g')
    for (const [path, file] of this.files) {
      let content: string
      try { content = readFileSync(path, 'utf8') } catch { continue }
      const lines = content.split('\n')
      for (let i = 0; i < lines.length; i++) {
        wordRe.lastIndex = 0
        const m = wordRe.exec(lines[i])
        if (m) {
          hits.push({
            file: path,
            relativePath: file.relativePath,
            line: i + 1,
            column: m.index + 1,
            snippet: lines[i].trim().slice(0, 100),
          })
          if (hits.length >= limit) return hits
        }
      }
    }
    return hits
  }

  /** Summary stats. */
  stats(): { files: number; symbols: number; root: string } {
    let symbols = 0
    for (const file of this.files.values()) symbols += file.symbols.length
    return { files: this.files.size, symbols, root: this.root }
  }

  /** Clear the entire index. */
  clear(): void {
    this.files.clear()
    this.byName.clear()
  }
}
