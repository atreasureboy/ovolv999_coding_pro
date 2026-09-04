import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  exportSession,
  exportSessionToFile,
  defaultFilename,
  type ExportFormat,
  type OpenAIMessage,
} from '../src/utils/sessionExport.js'

// ── Helpers ─────────────────────────────────────────────────────────────────

function userMsg(text: string): OpenAIMessage {
  return { role: 'user', content: text }
}

function assistantMsg(text: string): OpenAIMessage {
  return { role: 'assistant', content: text }
}

function assistantWithTools(text: string, tools: unknown[]): OpenAIMessage {
  return {
    role: 'assistant',
    content: text,
    tool_calls: tools as OpenAIMessage['tool_calls'],
  }
}

function toolMsg(content: string): OpenAIMessage {
  return { role: 'tool', content }
}

function toolCall(name: string, args: Record<string, unknown>): unknown {
  return {
    id: `call_${name}`,
    type: 'function',
    function: { name, arguments: JSON.stringify(args) },
  }
}

const sampleMessages: OpenAIMessage[] = [
  { role: 'system', content: 'You are a helpful assistant' },
  userMsg('Hello, world!'),
  assistantMsg('Hi there! How can I help you?'),
  userMsg('Write a function'),
  assistantWithTools('Let me create that for you.', [
    toolCall('Write', { file_path: '/tmp/test.ts', content: 'export const x = 1' }),
  ]),
  toolMsg('File written successfully'),
  assistantMsg('Done! I created the file.'),
]

// ── Markdown Export ─────────────────────────────────────────────────────────

describe('exportSession (markdown)', () => {
  it('exports with title', () => {
    const result = exportSession(sampleMessages, { format: 'markdown', title: 'My Chat' })
    expect(result.content).toContain('# My Chat')
    expect(result.content).toContain('*Messages: 7*')
  })

  it('includes user messages', () => {
    const result = exportSession(sampleMessages, { format: 'markdown' })
    expect(result.content).toContain('## User')
    expect(result.content).toContain('Hello, world!')
  })

  it('includes assistant messages', () => {
    const result = exportSession(sampleMessages, { format: 'markdown' })
    expect(result.content).toContain('## Assistant')
    expect(result.content).toContain('Hi there!')
  })

  it('skips system messages', () => {
    const result = exportSession(sampleMessages, { format: 'markdown' })
    expect(result.content).not.toContain('helpful assistant')
  })

  it('includes tool calls by default', () => {
    const result = exportSession(sampleMessages, { format: 'markdown' })
    expect(result.content).toContain('Tool Calls')
    expect(result.content).toContain('Write')
    expect(result.content).toContain('file_path')
  })

  it('can exclude tool calls', () => {
    const result = exportSession(sampleMessages, { format: 'markdown', includeTools: false })
    expect(result.content).not.toContain('Tool Calls')
  })

  it('includes tool results', () => {
    const result = exportSession(sampleMessages, { format: 'markdown' })
    expect(result.content).toContain('Tool Result')
    expect(result.content).toContain('File written')
  })

  it('truncates long messages', () => {
    const longMsg = userMsg('x'.repeat(1000))
    const result = exportSession([longMsg], { format: 'markdown', maxCharsPerMessage: 100 })
    expect(result.content).toContain('truncated')
    expect(result.content.length).toBeLessThan(500)
  })

  it('records correct messageCount', () => {
    const result = exportSession(sampleMessages, { format: 'markdown' })
    expect(result.messageCount).toBe(7)
  })

  it('records correct format', () => {
    const result = exportSession(sampleMessages, { format: 'markdown' })
    expect(result.format).toBe('markdown')
  })
})

// ── JSON Export ─────────────────────────────────────────────────────────────

describe('exportSession (json)', () => {
  it('produces valid JSON', () => {
    const result = exportSession(sampleMessages, { format: 'json' })
    const parsed = JSON.parse(result.content)
    expect(Array.isArray(parsed)).toBe(true)
    expect(parsed).toHaveLength(7)
  })

  it('preserves all fields', () => {
    const result = exportSession(sampleMessages, { format: 'json' })
    const parsed = JSON.parse(result.content)
    expect(parsed[1].role).toBe('user')
    expect(parsed[1].content).toBe('Hello, world!')
    expect(parsed[4].tool_calls).toBeDefined()
  })
})

// ── Text Export ─────────────────────────────────────────────────────────────

describe('exportSession (text)', () => {
  it('produces plain text', () => {
    const result = exportSession(sampleMessages, { format: 'text' })
    expect(result.content).toContain('[YOU]')
    expect(result.content).toContain('[AI]')
    expect(result.content).toContain('Hello, world!')
  })

  it('excludes tool calls by default', () => {
    const result = exportSession(sampleMessages, { format: 'text' })
    // The "→ Write" tool call indicator should not appear
    expect(result.content).not.toContain('→ Write')
  })

  it('can include tool call names', () => {
    const result = exportSession(sampleMessages, { format: 'text', includeTools: true })
    expect(result.content).toContain('→ Write')
  })

  it('skips system messages', () => {
    const result = exportSession(sampleMessages, { format: 'text' })
    expect(result.content).not.toContain('helpful assistant')
  })

  it('includes tool role messages', () => {
    const result = exportSession(sampleMessages, { format: 'text' })
    expect(result.content).toContain('[TOOL]')
  })
})

// ── Transcript Export ───────────────────────────────────────────────────────

describe('exportSession (transcript)', () => {
  it('produces timestamped transcript', () => {
    const result = exportSession(sampleMessages, { format: 'transcript' })
    expect(result.content).toMatch(/\[\d{2}:\d{2}:\d{2}\]/)
    expect(result.content).toContain('User:')
    expect(result.content).toContain('Assistant:')
  })

  it('includes tool calls in transcript', () => {
    const result = exportSession(sampleMessages, { format: 'transcript' })
    expect(result.content).toContain('[tool]')
    expect(result.content).toContain('Write')
  })

  it('can exclude tools', () => {
    const result = exportSession(sampleMessages, { format: 'transcript', includeTools: false })
    expect(result.content).not.toContain('[tool]')
  })
})

// ── Edge Cases ──────────────────────────────────────────────────────────────

describe('edge cases', () => {
  it('handles empty messages', () => {
    const result = exportSession([], { format: 'markdown' })
    expect(result.messageCount).toBe(0)
    expect(result.content).toContain('# Conversation')
  })

  it('handles only system messages', () => {
    const result = exportSession(
      [{ role: 'system', content: 'sys' }],
      { format: 'markdown' },
    )
    expect(result.content).not.toContain('sys')
  })

  it('handles multimodal content', () => {
    const msg: OpenAIMessage = {
      role: 'user',
      content: [
        { type: 'text', text: 'look at this' },
        { type: 'image_url', image_url: { url: 'data:image/png;base64,abc' } },
      ] as never,
    }
    const result = exportSession([msg], { format: 'markdown' })
    expect(result.content).toContain('look at this')
    expect(result.content).toContain('[image]')
  })

  it('handles null content', () => {
    const msg = { role: 'assistant', content: null } as OpenAIMessage
    const result = exportSession([msg], { format: 'markdown' })
    expect(result.content).toContain('## Assistant')
  })

  it('throws on unknown format', () => {
    expect(() => exportSession([], { format: 'unknown' as ExportFormat })).toThrow(/Unknown export format/)
  })
})

// ── File Export ─────────────────────────────────────────────────────────────

describe('exportSessionToFile', () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'export-'))
  })

  afterEach(() => {
    try { rmSync(dir, { recursive: true, force: true }) } catch { /* best-effort */ }
  })

  it('writes to file', () => {
    const path = exportSessionToFile(sampleMessages, dir, 'test.md', { format: 'markdown' })
    expect(existsSync(path)).toBe(true)
    const content = readFileSync(path, 'utf8')
    expect(content).toContain('# Conversation')
  })

  it('writes JSON to .json file', () => {
    const path = exportSessionToFile(sampleMessages, dir, 'data.json', { format: 'json' })
    expect(existsSync(path)).toBe(true)
    const content = readFileSync(path, 'utf8')
    expect(JSON.parse(content)).toHaveLength(7)
  })
})

// ── Filename Generator ──────────────────────────────────────────────────────

describe('defaultFilename', () => {
  it('generates markdown filename', () => {
    const name = defaultFilename('markdown')
    expect(name).toMatch(/^session-\d{4}-\d{2}-\d{2}T/)
    expect(name).toMatch(/\.md$/)
  })

  it('generates json filename', () => {
    const name = defaultFilename('json')
    expect(name).toMatch(/\.json$/)
  })

  it('generates text filename', () => {
    const name = defaultFilename('text')
    expect(name).toMatch(/\.txt$/)
  })

  it('generates transcript filename', () => {
    const name = defaultFilename('transcript')
    expect(name).toMatch(/\.txt$/)
  })

  it('produces unique filenames (different times)', () => {
    return new Promise<void>((resolve) => {
      const name1 = defaultFilename('markdown')
      setTimeout(() => {
        const name2 = defaultFilename('markdown')
        expect(name1).not.toBe(name2)
        resolve()
      }, 1100)
    })
  }, 10_000)
})

describe('/share format validation', () => {
  it('rejects an unknown format without writing a file', async () => {
    const { dispatchSlashCommand } = await import('../src/commands/index.js')
    await import('../src/commands/builtin.js')
    const dir = mkdtempSync(join(tmpdir(), 'share-dispatch-'))
    try {
      const ctx = {
        engine: {} as never,
        renderer: {} as never,
        history: [{ role: 'user', content: 'hello' }],
        cwd: dir,
        setHistory: () => undefined,
        runPrompt: () => undefined,
      }
      const result = await dispatchSlashCommand('/share xml', ctx as never)
      if (!result || result.type !== 'text') throw new Error('expected text result')
      expect(result.value).toContain('Unknown format "xml"')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
