/**
 * SyntaxHighlight — lightweight syntax highlighting for diff previews.
 *
 * Inspired by Codex's diff preview (syntax-colored diffs) and OpenCode's
 * TUI diff viewer. Provides ANSI-colored output for terminal, and HTML
 * spans for web/export.
 *
 * Zero dependencies — pure regex-based tokenizer. Supports:
 *   - TypeScript / JavaScript / TSX / JSX
 *   - Python
 *   - Go
 *   - JSON / YAML / TOML
 *   - Shell / Bash
 *   - Diff output (unified diff format)
 *   - Markdown
 *
 * Export formats:
 *   - ANSI escape codes (terminal)
 *   - HTML spans (web/export)
 *   - Plain text (fallback)
 */

// ── Token Types ───────────────────────────────────────────────────────────────

export type TokenKind =
  | 'keyword'
  | 'string'
  | 'number'
  | 'comment'
  | 'type'
  | 'function'
  | 'operator'
  | 'punctuation'
  | 'property'
  | 'variable'
  | 'regex'
  | 'builtin'
  | 'diff-add'
  | 'diff-remove'
  | 'diff-header'
  | 'diff-hunk'
  | 'plain'

export interface Token {
  kind: TokenKind
  text: string
  start: number
  end: number
}

// ── ANSI Colors ───────────────────────────────────────────────────────────────

const ANSI: Record<TokenKind, string> = {
  keyword: '\x1b[35m',      // magenta
  string: '\x1b[32m',       // green
  number: '\x1b[33m',       // yellow
  comment: '\x1b[90m',      // bright black (gray)
  type: '\x1b[36m',         // cyan
  function: '\x1b[34m',     // blue
  operator: '\x1b[37m',     // white
  punctuation: '\x1b[37m',  // white
  property: '\x1b[94m',     // bright blue
  variable: '\x1b[33m',     // yellow
  regex: '\x1b[31m',        // red
  builtin: '\x1b[35m',      // magenta
  'diff-add': '\x1b[32m',   // green
  'diff-remove': '\x1b[31m',// red
  'diff-header': '\x1b[1;36m', // bold cyan
  'diff-hunk': '\x1b[36m',  // cyan
  plain: '\x1b[0m',         // reset
}
const ANSI_RESET = '\x1b[0m'

// ── HTML Colors ───────────────────────────────────────────────────────────────

const HTML_COLORS: Record<TokenKind, string> = {
  keyword: '#c678dd',
  string: '#98c379',
  number: '#d19a66',
  comment: '#5c6370',
  type: '#56b6c2',
  function: '#61afef',
  operator: '#abb2bf',
  punctuation: '#abb2bf',
  property: '#61afef',
  variable: '#e5c07b',
  regex: '#e06c75',
  builtin: '#c678dd',
  'diff-add': '#98c379',
  'diff-remove': '#e06c75',
  'diff-header': '#56b6c2',
  'diff-hunk': '#56b6c2',
  plain: '#abb2bf',
}

// ── Language Detection ────────────────────────────────────────────────────────

export type Language =
  | 'ts' | 'tsx' | 'js' | 'jsx' | 'python' | 'go'
  | 'json' | 'yaml' | 'toml' | 'shell' | 'diff' | 'markdown' | 'text'

export function detectLanguage(filePath: string): Language {
  const ext = filePath.slice(filePath.lastIndexOf('.') + 1).toLowerCase()
  const name = filePath.toLowerCase()
  switch (ext) {
    case 'ts': return name.endsWith('.tsx') ? 'tsx' : 'ts'
    case 'tsx': return 'tsx'
    case 'js': return name.endsWith('.jsx') ? 'jsx' : 'js'
    case 'jsx': return 'jsx'
    case 'py': case 'pyi': return 'python'
    case 'go': return 'go'
    case 'json': return 'json'
    case 'yaml': case 'yml': return 'yaml'
    case 'toml': return 'toml'
    case 'sh': case 'bash': case 'zsh': return 'shell'
    case 'diff': case 'patch': return 'diff'
    case 'md': case 'mdx': return 'markdown'
    default: return 'text'
  }
}

// ── Tokenizer Registry ────────────────────────────────────────────────────────

type TokenizerFn = (line: string, lineNum: number) => Token[]

function tokenizeTS(line: string): Token[] {
  const tokens: Token[] = []
  let i = 0

  while (i < line.length) {
    // Skip whitespace
    if (/\s/.test(line[i])) { i++; continue }

    // Single-line comment
    if (line.startsWith('//', i)) {
      tokens.push({ kind: 'comment', text: line.slice(i), start: i, end: line.length })
      break
    }

    // Block comment
    if (line.startsWith('/*', i)) {
      const end = line.indexOf('*/', i + 2)
      const text = end === -1 ? line.slice(i) : line.slice(i, end + 2)
      tokens.push({ kind: 'comment', text, start: i, end: i + text.length })
      i += text.length
      continue
    }

    // String (single/double/template)
    if (line[i] === "'" || line[i] === '"' || line[i] === '`') {
      const quote = line[i]
      let j = i + 1
      while (j < line.length) {
        if (line[j] === '\\') { j += 2; continue }
        if (line[j] === quote) { j++; break }
        j++
      }
      tokens.push({ kind: 'string', text: line.slice(i, j), start: i, end: j })
      i = j
      continue
    }

    // Regex (simplified: after =, (, [, !, etc.)
    if (line[i] === '/' && i > 0 && /[=([!&|;,:?]/.test(line[i - 1])) {
      let j = i + 1
      while (j < line.length) {
        if (line[j] === '\\') { j += 2; continue }
        if (line[j] === '/') { j++; break }
        j++
      }
      tokens.push({ kind: 'regex', text: line.slice(i, j), start: i, end: j })
      i = j
      continue
    }

    // Number
    const numMatch = line.slice(i).match(/^0[xX][0-9a-fA-F]+|^0[bB][01]+|^0[oO][0-7]+|^\d+\.?\d*(?:[eE][+-]?\d+)?/)
    if (numMatch) {
      tokens.push({ kind: 'number', text: numMatch[0], start: i, end: i + numMatch[0].length })
      i += numMatch[0].length
      continue
    }

    // Word (keyword/type/function/etc.)
    const wordMatch = line.slice(i).match(/^[a-zA-Z_$][a-zA-Z0-9_$]*/)
    if (wordMatch) {
      const word = wordMatch[0]
      const kind = classifyTSWord(word, line, i)
      tokens.push({ kind, text: word, start: i, end: i + word.length })
      i += word.length
      continue
    }

    // Operator / punctuation
    const opMatch = line.slice(i).match(/^[^\w\s]+/)
    if (opMatch) {
      tokens.push({ kind: 'operator', text: opMatch[0], start: i, end: i + opMatch[0].length })
      i += opMatch[0].length
      continue
    }

    i++
  }

  return tokens
}

const TS_KEYWORDS = new Set([
  'break', 'case', 'catch', 'class', 'const', 'continue', 'debugger',
  'default', 'delete', 'do', 'else', 'enum', 'export', 'extends', 'false',
  'finally', 'for', 'function', 'if', 'import', 'in', 'instanceof', 'let',
  'new', 'null', 'return', 'super', 'switch', 'this', 'throw', 'true',
  'try', 'typeof', 'var', 'void', 'while', 'with', 'yield', 'as', 'async',
  'await', 'from', 'of', 'static', 'private', 'protected', 'public',
  'readonly', 'abstract', 'implements', 'interface', 'type', 'namespace',
  'declare', 'module', 'require',
])

const TS_BUILTINS = new Set([
  'console', 'process', 'Buffer', 'Promise', 'Array', 'Object', 'String',
  'Number', 'Boolean', 'Map', 'Set', 'WeakMap', 'WeakSet', 'Symbol',
  'Error', 'TypeError', 'RangeError', 'JSON', 'Math', 'Date', 'RegExp',
  'parseInt', 'parseFloat', 'isNaN', 'isFinite', 'undefined', 'NaN',
  'Infinity', 'global', 'globalThis', 'window', 'document',
])

function classifyTSWord(word: string, _line: string, _pos: number): TokenKind {
  if (TS_KEYWORDS.has(word)) return 'keyword'
  if (TS_BUILTINS.has(word)) return 'builtin'
  // Heuristic: PascalCase → type, camelCase after 'function' or '(' → function
  if (/^[A-Z]/.test(word)) return 'type'
  // Check if previous char is '.' → property
  if (_pos > 0 && _line[_pos - 1] === '.') return 'property'
  return 'variable'
}

function tokenizePython(line: string): Token[] {
  const tokens: Token[] = []
  let i = 0

  const PY_KEYWORDS = new Set([
    'def', 'class', 'import', 'from', 'as', 'if', 'elif', 'else', 'for',
    'while', 'try', 'except', 'finally', 'with', 'return', 'yield', 'raise',
    'pass', 'break', 'continue', 'and', 'or', 'not', 'is', 'in', 'lambda',
    'True', 'False', 'None', 'async', 'await', 'global', 'nonlocal', 'assert',
    'del',
  ])

  while (i < line.length) {
    if (/\s/.test(line[i])) { i++; continue }

    if (line.startsWith('#', i)) {
      tokens.push({ kind: 'comment', text: line.slice(i), start: i, end: line.length })
      break
    }

    if (line[i] === "'" || line[i] === '"') {
      const quote = line[i]
      // Triple-quoted
      if (line.slice(i, i + 3) === quote.repeat(3)) {
        const end = line.indexOf(quote.repeat(3), i + 3)
        const text = end === -1 ? line.slice(i) : line.slice(i, end + 3)
        tokens.push({ kind: 'string', text, start: i, end: i + text.length })
        i += text.length
        continue
      }
      let j = i + 1
      while (j < line.length) {
        if (line[j] === '\\') { j += 2; continue }
        if (line[j] === quote) { j++; break }
        j++
      }
      tokens.push({ kind: 'string', text: line.slice(i, j), start: i, end: j })
      i = j
      continue
    }

    const numMatch = line.slice(i).match(/^\d+\.?\d*(?:[eE][+-]?\d+)?/)
    if (numMatch) {
      tokens.push({ kind: 'number', text: numMatch[0], start: i, end: i + numMatch[0].length })
      i += numMatch[0].length
      continue
    }

    const wordMatch = line.slice(i).match(/^[a-zA-Z_][a-zA-Z0-9_]*/)
    if (wordMatch) {
      const word = wordMatch[0]
      const kind = PY_KEYWORDS.has(word) ? 'keyword'
        : /^[A-Z]/.test(word) ? 'type'
        : word === 'self' ? 'variable'
        : 'plain'
      tokens.push({ kind, text: word, start: i, end: i + word.length })
      i += word.length
      continue
    }

    const opMatch = line.slice(i).match(/^[^\w\s]+/)
    if (opMatch) {
      tokens.push({ kind: 'operator', text: opMatch[0], start: i, end: i + opMatch[0].length })
      i += opMatch[0].length
      continue
    }

    i++
  }

  return tokens
}

function tokenizeDiff(line: string): Token[] {
  const tokens: Token[] = []
  if (line.startsWith('+')) {
    tokens.push({ kind: 'diff-add', text: line, start: 0, end: line.length })
  } else if (line.startsWith('-')) {
    tokens.push({ kind: 'diff-remove', text: line, start: 0, end: line.length })
  } else if (line.startsWith('@@')) {
    tokens.push({ kind: 'diff-hunk', text: line, start: 0, end: line.length })
  } else if (/^(diff|index|---|\+\+\+|===)/.test(line)) {
    tokens.push({ kind: 'diff-header', text: line, start: 0, end: line.length })
  } else {
    tokens.push({ kind: 'plain', text: line, start: 0, end: line.length })
  }
  return tokens
}

function tokenizeJSON(line: string): Token[] {
  const tokens: Token[] = []
  let i = 0
  while (i < line.length) {
    if (/\s/.test(line[i])) { i++; continue }
    if (line[i] === '"') {
      let j = i + 1
      while (j < line.length) {
        if (line[j] === '\\') { j += 2; continue }
        if (line[j] === '"') { j++; break }
        j++
      }
      // Check if it's a key (followed by ':')
      const after = line.slice(j).trimStart()
      const isKey = after.startsWith(':')
      tokens.push({ kind: isKey ? 'property' : 'string', text: line.slice(i, j), start: i, end: j })
      i = j
      continue
    }
    const numMatch = line.slice(i).match(/^-?\d+\.?\d*(?:[eE][+-]?\d+)?/)
    if (numMatch) {
      tokens.push({ kind: 'number', text: numMatch[0], start: i, end: i + numMatch[0].length })
      i += numMatch[0].length
      continue
    }
    const wordMatch = line.slice(i).match(/^(true|false|null)\b/)
    if (wordMatch) {
      tokens.push({ kind: 'keyword', text: wordMatch[0], start: i, end: i + wordMatch[0].length })
      i += wordMatch[0].length
      continue
    }
    tokens.push({ kind: 'punctuation', text: line[i], start: i, end: i + 1 })
    i++
  }
  return tokens
}

function tokenizeShell(line: string): Token[] {
  const tokens: Token[] = []
  let i = 0
  while (i < line.length) {
    if (/\s/.test(line[i])) { i++; continue }
    if (line.startsWith('#', i)) {
      tokens.push({ kind: 'comment', text: line.slice(i), start: i, end: line.length })
      break
    }
    if (line[i] === "'" || line[i] === '"') {
      const quote = line[i]
      let j = i + 1
      while (j < line.length) {
        if (line[j] === '\\' && quote === '"') { j += 2; continue }
        if (line[j] === quote) { j++; break }
        j++
      }
      tokens.push({ kind: 'string', text: line.slice(i, j), start: i, end: j })
      i = j
      continue
    }
    const wordMatch = line.slice(i).match(/^[a-zA-Z_][a-zA-Z0-9_-]*/)
    if (wordMatch) {
      const word = wordMatch[0]
      const kind = /^(if|then|else|elif|fi|for|while|do|done|case|esac|function|return|exit|export|local|source|echo|cd|ls|rm|cp|mv|mkdir|grep|sed|awk|git|npm|pnpm|node|docker|curl|wget)$/.test(word)
        ? 'builtin' : 'plain'
      tokens.push({ kind, text: word, start: i, end: i + word.length })
      i += word.length
      continue
    }
    tokens.push({ kind: 'operator', text: line[i], start: i, end: i + 1 })
    i++
  }
  return tokens
}

const TOKENIZERS: Record<Language, TokenizerFn> = {
  ts: tokenizeTS,
  tsx: tokenizeTS,
  js: tokenizeTS,
  jsx: tokenizeTS,
  python: tokenizePython,
  go: tokenizeTS, // Go syntax is close enough to TS for highlighting
  json: tokenizeJSON,
  yaml: tokenizePython, // YAML highlighting is similar to Python
  toml: tokenizePython,
  shell: tokenizeShell,
  diff: tokenizeDiff,
  markdown: tokenizeTS, // Markdown code blocks use TS for now
  text: (line) => [{ kind: 'plain', text: line, start: 0, end: line.length }],
}

// ── Public API ────────────────────────────────────────────────────────────────

export interface HighlightOptions {
  language?: Language
  /** ANSI (terminal), HTML (web), or plain (no color) */
  format?: 'ansi' | 'html' | 'plain'
  /** Prefix each line with this string (e.g. line number) */
  linePrefix?: boolean
  /** Starting line number for linePrefix */
  startLine?: number
}

export function highlight(
  source: string,
  opts: HighlightOptions = {},
): string {
  const lang = opts.language ?? 'text'
  const format = opts.format ?? 'ansi'
  const tokenize = TOKENIZERS[lang] ?? TOKENIZERS.text
  const lines = source.split('\n')
  const result: string[] = []

  for (let i = 0; i < lines.length; i++) {
    let line = ''
    let prefix = ''

    if (opts.linePrefix) {
      const num = (opts.startLine ?? 1) + i
      prefix = `\x1b[90m${String(num).padStart(4, ' ')} \x1b[0m`
    }

    const tokens = tokenize(lines[i], i)
    if (tokens.length === 0) {
      line = lines[i]
    } else {
      for (const tok of tokens) {
        if (format === 'ansi') {
          line += ANSI[tok.kind] + tok.text + ANSI_RESET
        } else if (format === 'html') {
          line += `<span style="color:${HTML_COLORS[tok.kind]}">${escapeHtml(tok.text)}</span>`
        } else {
          line += tok.text
        }
      }
    }

    result.push(prefix + line)
  }

  return result.join('\n')
}

/**
 * Highlight a diff with syntax coloring for the changed lines.
 * Added/deleted lines are also syntax-highlighted according to the
 * file's language.
 */
export function highlightDiff(
  diffText: string,
  filePath?: string,
  opts: HighlightOptions = {},
): string {
  const lang = filePath ? detectLanguage(filePath) : 'diff'
  const format = opts.format ?? 'ansi'
  const lines = diffText.split('\n')
  const result: string[] = []
  const tokenize = TOKENIZERS[lang] ?? TOKENIZERS.text

  for (const line of lines) {
    if (line.startsWith('+')) {
      // Added line: green background + syntax highlight
      const content = line.slice(1)
      const tokens = tokenize(content, 0)
      if (format === 'ansi') {
        let colored = ''
        for (const tok of tokens) {
          colored += ANSI[tok.kind] + tok.text + ANSI_RESET
        }
        result.push(`\x1b[42m\x1b[30m+ ${colored}\x1b[0m`)
      } else if (format === 'html') {
        let colored = ''
        for (const tok of tokens) {
          colored += `<span style="color:${HTML_COLORS[tok.kind]}">${escapeHtml(tok.text)}</span>`
        }
        result.push(`<span style="background:#1a3a1a">+ ${colored}</span>`)
      } else {
        result.push(`+ ${content}`)
      }
    } else if (line.startsWith('-')) {
      const content = line.slice(1)
      const tokens = tokenize(content, 0)
      if (format === 'ansi') {
        let colored = ''
        for (const tok of tokens) {
          colored += ANSI[tok.kind] + tok.text + ANSI_RESET
        }
        result.push(`\x1b[41m\x1b[30m- ${colored}\x1b[0m`)
      } else if (format === 'html') {
        let colored = ''
        for (const tok of tokens) {
          colored += `<span style="color:${HTML_COLORS[tok.kind]}">${escapeHtml(tok.text)}</span>`
        }
        result.push(`<span style="background:#3a1a1a">- ${colored}</span>`)
      } else {
        result.push(`- ${content}`)
      }
    } else if (line.startsWith('@@')) {
      result.push(format === 'ansi'
        ? `\x1b[1;36m${line}\x1b[0m`
        : format === 'html'
        ? `<span style="color:#56b6c2;font-weight:bold">${escapeHtml(line)}</span>`
        : line)
    } else {
      result.push(line)
    }
  }

  return result.join('\n')
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

/**
 * Quick helper: syntax-highlight a code snippet in the terminal.
 */
export function highlightCode(
  source: string,
  filePath: string,
): string {
  return highlight(source, { language: detectLanguage(filePath), format: 'ansi' })
}