/**
 * Markdown Terminal Renderer
 *
 * Lightweight markdown to ANSI terminal text renderer.
 * Supports headings, bold, italic, code, lists, tables, links.
 */

import { ANSI, bold as boldText, dim, underline, stripAnsi, ansiLength, padRight } from '../utils/ansi.js'
import { getActiveTheme } from './theme.js'

// ── Types ───────────────────────────────────────────────────────────────────

export interface RenderOptions {
  maxWidth?: number
  codeBlockTheme?: 'dark' | 'light'
  showLineNumbers?: boolean
}

export interface MarkdownBlock {
  type: 'heading' | 'paragraph' | 'code' | 'list' | 'quote' | 'table' | 'hr' | 'list_item'
  content: string
  level?: number
  lang?: string
  ordered?: boolean
  items?: string[]
  header?: string[]
  rows?: string[][]
}

// ── Parser ──────────────────────────────────────────────────────────────────

export function parseMarkdown(text: string): MarkdownBlock[] {
  const lines = text.split('\n')
  const blocks: MarkdownBlock[] = []
  let i = 0

  while (i < lines.length) {
    const line = lines[i]

    // Skip empty lines
    if (line.trim() === '') {
      i++
      continue
    }

    // Horizontal rule
    if (line.match(/^(-{3,}|\*{3,}|_{3,})$/)) {
      blocks.push({ type: 'hr', content: '' })
      i++
      continue
    }

    // Heading
    const headingMatch = line.match(/^(#{1,6})\s+(.*)$/)
    if (headingMatch) {
      blocks.push({
        type: 'heading',
        content: headingMatch[2],
        level: headingMatch[1].length,
      })
      i++
      continue
    }

    // Code block
    if (line.match(/^```/)) {
      const lang = line.replace(/^```/, '').trim()
      const codeLines: string[] = []
      i++
      while (i < lines.length && !lines[i].match(/^```/)) {
        codeLines.push(lines[i])
        i++
      }
      i++ // skip closing ```
      blocks.push({
        type: 'code',
        content: codeLines.join('\n'),
        lang,
      })
      continue
    }

    // Blockquote
    if (line.match(/^>\s/)) {
      const quoteLines: string[] = []
      while (i < lines.length && lines[i].match(/^>\s/)) {
        quoteLines.push(lines[i].replace(/^>\s/, ''))
        i++
      }
      blocks.push({ type: 'quote', content: quoteLines.join('\n') })
      continue
    }

    // Unordered list
    if (line.match(/^[-*+]\s/)) {
      const items: string[] = []
      while (i < lines.length && lines[i].match(/^[-*+]\s/)) {
        items.push(lines[i].replace(/^[-*+]\s/, ''))
        i++
      }
      blocks.push({ type: 'list', items, ordered: false, content: '' })
      continue
    }

    // Ordered list
    if (line.match(/^\d+\.\s/)) {
      const items: string[] = []
      while (i < lines.length && lines[i].match(/^\d+\.\s/)) {
        items.push(lines[i].replace(/^\d+\.\s/, ''))
        i++
      }
      blocks.push({ type: 'list', items, ordered: true, content: '' })
      continue
    }

    // Table
    if (line.includes('|') && i + 1 < lines.length && lines[i + 1].match(/^[\s|-]+$/)) {
      const header = line.split('|').map(s => s.trim()).filter(Boolean)
      i += 2 // skip header and separator
      const rows: string[][] = []
      while (i < lines.length && lines[i].includes('|')) {
        rows.push(lines[i].split('|').map(s => s.trim()).filter(Boolean))
        i++
      }
      blocks.push({ type: 'table', content: '', header, rows })
      continue
    }

    // Paragraph (collect consecutive non-empty lines)
    const paraLines: string[] = []
    while (i < lines.length && lines[i].trim() !== '' && !lines[i].match(/^(#{1,6}\s|```|>\s|[-*+]\s|\d+\.\s)/)) {
      paraLines.push(lines[i])
      i++
    }
    blocks.push({ type: 'paragraph', content: paraLines.join(' ') })
  }

  return blocks
}

// ── Inline Formatting ───────────────────────────────────────────────────────

export function renderInline(text: string): string {
  let result = text

  // Code spans
  result = result.replace(/`([^`]+)`/g, (_, code) => {
    return ANSI.CYAN + code + ANSI.RESET
  })

  // Bold
  result = result.replace(/\*\*([^*]+)\*\*/g, (_, content) => boldText(content))
  result = result.replace(/__([^_]+)__/g, (_, content) => boldText(content))

  // Italic
  result = result.replace(/(?<!\*)\*([^*]+)\*(?!\*)/g, (_, content) => ANSI.ITALIC + content + ANSI.RESET)
  result = result.replace(/(?<!_)_([^_]+)_(?!_)/g, (_, content) => ANSI.ITALIC + content + ANSI.RESET)

  // Strikethrough
  result = result.replace(/~~([^~]+)~~/g, (_, content) => ANSI.STRIKETHROUGH + content + ANSI.RESET)

  // Links [text](url)
  result = result.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_, text, url) => {
    return underline(ANSI.BLUE + text + ANSI.RESET)
  })

  return result
}

// ── Block Rendering ─────────────────────────────────────────────────────────

export function renderBlock(block: MarkdownBlock, options: RenderOptions = {}): string {
  switch (block.type) {
    case 'heading':
      return renderHeading(block.content, block.level ?? 1)

    case 'paragraph':
      return renderInline(block.content)

    case 'code':
      return renderCodeBlock(block.content, block.lang, options)

    case 'list':
      return renderList(block.items ?? [], block.ordered ?? false)

    case 'quote':
      return renderQuote(block.content)

    case 'table':
      return renderTable(block.header ?? [], block.rows ?? [])

    case 'hr':
      return dim('─'.repeat(40))

    default:
      return block.content
  }
}

function renderHeading(text: string, level: number): string {
  const sizes: Record<number, (t: string) => string> = {
    1: (t) => boldText(ANSI.BRIGHT_WHITE + t + ANSI.RESET),
    2: (t) => boldText(ANSI.WHITE + t + ANSI.RESET),
    3: (t) => boldText(t),
    4: (t) => ANSI.UNDERLINE + t + ANSI.RESET,
    5: (t) => ANSI.BOLD + ANSI.DIM + t + ANSI.RESET,
    6: (t) => ANSI.DIM + t + ANSI.RESET,
  }
  const renderer = sizes[level] ?? sizes[6]

  const prefix = '#'.repeat(level) + ' '
  return dim(prefix) + renderer(text)
}

function renderCodeBlock(code: string, lang: string | undefined, _options: RenderOptions): string {
  const lines = code.split('\n')
  const rendered = lines.map(line => {
    return applySyntaxHighlighting(line, lang)
  })

  return rendered.join('\n')
}

function renderList(items: string[], ordered: boolean): string {
  return items.map((item, i) => {
    const marker = ordered ? `${i + 1}.` : '•'
    return `${ANSI.DIM}${marker}${ANSI.RESET} ${renderInline(item)}`
  }).join('\n')
}

function renderQuote(text: string): string {
  const lines = text.split('\n')
  return lines.map(line => `${ANSI.DIM}│${ANSI.RESET} ${ANSI.DIM}${renderInline(line)}${ANSI.RESET}`).join('\n')
}

function renderTable(header: string[], rows: string[][]): string {
  if (header.length === 0) return ''

  const allRows = [header, ...rows]
  const colCount = Math.max(...allRows.map(r => r.length))
  const colWidths: number[] = []

  for (let c = 0; c < colCount; c++) {
    const maxCellWidth = Math.max(...allRows.map(r => ansiLength(r[c] ?? '')))
    colWidths.push(Math.min(maxCellWidth, 40))
  }

  const formatRow = (cells: string[], isHeader = false) => {
    const formatted = cells.map((cell, i) => {
      const rendered = isHeader ? boldText(cell) : renderInline(cell)
      return padRight(rendered, colWidths[i])
    })
    return formatted.join(' │ ')
  }

  const lines: string[] = []
  lines.push(formatRow(header, true))
  lines.push(colWidths.map(w => '─'.repeat(w)).join('─┼─'))
  for (const row of rows) {
    lines.push(formatRow(row))
  }

  return lines.join('\n')
}

// ── Syntax Highlighting (basic) ─────────────────────────────────────────────

function applySyntaxHighlighting(line: string, lang: string | undefined): string {
  if (!lang) return ANSI.DIM + line + ANSI.RESET

  const theme = getActiveTheme()

  // Comments
  if (['ts', 'js', 'tsx', 'jsx', 'java', 'go', 'rust', 'c', 'cpp'].includes(lang)) {
    if (line.trim().startsWith('//')) {
      return `\x1b[38;2;${hexToRgb(theme.colors.comment)}m${line}\x1b[0m`
    }
  }
  if (['py', 'rb', 'sh'].includes(lang)) {
    if (line.trim().startsWith('#')) {
      return `\x1b[38;2;${hexToRgb(theme.colors.comment)}m${line}\x1b[0m`
    }
  }

  // Strings
  let result = line
  result = result.replace(/(["'`])((?:\\.|(?!\1).)*)\1/g, (match) => {
    return `\x1b[38;2;${hexToRgb(theme.colors.string)}m${match}\x1b[0m`
  })

  // Keywords
  const keywords = getKeywords(lang)
  if (keywords.length > 0) {
    const pattern = new RegExp(`\\b(${keywords.join('|')})\\b`, 'g')
    result = result.replace(pattern, (match) => {
      return `\x1b[38;2;${hexToRgb(theme.colors.keyword)}m${match}\x1b[0m`
    })
  }

  // Numbers
  result = result.replace(/\b(\d+\.?\d*)\b/g, (match) => {
    return `\x1b[38;2;${hexToRgb(theme.colors.number)}m${match}\x1b[0m`
  })

  return result
}

function getKeywords(lang: string): string[] {
  const common = ['const', 'let', 'var', 'function', 'return', 'if', 'else', 'for', 'while', 'class', 'import', 'export', 'default', 'async', 'await', 'new', 'try', 'catch', 'throw', 'typeof', 'instanceof']
  const python = ['def', 'class', 'if', 'elif', 'else', 'for', 'while', 'import', 'from', 'return', 'try', 'except', 'raise', 'with', 'as', 'lambda', 'yield', 'pass', 'break', 'continue', 'True', 'False', 'None']
  const go = ['func', 'var', 'const', 'type', 'struct', 'interface', 'package', 'import', 'return', 'if', 'else', 'for', 'switch', 'case', 'default', 'go', 'defer', 'chan', 'map', 'range']

  if (['py'].includes(lang)) return python
  if (['go'].includes(lang)) return go
  return common
}

function hexToRgb(hex: string): string {
  const cleaned = hex.replace('#', '')
  const r = parseInt(cleaned.slice(0, 2), 16)
  const g = parseInt(cleaned.slice(2, 4), 16)
  const b = parseInt(cleaned.slice(4, 6), 16)
  return `${r};${g};${b}`
}

// ── Full Document Render ────────────────────────────────────────────────────

export function renderMarkdown(text: string, options: RenderOptions = {}): string {
  const blocks = parseMarkdown(text)
  return blocks.map(b => renderBlock(b, options)).join('\n\n')
}
