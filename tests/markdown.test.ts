import { describe, it, expect } from 'vitest'
import {
  parseMarkdown, renderMarkdown, renderInline, renderBlock,
} from '../src/ui/markdown.js'
import { stripAnsi } from '../src/utils/ansi.js'

describe('Markdown Renderer', () => {
  describe('parseMarkdown', () => {
    it('parses headings', () => {
      const blocks = parseMarkdown('# Hello')
      expect(blocks[0].type).toBe('heading')
      expect(blocks[0].level).toBe(1)
      expect(blocks[0].content).toBe('Hello')
    })

    it('parses level 2 heading', () => {
      const blocks = parseMarkdown('## Title')
      expect(blocks[0].level).toBe(2)
    })

    it('parses paragraph', () => {
      const blocks = parseMarkdown('Some text here')
      expect(blocks[0].type).toBe('paragraph')
    })

    it('parses code block', () => {
      const blocks = parseMarkdown('```ts\nconst x = 1\n```')
      expect(blocks[0].type).toBe('code')
      expect(blocks[0].lang).toBe('ts')
      expect(blocks[0].content).toBe('const x = 1')
    })

    it('parses code block without language', () => {
      const blocks = parseMarkdown('```\ncode\n```')
      expect(blocks[0].type).toBe('code')
    })

    it('parses unordered list', () => {
      const blocks = parseMarkdown('- item 1\n- item 2\n- item 3')
      expect(blocks[0].type).toBe('list')
      expect(blocks[0].items).toEqual(['item 1', 'item 2', 'item 3'])
      expect(blocks[0].ordered).toBe(false)
    })

    it('parses ordered list', () => {
      const blocks = parseMarkdown('1. first\n2. second')
      expect(blocks[0].type).toBe('list')
      expect(blocks[0].ordered).toBe(true)
    })

    it('parses blockquote', () => {
      const blocks = parseMarkdown('> quoted text')
      expect(blocks[0].type).toBe('quote')
      expect(blocks[0].content).toBe('quoted text')
    })

    it('parses horizontal rule', () => {
      const blocks = parseMarkdown('---')
      expect(blocks[0].type).toBe('hr')
    })

    it('parses table', () => {
      const md = '| Name | Age |\n| --- | --- |\n| Alice | 30 |'
      const blocks = parseMarkdown(md)
      expect(blocks[0].type).toBe('table')
      expect(blocks[0].header).toEqual(['Name', 'Age'])
      expect(blocks[0].rows).toEqual([['Alice', '30']])
    })

    it('handles mixed content', () => {
      const md = '# Title\n\nSome paragraph.\n\n- list item'
      const blocks = parseMarkdown(md)
      expect(blocks).toHaveLength(3)
      expect(blocks[0].type).toBe('heading')
      expect(blocks[1].type).toBe('paragraph')
      expect(blocks[2].type).toBe('list')
    })
  })

  describe('renderInline', () => {
    it('renders bold text', () => {
      const result = renderInline('**bold**')
      expect(stripAnsi(result)).toBe('bold')
    })

    it('renders italic text', () => {
      const result = renderInline('*italic*')
      expect(stripAnsi(result)).toBe('italic')
    })

    it('renders code spans', () => {
      const result = renderInline('`code`')
      expect(stripAnsi(result)).toBe('code')
    })

    it('renders strikethrough', () => {
      const result = renderInline('~~deleted~~')
      expect(stripAnsi(result)).toBe('deleted')
    })

    it('renders links', () => {
      const result = renderInline('[text](https://example.com)')
      expect(stripAnsi(result)).toBe('text')
    })

    it('handles mixed formatting', () => {
      const result = renderInline('**bold** and `code`')
      expect(stripAnsi(result)).toBe('bold and code')
    })
  })

  describe('renderBlock', () => {
    it('renders heading', () => {
      const result = renderBlock({ type: 'heading', content: 'Title', level: 1 })
      expect(stripAnsi(result)).toContain('Title')
    })

    it('renders code block', () => {
      const result = renderBlock({ type: 'code', content: 'const x = 1', lang: 'ts' })
      expect(stripAnsi(result)).toContain('const x = 1')
    })

    it('renders list', () => {
      const result = renderBlock({ type: 'list', items: ['a', 'b'], ordered: false, content: '' })
      expect(stripAnsi(result)).toContain('a')
      expect(stripAnsi(result)).toContain('b')
    })

    it('renders quote', () => {
      const result = renderBlock({ type: 'quote', content: 'quoted' })
      expect(stripAnsi(result)).toContain('quoted')
    })

    it('renders table', () => {
      const result = renderBlock({
        type: 'table', content: '',
        header: ['Name', 'Age'],
        rows: [['Bob', '25']],
      })
      expect(stripAnsi(result)).toContain('Name')
      expect(stripAnsi(result)).toContain('Bob')
    })

    it('renders hr', () => {
      const result = renderBlock({ type: 'hr', content: '' })
      expect(stripAnsi(result)).toContain('─')
    })
  })

  describe('renderMarkdown (full)', () => {
    it('renders a full document', () => {
      const md = [
        '# Project Title',
        '',
        'This is a **description**.',
        '',
        '## Features',
        '',
        '- Feature one',
        '- Feature two',
        '',
        '```ts',
        'const x = 1',
        '```',
      ].join('\n')

      const result = renderMarkdown(md)
      expect(stripAnsi(result)).toContain('Project Title')
      expect(stripAnsi(result)).toContain('description')
      expect(stripAnsi(result)).toContain('Feature one')
      expect(stripAnsi(result)).toContain('const x = 1')
    })

    it('handles empty input', () => {
      expect(renderMarkdown('')).toBe('')
    })
  })

  describe('syntax highlighting', () => {
    it('highlights comments', () => {
      const md = '```ts\n// a comment\n```'
      const result = renderMarkdown(md)
      // Comment should be rendered (color may vary)
      expect(stripAnsi(result)).toContain('// a comment')
    })

    it('highlights Python comments', () => {
      const md = '```py\n# python comment\n```'
      const result = renderMarkdown(md)
      expect(stripAnsi(result)).toContain('# python comment')
    })

    it('highlights strings', () => {
      const md = '```ts\nconst x = "hello"\n```'
      const result = renderMarkdown(md)
      expect(stripAnsi(result)).toContain('"hello"')
    })
  })
})
