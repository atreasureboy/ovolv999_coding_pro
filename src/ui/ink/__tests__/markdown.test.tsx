/**
 * Tests for Markdown component rendering.
 * Verifies that various markdown constructs render to Ink output correctly.
 */

import { describe, it, expect } from 'vitest'
import { render } from 'ink-testing-library'
import { Markdown } from '../components/Markdown.js'

describe('Markdown rendering', () => {
  it('renders plain text paragraph', () => {
    const { lastFrame } = render(<Markdown>{'Hello world'}</Markdown>)
    expect((lastFrame() ?? '')).toContain('Hello world')
  })

  it('renders bold text', () => {
    const { lastFrame } = render(<Markdown>{'This is **bold** text'}</Markdown>)
    const frame = lastFrame() ?? ''
    expect(frame).toContain('bold')
    expect(frame).toContain('This is')
  })

  it('renders inline code', () => {
    const { lastFrame } = render(<Markdown>{'Use `npm install` to install'}</Markdown>)
    expect((lastFrame() ?? '')).toContain('npm install')
  })

  it('renders code blocks', () => {
    const md = '```ts\nconst x = 42\n```'
    const { lastFrame } = render(<Markdown>{md}</Markdown>)
    const frame = lastFrame() ?? ''
    expect(frame).toContain('const x = 42')
    expect(frame).toContain('ts')
  })

  it('renders headers', () => {
    const { lastFrame } = render(<Markdown>{'## Section Title'}</Markdown>)
    expect((lastFrame() ?? '')).toContain('Section Title')
  })

  it('renders unordered lists', () => {
    const { lastFrame } = render(<Markdown>{'- Item 1\n- Item 2\n- Item 3'}</Markdown>)
    const frame = lastFrame() ?? ''
    expect(frame).toContain('Item 1')
    expect(frame).toContain('Item 2')
    expect(frame).toContain('Item 3')
  })

  it('renders ordered lists', () => {
    const { lastFrame } = render(<Markdown>{'1. First\n2. Second'}</Markdown>)
    const frame = lastFrame() ?? ''
    expect(frame).toContain('First')
    expect(frame).toContain('Second')
  })

  it('renders blockquotes', () => {
    const { lastFrame } = render(<Markdown>{'> This is a quote'}</Markdown>)
    expect((lastFrame() ?? '')).toContain('This is a quote')
  })

  it('renders horizontal rule', () => {
    const { lastFrame } = render(<Markdown>{'Before\n---\nAfter'}</Markdown>)
    const frame = lastFrame() ?? ''
    expect(frame).toContain('Before')
    expect(frame).toContain('After')
    expect(frame).toContain('─')
  })

  it('renders links', () => {
    const { lastFrame } = render(<Markdown>{'See [docs](https://example.com)'}</Markdown>)
    expect((lastFrame() ?? '')).toContain('docs')
  })

  it('handles mixed content', () => {
    const md = [
      '# Title',
      '',
      'Some **bold** paragraph.',
      '',
      '```js',
      'console.log("hi")',
      '```',
      '',
      '- Item A',
      '- Item B',
    ].join('\n')
    const { lastFrame } = render(<Markdown>{md}</Markdown>)
    const frame = lastFrame() ?? ''
    expect(frame).toContain('Title')
    expect(frame).toContain('bold')
    expect(frame).toContain('console.log')
    expect(frame).toContain('Item A')
    expect(frame).toContain('Item B')
  })

  it('handles empty input', () => {
    const { lastFrame } = render(<Markdown>{''}</Markdown>)
    // Should not crash, output may be empty
    expect(lastFrame()).toBeDefined()
  })
})
