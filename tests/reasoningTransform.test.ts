import { describe, it, expect } from 'vitest'
import {
  detectReasoningFlavor,
  buildReasoningParams,
  extractReasoningDelta,
  normalizeHistoryForRequest,
  supportedEfforts,
  type ReasoningMessage,
} from '../src/core/model/reasoningTransform.js'

/**
 * Round 42 gap #3 (opencode transform.ts): reasoning/thinking parameter
 * translation across provider flavors + history normalization.
 */

describe('detectReasoningFlavor', () => {
  it('routes by provider and model id', () => {
    expect(detectReasoningFlavor('anthropic', 'claude-4-7-opus')).toBe('anthropic-thinking')
    expect(detectReasoningFlavor('openai', 'o3-mini')).toBe('openai-effort')
    expect(detectReasoningFlavor(undefined, 'gpt-5.2')).toBe('openai-effort')
    expect(detectReasoningFlavor('deepseek', 'deepseek-r1')).toBe('deepseek-replay')
    expect(detectReasoningFlavor(undefined, 'deepseek-chat')).toBe('none')
    expect(detectReasoningFlavor(undefined, 'qwen3-max')).toBe('qwen-toggle')
    expect(detectReasoningFlavor(undefined, 'QwQ-32B')).toBe('qwen-toggle')
    expect(detectReasoningFlavor(undefined, 'glm-4.7')).toBe('glm-object')
    expect(detectReasoningFlavor('minimax', 'MiniMax-M2')).toBe('minimax-config')
    expect(detectReasoningFlavor('grok', 'grok-4')).toBe('grok-effort')
    expect(detectReasoningFlavor('openrouter', 'x/y')).toBe('openrouter-native')
    expect(detectReasoningFlavor(undefined, 'some-unknown-model')).toBe('none')
  })
})

describe('buildReasoningParams', () => {
  it('openai flavor → reasoning_effort', () => {
    expect(buildReasoningParams('openai', 'o3', { effort: 'high' })).toEqual({ reasoning_effort: 'high' })
    expect(buildReasoningParams('openai', 'o3', {})).toEqual({ reasoning_effort: 'medium' })
    // OpenAI cannot disable reasoning entirely.
    expect(buildReasoningParams('openai', 'o3', { enabled: false })).toBeUndefined()
  })

  it('anthropic flavor → thinking object with clamped budget', () => {
    expect(buildReasoningParams('anthropic', 'claude-4-7-opus', { effort: 'high' }))
      .toEqual({ thinking: { type: 'enabled', budget_tokens: 10_240 } })
    expect(buildReasoningParams('anthropic', 'claude-4-7-sonnet', { budgetTokens: 1_000_000 }))
      .toEqual({ thinking: { type: 'enabled', budget_tokens: 64_000 } })
    expect(buildReasoningParams('anthropic', 'claude-4-7-sonnet', { enabled: false }))
      .toEqual({ thinking: { type: 'disabled' } })
  })

  it('qwen flavor → enable_thinking toggle (+budget)', () => {
    expect(buildReasoningParams(undefined, 'qwen3-max', { enabled: false }))
      .toEqual({ enable_thinking: false })
    expect(buildReasoningParams(undefined, 'qwen3-max', { budgetTokens: 40_000 }))
      .toEqual({ enable_thinking: true, thinking_budget: 32_768 })
  })

  it('glm flavor → thinking object form', () => {
    expect(buildReasoningParams(undefined, 'glm-4.7', {})).toEqual({ thinking: { type: 'enabled' } })
    expect(buildReasoningParams(undefined, 'glm-4.7', { enabled: false })).toEqual({ thinking: { type: 'disabled' } })
  })

  it('deepseek flavor has no request-side knob; unknown models add nothing', () => {
    expect(buildReasoningParams('deepseek', 'deepseek-r1', { effort: 'high' })).toBeUndefined()
    expect(buildReasoningParams(undefined, 'random-model', { effort: 'high' })).toBeUndefined()
    expect(buildReasoningParams(undefined, 'random-model', {})).toBeUndefined()
  })

  it('grok/openrouter shapes', () => {
    expect(buildReasoningParams('grok', 'grok-4', { effort: 'minimal' })).toEqual({ reasoning_effort: 'low' })
    expect(buildReasoningParams('openrouter', 'a/b', { effort: 'high' }))
      .toEqual({ reasoning: { effort: 'high', exclude: false } })
  })

  it('supportedEfforts reports per-flavor tiers', () => {
    expect(supportedEfforts('openai-effort')).toEqual(['minimal', 'low', 'medium', 'high'])
    expect(supportedEfforts('grok-effort')).toEqual(['low', 'high'])
    expect(supportedEfforts('deepseek-replay')).toEqual([])
  })
})

describe('extractReasoningDelta', () => {
  it('recognizes all vendor stream shapes', () => {
    expect(extractReasoningDelta({ reasoning_content: 'a' })).toBe('a')
    expect(extractReasoningDelta({ reasoning: 'b' })).toBe('b')
    expect(extractReasoningDelta({ thinking: 'c' })).toBe('c')
    expect(extractReasoningDelta({ reasoning_details: [{ text: 'd1' }, { text: 'd2' }] })).toBe('d1d2')
    expect(extractReasoningDelta({ content: 'normal' })).toBeUndefined()
    expect(extractReasoningDelta(undefined)).toBeUndefined()
    expect(extractReasoningDelta({ reasoning: '' })).toBeUndefined()
  })
})

describe('normalizeHistoryForRequest', () => {
  const history: Array<Record<string, unknown>> = [
    { role: 'user', content: 'q' },
    { role: 'assistant', content: 'a', reasoningContent: 'secret thoughts' },
    { role: 'user', content: 'next' },
  ]

  it('deepseek flavor replays reasoning as reasoning_content', () => {
    const out = normalizeHistoryForRequest('deepseek', 'deepseek-r1', history)
    expect(out[1]).toEqual({ role: 'assistant', content: 'a', reasoning_content: 'secret thoughts' })
  })

  it('every other flavor strips it', () => {
    for (const [provider, model] of [['openai', 'o3'], ['anthropic', 'claude-4-7'], [undefined, 'random']] as const) {
      const out = normalizeHistoryForRequest(provider, model, history)
      expect(out[1]).toEqual({ role: 'assistant', content: 'a' })
    }
  })

  it('messages without reasoning pass through untouched (same reference)', () => {
    const clean: Array<Record<string, unknown>> = [{ role: 'user', content: 'q' }]
    const out = normalizeHistoryForRequest('openai', 'o3', clean)
    expect(out[0]).toBe(clean[0])
  })

  it('ReasoningMessage shape matches the runtime assistant message', () => {
    const m: ReasoningMessage = { role: 'assistant', content: 'x', reasoningContent: 'r' }
    expect(m.reasoningContent).toBe('r')
  })
})
