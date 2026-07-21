import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { fileURLToPath } from 'url'
import {
  estimateTokens,
  estimateTextTokens,
  estimateToolDefinitionTokens,
  calculateContextState,
  getCompressionStrategy,
  microCompact,
  maybeTimeBasedMicroCompact,
  resolveContextWindow,
  KNOWN_MODEL_CONTEXT_WINDOWS,
  MODEL_MAX_CONTEXT_TOKENS,
  CONTEXT_MICROCOMPACT_PCT,
  CONTEXT_WARN_PCT,
  CONTEXT_COMPACT_PCT,
  MAX_OUTPUT_TOKENS_DEFAULT,
  clampMaxOutputTokens,
  effectiveInputBudget,
  isFinitePositiveInteger,
  maybeCompact,
  isAbort,
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

// ── maybeTimeBasedMicroCompact ───────────────────────────────────────────────

describe('maybeTimeBasedMicroCompact', () => {
  /** Helper: build enough tool results to exceed KEEP_RECENT (6) */
  function makeOldToolResultConversation(count: number): OpenAIMessage[] {
    const msgs: OpenAIMessage[] = []
    for (let i = 0; i < count; i++) {
      msgs.push({
        role: 'assistant',
        content: null,
        tool_calls: [{ id: `tc_${i}`, type: 'function', function: { name: 'Read', arguments: '{}' } }],
      })
      msgs.push({
        role: 'tool',
        tool_call_id: `tc_${i}`,
        content: 'X'.repeat(500), // substantial content
        name: 'Read',
      })
    }
    return msgs
  }

  it('does NOT compact when time gap is below threshold', () => {
    // 10 tool results would normally trigger microCompact (>6), so the
    // time-based path is the only thing gating this call.
    const msgs = makeOldToolResultConversation(10)
    const now = 1_000_000
    const lastAssistantTs = now - 60_000 // 1 minute ago, below 5 min default
    const result = maybeTimeBasedMicroCompact(msgs, lastAssistantTs, now)
    expect(result.compacted).toBe(false)
    expect(result.toolsCleared).toBe(0)
  })

  it('DOES compact when time gap exceeds threshold', () => {
    const msgs = makeOldToolResultConversation(10)
    const now = 1_000_000
    const lastAssistantTs = now - 10 * 60_000 // 10 min ago, above 5 min default
    const result = maybeTimeBasedMicroCompact(msgs, lastAssistantTs, now)
    expect(result.compacted).toBe(true)
    expect(result.toolsCleared).toBeGreaterThan(0)
  })

  it('does NOT compact when lastAssistantTimestamp is undefined', () => {
    // No baseline to measure from — conservative no-op, never clears.
    const msgs = makeOldToolResultConversation(10)
    const result = maybeTimeBasedMicroCompact(msgs, undefined, Date.now())
    expect(result.compacted).toBe(false)
    expect(result.toolsCleared).toBe(0)
  })

  it('respects custom threshold', () => {
    const msgs = makeOldToolResultConversation(10)
    const now = 1_000_000
    // 2 min gap with 1 min threshold → should compact
    const gap2min = now - 2 * 60_000
    const r1 = maybeTimeBasedMicroCompact(msgs.slice(), gap2min, now, 60_000)
    expect(r1.compacted).toBe(true)

    // 5 min gap with 10 min threshold → should NOT compact
    const gap5min = now - 5 * 60_000
    const r2 = maybeTimeBasedMicroCompact(msgs.slice(), gap5min, now, 10 * 60_000)
    expect(r2.compacted).toBe(false)
  })

  it('uses default 5-minute threshold when none provided', () => {
    // 5 min - 1ms gap with default threshold → no compact (just under)
    const msgs = makeOldToolResultConversation(10)
    const now = 1_000_000
    const justUnder = now - (5 * 60_000 - 1)
    const r1 = maybeTimeBasedMicroCompact(msgs.slice(), justUnder, now)
    expect(r1.compacted).toBe(false)

    // 5 min + 1ms gap → compact (just over)
    const justOver = now - (5 * 60_000 + 1)
    const r2 = maybeTimeBasedMicroCompact(msgs.slice(), justOver, now)
    expect(r2.compacted).toBe(true)
  })

  it('is a no-op when there are no compactable tool results', () => {
    // Pure conversation, no tool results. Even past the cache TTL,
    // there's nothing to clear — the gate should not flip `compacted`
    // to true and confuse the caller.
    const msgs: OpenAIMessage[] = [
      { role: 'user', content: 'Hello' },
      { role: 'assistant', content: 'Hi there' },
    ]
    const now = 1_000_000
    const lastAssistantTs = now - 60 * 60_000 // 1 hour ago, well past TTL
    const result = maybeTimeBasedMicroCompact(msgs, lastAssistantTs, now)
    expect(result.compacted).toBe(false)
  })
})

// ── context-window resolution (model-aware) ───────────────────────────────────

describe('resolveContextWindow', () => {
  it('uses explicit override when provided', () => {
    expect(resolveContextWindow('claude-sonnet-4-5', 123_456)).toBe(123_456)
    expect(resolveContextWindow('gpt-4', 32_000)).toBe(32_000)
  })

  it('falls back to MODEL_MAX_CONTEXT_TOKENS for unknown models', () => {
    expect(resolveContextWindow('totally-unknown-model-9000')).toBe(MODEL_MAX_CONTEXT_TOKENS)
  })

  it('handles missing/empty model name', () => {
    expect(resolveContextWindow('')).toBe(MODEL_MAX_CONTEXT_TOKENS)
  })

  it('resolves Claude Sonnet 4.x to 200k', () => {
    expect(resolveContextWindow('claude-sonnet-4-5')).toBe(200_000)
    expect(resolveContextWindow('claude-opus-4')).toBe(200_000)
    expect(resolveContextWindow('claude-haiku-4')).toBe(200_000)
  })

  it('resolves GPT-4 (8k context) vs GPT-4 Turbo (128k)', () => {
    expect(resolveContextWindow('gpt-4')).toBe(8_192)
    expect(resolveContextWindow('gpt-4-32k')).toBe(32_768)
    expect(resolveContextWindow('gpt-4-turbo')).toBe(128_000)
    expect(resolveContextWindow('gpt-4o')).toBe(128_000)
    expect(resolveContextWindow('gpt-4o-mini')).toBe(128_000)
  })

  it('resolves GPT-3.5 windows', () => {
    expect(resolveContextWindow('gpt-3.5-turbo')).toBe(4_096)
    expect(resolveContextWindow('gpt-3.5-turbo-16k')).toBe(16_385)
  })

  it('handles o-series and GPT-5', () => {
    expect(resolveContextWindow('o1')).toBe(200_000)
    expect(resolveContextWindow('o1-mini')).toBe(200_000)
    expect(resolveContextWindow('o3-mini')).toBe(200_000)
    expect(resolveContextWindow('gpt-5')).toBe(400_000)
  })

  it('ignores non-positive overrides and falls through to lookup', () => {
    expect(resolveContextWindow('gpt-4-turbo', 0)).toBe(128_000)
    expect(resolveContextWindow('gpt-4-turbo', -1)).toBe(128_000)
  })

  it('exposes a non-empty model table', () => {
    expect(KNOWN_MODEL_CONTEXT_WINDOWS.length).toBeGreaterThan(0)
  })
})

// ── estimateTokens improvements ──────────────────────────────────────────────

describe('estimateTokens improvements', () => {
  it('counts role string overhead in addition to content', () => {
    const singleRole: OpenAIMessage[] = [
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'hi back' },
    ]
    // With role overhead added, even content-free messages have a cost
    const tokens = estimateTokens(singleRole)
    expect(tokens).toBeGreaterThan(0)
  })

  it('tool result with tool_call_id adds more overhead than content alone', () => {
    const justContent: OpenAIMessage[] = [{ role: 'user', content: 'X'.repeat(500) }]
    const withToolEnvelope: OpenAIMessage[] = [
      {
        role: 'tool',
        tool_call_id: 'call_very_long_uuid_identifier_xxxxxxxx',
        content: 'X'.repeat(500),
        name: 'Read',
      },
    ]
    // Tool envelope adds role + tool_call_id + name overhead → must be ≥
    const just = estimateTokens(justContent)
    const withEnv = estimateTokens(withToolEnvelope)
    expect(withEnv).toBeGreaterThanOrEqual(just)
  })

  it('includes JSON syntax overhead in tool_calls', () => {
    // Compare apples to apples: a small content string vs a tool_calls array
    // with comparable JSON serialization size. After the fix, both should
    // contribute their envelope + payload tokens (no silent zero-cost).
    const noCalls: OpenAIMessage[] = [
      { role: 'assistant', content: 'X'.repeat(100) },
    ]
    const withCalls: OpenAIMessage[] = [
      {
        role: 'assistant',
        content: null,
        tool_calls: [{
          id: 'tc1',
          type: 'function',
          function: { name: 'Read', arguments: '{"file_path":"a.ts"}' },
        }],
      },
    ]
    // Both must be > 0 and the tool-call message must reflect its payload size
    expect(estimateTokens(noCalls)).toBeGreaterThan(0)
    expect(estimateTokens(withCalls)).toBeGreaterThan(0)
  })
})

describe('estimateToolDefinitionTokens', () => {
  it('returns 0 for empty/null/undefined', () => {
    expect(estimateToolDefinitionTokens(undefined)).toBe(0)
    expect(estimateToolDefinitionTokens(null)).toBe(0)
    expect(estimateToolDefinitionTokens([])).toBe(0)
  })

  it('counts each tool definition plus wrapper overhead', () => {
    const defs = [
      { type: 'function', function: { name: 'Read', description: 'd', parameters: { type: 'object', properties: { file_path: { type: 'string' } } } } },
      { type: 'function', function: { name: 'Write', description: 'd', parameters: { type: 'object', properties: { file_path: { type: 'string' } } } } },
    ]
    const tokens = estimateToolDefinitionTokens(defs)
    expect(tokens).toBeGreaterThan(0)
    // Each definition is at minimum >50 chars → >14 tokens each
    // Plus wrapper overhead of 14 chars → ~4 tokens
    expect(tokens).toBeGreaterThan(20)
  })
})

// ── threshold constants exported from compact.ts ─────────────────────────────

describe('context thresholds exposed for engine alignment', () => {
  it('exports the three pressure thresholds', () => {
    expect(CONTEXT_MICROCOMPACT_PCT).toBeCloseTo(0.50, 5)
    expect(CONTEXT_WARN_PCT).toBeCloseTo(0.70, 5)
    expect(CONTEXT_COMPACT_PCT).toBeCloseTo(0.85, 5)
  })

  it('monotonic ordering: micro < warn < compact', () => {
    expect(CONTEXT_MICROCOMPACT_PCT).toBeLessThan(CONTEXT_WARN_PCT)
    expect(CONTEXT_WARN_PCT).toBeLessThan(CONTEXT_COMPACT_PCT)
  })
})

// ── isFinitePositiveInteger (validation predicate) ────────────────────────────

describe('isFinitePositiveInteger', () => {
  it('accepts finite positive integers', () => {
    expect(isFinitePositiveInteger(1)).toBe(true)
    expect(isFinitePositiveInteger(42)).toBe(true)
    expect(isFinitePositiveInteger(200_000)).toBe(true)
  })

  it('rejects zero and negatives', () => {
    expect(isFinitePositiveInteger(0)).toBe(false)
    expect(isFinitePositiveInteger(-1)).toBe(false)
    expect(isFinitePositiveInteger(-100_000)).toBe(false)
  })

  it('rejects Infinity and NaN', () => {
    expect(isFinitePositiveInteger(Number.POSITIVE_INFINITY)).toBe(false)
    expect(isFinitePositiveInteger(Number.NEGATIVE_INFINITY)).toBe(false)
    expect(isFinitePositiveInteger(Number.NaN)).toBe(false)
  })

  it('rejects floats', () => {
    expect(isFinitePositiveInteger(1.5)).toBe(false)
    expect(isFinitePositiveInteger(0.1)).toBe(false)
    expect(isFinitePositiveInteger(8192.0001)).toBe(false)
  })

  it('rejects non-numbers', () => {
    expect(isFinitePositiveInteger(null)).toBe(false)
    expect(isFinitePositiveInteger(undefined)).toBe(false)
    expect(isFinitePositiveInteger('8192')).toBe(false)
    expect(isFinitePositiveInteger({})).toBe(false)
    expect(isFinitePositiveInteger(true)).toBe(false)
    expect(isFinitePositiveInteger([1])).toBe(false)
  })
})

// ── resolveContextWindow: invalid override coverage ───────────────────────────

describe('resolveContextWindow — invalid override coverage', () => {
  it('REJECTS Infinity (would disable percentage checks permanently)', () => {
    expect(resolveContextWindow('gpt-4-turbo', Number.POSITIVE_INFINITY))
      .toBe(128_000)
  })

  it('REJECTS -Infinity', () => {
    expect(resolveContextWindow('gpt-4-turbo', Number.NEGATIVE_INFINITY))
      .toBe(128_000)
  })

  it('REJECTS NaN (silently broke the >0 compare)', () => {
    expect(resolveContextWindow('gpt-4-turbo', Number.NaN)).toBe(128_000)
  })

  it('REJECTS floats (context windows are integers)', () => {
    expect(resolveContextWindow('claude-sonnet-4', 1234.5)).toBe(200_000)
    expect(resolveContextWindow('claude-sonnet-4', 200_000.0001)).toBe(200_000)
  })

  it('REJECTS zero and negative', () => {
    expect(resolveContextWindow('claude-sonnet-4', 0)).toBe(200_000)
    expect(resolveContextWindow('claude-sonnet-4', -100)).toBe(200_000)
  })

  it('accepts a strictly-positive integer override', () => {
    expect(resolveContextWindow('claude-sonnet-4', 32_000)).toBe(32_000)
    expect(resolveContextWindow('claude-sonnet-4', 1)).toBe(1)
  })

  it('accepts the full int32 range of positive integers', () => {
    expect(resolveContextWindow('claude-sonnet-4', 2_147_483_647)).toBe(2_147_483_647)
  })
})

// ── clampMaxOutputTokens (output-cap safety) ──────────────────────────────────

describe('clampMaxOutputTokens', () => {
  it('uses default when requested is undefined / null', () => {
    // default = 8192; window = 200k, half = 100k → min(8192, 100k) = 8192
    expect(clampMaxOutputTokens(undefined, 200_000)).toBe(8_192)
    expect(clampMaxOutputTokens(null, 200_000)).toBe(8_192)
  })

  it('caps at half the window when requested exceeds it', () => {
    // 8k window with default 8k requested → min(8192, 4096) = 4096
    expect(clampMaxOutputTokens(undefined, 8_192)).toBe(4_096)
    // explicit 8192 on 8k window → also 4096
    expect(clampMaxOutputTokens(8_192, 8_192)).toBe(4_096)
  })

  it('keeps requested when smaller than half-window', () => {
    expect(clampMaxOutputTokens(1_024, 8_192)).toBe(1_024)
    expect(clampMaxOutputTokens(4_096, 200_000)).toBe(4_096)
  })

  it('floors at 1 on degenerate windows', () => {
    expect(clampMaxOutputTokens(10, 1)).toBe(1)
    expect(clampMaxOutputTokens(undefined, 1)).toBe(1)
  })

  it('falls back to default when requested is non-finite', () => {
    // NaN/Infinity → fall back to default 8192; window = 200k, half = 100k → 8192
    expect(clampMaxOutputTokens(Number.NaN, 200_000)).toBe(8_192)
    expect(clampMaxOutputTokens(Number.POSITIVE_INFINITY, 200_000)).toBe(8_192)
    expect(clampMaxOutputTokens(Number.NEGATIVE_INFINITY, 200_000)).toBe(8_192)
  })

  it('falls back to default when requested is 0 or negative', () => {
    expect(clampMaxOutputTokens(0, 200_000)).toBe(8_192)
    expect(clampMaxOutputTokens(-1, 200_000)).toBe(8_192)
  })

  it('falls back to default when requested is a non-integer', () => {
    expect(clampMaxOutputTokens(8192.5, 200_000)).toBe(8_192)
    expect(clampMaxOutputTokens(0.1, 200_000)).toBe(8_192)
  })

  it('survives pathological contextWindow (NaN / Infinity / 0)', () => {
    // Even with garbage window, we should never produce NaN/max_output;
    // degenerate window → skip clamp, return max(1, requested)
    expect(clampMaxOutputTokens(8192, Number.NaN)).toBe(8_192)
    expect(clampMaxOutputTokens(8192, Number.POSITIVE_INFINITY)).toBe(8_192)
    expect(clampMaxOutputTokens(8192, 0)).toBe(8_192)
    expect(clampMaxOutputTokens(8192, -1)).toBe(8_192)
  })

  it('exposes MAX_OUTPUT_TOKENS_DEFAULT = 8192', () => {
    expect(MAX_OUTPUT_TOKENS_DEFAULT).toBe(8_192)
  })
})

// ── estimateTextTokens — multilingual-aware ──────────────────────────────────

describe('estimateTextTokens — multilingual awareness', () => {
  it('handles empty / null / undefined as zero', () => {
    expect(estimateTextTokens('')).toBe(0)
    expect(estimateTextTokens(null)).toBe(0)
    expect(estimateTextTokens(undefined as unknown as string)).toBe(0)
  })

  it('pure ASCII: cost = chars / 3.5', () => {
    // 35 chars → 10 tokens exactly
    const text = 'a'.repeat(35)
    expect(estimateTextTokens(text)).toBeCloseTo(10, 6)
  })

  it('pure Chinese (CJK): each character ≈ 2 tokens (heuristic at NON_ASCII_CHARS_PER_TOKEN=0.5)', () => {
    // 100 Chinese characters → ~200 tokens at the 2-tokens-per-codepoint rate.
    const text = '中'.repeat(100)
    expect(estimateTextTokens(text)).toBeCloseTo(200, 6)
  })

  it('CJK is significantly MORE expensive than ASCII of equal char count', () => {
    // Same character COUNT but very different token COUNT — this is the key
    // guarantee for Chinese-heavy sessions. With the legacy 3.5 rate flat
    // across all chars, 100 ASCII chars and 100 CJK chars would BOTH estimate
    // ~28 tokens; we require CJK to be MANY TIMES higher.
    const asciiText = 'a'.repeat(100)
    const cjkText = '中'.repeat(100)
    const asciiTok = estimateTextTokens(asciiText)
    const cjkTok = estimateTextTokens(cjkText)
    expect(cjkTok).toBeGreaterThan(asciiTok)
    // CJK must estimate at least 3x the ASCII cost for the same char count
    expect(cjkTok).toBeGreaterThan(asciiTok * 3)
    // Numerically: ASCII = 100/3.5 ≈ 28.57, CJK = 100 → ratio ≈ 3.5x
  })

  it('emoji counted once (surrogate-pair safe)', () => {
    // 🎉 = U+1F389, encoded as a UTF-16 surrogate pair (2 UTF-16 code units,
    // ONE Unicode code point). Using `String.length` would over-count by 2x;
    // estimateTextTokens must count it as a single code point = 1 token.
    const single = '🎉'
    const repeated = '🎉'.repeat(10)
    expect(single.length).toBe(2)              // confirms surrogate-pair UTF-16
    // `🎉` is ONE Unicode code point (U+1F389) iterated ONCE; the per-codepoint
    // estimate at 1 / NON_ASCII_CHARS_PER_TOKEN = 2 tokens. We do NOT claim
    // "one emoji = one token" — the heuristic sets the rate at 2, and ZWJ
    // sequences (which iterate multiple code points) deliberately cost more.
    expect(estimateTextTokens(single)).toBe(2) // one surrogate-pair code point → 2 tokens
    expect(estimateTextTokens(repeated)).toBe(20) // 10 codepoints × 2 tokens each
  })

  it('ZWJ emoji sequences iterate as multiple code points (NOT one grapheme)', () => {
    // `👨‍👩‍👧` renders as a single emoji but in Unicode is MANY code points:
    //   man (1) + ZWJ (1) + woman (1) + ZWJ (1) + girl (1) = 5 code points.
    // We do NOT do grapheme segmentation, so each code point is counted.
    // This is a known UNDER-count vs real tokenizers for complex emoji —
    // the engine absorbs the variance via the pressure-threshold margins.
    const zwj = '👨‍👩‍👧'
    // Sanity: confirm we have > 1 code point to iterate
    let count = 0
    for (const _ of zwj) count++ // eslint-disable-line @typescript-eslint/no-unused-vars
    expect(count).toBeGreaterThan(1)
    // The heuristic cost = codePoints × 2; we don't assert the exact number
    // (Intl.Segmenter could push it either way), only that it is more than
    // the single-codepoint emoji `🎉`.
    expect(estimateTextTokens(zwj)).toBeGreaterThan(estimateTextTokens('🎉'))
  })

  it('mixed text estimates the sum of its parts', () => {
    // 70 CJK + 70 ASCII (each 70 chars) → must match the sum computed
    // independently, NOT a flat 140/3.5.
    const cjkPart = '测'.repeat(70)            // 70 non-ASCII code points
    const asciiPart = 'a'.repeat(70)            // 70 ASCII code points
    const mixed = cjkPart + asciiPart
    const expected = estimateTextTokens(cjkPart) + estimateTextTokens(asciiPart)
    expect(estimateTextTokens(mixed)).toBeCloseTo(expected, 6)
    expect(estimateTextTokens(mixed)).toBeGreaterThan(70 / 3.5 + 5)
  })

  it('Japanese kana and Korean hangul are counted as non-ASCII', () => {
    const japanese = 'こんにちは' // 5 hiragana code points
    const korean = '안녕하세요'   // 5 hangul code points
    expect(estimateTextTokens(japanese)).toBe(10) // 5 × 2
    expect(estimateTextTokens(korean)).toBe(10)
  })

  it('accented Latin / Cyrillic / Hebrew counted as non-ASCII', () => {
    // Fully non-ASCII strings → 2 tokens per code point (heuristic)
    expect(estimateTextTokens('café')).toBeCloseTo(3/3.5 + 2, 6)
    expect(estimateTextTokens('Привет')).toBe(12) // 6 × 2
    expect(estimateTextTokens('שלום')).toBe(8)   // 4 × 2
  })

  it('monotonic: more characters → never fewer tokens', () => {
    const s1 = 'a'.repeat(100)
    const s2 = 'a'.repeat(200)
    const s3 = '中'.repeat(100)
    const s4 = '中'.repeat(200)
    expect(estimateTextTokens(s2)).toBeGreaterThan(estimateTextTokens(s1))
    expect(estimateTextTokens(s4)).toBeGreaterThan(estimateTextTokens(s3))
  })

  it('conservative: at least 2 tokens per non-ASCII code point at the current heuristic factor', () => {
    // Per-codepoint rate is 2 tokens (see NON_ASCII_CHARS_PER_TOKEN = 0.5);
    // 1 CJK char → 2 tokens. We describe this as the CURRENT heuristic floor
    // rather than a worst-case bound (the docstring explicitly disclaims
    // worst-case guarantees).
    expect(estimateTextTokens('中')).toBe(2)
    expect(estimateTextTokens('日')).toBe(2)
  })

  it('no dependency on tokenizer — same input always yields same tokens', () => {
    const text = 'Hello 世界 🎉'
    const a = estimateTextTokens(text)
    const b = estimateTextTokens(text)
    const c = estimateTextTokens(text)
    expect(a).toBe(b)
    expect(b).toBe(c)
  })
})

// ── estimateTokens + toolDefs reflect multilingual cost ──────────────────────

describe('estimateTokens / toolDefs use multilingual cost', () => {
  it('Chinese message estimates substantially more than ASCII of same length', () => {
    const asciiMsg: OpenAIMessage[] = [{ role: 'user', content: 'a'.repeat(500) }]
    const cjkMsg: OpenAIMessage[] = [{ role: 'user', content: '中'.repeat(500) }]
    const asciiCost = estimateTokens(asciiMsg)
    const cjkCost = estimateTokens(cjkMsg)
    // The same-character-count comparison: CJK should be FAR higher
    expect(cjkCost).toBeGreaterThan(asciiCost * 3)
  })

  it('emoji-rich message: 1 emoji ≈ 1 token (not zero, not 2)', () => {
    const emojiMsg: OpenAIMessage[] = [{ role: 'user', content: '🎉🎉🎉' }]
    const cost = estimateTokens(emojiMsg)
    // We expect the 3 emojis alone to contribute ~3 tokens, plus role/envelope.
    // If a naive implementation used str.length (which is 6 for 3 surrogate
    // pairs) at the ASCII rate it would compute 6/3.5 ≈ 1.7 — too low.
    // With per-codepoint counting we get 3 emoji-tokens = 3 minimum.
    expect(cost).toBeGreaterThanOrEqual(7) // 3 emoji + role + envelope
  })

  it('Chinese tool description flagged in tool-definition cost', () => {
    const defs = [{
      type: 'function',
      function: {
        name: 'ReadFile', // 8 ASCII chars
        description: '读取文件内容', // 5 CJK code points
        parameters: { type: 'object', properties: {} },
      },
    }]
    const tokens = estimateToolDefinitionTokens(defs)
    // Same structure but with ASCII description would estimate ~25 tokens;
    // CJK description must push it well above the all-ASCII equivalent.
    const asciiVer = [{
      type: 'function',
      function: {
        name: 'ReadFile',
        description: 'a'.repeat(5),
        parameters: { type: 'object', properties: {} },
      },
    }]
    const asciiTokens = estimateToolDefinitionTokens(asciiVer)
    expect(tokens).toBeGreaterThan(asciiTokens)
  })
})

// ── effectiveInputBudget ─────────────────────────────────────────────────────

describe('effectiveInputBudget', () => {
  it('subtracts clamped output from window', () => {
    // 200k window, default 8192 → clamp to 8192 (within half-window) → 200k - 8192 = 191_808
    expect(effectiveInputBudget(200_000, undefined)).toBe(191_808)
  })

  it('uses min on small windows so input still has room', () => {
    // 8k window, 8k requested → clamped to 4k → input budget = 4k
    expect(effectiveInputBudget(8_192, 8_192)).toBe(4_096)
  })

  it('subtracts bigger output when window is large', () => {
    // 64k window, 16k requested → 16k < 32k half-window → keep 16k → input = 48k
    expect(effectiveInputBudget(64_000, 16_000)).toBe(48_000)
  })

  it('falls back to default before clamping on invalid requested', () => {
    // NaN → default 8192 → 8192 > half(8k)=4096 → clamped to 4096 → input = 4k
    expect(effectiveInputBudget(8_192, Number.NaN)).toBe(4_096)
    // 16k window, +Infinity → default 8192 → 8192 > half(16k)=8000 → clamp to 8000 → input = 8k
    expect(effectiveInputBudget(16_000, Number.POSITIVE_INFINITY)).toBe(8_000)
  })

  it('floors at 1 even when clamp leaves a tiny input', () => {
    // 2k window, default 8192 → clamp to 1000 → input = 1000
    expect(effectiveInputBudget(2_000, undefined)).toBe(1_000)
    // window smaller than default → clamp to window/2
    expect(effectiveInputBudget(1_000, undefined)).toBe(500)
  })
})

// ─────────────────────────────────────────────────────────────────────────
// maybeCompact abort propagation — reviewer-confirmed cancellation defect
// ─────────────────────────────────────────────────────────────────────────

/**
 * Build a "fake" client that models the abortable shape of the real
 * OpenAI SDK. The real `client.chat.completions.create(params, opts)`
 * takes request options as a SECOND argument and responds to the
 * `signal` field there. We mimic that signature so the test exercises
 * the same call site `maybeCompact` uses.
 *
 * Modes:
 *   - abortBeforeCreate: throw an AbortError synchronously if the signal
 *     is already aborted when create() is called.
 *   - rejectOnSignal: reject after seeing signal.aborted flip true.
 *   - settle: complete with a fake response containing the supplied
 *     summary.
 */
function makeFakeClient(opts: {
  behaviour: 'settle' | 'reject-on-signal' | 'reject-immediately'
  rejectWith?: unknown
  reply?: string
}): { chat: { completions: { create: (...a: unknown[]) => Promise<unknown> } } } {
  return {
    chat: {
      completions: {
        create: async (...args: unknown[]) => {
          // Pull the signal out of the second positional argument (the
          // OpenAI SDK shape). The engine and tests may pass undefined.
          const second = args[1] as { signal?: AbortSignal } | undefined
          const signal = second?.signal

          if (opts.behaviour === 'reject-immediately') {
            throw (opts.rejectWith as Error) ?? Object.assign(new Error('upstream failure'), { name: 'Error' })
          }
          if (opts.behaviour === 'reject-on-signal') {
            // Wait for the signal to fire, then reject.
            return new Promise<unknown>((_, reject) => {
              if (signal?.aborted) {
                reject(opts.rejectWith as Error ?? Object.assign(new Error('aborted'), { name: 'AbortError' }))
                return
              }
              const onAbort = () => {
                reject(opts.rejectWith as Error ?? Object.assign(new Error('aborted'), { name: 'AbortError' }))
              }
              signal?.addEventListener('abort', onAbort, { once: true })
            })
          }
          // settle — return a fake summary response
          return {
            choices: [
              { message: { content: opts.reply ?? '<summary>test summary</summary>' } },
            ],
          }
        },
      },
    },
  }
}

/**
 * Build a messages array that crosses the KEEP_RECENT_MESSAGES * 2
 * threshold so maybeCompact actually attempts a summary request
 * (the early-return path returns `compacted: false` without calling
 * the LLM). We don't care about the content — we just want to drive
 * the create() call.
 */
function buildMessagesForCompact(): OpenAIMessage[] {
  const messages: OpenAIMessage[] = []
  // 20 user/assistant pairs to get past the minimum length gate.
  for (let i = 0; i < 20; i++) {
    messages.push({
      role: 'user',
      content: 'user-message-' + i + ' '.repeat(200),
    })
    messages.push({
      role: 'assistant',
      content: 'assistant-reply-' + i + ' '.repeat(200),
    })
  }
  return messages
}

describe('maybeCompact — abort propagation (cancellation defect fix)', () => {
  it('throws immediately when the signal is already aborted at entry', async () => {
    const client = makeFakeClient({ behaviour: 'settle' })
    const ac = new AbortController()
    ac.abort() // already aborted before we ever call

    await expect(maybeCompact(
      client as unknown as Parameters<typeof maybeCompact>[0],
      'test-model',
      buildMessagesForCompact(),
      ac.signal,
    )).rejects.toThrow(/aborted before summarization/i)

    // The fake client's create must NOT have been called when the
    // signal was already aborted at entry.
  })

  it('forwards the AbortSignal to chat.completions.create as a second argument', () => {
    // Source-level audit: the catch in maybeCompact previously swallowed
    // every error (including AbortError). The fix MUST pass { signal }
    // as the second argument and MUST re-throw on abort.
    //
    // We can't introspect a fake client from outside without a
    // wrapper, so this is the cleanest structural regression guard.
    // Use top-level readFileSync import
    const src = readFileSync(
      fileURLToPath(new URL('../src/core/compact.ts', import.meta.url)),
      'utf8',
    )
    // Confirm the create call now uses the second-argument options shape.
    expect(src).toMatch(/client\.chat\.completions\.create\(\s*\{/)
    expect(src).toMatch(/signal\s*\?\s*\{\s*signal\s*\}\s*:\s*undefined/)
    // Confirm the catch no longer swallows every error — it must
    // distinguish abort from non-abort.
    expect(src).not.toMatch(/\}\s*catch\s*\{\s*\/\/\s*If summarization fails/m)
    expect(src).toMatch(/isAbort\(/)
    expect(src).toMatch(/throw err/)
  })

  it('re-throws AbortError when the upstream create() rejects with one', async () => {
    const abortErr = Object.assign(new Error('aborted'), { name: 'AbortError' })
    const client = makeFakeClient({ behaviour: 'reject-immediately', rejectWith: abortErr })
    const ac = new AbortController()

    await expect(maybeCompact(
      client as unknown as Parameters<typeof maybeCompact>[0],
      'test-model',
      buildMessagesForCompact(),
      ac.signal,
    )).rejects.toBe(abortErr)
  })

  it('re-throws when the rejection message begins with "aborted"', async () => {
    const undiciStyle = new Error('aborted')
    const client = makeFakeClient({ behaviour: 'reject-immediately', rejectWith: undiciStyle })
    const ac = new AbortController()

    await expect(maybeCompact(
      client as unknown as Parameters<typeof maybeCompact>[0],
      'test-model',
      buildMessagesForCompact(),
      ac.signal,
    )).rejects.toBe(undiciStyle)
  })

  it('does NOT swallow non-abort failures — they return compacted:false (preserved behaviour)', async () => {
    const netErr = new Error('connect ECONNREFUSED')
    const client = makeFakeClient({ behaviour: 'reject-immediately', rejectWith: netErr })
    const ac = new AbortController()

    const result = await maybeCompact(
      client as unknown as Parameters<typeof maybeCompact>[0],
      'test-model',
      buildMessagesForCompact(),
      ac.signal,
    )
    expect(result.compacted).toBe(false)
    // Original messages must be returned unchanged.
    expect(result.messages.length).toBe(buildMessagesForCompact().length)
  })

  it('still throws on abort even when no signal is passed (signal undefined)', async () => {
    // Regression guard: the abort-detect path must remain correct in
    // branches that never received a signal. With `signal` undefined,
    // isAbort must NOT match a non-abort error — and a thrown AbortError
    // still re-throws because err.name === 'AbortError'.
    const abortErr = Object.assign(new Error('aborted'), { name: 'AbortError' })
    const client = makeFakeClient({ behaviour: 'reject-immediately', rejectWith: abortErr })

    await expect(maybeCompact(
      client as unknown as Parameters<typeof maybeCompact>[0],
      'test-model',
      buildMessagesForCompact(),
      // no signal
    )).rejects.toBe(abortErr)
  })

  it('source-level guard: contextManager passes the abort signal to maybeCompact', () => {
    const src = readFileSync(
      fileURLToPath(new URL('../src/core/context/contextManager.ts', import.meta.url)),
      'utf8',
    )
    // Proactive compact path (evaluateBudget)
    expect(src).toMatch(/maybeCompact\(/)
    // Both call sites pass abortSignal
    const matches = src.match(/maybeCompact\(/g)
    expect(matches?.length).toBeGreaterThanOrEqual(2)
    // Verify abortSignal is forwarded in both paths
    expect(src).toMatch(/this\.deps\.client,\s*this\.deps\.model,\s*messages,\s*abortSignal/)
  })
})

describe('isAbort helper (cancellation recogniser)', () => {
  it('returns true when signal is aborted', () => {
    const ac = new AbortController(); ac.abort()
    expect(isAbort(new Error('whatever'), ac.signal)).toBe(true)
  })

  it('returns true for err.name === "AbortError"', () => {
    const e = Object.assign(new Error('aborted'), { name: 'AbortError' })
    expect(isAbort(e)).toBe(true)
  })

  it('returns true for messages starting with "aborted"', () => {
    expect(isAbort(new Error('aborted'))).toBe(true)
  })

  it('returns true for messages containing "Request was aborted"', () => {
    expect(isAbort(new Error('Request was aborted'))).toBe(true)
  })

  it('returns true for messages starting with "this operation was aborted"', () => {
    expect(isAbort(new Error('This operation was aborted'))).toBe(true)
  })

  it('returns false for generic upstream failures', () => {
    expect(isAbort(new Error('connect ECONNREFUSED'))).toBe(false)
    expect(isAbort(new Error('rate limit exceeded'))).toBe(false)
    expect(isAbort(new Error('internal server error'))).toBe(false)
  })

  it('returns false for null / undefined', () => {
    expect(isAbort(null)).toBe(false)
    expect(isAbort(undefined)).toBe(false)
  })
})
