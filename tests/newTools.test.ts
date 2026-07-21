/**
 * Tests for the 5 new tools: Brief, CtxInspect, TerminalCapture,
 * WebBrowser, PushNotification.
 *
 * Focus on pure helper functions and the tool execute contract with
 * stubbed contexts. Network/exec backends are exercised structurally.
 */

import { describe, it, expect } from 'vitest'
import { BriefTool } from '../src/tools/brief.js'
import { CtxInspectTool } from '../src/tools/ctxInspect.js'
import { TerminalCaptureTool, stripAnsi } from '../src/tools/terminalCapture.js'
import { WebBrowserTool, parseHtml, formatPage } from '../src/tools/webBrowser.js'
import { PushNotificationTool } from '../src/tools/pushNotification.js'
import type { ToolContext, OpenAIMessage } from '../src/core/types.js'

function makeCtx(overrides: Partial<ToolContext> = {}): ToolContext {
  return {
    cwd: '/tmp/test',
    permissionMode: 'auto',
    ...overrides,
  }
}

function makeMessages(n: number): OpenAIMessage[] {
  const out: OpenAIMessage[] = []
  for (let i = 0; i < n; i++) {
    out.push({ role: i % 2 === 0 ? 'user' : 'assistant', content: `Message ${i} ${'x'.repeat(100)}` })
  }
  return out
}

// ── Brief Tool ──────────────────────────────────────────────────────────────

describe('BriefTool', () => {
  const tool = new BriefTool()

  it('has correct name and metadata', () => {
    expect(tool.name).toBe('Brief')
    expect(tool.metadata.readOnly).toBe(true)
  })

  it('returns a summary with context info', async () => {
    const ctx = makeCtx({ getMessages: () => makeMessages(5) })
    const result = await tool.execute({}, ctx)
    expect(result.isError).toBe(false)
    expect(result.content).toContain('Context:')
    expect(result.content).toContain('Messages: 5')
  })

  it('includes CWD', async () => {
    const ctx = makeCtx({ getMessages: () => [] })
    const result = await tool.execute({}, ctx)
    expect(result.content).toContain('/tmp/test')
  })

  it('full detail includes header', async () => {
    const ctx = makeCtx({ getMessages: () => makeMessages(3) })
    const result = await tool.execute({ detail: 'full' }, ctx)
    expect(result.content).toContain('Session Brief')
  })

  it('handles empty messages', async () => {
    const ctx = makeCtx()
    const result = await tool.execute({}, ctx)
    expect(result.isError).toBe(false)
  })

  it('isConcurrencySafe returns true', () => {
    expect(tool.isConcurrencySafe()).toBe(true)
  })
})

// ── CtxInspect Tool ─────────────────────────────────────────────────────────

describe('CtxInspectTool', () => {
  const tool = new CtxInspectTool()

  it('has correct name', () => {
    expect(tool.name).toBe('CtxInspect')
  })

  it('reports no messages', async () => {
    const result = await tool.execute({}, makeCtx())
    expect(result.content).toContain('No messages')
  })

  it('summary includes token count and message count', async () => {
    const ctx = makeCtx({ getMessages: () => makeMessages(10) })
    const result = await tool.execute({ action: 'summary' }, ctx)
    expect(result.content).toContain('Total tokens')
    expect(result.content).toContain('Messages: 10')
  })

  it('largest action shows top messages', async () => {
    const msgs = makeMessages(10)
    msgs[3] = { role: 'tool', name: 'Read', content: 'x'.repeat(5000) }
    const ctx = makeCtx({ getMessages: () => msgs })
    const result = await tool.execute({ action: 'largest', top_n: 3 }, ctx)
    expect(result.content).toContain('largest messages')
    expect(result.content).toContain('#3')
  })

  it('breakdown shows per-role stats', async () => {
    const ctx = makeCtx({ getMessages: () => makeMessages(6) })
    const result = await tool.execute({ action: 'breakdown' }, ctx)
    expect(result.content).toContain('breakdown')
    expect(result.content).toContain('user')
    expect(result.content).toContain('assistant')
  })

  it('projection shows snip potential', async () => {
    const msgs = makeMessages(4)
    msgs[0] = { role: 'tool', name: 'Read', content: 'x'.repeat(20000) }
    const ctx = makeCtx({ getMessages: () => msgs })
    const result = await tool.execute({ action: 'projection' }, ctx)
    expect(result.content.toLowerCase()).toContain('snip')
  })

  it('handles oversized tool results in projection', async () => {
    const msgs: OpenAIMessage[] = [
      { role: 'tool', name: 'Read', content: 'A'.repeat(20000) },
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'hello' },
      { role: 'user', content: 'hi2' },
      { role: 'assistant', content: 'hello2' },
      { role: 'user', content: 'hi3' },
      { role: 'assistant', content: 'hello3' },
      { role: 'user', content: 'hi4' },
    ]
    const ctx = makeCtx({ getMessages: () => msgs })
    const result = await tool.execute({ action: 'projection' }, ctx)
    expect(result.content.toLowerCase()).toContain('snip')
  })
})

// ── TerminalCapture ─────────────────────────────────────────────────────────

describe('TerminalCaptureTool', () => {
  const tool = new TerminalCaptureTool()

  it('has correct name', () => {
    expect(tool.name).toBe('TerminalCapture')
  })

  it('reports unavailable when not in tmux', async () => {
    const savedTmux = process.env.TMUX
    delete process.env.TMUX
    try {
      const result = await tool.execute({}, makeCtx())
      expect(result.isError).toBe(false)
      expect(result.content).toContain('not available')
    } finally {
      if (savedTmux !== undefined) process.env.TMUX = savedTmux
    }
  })
})

describe('stripAnsi', () => {
  it('strips color codes', () => {
    expect(stripAnsi('\x1b[31mred\x1b[0m')).toBe('red')
  })

  it('strips cursor moves', () => {
    expect(stripAnsi('\x1b[2Atext')).toBe('text')
  })

  it('strips OSC sequences', () => {
    expect(stripAnsi('\x1b]0;title\x07text')).toBe('text')
  })

  it('leaves plain text alone', () => {
    expect(stripAnsi('hello world')).toBe('hello world')
  })

  it('handles mixed sequences', () => {
    expect(stripAnsi('\x1b[1m\x1b[31mBold Red\x1b[0m normal')).toBe('Bold Red normal')
  })

  it('handles empty string', () => {
    expect(stripAnsi('')).toBe('')
  })
})

// ── WebBrowser ──────────────────────────────────────────────────────────────

describe('WebBrowserTool', () => {
  const tool = new WebBrowserTool()

  it('has correct name', () => {
    expect(tool.name).toBe('WebBrowser')
  })

  it('errors without url', async () => {
    const result = await tool.execute({}, makeCtx())
    expect(result.isError).toBe(true)
    expect(result.content).toContain('url is required')
  })
})

describe('parseHtml', () => {
  const sampleHtml = `
    <html>
    <head>
      <title>Test Page</title>
      <meta name="description" content="A test page">
      <meta property="og:title" content="OG Title">
    </head>
    <body>
      <h1>Main Heading</h1>
      <h2>Subheading</h2>
      <p>First paragraph with <a href="/rel1">a link</a>.</p>
      <p>Second paragraph with <a href="https://example.com/abs">external</a>.</p>
      <ul><li>Item one</li><li>Item two</li></ul>
      <form action="/submit" method="post">
        <input name="username" type="text">
        <input name="password" type="password">
      </form>
    </body>
    </html>
  `

  it('extracts title', () => {
    const page = parseHtml('http://x.com', 'http://x.com', 200, sampleHtml, 'text/html')
    expect(page.title).toBe('Test Page')
  })

  it('extracts description', () => {
    const page = parseHtml('http://x.com', 'http://x.com', 200, sampleHtml, 'text/html')
    expect(page.description).toBe('A test page')
  })

  it('extracts meta tags', () => {
    const page = parseHtml('http://x.com', 'http://x.com', 200, sampleHtml, 'text/html')
    expect(page.metaTags['og:title']).toBe('OG Title')
    expect(page.metaTags['description']).toBe('A test page')
  })

  it('extracts headings', () => {
    const page = parseHtml('http://x.com', 'http://x.com', 200, sampleHtml, 'text/html')
    expect(page.headings.length).toBe(2)
    expect(page.headings[0].level).toBe(1)
    expect(page.headings[0].text).toBe('Main Heading')
    expect(page.headings[1].level).toBe(2)
  })

  it('extracts and resolves links', () => {
    const page = parseHtml('http://x.com', 'http://x.com', 200, sampleHtml, 'text/html')
    expect(page.links.length).toBe(2)
    expect(page.links[0].href).toBe('http://x.com/rel1')
    expect(page.links[1].href).toBe('https://example.com/abs')
  })

  it('extracts text blocks', () => {
    const page = parseHtml('http://x.com', 'http://x.com', 200, sampleHtml, 'text/html')
    expect(page.textBlocks.length).toBeGreaterThan(0)
    expect(page.textBlocks.some((t) => t.includes('First paragraph'))).toBe(true)
    expect(page.textBlocks.some((t) => t.includes('Item one'))).toBe(true)
  })

  it('extracts forms', () => {
    const page = parseHtml('http://x.com', 'http://x.com', 200, sampleHtml, 'text/html')
    expect(page.forms.length).toBe(1)
    expect(page.forms[0].method).toBe('post')
    expect(page.forms[0].action).toBe('http://x.com/submit')
    expect(page.forms[0].fields).toContain('username')
    expect(page.forms[0].fields).toContain('password')
  })

  it('strips script and style content', () => {
    const html = '<script>var x = 1</script><style>.a{}</style><p>visible</p>'
    const page = parseHtml('http://x', 'http://x', 200, html, 'text/html')
    expect(page.textBlocks.some((t) => t.includes('visible'))).toBe(true)
    expect(page.textBlocks.some((t) => t.includes('var x'))).toBe(false)
  })

  it('ignores javascript: links', () => {
    const html = '<a href="javascript:alert(1)">click</a><a href="#frag">frag</a><a href="/ok">ok</a>'
    const page = parseHtml('http://x', 'http://x', 200, html, 'text/html')
    expect(page.links.length).toBe(1)
    expect(page.links[0].href).toBe('http://x/ok')
  })

  it('decodes HTML entities', () => {
    const html = '<p>5 &lt; 10 &amp; 3 &gt; 2</p>'
    const page = parseHtml('http://x', 'http://x', 200, html, 'text/html')
    expect(page.textBlocks[0]).toBe('5 < 10 & 3 > 2')
  })

  it('handles empty body', () => {
    const page = parseHtml('http://x', 'http://x', 200, '', 'text/html')
    expect(page.title).toBe('')
    expect(page.headings.length).toBe(0)
  })
})

describe('formatPage', () => {
  const samplePage = parseHtml('http://x.com', 'http://x.com', 200, `
    <title>Test</title><meta name="description" content="Desc">
    <h1>Title</h1><p>Body text</p>
    <a href="/a">A</a><a href="/b">B</a>
  `, 'text/html')

  it('formats all extract', () => {
    const out = formatPage(samplePage, 'all', 50)
    expect(out).toContain('URL: http://x.com')
    expect(out).toContain('Title: Test')
    expect(out).toContain('Links')
    expect(out).toContain('Body text')
  })

  it('formats metadata-only', () => {
    const out = formatPage(samplePage, 'metadata', 50)
    expect(out).toContain('Title: Test')
    expect(out).toContain('Desc')
    expect(out).not.toContain('Body text')
  })

  it('formats links-only', () => {
    const out = formatPage(samplePage, 'links', 50)
    expect(out).toContain('Links')
    expect(out).toContain('/a')
  })

  it('respects maxLinks', () => {
    const out = formatPage(samplePage, 'links', 1)
    expect(out).toContain('showing 1')
  })
})

// ── PushNotification ────────────────────────────────────────────────────────

describe('PushNotificationTool', () => {
  const tool = new PushNotificationTool()

  it('has correct name', () => {
    expect(tool.name).toBe('PushNotification')
  })

  it('errors without title/message', async () => {
    const result = await tool.execute({}, makeCtx())
    expect(result.isError).toBe(true)
  })

  it('errors with empty title', async () => {
    const result = await tool.execute({ title: '', message: 'hi' }, makeCtx())
    expect(result.isError).toBe(true)
  })

  it('delivers via terminal bell fallback', async () => {
    const result = await tool.execute(
      { title: 'Test', message: 'Hello', urgency: 'normal' },
      makeCtx(),
    )
    expect(result.isError).toBe(false)
    expect(result.content).toContain('Notification delivered')
  })

  it('handles critical urgency', async () => {
    const result = await tool.execute(
      { title: 'Urgent', message: 'Now', urgency: 'critical' },
      makeCtx(),
    )
    expect(result.isError).toBe(false)
  })

  it('isConcurrencySafe returns true', () => {
    expect(tool.isConcurrencySafe()).toBe(true)
  })
})
