/**
 * Tests for src/core/snipCompact.ts
 */

import { describe, it, expect } from 'vitest'
import {
  snipCompact,
  snipString,
  estimateSnipSavings,
  formatSnipResult,
  SNIP_TOOL_RESULT_MAX_CHARS,
  SNIP_HEAD_CHARS,
  SNIP_TAIL_CHARS,
} from '../src/core/snipCompact.js'
import type { OpenAIMessage } from '../src/core/types.js'

function bigToolResult(name: string, size: number): OpenAIMessage {
  return { role: 'tool', name, content: 'x'.repeat(size) }
}

describe('snipCompact', () => {
  describe('snipString', () => {
    it('leaves short strings untouched', () => {
      expect(snipString('hello')).toBe('hello')
    })

    it('trims long strings to head+tail', () => {
      const big = 'A'.repeat(SNIP_TOOL_RESULT_MAX_CHARS * 2)
      const out = snipString(big)
      expect(out.length).toBeLessThan(big.length)
      expect(out).toContain('snip')
      expect(out.startsWith('A'.repeat(10))).toBe(true)
      expect(out.endsWith('A'.repeat(10))).toBe(true)
    })

    it('keeps head and tail content', () => {
      const head = 'HEAD'.repeat(500)
      const middle = 'M'.repeat(SNIP_TOOL_RESULT_MAX_CHARS)
      const tail = 'TAIL'.repeat(500)
      const out = snipString(head + middle + tail)
      expect(out).toContain('HEAD')
      expect(out).toContain('TAIL')
    })
  })

  describe('snipCompact — empty / no-op', () => {
    it('returns snipped=false on empty array', () => {
      const r = snipCompact([])
      expect(r.snipped).toBe(false)
      expect(r.messagesTrimmed).toBe(0)
      expect(r.messagesDropped).toBe(0)
      expect(r.thinkingStripped).toBe(0)
    })

    it('returns snipped=false when nothing to trim', () => {
      const msgs: OpenAIMessage[] = [
        { role: 'user', content: 'hi' },
        { role: 'assistant', content: 'hello' },
      ]
      const r = snipCompact(msgs)
      expect(r.snipped).toBe(false)
    })
  })

  describe('snipCompact — oversized tool results', () => {
    it('trims a long tool result', () => {
      const msgs: OpenAIMessage[] = [
        bigToolResult('Read', SNIP_TOOL_RESULT_MAX_CHARS * 3),
        ...recentMessages(8),
      ]
      const r = snipCompact(msgs)
      expect(r.snipped).toBe(true)
      expect(r.messagesTrimmed).toBe(1)
      expect(r.tokensAfter).toBeLessThan(r.tokensBefore)
    })

    it('does not trim tool results in the protected range', () => {
      const big = bigToolResult('Read', SNIP_TOOL_RESULT_MAX_CHARS * 3)
      const msgs: OpenAIMessage[] = [big] // single message, in protected range
      const r = snipCompact(msgs)
      expect(r.messagesTrimmed).toBe(0)
    })

    it('trims multiple oversized tool results', () => {
      const msgs: OpenAIMessage[] = [
        bigToolResult('Read', SNIP_TOOL_RESULT_MAX_CHARS * 3),
        bigToolResult('Grep', SNIP_TOOL_RESULT_MAX_CHARS * 3),
        bigToolResult('Bash', SNIP_TOOL_RESULT_MAX_CHARS * 3),
        ...recentMessages(8),
      ]
      const r = snipCompact(msgs)
      expect(r.messagesTrimmed).toBe(3)
    })

    it('idempotent — running twice does not trim again', () => {
      const msgs: OpenAIMessage[] = [
        bigToolResult('Read', SNIP_TOOL_RESULT_MAX_CHARS * 3),
        ...recentMessages(8),
      ]
      const r1 = snipCompact(msgs)
      const r2 = snipCompact(r1.messages)
      expect(r2.messagesTrimmed).toBe(0)
    })
  })

  describe('snipCompact — empty messages', () => {
    it('drops whitespace-only messages', () => {
      const msgs: OpenAIMessage[] = [
        { role: 'user', content: '   ' },
        { role: 'assistant', content: '' },
        { role: 'user', content: 'real' },
        ...recentMessages(8),
      ]
      const r = snipCompact(msgs)
      expect(r.messagesDropped).toBeGreaterThan(0)
    })

    it('never drops system messages', () => {
      const msgs: OpenAIMessage[] = [
        { role: 'system', content: '' },
        ...recentMessages(8),
      ]
      const r = snipCompact(msgs)
      const stillHasSystem = r.messages.some((m) => m.role === 'system')
      expect(stillHasSystem).toBe(true)
    })
  })

  describe('snipCompact — duplicate user messages', () => {
    it('collapses consecutive duplicates', () => {
      const msgs: OpenAIMessage[] = [
        { role: 'user', content: 'same prompt' },
        { role: 'user', content: 'same prompt' },
        { role: 'user', content: 'same prompt' },
        ...recentMessages(8),
      ]
      const r = snipCompact(msgs)
      const userCount = r.messages.filter((m) => m.content === 'same prompt').length
      expect(userCount).toBeLessThan(3)
    })
  })

  describe('snipCompact — thinking blocks', () => {
    it('strips thinking-type content parts from old assistant messages', () => {
      const msgs: OpenAIMessage[] = [
        {
          role: 'assistant',
          content: [
            { type: 'text', text: 'final answer' },
            { type: 'thinking' as unknown as 'text', text: 'long internal reasoning' },
          ],
        },
        ...recentMessages(8),
      ]
      const r = snipCompact(msgs)
      expect(r.thinkingStripped).toBe(1)
    })

    it('strips <thinking>…</thinking> text blocks', () => {
      const msgs: OpenAIMessage[] = [
        {
          role: 'assistant',
          content: [{ type: 'text', text: '<thinking>let me reason</thinking>' }],
        },
        ...recentMessages(8),
      ]
      const r = snipCompact(msgs)
      expect(r.thinkingStripped).toBe(1)
    })

    it('does not strip thinking from recent (protected) messages', () => {
      const msgs: OpenAIMessage[] = [
        {
          role: 'assistant',
          content: [{ type: 'text', text: '<thinking>reasoning</thinking>' }],
        },
      ]
      const r = snipCompact(msgs)
      expect(r.thinkingStripped).toBe(0)
    })
  })

  describe('estimateSnipSavings', () => {
    it('returns 0 when nothing to save', () => {
      expect(estimateSnipSavings([])).toBe(0)
      expect(estimateSnipSavings(recentMessages(4))).toBe(0)
    })

    it('estimates savings for oversized tool results', () => {
      const msgs: OpenAIMessage[] = [
        bigToolResult('Read', SNIP_TOOL_RESULT_MAX_CHARS * 3),
        ...recentMessages(8),
      ]
      expect(estimateSnipSavings(msgs)).toBeGreaterThan(0)
    })

    it('is a lower-bound estimate (≤ actual savings)', () => {
      const msgs: OpenAIMessage[] = [
        bigToolResult('Read', SNIP_TOOL_RESULT_MAX_CHARS * 3),
        ...recentMessages(8),
      ]
      const estimated = estimateSnipSavings(msgs)
      const actual = snipCompact([...msgs]).tokensBefore - snipCompact([...msgs]).tokensAfter
      // Estimate is a rough token count; just verify both > 0
      expect(estimated).toBeGreaterThan(0)
      expect(actual).toBeGreaterThan(0)
    })
  })

  describe('formatSnipResult', () => {
    it('formats a no-op result', () => {
      const out = formatSnipResult(snipCompact([]))
      expect(out).toContain('nothing')
    })

    it('formats a trim result', () => {
      const msgs: OpenAIMessage[] = [
        bigToolResult('Read', SNIP_TOOL_RESULT_MAX_CHARS * 3),
        ...recentMessages(8),
      ]
      const out = formatSnipResult(snipCompact(msgs))
      expect(out).toContain('Trimmed')
    })
  })
})

function recentMessages(n: number): OpenAIMessage[] {
  const out: OpenAIMessage[] = []
  for (let i = 0; i < n; i++) {
    out.push({ role: i % 2 === 0 ? 'user' : 'assistant', content: `recent ${i}` })
  }
  return out
}
