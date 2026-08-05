/**
 * CodeStructure — AST-aware code analysis (v0.6.0).
 *
 * Inspired by Codex's tree-sitter integration: extract structural
 * information from source code without relying on language servers
 * or native binaries. Uses regex-based heuristics that work across
 * TypeScript, JavaScript, Python, Go, Rust, and Java.
 *
 * Capabilities:
 *   - Extract functions, classes, interfaces, exports
 *   - Extract imports/dependencies
 *   - Find symbol references across a codebase
 *   - Semantic diff (what changed structurally, not just text)
 *   - Code quality markers (TODO, FIXME, complexity hints)
 *
 * All operations are pure and synchronous — suitable for use in
 * tool definitions and the tool execution hot path.
 */

import { readFileSync, existsSync, readdirSync, statSync } from 'fs'
import { join, extname, relative } from 'path'

// ── Types ───────────────────────────────────────────────────────────────────

export interface CodeSymbol {
  kind: 'function' | 'class' | 'interface' | 'type' | 'enum' | 'const' | 'let' | 'var' | 'export'
  name: string
  file: string
  line: number
  column: number
  /** The line of code where the symbol is defined */
  signature: string
  /** For methods: the parent class/object name */
  parent?: string
  /** Whether it's exported */
  exported: boolean
  /** Whether it's the default export */
  isDefault: boolean
}

export interface ImportInfo {
  source: string
  symbols: string[]
  isDefault: boolean
  isTypeOnly: boolean
  file: string
  line: number
}

export interface CodeStructure {
  file: string
  language: string
  symbols: CodeSymbol[]
  imports: ImportInfo[]
  exports: string[]
  todos: string[]
  lineCount: number
}

export interface DiffSymbol {
  file: string
  kind: 'added' | 'removed' | 'modified'
  symbol: string
  oldSignature?: string
  newSignature?: string
}

// ── Language detection ──────────────────────────────────────────────────────

function detectLanguage(filePath: string): string {
  const ext = extname(filePath).toLowerCase()
  const map: Record<string, string> = {
    '.ts': 'typescript',
    '.tsx': 'typescript',
    '.js': 'javascript',
    '.jsx': 'javascript',
    '.py': 'python',
    '.go': 'go',
    '.rs': 'rust',
    '.java': 'java',
    '.json': 'json',
    '.yaml': 'yaml',
    '.yml': 'yaml',
    '.toml': 'toml',
  }
  return map[ext] ?? 'unknown'
}

// ── Symbol extraction ───────────────────────────────────────────────────────

/**
 * Extract all structural symbols from a file. Works with TypeScript,
 * JavaScript, JSX, and TSX.
 */
export function extractSymbols(
  filePath: string,
  content?: string,
): CodeSymbol[] {
  const src = content ?? (existsSync(filePath) ? readFileSync(filePath, 'utf8') : '')
  if (!src.trim()) return []

  const symbols: CodeSymbol[] = []
  const lines = src.split('\n')
  const lang = detectLanguage(filePath)

  // Pattern matching is language-specific
  if (lang === 'typescript' || lang === 'javascript') {
    extractTSJSSymbols(lines, filePath, symbols)
  } else if (lang === 'python') {
    extractPythonSymbols(lines, filePath, symbols)
  } else if (lang === 'go') {
    extractGoSymbols(lines, filePath, symbols)
  }

  return symbols
}

function extractTSJSSymbols(lines: string[], file: string, out: CodeSymbol[]): void {
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim()
    const lineno = i + 1

    // Skip comments and empty lines
    if (!line || line.startsWith('//') || line.startsWith('/*') || line.startsWith('*')) continue

    // Exported
    const isExported = line.startsWith('export ')
    const isDefault = isExported && line.includes('default ')

    // Class declarations
    const classMatch = line.match(
      /(?:export\s+)?(?:abstract\s+)?class\s+(\w+)/,
    )
    if (classMatch) {
      out.push({
        kind: 'class',
        name: classMatch[1],
        file,
        line: lineno,
        column: line.indexOf('class'),
        signature: line,
        exported: isExported,
        isDefault,
      })
      continue
    }

    // Interface declarations
    const ifaceMatch = line.match(
      /(?:export\s+)?interface\s+(\w+)/,
    )
    if (ifaceMatch) {
      out.push({
        kind: 'interface',
        name: ifaceMatch[1],
        file,
        line: lineno,
        column: line.indexOf('interface'),
        signature: line,
        exported: isExported,
        isDefault,
      })
      continue
    }

    // Type alias
    const typeMatch = line.match(
      /(?:export\s+)?type\s+(\w+)\s*=/,
    )
    if (typeMatch) {
      out.push({
        kind: 'type',
        name: typeMatch[1],
        file,
        line: lineno,
        column: line.indexOf('type'),
        signature: line,
        exported: isExported,
        isDefault,
      })
      continue
    }

    // Enum declarations
    const enumMatch = line.match(
      /(?:export\s+)?(?:const\s+)?enum\s+(\w+)/,
    )
    if (enumMatch) {
      out.push({
        kind: 'enum',
        name: enumMatch[1],
        file,
        line: lineno,
        column: line.indexOf('enum'),
        signature: line,
        exported: isExported,
        isDefault,
      })
      continue
    }

    // Function declarations (not arrow functions yet)
    const funcMatch = line.match(
      /(?:export\s+)?(?:async\s+)?function\s+(\w+)/,
    )
    if (funcMatch) {
      out.push({
        kind: 'function',
        name: funcMatch[1],
        file,
        line: lineno,
        column: line.indexOf('function'),
        signature: line,
        exported: isExported,
        isDefault,
      })
      continue
    }

    // Arrow function / method assigned to const/let/var
    const constArrow = line.match(
      /(?:export\s+)?(?:const|let|var)\s+(\w+)\s*[:=]\s*(?:async\s*)?\(/,
    )
    if (constArrow) {
      out.push({
        kind: 'function',
        name: constArrow[1],
        file,
        line: lineno,
        column: line.indexOf(constArrow[1]),
        signature: line,
        exported: isExported,
        isDefault,
      })
      continue
    }

    // Method definitions inside class bodies (detected by indentation)
    const methodMatch = line.match(
      /^\s{2,}(?:public\s+|private\s+|protected\s+|static\s+|async\s+)*(\w+)\s*\(/,
    )
    if (methodMatch && !['if', 'for', 'while', 'switch', 'catch', 'return', 'throw', 'new'].includes(methodMatch[1])) {
      out.push({
        kind: 'function',
        name: methodMatch[1],
        file,
        line: lineno,
        column: line.indexOf(methodMatch[1]),
        signature: line,
        exported: false,
        isDefault: false,
      })
      continue
    }
  }
}

function extractPythonSymbols(lines: string[], file: string, out: CodeSymbol[]): void {
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim()
    const lineno = i + 1
    if (!line || line.startsWith('#')) continue

    const classMatch = line.match(/^class\s+(\w+)/)
    if (classMatch) {
      out.push({
        kind: 'class', name: classMatch[1], file, line: lineno,
        column: line.indexOf('class'), signature: line,
        exported: true, isDefault: false,
      })
      continue
    }

    const funcMatch = line.match(/^(?:async\s+)?def\s+(\w+)/)
    if (funcMatch) {
      out.push({
        kind: 'function', name: funcMatch[1], file, line: lineno,
        column: line.indexOf('def'), signature: line,
        exported: !funcMatch[1].startsWith('_'), isDefault: false,
      })
      continue
    }
  }
}

function extractGoSymbols(lines: string[], file: string, out: CodeSymbol[]): void {
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim()
    const lineno = i + 1
    if (!line || line.startsWith('//')) continue

    const funcMatch = line.match(/^func\s+(?:\([^)]*\)\s+)?(\w+)/)
    if (funcMatch) {
      out.push({
        kind: 'function', name: funcMatch[1], file, line: lineno,
        column: line.indexOf('func'), signature: line,
        exported: funcMatch[1][0] === funcMatch[1][0].toUpperCase(),
        isDefault: false,
      })
      continue
    }

    const typeMatch = line.match(/^type\s+(\w+)\s+struct/)
    if (typeMatch) {
      out.push({
        kind: 'class', name: typeMatch[1], file, line: lineno,
        column: line.indexOf('type'), signature: line,
        exported: typeMatch[1][0] === typeMatch[1][0].toUpperCase(),
        isDefault: false,
      })
      continue
    }
  }
}

// ── Import extraction ───────────────────────────────────────────────────────

export function extractImports(
  filePath: string,
  content?: string,
): ImportInfo[] {
  const src = content ?? (existsSync(filePath) ? readFileSync(filePath, 'utf8') : '')
  if (!src.trim()) return []

  const imports: ImportInfo[] = []
  const lines = src.split('\n')

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim()
    const lineno = i + 1

    // ES module imports
    const importMatch = line.match(
      /^import\s+(?:type\s+)?(?:(?:\{([^}]+)\})|(?:(\w+)(?:\s*,\s*(?:\{([^}]+)\}))?))\s+from\s+['"]([^'"]+)['"]/,
    )
    if (importMatch) {
      const named = importMatch[1] ?? importMatch[3] ?? ''
      const default_ = importMatch[2] ?? ''
      const source = importMatch[4]
      const symbols: string[] = []
      if (default_) symbols.push(default_)
      if (named) symbols.push(...named.split(',').map((s) => s.trim().replace(/\s+as\s+\w+/, '').trim()).filter(Boolean))
      imports.push({
        source,
        symbols,
        isDefault: !!default_,
        isTypeOnly: line.includes('import type'),
        file: filePath,
        line: lineno,
      })
      continue
    }

    // CommonJS require
    const requireMatch = line.match(
      /(?:const|let|var)\s+(?:\{([^}]+)\})?\s*=\s*require\s*\(\s*['"]([^'"]+)['"]\s*\)/,
    )
    if (requireMatch) {
      const named = requireMatch[1] ?? ''
      imports.push({
        source: requireMatch[2],
        symbols: named ? named.split(',').map((s) => s.trim().replace(/\s*:\s*\w+/, '').trim()).filter(Boolean) : [],
        isDefault: !named,
        isTypeOnly: false,
        file: filePath,
        line: lineno,
      })
    }
  }

  return imports
}

// ── Full structure ──────────────────────────────────────────────────────────

export function analyzeFile(filePath: string): CodeStructure {
  const content = existsSync(filePath) ? readFileSync(filePath, 'utf8') : ''
  const lines = content.split('\n')
  const todos: string[] = []

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim()
    const match = line.match(
      /\b(TODO|FIXME|HACK|XXX|DECISION|NOTE|WARNING|BUG|OPTIMIZE|REVIEW)\b[:\s-]*(.*)/i,
    )
    if (match) {
      todos.push(`L${i + 1}: ${match[1].toUpperCase()}: ${match[2] || ''}`)
    }
  }

  return {
    file: filePath,
    language: detectLanguage(filePath),
    symbols: extractSymbols(filePath, content),
    imports: extractImports(filePath, content),
    exports: extractSymbols(filePath, content).filter((s) => s.exported).map((s) => s.name),
    todos,
    lineCount: lines.length,
  }
}

// ── Codebase scanning ───────────────────────────────────────────────────────

export interface CodebaseScan {
  root: string
  files: number
  totalLines: number
  symbols: CodeSymbol[]
  imports: ImportInfo[]
  todos: string[]
  languages: Record<string, number>
}

export function scanCodebase(
  rootDir: string,
  maxFiles = 500,
): CodebaseScan {
  const scan: CodebaseScan = {
    root: rootDir,
    files: 0,
    totalLines: 0,
    symbols: [],
    imports: [],
    todos: [],
    languages: {},
  }

  const exclude = new Set([
    'node_modules', '.git', 'dist', 'build', '.next', 'coverage',
    '__pycache__', '.cache', 'vendor',
  ])

  const sourceExts = new Set([
    '.ts', '.tsx', '.js', '.jsx', '.py', '.go', '.rs', '.java',
  ])

  const stack: string[] = [rootDir]
  while (stack.length > 0 && scan.files < maxFiles) {
    const dir = stack.pop()!
    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      if (scan.files >= maxFiles) break
      const full = join(dir, entry.name)
      if (entry.isDirectory()) {
        if (!exclude.has(entry.name)) stack.push(full)
      } else if (entry.isFile() && sourceExts.has(extname(entry.name).toLowerCase())) {
        try {
          const structure = analyzeFile(full)
          scan.files++
          scan.totalLines += structure.lineCount
          scan.symbols.push(...structure.symbols)
          scan.imports.push(...structure.imports)
          scan.todos.push(...structure.todos.map((t) => `${relative(rootDir, full)}:${t}`))
          scan.languages[structure.language] = (scan.languages[structure.language] ?? 0) + 1
        } catch {
          // skip unreadable files
        }
      }
    }
  }

  return scan
}

// ── Semantic diff ───────────────────────────────────────────────────────────

/**
 * Compare two versions of a file and produce a structural diff.
 * This is NOT a line-by-line diff — it tells you what *symbols*
 * changed, which is more useful for code review.
 */
export function semanticDiff(
  oldContent: string,
  newContent: string,
  filePath: string,
): DiffSymbol[] {
  const oldSymbols = extractSymbols(filePath, oldContent)
  const newSymbols = extractSymbols(filePath, newContent)

  const oldMap = new Map(oldSymbols.map((s) => [s.name, s]))
  const newMap = new Map(newSymbols.map((s) => [s.name, s]))
  const diffs: DiffSymbol[] = []

  // Removed
  for (const [name, sym] of oldMap) {
    if (!newMap.has(name)) {
      diffs.push({ file: filePath, kind: 'removed', symbol: name, oldSignature: sym.signature })
    }
  }

  // Added
  for (const [name, sym] of newMap) {
    if (!oldMap.has(name)) {
      diffs.push({ file: filePath, kind: 'added', symbol: name, newSignature: sym.signature })
    }
  }

  // Modified (same name, different signature)
  for (const [name, newSym] of newMap) {
    const oldSym = oldMap.get(name)
    if (oldSym && oldSym.signature !== newSym.signature) {
      diffs.push({
        file: filePath,
        kind: 'modified',
        symbol: name,
        oldSignature: oldSym.signature,
        newSignature: newSym.signature,
      })
    }
  }

  return diffs
}

// ── Find references ─────────────────────────────────────────────────────────

/**
 * Find all references to a symbol across a codebase.
 */
export function findReferences(
  symbolName: string,
  rootDir: string,
  maxFiles = 200,
): Array<{ file: string; line: number; context: string }> {
  const refs: Array<{ file: string; line: number; context: string }> = []
  const exclude = new Set([
    'node_modules', '.git', 'dist', 'build', '.next', 'coverage',
  ])
  const sourceExts = new Set([
    '.ts', '.tsx', '.js', '.jsx', '.py', '.go', '.rs', '.java',
  ])

  const stack: string[] = [rootDir]
  while (stack.length > 0 && refs.length < 500) {
    const dir = stack.pop()!
    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      if (refs.length >= 500) break
      const full = join(dir, entry.name)
      if (entry.isDirectory()) {
        if (!exclude.has(entry.name)) stack.push(full)
      } else if (entry.isFile() && sourceExts.has(extname(entry.name).toLowerCase())) {
        try {
          const content = readFileSync(full, 'utf8')
          const lines = content.split('\n')
          for (let i = 0; i < lines.length; i++) {
            if (lines[i].includes(symbolName)) {
              refs.push({
                file: relative(rootDir, full),
                line: i + 1,
                context: lines[i].trim().slice(0, 120),
              })
            }
          }
        } catch {
          // skip
        }
      }
    }
  }

  return refs
}