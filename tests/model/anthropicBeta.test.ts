import { describe, expect, it } from 'vitest'
import {
  buildAnthropicRequest,
  extractAnthropicBetaHeaders,
} from '../../src/core/model/anthropicSse.js'

describe('buildAnthropicRequest providerOptions (R8)', () => {
  it('omits cache_control when cacheSystem/cacheTools are off', () => {
    const body = buildAnthropicRequest({
      model: 'claude-sonnet-4-6',
      systemPrompt: 'You are helpful.',
      messages: [{ role: 'user', content: 'Hi' }],
      tools: [],
      maxTokens: 1024,
    })
    expect(body.system).toBe('You are helpful.')
    expect(body.tools).toEqual([])
  })

  it('wraps system in cache_control block when cacheSystem is true', () => {
    const body = buildAnthropicRequest({
      model: 'claude-sonnet-4-6',
      systemPrompt: 'Sys.',
      messages: [{ role: 'user', content: 'Hi' }],
      tools: [],
      maxTokens: 1024,
      providerOptions: { cacheSystem: true },
    })
    expect(Array.isArray(body.system)).toBe(true)
    const sys = body.system as unknown as Array<Record<string, unknown>>
    expect(sys[0]).toMatchObject({
      type: 'text',
      text: 'Sys.',
      cache_control: { type: 'ephemeral' },
    })
  })

  it('marks only the LAST tool with cache_control when cacheTools is true', () => {
    const body = buildAnthropicRequest({
      model: 'm',
      systemPrompt: 's',
      messages: [],
      tools: [
        { type: 'function', function: { name: 'A' } },
        { type: 'function', function: { name: 'B' } },
        { type: 'function', function: { name: 'C' } },
      ],
      maxTokens: 100,
      providerOptions: { cacheTools: true },
    })
    const tools = (body.tools ?? []) as unknown as Array<Record<string, unknown>>
    expect(tools[0]).not.toHaveProperty('cache_control')
    expect(tools[1]).not.toHaveProperty('cache_control')
    expect(tools[2]?.cache_control).toEqual({ type: 'ephemeral' })
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
    expect((body as unknown as { thinking?: unknown }).thinking).toEqual({
      type: 'enabled',
      budget_tokens: 4096,
    })
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
    expect((body as unknown as { thinking?: unknown }).thinking).toBeUndefined()
  })
})

describe('extractAnthropicBetaHeaders', () => {
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
