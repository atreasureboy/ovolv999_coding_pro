/**
 * Markdown — lightweight markdown-to-Ink renderer.
 *
 * Supports:
 * - Code blocks (```lang ... ```) with dark background
 * - Inline code (`code`)
 * - Bold (**text**)
 * - Headers (#, ##, ###)
 * - Unordered lists (- or *)
 * - Ordered lists (1. 2. 3.)
 * - Blockquotes (> text)
 * - Horizontal rules (---)
 * - Links [text](url) → text (dim url)
 *
 * Not a full CommonMark parser — just enough for LLM output readability.
 */

import { Text, Box } from 'ink'
import type { ReactNode } from 'react'

// ── Inline parsing ──────────────────────────────────────────────────────────

interface InlineSegment {
  text: string
  bold?: boolean
  code?: boolean
  italic?: boolean
  link?: string
}

function parseInline(text: string): InlineSegment[] {
  const segments: InlineSegment[] = []

  // Regex matches: **bold**, `code`, *italic*, [text](url)
  const re = /\*\*(.+?)\*\*|`(.+?)`|\*(.+?)\*|\[([^\]]+)\]\(([^)]+)\)/g
  let lastIdx = 0
  let match: RegExpExecArray | null

  while ((match = re.exec(text)) !== null) {
    if (match.index > lastIdx) {
      segments.push({ text: text.slice(lastIdx, match.index) })
    }
    if (match[1] !== undefined) {
      segments.push({ text: match[1], bold: true })
    } else if (match[2] !== undefined) {
      segments.push({ text: match[2], code: true })
    } else if (match[3] !== undefined) {
      segments.push({ text: match[3], italic: true })
    } else if (match[4] !== undefined && match[5] !== undefined) {
      segments.push({ text: match[4], link: match[5] })
    }
    lastIdx = re.lastIndex
  }
  if (lastIdx < text.length) {
    segments.push({ text: text.slice(lastIdx) })
  }
  return segments.length > 0 ? segments : [{ text }]
}

function renderInline(text: string): ReactNode {
  const segments = parseInline(text)
  return segments.map((seg, i) => {
    if (seg.code) {
      return (
        <Text key={i} backgroundColor="gray" color="white">{' '}{seg.text}{' '}</Text>
      )
    }
    if (seg.bold) {
      return <Text key={i} bold>{seg.text}</Text>
    }
    if (seg.italic) {
      return <Text key={i} dimColor>{seg.text}</Text>
    }
    if (seg.link) {
      return <Text key={i} underline color="cyan">{seg.text}</Text>
    }
    return <Text key={i}>{seg.text}</Text>
  })
}

// ── Block types ─────────────────────────────────────────────────────────────

type Block =
  | { type: 'code'; lang: string; content: string }
  | { type: 'header'; level: number; content: string }
  | { type: 'list'; ordered: boolean; items: string[] }
  | { type: 'quote'; content: string }
  | { type: 'hr' }
  | { type: 'paragraph'; content: string }

function parseBlocks(text: string): Block[] {
  const lines = text.split('\n')
  const blocks: Block[] = []
  let i = 0

  while (i < lines.length) {
    const line = lines[i]

    // Code block
    if (line.trim().startsWith('```')) {
      const lang = line.trim().slice(3).trim()
      const codeLines: string[] = []
      i++
      while (i < lines.length && !lines[i].trim().startsWith('```')) {
        codeLines.push(lines[i])
        i++
      }
      i++ // skip closing ```
      blocks.push({ type: 'code', lang, content: codeLines.join('\n') })
      continue
    }

    // Header
    const headerMatch = line.match(/^(#{1,4})\s+(.+)$/)
    if (headerMatch) {
      blocks.push({ type: 'header', level: headerMatch[1].length, content: headerMatch[2] })
      i++
      continue
    }

    // Horizontal rule
    if (/^(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
      blocks.push({ type: 'hr' })
      i++
      continue
    }

    // Blockquote
    if (line.trim().startsWith('>')) {
      const quoteLines: string[] = []
      while (i < lines.length && lines[i].trim().startsWith('>')) {
        quoteLines.push(lines[i].trim().replace(/^>\s?/, ''))
        i++
      }
      blocks.push({ type: 'quote', content: quoteLines.join('\n') })
      continue
    }

    // Unordered list
    if (/^\s*[-*]\s+/.test(line)) {
      const items: string[] = []
      while (i < lines.length && /^\s*[-*]\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^\s*[-*]\s+/, ''))
        i++
      }
      blocks.push({ type: 'list', ordered: false, items })
      continue
    }

    // Ordered list
    if (/^\s*\d+\.\s+/.test(line)) {
      const items: string[] = []
      while (i < lines.length && /^\s*\d+\.\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^\s*\d+\.\s+/, ''))
        i++
      }
      blocks.push({ type: 'list', ordered: true, items })
      continue
    }

    // Empty line — skip
    if (line.trim() === '') {
      i++
      continue
    }

    // Paragraph (accumulate consecutive non-empty lines)
    const paraLines: string[] = []
    while (
      i < lines.length &&
      lines[i].trim() !== '' &&
      !lines[i].trim().startsWith('```') &&
      !/^#{1,4}\s+/.test(lines[i]) &&
      !/^\s*[-*]\s+/.test(lines[i]) &&
      !/^\s*\d+\.\s+/.test(lines[i]) &&
      !lines[i].trim().startsWith('>') &&
      !/^(-{3,}|\*{3,}|_{3,})\s*$/.test(lines[i])
    ) {
      paraLines.push(lines[i])
      i++
    }
    if (paraLines.length > 0) {
      blocks.push({ type: 'paragraph', content: paraLines.join(' ') })
    }
  }

  return blocks
}

// ── Component ───────────────────────────────────────────────────────────────

function CodeBlock({ content, lang }: { content: string; lang: string }): ReactNode {
  const lines = content.split('\n').filter((l) => l.trim() || true) // keep all lines
  return (
    <Box flexDirection="column" marginY={0}>
      {lines.slice(0, 50).map((line, i) => (
        <Box key={i}>
          <Text backgroundColor="gray" color="white" dimColor>
            {' '}
            {line.length > 100 ? line.slice(0, 97) + '...' : line || ' '}
            {' '}
          </Text>
        </Box>
      ))}
      {lines.length > 50 ? <Text dimColor> ... +{lines.length - 50} more</Text> : null}
      {lang ? <Text dimColor> {lang}</Text> : null}
    </Box>
  )
}

function renderBlock(block: Block, key: number): ReactNode {
  switch (block.type) {
    case 'code':
      return <CodeBlock key={key} content={block.content} lang={block.lang} />

    case 'header': {
      const colors = ['', 'magentaBright', 'cyanBright', 'blueBright', 'white']
      const color = colors[block.level] || 'white'
      return (
        <Box key={key} marginTop={block.level <= 2 ? 1 : 0}>
          <Text bold color={color}>{renderInline(block.content)}</Text>
        </Box>
      )
    }

    case 'list':
      return (
        <Box key={key} flexDirection="column">
          {block.items.map((item, i) => (
            <Box key={i}>
              <Text dimColor>{block.ordered ? `${i + 1}.` : '•'}</Text>
              <Text>{renderInline(' ' + item)}</Text>
            </Box>
          ))}
        </Box>
      )

    case 'quote':
      return (
        <Box key={key} marginLeft={2}>
          <Text dimColor>│ {renderInline(block.content)}</Text>
        </Box>
      )

    case 'hr':
      return (
        <Box key={key}>
          <Text dimColor>{'─'.repeat(40)}</Text>
        </Box>
      )

    case 'paragraph':
      return (
        <Box key={key}>
          <Text>{renderInline(block.content)}</Text>
        </Box>
      )
  }
}

export function Markdown({ children }: { children: string }): ReactNode {
  const blocks = parseBlocks(children)
  return (
    <Box flexDirection="column">
      {blocks.map((block, i) => renderBlock(block, i))}
    </Box>
  )
}
