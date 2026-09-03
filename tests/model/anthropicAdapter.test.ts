import { describe, expect, it } from 'vitest'
import {
  AnthropicChunkTranslator,
  buildAnthropicRequest,
  buildAssistantMessageToAnthropicContent,
  toolResultToAnthropicUserBlock,
  extractAnthropicBetaHeaders,
} from '../../src/core/model/anthropicSse.js'

describe('buildAnthropicRequest (R8: SDK type)', () => {
  it('builds a request body that matches the SDK MessageCreateParamsNonStreaming shape', () => {
    const body = buildAnthropicRequest({
      model: 'claude-sonnet-4-6',
      systemPrompt: 'You are helpful.',
      messages: [{ role: 'user', content: 'Hello' }],
      tools: [
        {
          type: 'function',
          function: {
            name: 'Bash',
            description: 'Run a shell command',
            parameters: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] },
          },
        },
      ],
      maxTokens: 4096,
      temperature: 0.5,
    })
    expect(body.model).toBe('claude-sonnet-4-6')
    expect(body.system).toBe('You are helpful.')
    expect(body.max_tokens).toBe(4096)
    expect(body.temperature).toBe(0.5)
    expect(body.stream).toBeUndefined()
    expect(body.messages).toEqual([{ role: 'user', content: 'Hello' }])
    expect(body.tools?.[0]?.name).toBe('Bash')
  })

  it('handles empty tools list', () => {
    const body = buildAnthropicRequest({
      model: 'm',
      systemPrompt: 's',
      messages: [],
      tools: [],
      maxTokens: 1024,
    })
    // Empty tools must OMIT the field — the Messages API rejects [].
    expect(body.tools).toBeUndefined()
  })

  it('emits thinking block when thinkingBudget > 0', () => {
    const body = buildAnthropicRequest({
      model: 'm',
      systemPrompt: 's',
      messages: [],
      tools: [],
      maxTokens: 16000,
      providerOptions: { thinkingBudget: 4096 },
    })
    expect((body as { thinking?: unknown }).thinking).toEqual({ type: 'enabled', budget_tokens: 4096 })
  })

  it('does not emit thinking when budget is 0', () => {
    const body = buildAnthropicRequest({
      model: 'm',
      systemPrompt: 's',
      messages: [],
      tools: [],
      maxTokens: 100,
      providerOptions: { thinkingBudget: 0 },
    })
    expect((body as { thinking?: unknown }).thinking).toBeUndefined()
  })
})

describe('extractAnthropicBetaHeaders (R8)', () => {
  it('returns empty array when no provider options', () => {
    expect(extractAnthropicBetaHeaders()).toEqual([])
    expect(extractAnthropicBetaHeaders({})).toEqual([])
  })

  it('returns explicit beta headers', () => {
    expect(extractAnthropicBetaHeaders({
      anthropicBeta: ['prompt-caching-2024-07-31'],
    })).toEqual(['prompt-caching-2024-07-31'])
  })

  it('auto-adds extended-thinking when thinkingBudget is set and thinking beta missing', () => {
    const headers = extractAnthropicBetaHeaders({
      anthropicBeta: ['prompt-caching-2024-07-31'],
      thinkingBudget: 4096,
    })
    expect(headers).toContain('prompt-caching-2024-07-31')
    expect(headers).toContain('extended-thinking-2025-01-01')
  })

  it('does not duplicate thinking beta', () => {
    const headers = extractAnthropicBetaHeaders({
      anthropicBeta: ['extended-thinking-2025-04-01'],
      thinkingBudget: 4096,
    })
    expect(headers.filter((h) => h.includes('thinking'))).toHaveLength(1)
  })
})

describe('AnthropicChunkTranslator (R8)', () => {
  it('emits content delta for text_delta', () => {
    const t = new AnthropicChunkTranslator('claude-sonnet-4-6')
    const chunks = t.push({
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'text_delta', text: 'Hello' },
    })
    expect(chunks).toHaveLength(1)
    const delta = chunks[0]?.choices[0]?.delta as { content?: string }
    expect(delta.content).toBe('Hello')
  })

  it('maps tool_use finish reason to tool_calls', () => {
    const t = new AnthropicChunkTranslator('claude-sonnet-4-6')
    t.push({ type: 'message_delta', delta: { stop_reason: 'tool_use', stop_sequence: null } })
    const chunks = t.push({ type: 'message_stop' })
    expect(chunks[0]?.choices[0]?.finish_reason).toBe('tool_calls')
  })

  it('maps max_tokens to length finish reason', () => {
    const t = new AnthropicChunkTranslator('claude-sonnet-4-6')
    t.push({ type: 'message_delta', delta: { stop_reason: 'max_tokens', stop_sequence: null } })
    const chunks = t.push({ type: 'message_stop' })
    expect(chunks[0]?.choices[0]?.finish_reason).toBe('length')
  })

  it('usage is emitted ONCE (finalize) — message_stop carries no usage; message_delta is cumulative', () => {
    const t = new AnthropicChunkTranslator('claude-sonnet-4-6')
    t.push({
      type: 'message_start',
      message: { id: 'm', type: 'message', role: 'assistant', content: [], model: 'claude-sonnet-4-6', stop_reason: null, usage: { input_tokens: 30, output_tokens: 3 } },
    })
    // Multiple message_delta events with RUNNING TOTALS (the Anthropic
    // contract is cumulative) — last one must win, never summed.
    t.push({ type: 'message_delta', delta: { stop_reason: null, stop_sequence: null }, usage: { output_tokens: 27 } })
    t.push({ type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 50 } })
    const stopChunks = t.push({ type: 'message_stop' })
    // message_stop chunk: finish reason only, NO usage (single-emission
    // contract — the old duplicate usage chunk double-counted for any
    // accumulating consumer).
    expect(stopChunks[0]?.choices[0]?.finish_reason).toBe('stop')
    expect(stopChunks[0]?.usage).toBeUndefined()
    const final = t.finalizeWithUsage(undefined)
    // 50 (cumulative final), NOT 3+27+50 — and NOT 3+50.
    expect(final.usage?.completion_tokens).toBe(50)
  })

  it('captures input_tokens from message_start', () => {
    const t = new AnthropicChunkTranslator('claude-sonnet-4-6')
    t.push({
      type: 'message_start',
      message: { id: 'm', type: 'message', role: 'assistant', content: [], model: 'claude-sonnet-4-6', stop_reason: null, usage: { input_tokens: 30, output_tokens: 0 } },
    })
    const final = t.finalizeWithUsage(undefined)
    expect(final.usage?.prompt_tokens).toBe(30)
  })

  it('emits initial tool call chunk on content_block_start for tool_use', () => {
    const t = new AnthropicChunkTranslator('claude-sonnet-4-6')
    const chunks = t.push({
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'tool_use', id: 'toolu_01', name: 'Bash' },
    })
    expect(chunks).toHaveLength(1)
    const toolCall = (chunks[0]?.choices[0]?.delta as { tool_calls?: Array<{ function?: { name?: string } }> }).tool_calls?.[0]
    expect(toolCall?.function?.name).toBe('Bash')
  })
})

describe('buildAssistantMessageToAnthropicContent', () => {
  it('returns text block only when no tool calls', () => {
    const blocks = buildAssistantMessageToAnthropicContent('Hello', [])
    expect(blocks).toEqual([{ type: 'text', text: 'Hello' }])
  })

  it('returns tool_use blocks for tool calls', () => {
    const blocks = buildAssistantMessageToAnthropicContent(null, [
      { id: 't1', name: 'Bash', arguments: '{"command":"ls"}' },
    ])
    expect(blocks).toEqual([
      { type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'ls' } },
    ])
  })

  it('parses invalid JSON arguments as empty object', () => {
    const blocks = buildAssistantMessageToAnthropicContent(null, [
      { id: 't1', name: 'Bash', arguments: 'not json' },
    ])
    expect(blocks).toEqual([
      { type: 'tool_use', id: 't1', name: 'Bash', input: {} },
    ])
  })
})

describe('toolResultToAnthropicUserBlock', () => {
  it('builds a tool_result block', () => {
    const block = toolResultToAnthropicUserBlock('t1', 'output', false)
    expect(block).toEqual({
      type: 'tool_result',
      tool_use_id: 't1',
      content: 'output',
      is_error: false,
    })
  })

  it('passes through is_error', () => {
    const block = toolResultToAnthropicUserBlock('t1', 'msg', true)
    expect(block.is_error).toBe(true)
  })
})
