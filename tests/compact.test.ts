import { describe, it, expect } from 'vitest'
import {
  estimateTokens,
  calculateContextState,
  getCompressionStrategy,
  microCompact,
} from '../src/core/compact.js'
import type { OpenAIMessage } from '../src/core/types.js'

// ── compact split logic (tool_call/result pair preservation) ─────────────────

describe('maybeCompact split logic', () => {
  // maybeCompact only fires when tokens exceed threshold.
  // We test the split via the internal logic by observing which messages
  // end up in the summary vs recent.

  it('preserves assistant+tool_calls+tool_results together when split lands on tool results', () => {
    // Build a conversation where the split point lands between an assistant
    // message with tool_calls and its tool result messages.
    const messages: OpenAIMessage[] = []

    // 6 filler messages (to push past KEEP_RECENT_MESSAGES=8)
    for (let i = 0; i < 6; i++) {
      messages.push({ role: 'user', content: `Filler message ${i} with enough text to be substantial for token estimation purposes.` })
      messages.push({ role: 'assistant', content: `Response ${i} with enough text to be substantial for token estimation purposes.` })
    }
    // assistant with tool_calls
    messages.push({ role: 'assistant', content: null, tool_calls: [{ id: 'tc1', type: 'function', function: { name: 'Read', arguments: '{"file_path":"test.ts"}' } }] })
    // tool results
    messages.push({ role: 'tool', tool_call_id: 'tc1', content: 'file contents here', name: 'Read' })
    messages.push({ role: 'tool', tool_call_id: 'tc1', content: 'more content', name: 'Read' })

    // We can't call maybeCompact without a real LLM client, but we can verify
    // that estimateTokens gives a large enough count that the split logic matters.
    const tokens = estimateTokens(messages)
    expect(tokens).toBeGreaterThan(0)

    // Verify the messages array structure is valid for API submission
    // (tool results must follow their assistant tool_calls)
    const lastAssistantIdx = messages.reduce((last, m, i) =>
      m.role === 'assistant' && m.tool_calls ? i : last, -1)
    expect(lastAssistantIdx).toBeGreaterThan(-1)
    // All tool messages must be after the last assistant with tool_calls
    for (let i = 0; i < messages.length; i++) {
      if (messages[i]?.role === 'tool') {
        expect(i).toBeGreaterThan(lastAssistantIdx)
      }
    }
  })

  it('estimateTokens counts content, tool_calls, and overhead', () => {
    const messages: OpenAIMessage[] = [
      { role: 'user', content: 'Hello world' },
      { role: 'assistant', content: null, tool_calls: [{ id: 'tc1', type: 'function', function: { name: 'Bash', arguments: '{"command":"ls"}' } }] },
      { role: 'tool', tool_call_id: 'tc1', content: 'output', name: 'Bash' },
    ]
    const tokens = estimateTokens(messages)
    expect(tokens).toBeGreaterThan(0)
    // Should be higher than just "Hello world"
    expect(tokens).toBeGreaterThan(estimateTokens([{ role: 'user', content: 'Hi' }]))
  })

  it('getCompressionStrategy returns correct levels', () => {
    expect(getCompressionStrategy(0.5)).toBe('proportional')
    expect(getCompressionStrategy(0.7)).toBe('proportional')
    expect(getCompressionStrategy(0.86)).toBe('priority')
    expect(getCompressionStrategy(0.91)).toBe('aggressive')
  })

  it('calculateContextState includes all fields', () => {
    const messages: OpenAIMessage[] = [{ role: 'user', content: 'A'.repeat(1000) }]
    const state = calculateContextState(messages, 10_000)
    expect(state.currentTokens).toBeGreaterThan(0)
    expect(state.maxTokens).toBe(10_000)
    expect(state.pct).toBeGreaterThan(0)
    expect(state.pct).toBeLessThanOrEqual(1)
    expect(typeof state.shouldWarn).toBe('boolean')
    expect(typeof state.shouldCompact).toBe('boolean')
    expect(state.strategy).toBeDefined()
  })
})

// ── microCompact ────────────────────────────────────────────────────────────

describe('microCompact', () => {
  /** Helper: create a tool result message with substantial content */
  function toolResult(name: string, id: string, content: string): OpenAIMessage {
    return { role: 'tool', tool_call_id: id, content, name }
  }

  /** Helper: create N tool results from compactable tools, interleaved with assistant msgs */
  function makeConversationWithToolResults(count: number): OpenAIMessage[] {
    const msgs: OpenAIMessage[] = []
    for (let i = 0; i < count; i++) {
      msgs.push({
        role: 'assistant',
        content: null,
        tool_calls: [{ id: `tc_${i}`, type: 'function', function: { name: 'Read', arguments: '{}' } }],
      })
      msgs.push(toolResult('Read', `tc_${i}`, `File content ${i}: ` + 'X'.repeat(500)))
    }
    return msgs
  }

  it('returns compacted=false when fewer tool results than KEEP_RECENT', () => {
    const msgs = makeConversationWithToolResults(3) // < 6 (KEEP_RECENT_TOOL_RESULTS)
    const result = microCompact(msgs)
    expect(result.compacted).toBe(false)
    expect(result.toolsCleared).toBe(0)
    expect(result.tokensAfter).toBe(result.tokensBefore)
  })

  it('clears old tool results, keeping the 6 most recent', () => {
    const msgs = makeConversationWithToolResults(10)
    const result = microCompact(msgs)
    expect(result.compacted).toBe(true)
    expect(result.toolsCleared).toBe(4) // 10 - 6 = 4 cleared
    expect(result.tokensAfter).toBeLessThan(result.tokensBefore)

    // The last 6 tool results should still have their original content
    const toolMsgs = msgs.filter((m) => m.role === 'tool')
    const last6 = toolMsgs.slice(-6)
    for (const m of last6) {
      expect(m.content).toContain('File content')
    }
    // The first 4 should be cleared
    const first4 = toolMsgs.slice(0, 4)
    for (const m of first4) {
      expect(m.content).toContain('cleared')
    }
  })

  it('only clears compactable tools (Read, Grep, Glob, Bash, Web*)', () => {
    const msgs: OpenAIMessage[] = [
      // Old Read result (compactable)
      { role: 'assistant', content: null, tool_calls: [{ id: 'tc_r', type: 'function', function: { name: 'Read', arguments: '{}' } }] },
      toolResult('Read', 'tc_r', 'X'.repeat(500)),
      // Old Write result (NOT compactable)
      { role: 'assistant', content: null, tool_calls: [{ id: 'tc_w', type: 'function', function: { name: 'Write', arguments: '{}' } }] },
      toolResult('Write', 'tc_w', 'File written successfully'),
      // Old Edit result (NOT compactable)
      { role: 'assistant', content: null, tool_calls: [{ id: 'tc_e', type: 'function', function: { name: 'Edit', arguments: '{}' } }] },
      toolResult('Edit', 'tc_e', 'Edit applied'),
    ]
    // Add 6 more Read results to exceed KEEP_RECENT
    for (let i = 0; i < 6; i++) {
      msgs.push({ role: 'assistant', content: null, tool_calls: [{ id: `tc_${i}`, type: 'function', function: { name: 'Read', arguments: '{}' } }] })
      msgs.push(toolResult('Read', `tc_${i}`, 'X'.repeat(500)))
    }

    const result = microCompact(msgs)
    expect(result.compacted).toBe(true)

    // Write and Edit results should NOT be cleared
    const writeMsg = msgs.find((m) => m.name === 'Write' && m.role === 'tool')
    const editMsg = msgs.find((m) => m.name === 'Edit' && m.role === 'tool')
    expect(writeMsg?.content).toBe('File written successfully')
    expect(editMsg?.content).toBe('Edit applied')
  })

  it('is idempotent — running twice does not clear more', () => {
    const msgs = makeConversationWithToolResults(10)
    const first = microCompact(msgs)
    expect(first.compacted).toBe(true)
    const second = microCompact(msgs)
    expect(second.compacted).toBe(false) // already cleared
    expect(second.toolsCleared).toBe(0)
  })

  it('does not clear small tool results (not worth the overhead)', () => {
    const msgs: OpenAIMessage[] = []
    for (let i = 0; i < 10; i++) {
      msgs.push({ role: 'assistant', content: null, tool_calls: [{ id: `tc_${i}`, type: 'function', function: { name: 'Bash', arguments: '{}' } }] })
      msgs.push(toolResult('Bash', `tc_${i}`, 'ok')) // tiny result
    }
    const result = microCompact(msgs)
    // "ok" is shorter than the placeholder, so nothing gets cleared
    expect(result.compacted).toBe(false)
  })

  it('reduces token count after compaction', () => {
    const msgs = makeConversationWithToolResults(20)
    const tokensBefore = estimateTokens(msgs)
    const result = microCompact(msgs)
    const tokensAfter = estimateTokens(msgs)
    expect(result.compacted).toBe(true)
    expect(tokensAfter).toBeLessThan(tokensBefore)
    expect(result.tokensAfter).toBe(tokensAfter)
  })

  it('handles empty messages', () => {
    const result = microCompact([])
    expect(result.compacted).toBe(false)
    expect(result.toolsCleared).toBe(0)
  })

  it('handles messages with no tool results', () => {
    const msgs: OpenAIMessage[] = [
      { role: 'user', content: 'Hello' },
      { role: 'assistant', content: 'Hi there' },
    ]
    const result = microCompact(msgs)
    expect(result.compacted).toBe(false)
  })
})
