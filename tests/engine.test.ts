import { describe, it, expect } from 'vitest'
import { partitionToolCalls } from '../src/core/toolRuntime/toolScheduler.js'
import {
  calculateContextState,
  estimateTokens,
  getCompressionStrategy,
  MODEL_MAX_CONTEXT_TOKENS,
} from '../src/core/compact.js'
import { parseCriticOutput, formatMessagesForCritic } from '../src/prompts/critic.js'

// ── partitionToolCalls ──────────────────────────────────────────────────────

function makeParsedToolCall(
  name: string,
  args: Record<string, unknown> = {},
): { tc: { index: number; id: string; name: string; arguments: string }; input: Record<string, unknown> } {
  return {
    tc: { index: 0, id: `tc_${name}`, name, arguments: JSON.stringify(args) },
    input: args,
  }
}

describe('partitionToolCalls', () => {
  it('groups safe tools into a single parallel batch', () => {
    const calls = [
      makeParsedToolCall('Read', { file_path: 'a.ts' }),
      makeParsedToolCall('Glob', { pattern: '*.ts' }),
      makeParsedToolCall('Grep', { pattern: 'foo' }),
    ]

    const batches = partitionToolCalls(calls)
    expect(batches).toHaveLength(1)
    expect(batches[0].safe).toBe(true)
    expect(batches[0].calls).toHaveLength(3)
  })

  it('separates Write/Edit into their own serial batches', () => {
    const calls = [
      makeParsedToolCall('Read', { file_path: 'a.ts' }),
      makeParsedToolCall('Write', { file_path: 'b.ts', content: 'hello' }),
      makeParsedToolCall('Glob', { pattern: '*.ts' }),
    ]

    const batches = partitionToolCalls(calls)
    // Read is safe (batch 1), Write is unsafe (batch 2), Glob is safe but
    // follows unsafe so it starts a new batch (batch 3)
    expect(batches).toHaveLength(3)
    expect(batches[0].safe).toBe(true)
    expect(batches[1].safe).toBe(false)
    expect(batches[2].safe).toBe(true)
  })

  it('merges consecutive safe tool calls into one batch', () => {
    const calls = [
      makeParsedToolCall('Read', { file_path: 'a.ts' }),
      makeParsedToolCall('Glob', { pattern: '*.ts' }),
      makeParsedToolCall('WebFetch', { url: 'http://example.com' }),
    ]

    const batches = partitionToolCalls(calls)
    expect(batches).toHaveLength(1)
    expect(batches[0].safe).toBe(true)
  })

  it('handles empty input', () => {
    const batches = partitionToolCalls([])
    expect(batches).toHaveLength(0)
  })

  it('puts Bash in parallel batch (per design: dependent ops use &&)', () => {
    const calls = [
      makeParsedToolCall('Read', { file_path: 'a.ts' }),
      makeParsedToolCall('Bash', { command: 'ls' }),
    ]

    const batches = partitionToolCalls(calls)
    expect(batches).toHaveLength(1)
    expect(batches[0].safe).toBe(true)
  })

  it('starts new batch when unsafe tool interrupts safe sequence', () => {
    const calls = [
      makeParsedToolCall('Read', { file_path: 'a.ts' }),
      makeParsedToolCall('Edit', { file_path: 'a.ts', old_string: 'foo', new_string: 'bar' }),
      makeParsedToolCall('Read', { file_path: 'b.ts' }),
      makeParsedToolCall('Edit', { file_path: 'b.ts', old_string: 'x', new_string: 'y' }),
    ]

    const batches = partitionToolCalls(calls)
    // Read(safe) → Edit(unsafe) → Read(safe) → Edit(unsafe)
    expect(batches).toHaveLength(4)
  })
})

// ── estimateTokens / calculateContextState ──────────────────────────────────

describe('estimateTokens', () => {
  it('returns 0 for empty messages', () => {
    expect(estimateTokens([])).toBe(0)
  })

  it('estimates tokens for simple text messages', () => {
    const messages = [
      { role: 'user' as const, content: 'Hello world' },
    ]
    // "Hello world" = 11 chars + 20 envelope = 31 chars / 3.5 ≈ 9 tokens
    const tokens = estimateTokens(messages)
    expect(tokens).toBeGreaterThan(0)
    expect(tokens).toBeLessThan(20)
  })

  it('accounts for tool_calls JSON overhead', () => {
    const messages = [
      {
        role: 'assistant' as const,
        content: null,
        tool_calls: [
          {
            id: 'tc_1',
            type: 'function' as const,
            function: { name: 'Read', arguments: '{"file_path":"test.ts"}' },
          },
        ],
      },
    ]
    const tokens = estimateTokens(messages)
    expect(tokens).toBeGreaterThan(0)
  })

  it('estimates more tokens for longer content', () => {
    const short = [{ role: 'user' as const, content: 'Hi' }]
    const long = [{ role: 'user' as const, content: 'A'.repeat(1000) }]
    expect(estimateTokens(long)).toBeGreaterThan(estimateTokens(short))
  })
})

describe('calculateContextState', () => {
  it('calculates percentage correctly', () => {
    const messages = [{ role: 'user' as const, content: 'A'.repeat(7000) }]
    const maxTokens = 10000
    const state = calculateContextState(messages, maxTokens)
    expect(state.maxTokens).toBe(maxTokens)
    expect(state.pct).toBeGreaterThan(0)
    expect(state.pct).toBeLessThanOrEqual(1)
  })

  it('should warn at 70%', () => {
    // 70% of 200k = 140k tokens
    const charsNeeded = Math.ceil(140000 * 3.5 - 20) // minus envelope overhead
    const messages = [{ role: 'user' as const, content: 'A'.repeat(charsNeeded) }]
    const state = calculateContextState(messages, MODEL_MAX_CONTEXT_TOKENS)
    expect(state.shouldWarn).toBe(true)
  })

  it('should compact at 85%', () => {
    // 85% of 200k = 170k tokens
    const charsNeeded = Math.ceil(170000 * 3.5 - 20)
    const messages = [{ role: 'user' as const, content: 'A'.repeat(charsNeeded) }]
    const state = calculateContextState(messages, MODEL_MAX_CONTEXT_TOKENS)
    expect(state.shouldCompact).toBe(true)
  })

  it('does not warn or compact under thresholds', () => {
    const messages = [{ role: 'user' as const, content: 'short message' }]
    const state = calculateContextState(messages, MODEL_MAX_CONTEXT_TOKENS)
    expect(state.shouldWarn).toBe(false)
    expect(state.shouldCompact).toBe(false)
  })
})

// ── getCompressionStrategy ──────────────────────────────────────────────────

describe('getCompressionStrategy', () => {
  it('returns proportional under 85%', () => {
    expect(getCompressionStrategy(0.5)).toBe('proportional')
    expect(getCompressionStrategy(0.7)).toBe('proportional')
    expect(getCompressionStrategy(0.84)).toBe('proportional')
  })

  it('returns priority at 85%+', () => {
    expect(getCompressionStrategy(0.86)).toBe('priority')
    expect(getCompressionStrategy(0.9)).toBe('priority')
  })

  it('returns aggressive at 90%+', () => {
    expect(getCompressionStrategy(0.91)).toBe('aggressive')
    expect(getCompressionStrategy(0.99)).toBe('aggressive')
  })
})

// ── Critic ──────────────────────────────────────────────────────────────────

describe('parseCriticOutput', () => {
  it('returns null for OK response', () => {
    expect(parseCriticOutput('OK')).toBeNull()
    expect(parseCriticOutput('ok')).toBeNull()
    expect(parseCriticOutput('  OK  ')).toBeNull()
  })

  it('returns null for empty response', () => {
    expect(parseCriticOutput('')).toBeNull()
  })

  it('returns the output for non-OK responses', () => {
    const output = '[问题] 重复劳动\n[纠正] 换个策略'
    expect(parseCriticOutput(output)).toBe(output)
  })

  it('trims whitespace from response', () => {
    const output = '[问题] something'
    expect(parseCriticOutput('  ' + output + '  ')).toBe(output)
  })
})

describe('formatMessagesForCritic', () => {
  it('formats assistant messages correctly', () => {
    const messages = [{ role: 'assistant' as const, content: 'Hello' }]
    const formatted = formatMessagesForCritic(messages)
    expect(formatted).toContain('[ASSISTANT]')
    expect(formatted).toContain('Hello')
  })

  it('formats tool results with truncation', () => {
    const longResult = 'A'.repeat(1000)
    const messages = [
      { role: 'tool' as const, content: longResult, name: 'Bash' },
    ]
    const formatted = formatMessagesForCritic(messages)
    expect(formatted).toContain('[TOOL_RESULT:Bash]')
    expect(formatted.length).toBeLessThan(longResult.length)
  })

  it('formats user messages', () => {
    const messages = [{ role: 'user' as const, content: 'Do something' }]
    const formatted = formatMessagesForCritic(messages)
    expect(formatted).toContain('[USER]')
    expect(formatted).toContain('Do something')
  })

  it('handles empty input', () => {
    expect(formatMessagesForCritic([])).toBe('')
  })

  it('formats assistant messages with tool calls', () => {
    const messages = [
      {
        role: 'assistant' as const,
        content: 'Let me check',
        tool_calls: [
          {
            id: 'tc_1',
            type: 'function' as const,
            function: { name: 'Read', arguments: '{"file_path":"test.ts"}' },
          },
        ],
      },
    ]
    const formatted = formatMessagesForCritic(messages)
    expect(formatted).toContain('[ASSISTANT]')
    expect(formatted).toContain('Let me check')
    expect(formatted).toContain('[TOOL_CALL]')
    expect(formatted).toContain('Read')
  })
})
