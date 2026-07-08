import { describe, it, expect, beforeEach } from 'vitest'
import {
  CostTracker,
  getModelPricing,
  calculateUSDCost,
  formatCost,
  formatNumber,
  formatDuration,
  hasUnknownModelCost,
  resetUnknownModelCost,
  roughTokenCountEstimation,
  bytesPerTokenForFileType,
  roughTokenCountEstimationForFileType,
} from '../src/core/costTracker.js'

// ── getModelPricing ─────────────────────────────────────────────────────────

describe('getModelPricing', () => {
  it('returns pricing for exact model name', () => {
    const p = getModelPricing('gpt-4o')
    expect(p).toEqual({ inputPer1M: 2.5, outputPer1M: 10 })
  })

  it('returns pricing for prefix match (versioned model)', () => {
    const p = getModelPricing('gpt-4o-2024-08-06')
    expect(p).not.toBeNull()
    expect(p!.inputPer1M).toBe(2.5)
  })

  it('returns pricing for claude versioned models', () => {
    const p = getModelPricing('claude-sonnet-4-6-20250514')
    expect(p).not.toBeNull()
    expect(p!.inputPer1M).toBe(3)
  })

  it('returns null for unknown model', () => {
    expect(getModelPricing('totally-unknown-model')).toBeNull()
  })

  it('prefers longest prefix match', () => {
    // "claude-sonnet-4-6" is longer than "claude-sonnet-4"
    const p = getModelPricing('claude-sonnet-4-6-something')
    expect(p).not.toBeNull()
    // Both have the same pricing here, but the longer key should win
    expect(p!.inputPer1M).toBe(3)
  })
})

// ── calculateUSDCost ────────────────────────────────────────────────────────

describe('calculateUSDCost', () => {
  beforeEach(() => resetUnknownModelCost())

  it('computes cost for known model', () => {
    // gpt-4o: $2.5/1M input, $10/1M output
    // 1000 input + 500 output = 0.0025 + 0.005 = 0.0075
    const cost = calculateUSDCost('gpt-4o', { inputTokens: 1000, outputTokens: 500 })
    expect(cost).toBeCloseTo(0.0075, 6)
  })

  it('returns 0 for unknown model and sets flag', () => {
    const cost = calculateUSDCost('unknown-model', { inputTokens: 1000, outputTokens: 500 })
    expect(cost).toBe(0)
    expect(hasUnknownModelCost()).toBe(true)
  })

  it('does not set flag for known model', () => {
    resetUnknownModelCost()
    calculateUSDCost('gpt-4o-mini', { inputTokens: 100, outputTokens: 50 })
    expect(hasUnknownModelCost()).toBe(false)
  })

  it('handles zero tokens', () => {
    const cost = calculateUSDCost('gpt-4o', { inputTokens: 0, outputTokens: 0 })
    expect(cost).toBe(0)
  })
})

// ── Formatting helpers ──────────────────────────────────────────────────────

describe('formatCost', () => {
  it('uses 2 decimal places for costs > 0.5', () => {
    expect(formatCost(1.234)).toBe('$1.23')
    expect(formatCost(10)).toBe('$10.00')
  })

  it('uses 4 decimal places for small costs', () => {
    expect(formatCost(0.0075)).toBe('$0.0075')
  })

  it('formats zero', () => {
    expect(formatCost(0)).toBe('$0.0000')
  })
})

describe('formatNumber', () => {
  it('adds thousands separators', () => {
    expect(formatNumber(1234567)).toBe('1,234,567')
  })

  it('handles small numbers', () => {
    expect(formatNumber(42)).toBe('42')
  })

  it('handles zero', () => {
    expect(formatNumber(0)).toBe('0')
  })
})

describe('formatDuration', () => {
  it('formats milliseconds', () => {
    expect(formatDuration(500)).toBe('500ms')
  })

  it('formats seconds', () => {
    expect(formatDuration(1500)).toBe('1.5s')
    expect(formatDuration(30000)).toBe('30.0s')
  })

  it('formats minutes and seconds', () => {
    expect(formatDuration(133000)).toBe('2m 13s')
  })
})

// ── CostTracker ─────────────────────────────────────────────────────────────

describe('CostTracker', () => {
  let tracker: CostTracker

  beforeEach(() => {
    resetUnknownModelCost()
    tracker = new CostTracker()
  })

  it('starts with zero state', () => {
    expect(tracker.getTotalCost()).toBe(0)
    expect(tracker.getTotalInputTokens()).toBe(0)
    expect(tracker.getTotalOutputTokens()).toBe(0)
    expect(tracker.getTotalAPICalls()).toBe(0)
    expect(tracker.getModelUsage()).toHaveLength(0)
  })

  it('accumulates usage for a single model', () => {
    tracker.addUsage('gpt-4o', { inputTokens: 1000, outputTokens: 500 })
    expect(tracker.getTotalInputTokens()).toBe(1000)
    expect(tracker.getTotalOutputTokens()).toBe(500)
    expect(tracker.getTotalAPICalls()).toBe(1)
    expect(tracker.getTotalCost()).toBeCloseTo(0.0075, 6)
  })

  it('accumulates multiple calls for the same model', () => {
    tracker.addUsage('gpt-4o', { inputTokens: 1000, outputTokens: 500 })
    tracker.addUsage('gpt-4o', { inputTokens: 2000, outputTokens: 1000 })
    expect(tracker.getTotalInputTokens()).toBe(3000)
    expect(tracker.getTotalOutputTokens()).toBe(1500)
    expect(tracker.getTotalAPICalls()).toBe(2)
    expect(tracker.getTotalCost()).toBeCloseTo(0.0225, 6)

    const usage = tracker.getModelUsage()
    expect(usage).toHaveLength(1)
    expect(usage[0].apiCalls).toBe(2)
    expect(usage[0].inputTokens).toBe(3000)
  })

  it('tracks multiple models separately', () => {
    tracker.addUsage('gpt-4o', { inputTokens: 1000, outputTokens: 500 })
    tracker.addUsage('gpt-4o-mini', { inputTokens: 500, outputTokens: 200 })
    const usage = tracker.getModelUsage()
    expect(usage).toHaveLength(2)
    expect(tracker.getTotalAPICalls()).toBe(2)
  })

  it('tracks API duration', () => {
    tracker.addUsage('gpt-4o', { inputTokens: 100, outputTokens: 50 }, 1500)
    tracker.addUsage('gpt-4o', { inputTokens: 100, outputTokens: 50 }, 2500)
    expect(tracker.getTotalAPIDurationMs()).toBe(4000)
  })

  it('formatSummary includes cost and token totals', () => {
    tracker.addUsage('gpt-4o', { inputTokens: 1000, outputTokens: 500 })
    const summary = tracker.formatSummary()
    expect(summary).toContain('Total cost')
    expect(summary).toContain('1,000 input')
    expect(summary).toContain('500 output')
    expect(summary).toContain('1 call')
  })

  it('formatSummary includes per-model breakdown', () => {
    tracker.addUsage('gpt-4o', { inputTokens: 1000, outputTokens: 500 })
    tracker.addUsage('gpt-4o-mini', { inputTokens: 200, outputTokens: 100 })
    const summary = tracker.formatSummary()
    expect(summary).toContain('gpt-4o:')
    expect(summary).toContain('gpt-4o-mini:')
  })

  it('formatSummary notes unknown model pricing', () => {
    tracker.addUsage('unknown-model', { inputTokens: 100, outputTokens: 50 })
    const summary = tracker.formatSummary()
    expect(summary).toContain('unknown model pricing')
  })

  it('reset clears all state', () => {
    tracker.addUsage('gpt-4o', { inputTokens: 1000, outputTokens: 500 })
    tracker.reset()
    expect(tracker.getTotalCost()).toBe(0)
    expect(tracker.getTotalInputTokens()).toBe(0)
    expect(tracker.getModelUsage()).toHaveLength(0)
  })
})

// ── Token estimation (ported from Claude Code) ──────────────────────────────

describe('roughTokenCountEstimation', () => {
  it('estimates tokens at 4 bytes/token by default', () => {
    expect(roughTokenCountEstimation('hello world!')).toBe(3) // 12 chars / 4
  })

  it('respects custom bytesPerToken', () => {
    expect(roughTokenCountEstimation('hello world!', 2)).toBe(6) // 12 / 2
  })

  it('returns 0 for empty string', () => {
    expect(roughTokenCountEstimation('')).toBe(0)
  })
})

describe('bytesPerTokenForFileType', () => {
  it('returns 2 for JSON', () => {
    expect(bytesPerTokenForFileType('json')).toBe(2)
    expect(bytesPerTokenForFileType('jsonl')).toBe(2)
    expect(bytesPerTokenForFileType('jsonc')).toBe(2)
  })

  it('returns 2 for uppercase JSON', () => {
    expect(bytesPerTokenForFileType('JSON')).toBe(2)
  })

  it('returns 4 for other file types', () => {
    expect(bytesPerTokenForFileType('ts')).toBe(4)
    expect(bytesPerTokenForFileType('py')).toBe(4)
    expect(bytesPerTokenForFileType('md')).toBe(4)
  })
})

describe('roughTokenCountEstimationForFileType', () => {
  it('uses denser ratio for JSON', () => {
    const content = '{"key":"value","num":42}'
    // JSON: 24 chars / 2 = 12 tokens
    expect(roughTokenCountEstimationForFileType(content, 'json')).toBe(12)
  })

  it('uses default ratio for non-JSON', () => {
    const content = '{"key":"value","num":42}'
    // Non-JSON: 24 chars / 4 = 6 tokens
    expect(roughTokenCountEstimationForFileType(content, 'ts')).toBe(6)
  })

  it('JSON estimate is higher than default (denser tokens)', () => {
    const content = '{"a":1,"b":2}'
    const jsonEst = roughTokenCountEstimationForFileType(content, 'json')
    const defaultEst = roughTokenCountEstimationForFileType(content, 'ts')
    expect(jsonEst).toBeGreaterThan(defaultEst)
  })
})
