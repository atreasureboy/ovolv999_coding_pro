/**
 * Web Browser Tool — structured web page retrieval
 *
 * A richer alternative to WebFetch: fetches a URL and extracts
 * structured information — title, headings, links, forms, text
 * blocks, and metadata. Does NOT execute JavaScript (no headless
 * browser); intended for documentation pages, APIs, and static
 * content.
 *
 * Output is formatted for LLM consumption: concise, structured,
 * with link lists the model can follow.
 */

import type { Tool, ToolContext, ToolDefinition, ToolResult } from '../core/types.js'

export interface ParsedPage {
  url: string
  finalUrl: string
  status: number
  title: string
  description: string
  headings: { level: number; text: string }[]
  links: { text: string; href: string }[]
  forms: { action: string; method: string; fields: string[] }[]
  textBlocks: string[]
  metaTags: Record<string, string>
  contentType: string
  contentLength: number
}

export class WebBrowserTool implements Tool {
  name = 'WebBrowser'
  metadata = { readOnly: true, concurrencySafe: true }

  definition: ToolDefinition = {
    type: 'function',
    function: {
      name: 'WebBrowser',
      description: `Fetch a web page and extract structured content: title, headings, links, forms, and text. Does NOT execute JavaScript.

## When to Use
- Reading documentation pages
- Inspecting a REST API's HTML docs
- Gathering links from a page (then WebFetch specific ones)
- Checking a page's metadata / Open Graph tags

## When NOT to Use
- You need the rendered (JS-executed) page — this tool is static-only
- You just want raw text — use WebFetch instead (lighter)

## Output
Structured page summary with extractable links for follow-up.`,
      parameters: {
        type: 'object',
        properties: {
          url: { type: 'string', description: 'The URL to fetch.' },
          extract: {
            type: 'string',
            enum: ['all', 'text', 'links', 'metadata'],
            description: 'What to extract. all (default): everything. text: body text only. links: link list only. metadata: title/description/tags.',
          },
          max_links: {
            type: 'number',
            description: 'Max links to return (default 50).',
          },
        },
        required: ['url'],
      },
    },
  }

  isConcurrencySafe(): boolean {
    return true
  }

  async execute(input: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const url = input.url as string | undefined
    if (!url || typeof url !== 'string') {
      return { content: 'Error: url is required', isError: true }
    }

    const extract = (input.extract as string) ?? 'all'
    const maxLinks = (input.max_links as number) ?? 50

    let response: Response
    try {
      response = await fetch(url, {
        redirect: 'follow',
        signal: ctx.signal,
        headers: {
          'User-Agent': 'ovolv999-webbrowser/1.0',
          'Accept': 'text/html,application/xhtml+xml,application/json,text/plain',
        },
      })
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      return { content: `Fetch failed: ${msg}`, isError: true }
    }

    const contentType = response.headers.get('content-type') ?? 'unknown'
    const html = await response.text()

    const page = parseHtml(url, response.url, response.status, html, contentType)

    return {
      content: formatPage(page, extract, maxLinks),
      isError: false,
    }
  }
}

// ── HTML Parsing (minimal, no dependencies) ─────────────────────────────────

const ENTITY_MAP: Record<string, string> = {
  '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'",
  '&apos;': "'", '&nbsp;': ' ', '&hellip;': '...', '&mdash;': '—',
  '&ndash;': '–', '&copy;': '©', '&reg;': '®', '&trade;': '™',
}

function decodeEntities(s: string): string {
  let out = s
  for (const [entity, char] of Object.entries(ENTITY_MAP)) {
    out = out.replaceAll(entity, char)
  }
  // Numeric entities
  out = out.replace(/&#(\d+);/g, (_, n) => {
    const code = parseInt(n, 10)
    return code > 0 ? String.fromCodePoint(code) : ''
  })
  out = out.replace(/&#x([0-9a-f]+);/gi, (_, n) => {
    const code = parseInt(n, 16)
    return code > 0 ? String.fromCodePoint(code) : ''
  })
  return out
}

function stripTags(html: string): string {
  return decodeEntities(
    html
      .replace(/<script[\s\S]*?<\/script>/gi, '')
      .replace(/<style[\s\S]*?<\/style>/gi, '')
      .replace(/<[^>]+>/g, '')
      .replace(/\s+/g, ' ')
      .trim(),
  )
}

export function parseHtml(
  originalUrl: string,
  finalUrl: string,
  status: number,
  html: string,
  contentType: string,
): ParsedPage {
  const page: ParsedPage = {
    url: originalUrl,
    finalUrl,
    status,
    title: '',
    description: '',
    headings: [],
    links: [],
    forms: [],
    textBlocks: [],
    metaTags: {},
    contentType,
    contentLength: html.length,
  }

  // Title
  const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)
  if (titleMatch) page.title = decodeEntities(titleMatch[1].trim())

  // Meta tags
  const metaRegex = /<meta\s+([^>]*)>/gi
  let metaMatch: RegExpExecArray | null
  while ((metaMatch = metaRegex.exec(html)) !== null) {
    const attrs = metaMatch[1]
    const nameMatch = attrs.match(/(?:name|property|http-equiv)\s*=\s*["']?([^"'\s>]+)/i)
    const contentMatch = attrs.match(/content\s*=\s*["']([^"']*)["']/i)
    if (nameMatch && contentMatch) {
      const name = nameMatch[1].toLowerCase()
      const content = decodeEntities(contentMatch[1])
      page.metaTags[name] = content
      if (name === 'description' || name === 'og:description') {
        page.description = content
      }
    }
  }

  // Headings
  const headingRegex = /<h([1-6])[^>]*>([\s\S]*?)<\/h\1>/gi
  let hMatch: RegExpExecArray | null
  while ((hMatch = headingRegex.exec(html)) !== null) {
    const level = parseInt(hMatch[1], 10)
    const text = stripTags(hMatch[2])
    if (text) page.headings.push({ level, text })
  }

  // Links
  const linkRegex = /<a\s+([^>]*)>([\s\S]*?)<\/a>/gi
  let lMatch: RegExpExecArray | null
  while ((lMatch = linkRegex.exec(html)) !== null) {
    const attrs = lMatch[1]
    const text = stripTags(lMatch[2])
    const hrefMatch = attrs.match(/href\s*=\s*["']?([^"'\s>]+)/i)
    if (hrefMatch) {
      const href = decodeEntities(hrefMatch[1])
      if (href && !href.startsWith('javascript:') && !href.startsWith('#')) {
        page.links.push({ text: text || href, href: resolveUrl(href, finalUrl) })
      }
    }
  }

  // Forms
  const formRegex = /<form\s+([^>]*)>([\s\S]*?)<\/form>/gi
  let fMatch: RegExpExecArray | null
  while ((fMatch = formRegex.exec(html)) !== null) {
    const attrs = fMatch[1]
    const body = fMatch[2]
    const actionMatch = attrs.match(/action\s*=\s*["']?([^"'\s>]+)/i)
    const methodMatch = attrs.match(/method\s*=\s*["']?([^"'\s>]+)/i)
    const fields: string[] = []
    const inputRegex = /<(?:input|textarea|select)\s+[^>]*?(?:name|id)\s*=\s*["']?([^"'\s>]+)/gi
    let iMatch: RegExpExecArray | null
    while ((iMatch = inputRegex.exec(body)) !== null) {
      fields.push(iMatch[1])
    }
    page.forms.push({
      action: actionMatch ? resolveUrl(decodeEntities(actionMatch[1]), finalUrl) : finalUrl,
      method: (methodMatch?.[1] ?? 'get').toLowerCase(),
      fields,
    })
  }

  // Text blocks (paragraphs, list items, pre, code)
  const blockTags = ['p', 'li', 'pre', 'code', 'blockquote', 'dd', 'dt']
  for (const tag of blockTags) {
    const blockRegex = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, 'gi')
    let bMatch: RegExpExecArray | null
    while ((bMatch = blockRegex.exec(html)) !== null) {
      const text = stripTags(bMatch[1])
      if (text.length > 0) page.textBlocks.push(text)
    }
  }

  return page
}

function resolveUrl(href: string, base: string): string {
  try {
    return new URL(href, base).href
  } catch {
    return href
  }
}

export function formatPage(page: ParsedPage, extract: string, maxLinks: number): string {
  const lines: string[] = []

  lines.push(`URL: ${page.finalUrl}`)
  lines.push(`Status: ${page.status} | Type: ${page.contentType}`)

  if (extract === 'metadata') {
    lines.push(`Title: ${page.title}`)
    lines.push(`Description: ${page.description}`)
    const tags = Object.entries(page.metaTags).slice(0, 20)
    if (tags.length > 0) {
      lines.push('Meta tags:')
      for (const [k, v] of tags) lines.push(`  ${k}: ${v}`)
    }
    return lines.join('\n')
  }

  if (page.title) lines.push(`Title: ${page.title}`)
  if (page.description) lines.push(`Description: ${page.description}`)

  if (extract === 'links' || extract === 'all') {
    const seen = new Set<string>()
    const unique = page.links.filter((l) => {
      if (seen.has(l.href)) return false
      seen.add(l.href)
      return true
    })
    const shown = unique.slice(0, maxLinks)
    if (shown.length > 0) {
      lines.push('')
      lines.push(`Links (${unique.length} total, showing ${shown.length}):`)
      for (const l of shown) {
        const text = l.text.length > 50 ? l.text.slice(0, 47) + '...' : l.text
        lines.push(`  - ${text}: ${l.href}`)
      }
    }
  }

  if (extract === 'text' || extract === 'all') {
    if (page.headings.length > 0) {
      lines.push('')
      lines.push('Headings:')
      for (const h of page.headings.slice(0, 30)) {
        lines.push(`  ${'#'.repeat(h.level)} ${h.text}`)
      }
    }
    if (page.textBlocks.length > 0) {
      lines.push('')
      lines.push('Text content:')
      const joined = page.textBlocks.join('\n\n')
      const trimmed = joined.length > 8000 ? joined.slice(0, 8000) + '\n...(truncated)' : joined
      lines.push(trimmed)
    }
  }

  if (extract === 'all' && page.forms.length > 0) {
    lines.push('')
    lines.push(`Forms (${page.forms.length}):`)
    for (const f of page.forms.slice(0, 10)) {
      lines.push(`  [${f.method.toUpperCase()}] ${f.action} — fields: ${f.fields.join(', ') || '(none)'}`)
    }
  }

  return lines.join('\n')
}
