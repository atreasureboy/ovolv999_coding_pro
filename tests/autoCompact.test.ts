import { describe, it, expect } from 'vitest'
import {
  analyzeContext, getStage, shouldCompact, planCompaction,
  formatContextBar, formatStageWarning, formatCompactPlan, formatStats,
  getContextWindowForModel, createConfigForModel,
  DEFAULT_THRESHOLDS, DEFAULT_COMPACT_CONFIG, MODEL_CONTEXT_WINDOWS,
  type CompactConfig,
} from '../src/core/autoCompact.js'
import type { OpenAIMessage } from '../src/core/types.js'

function makeMessages(count: number, tokensPerMessage = 500): OpenAIMessage[] {
  const msgs: OpenAIMessage[] = []
  for (let i = 0; i < count; i++) {
    const content = 'a'.repeat(tokensPerMessage * 4) // ~4 chars per token
    msgs.push({ role: 'user', content })
  }
  return msgs
}

describe('Auto-Compact Guard', () => {
  describe('getStage', () => {
    it('returns safe below caution threshold', () => {
      expect(getStage(0.1, DEFAULT_THRESHOLDS)).toBe('safe')
      expect(getStage(0.49, DEFAULT_THRESHOLDS)).toBe('safe')
    })

    it('returns caution at 0.5', () => {
      expect(getStage(0.5, DEFAULT_THRESHOLDS)).toBe('caution')
      expect(getStage(0.6, DEFAULT_THRESHOLDS)).toBe('caution')
    })

    it('returns warning at 0.7', () => {
      expect(getStage(0.7, DEFAULT_THRESHOLDS)).toBe('warning')
      expect(getStage(0.8, DEFAULT_THRESHOLDS)).toBe('warning')
    })

    it('returns critical at 0.85', () => {
      expect(getStage(0.85, DEFAULT_THRESHOLDS)).toBe('critical')
      expect(getStage(0.91, DEFAULT_THRESHOLDS)).toBe('critical')
    })

    it('returns compact at 0.92+', () => {
      expect(getStage(0.92, DEFAULT_THRESHOLDS)).toBe('compact')
      expect(getStage(1.0, DEFAULT_THRESHOLDS)).toBe('compact')
      expect(getStage(1.5, DEFAULT_THRESHOLDS)).toBe('compact')
    })
  })

  describe('analyzeContext', () => {
    it('returns zero stats for empty messages', () => {
      const stats = analyzeContext([], DEFAULT_COMPACT_CONFIG)
      expect(stats.messageCount).toBe(0)
      expect(stats.totalTokens).toBe(0)
      expect(stats.usageRatio).toBe(0)
      expect(stats.stage).toBe('safe')
    })

    it('calculates usage ratio correctly', () => {
      const config: CompactConfig = {
        ...DEFAULT_COMPACT_CONFIG,
        contextWindow: 10_000,
      }
      // ~500 tokens per message, 10 messages = ~5000 tokens
      const msgs = makeMessages(10, 500)
      const stats = analyzeContext(msgs, config)
      expect(stats.totalTokens).toBeGreaterThan(4000)
      expect(stats.usageRatio).toBeGreaterThan(0.4)
      expect(stats.usageRatio).toBeLessThan(0.6)
    })

    it('calculates remaining tokens', () => {
      const config: CompactConfig = {
        ...DEFAULT_COMPACT_CONFIG,
        contextWindow: 10_000,
      }
      const msgs = makeMessages(5, 500)
      const stats = analyzeContext(msgs, config)
      expect(stats.remainingTokens).toBeGreaterThan(0)
      expect(stats.remainingTokens).toBeLessThan(10_000)
    })

    it('estimates slots remaining', () => {
      const config: CompactConfig = {
        ...DEFAULT_COMPACT_CONFIG,
        contextWindow: 10_000,
      }
      const msgs = makeMessages(5, 500)
      const stats = analyzeContext(msgs, config)
      expect(stats.estimatedSlotsRemaining).toBeGreaterThan(0)
    })

    it('identifies correct stage', () => {
      const config: CompactConfig = {
        ...DEFAULT_COMPACT_CONFIG,
        contextWindow: 1000,
      }
      // Many messages, small context
      const msgs = makeMessages(50, 100)
      const stats = analyzeContext(msgs, config)
      expect(['warning', 'critical', 'compact']).toContain(stats.stage)
    })
  })

  describe('shouldCompact', () => {
    it('does not compact when safe', () => {
      const config: CompactConfig = {
        ...DEFAULT_COMPACT_CONFIG,
        contextWindow: 1_000_000,
      }
      const msgs = makeMessages(10, 500)
      const decision = shouldCompact(msgs, config)
      expect(decision.shouldCompact).toBe(false)
    })

    it('auto-compacts when ratio exceeds threshold', () => {
      const config: CompactConfig = {
        ...DEFAULT_COMPACT_CONFIG,
        contextWindow: 5000,
        minMessages: 5,
      }
      const msgs = makeMessages(30, 500)
      const decision = shouldCompact(msgs, config)
      expect(decision.shouldCompact).toBe(true)
      expect(decision.reason).toContain('Auto-compacting')
    })

    it('respects minMessages even when over threshold', () => {
      const config: CompactConfig = {
        ...DEFAULT_COMPACT_CONFIG,
        contextWindow: 500,
        minMessages: 100,
      }
      const msgs = makeMessages(5, 500)
      const decision = shouldCompact(msgs, config)
      expect(decision.shouldCompact).toBe(false)
      expect(decision.reason).toContain('min')
    })

    it('forces compaction when force=true', () => {
      const config: CompactConfig = {
        ...DEFAULT_COMPACT_CONFIG,
        contextWindow: 1_000_000,
        minMessages: 5,
      }
      const msgs = makeMessages(10, 500)
      const decision = shouldCompact(msgs, config, true)
      expect(decision.shouldCompact).toBe(true)
      expect(decision.forced).toBe(true)
    })

    it('force still respects minMessages', () => {
      const config: CompactConfig = {
        ...DEFAULT_COMPACT_CONFIG,
        minMessages: 100,
      }
      const msgs = makeMessages(5)
      const decision = shouldCompact(msgs, config, true)
      expect(decision.shouldCompact).toBe(false)
    })

    it('does not compact when autoCompact is disabled', () => {
      const config: CompactConfig = {
        ...DEFAULT_COMPACT_CONFIG,
        contextWindow: 500,
        autoCompact: false,
      }
      const msgs = makeMessages(50, 500)
      const decision = shouldCompact(msgs, config)
      expect(decision.shouldCompact).toBe(false)
    })
  })

  describe('planCompaction', () => {
    it('keeps recent messages and summarizes older ones', () => {
      const config: CompactConfig = {
        ...DEFAULT_COMPACT_CONFIG,
        keepRecent: 5,
      }
      const msgs = makeMessages(20, 500)
      const plan = planCompaction(msgs, config)
      expect(plan.toKeep).toHaveLength(5)
      expect(plan.toSummarize).toHaveLength(15)
    })

    it('handles messages shorter than keepRecent', () => {
      const config: CompactConfig = {
        ...DEFAULT_COMPACT_CONFIG,
        keepRecent: 20,
      }
      const msgs = makeMessages(5, 500)
      const plan = planCompaction(msgs, config)
      expect(plan.toKeep).toHaveLength(5)
      expect(plan.toSummarize).toHaveLength(0)
    })

    it('calculates token estimates', () => {
      const msgs = makeMessages(20, 500)
      const plan = planCompaction(msgs)
      expect(plan.compactedTokens).toBeGreaterThan(0)
      expect(plan.keptTokens).toBeGreaterThan(0)
      expect(plan.estimatedAfterCompact).toBeGreaterThan(0)
    })

    it('estimatedAfterCompact is less than original', () => {
      const msgs = makeMessages(30, 500)
      const plan = planCompaction(msgs)
      const original = plan.compactedTokens + plan.keptTokens
      expect(plan.estimatedAfterCompact).toBeLessThan(original)
    })
  })

  describe('formatContextBar', () => {
    it('renders safe bar', () => {
      const stats = analyzeContext(makeMessages(1), {
        ...DEFAULT_COMPACT_CONFIG,
        contextWindow: 1_000_000,
      })
      const bar = formatContextBar(stats)
      expect(bar).toContain('✓')
      expect(bar).toContain('%')
    })

    it('renders compact bar', () => {
      const stats = analyzeContext(makeMessages(100, 1000), {
        ...DEFAULT_COMPACT_CONFIG,
        contextWindow: 1000,
      })
      const bar = formatContextBar(stats)
      expect(bar).toContain('✗')
    })
  })

  describe('formatStageWarning', () => {
    it('returns empty string for safe stage', () => {
      expect(formatStageWarning('safe', {} as any)).toBe('')
    })

    it('includes percentage for caution', () => {
      const stats = { usageRatio: 0.55 } as any
      const msg = formatStageWarning('caution', stats)
      expect(msg).toContain('55%')
      expect(msg).toContain('compacting soon')
    })

    it('includes /compact suggestion for warning', () => {
      const stats = { usageRatio: 0.75 } as any
      const msg = formatStageWarning('warning', stats)
      expect(msg).toContain('/compact')
    })

    it('includes auto-compact note for critical', () => {
      const stats = { usageRatio: 0.88 } as any
      const msg = formatStageWarning('critical', stats)
      expect(msg).toContain('auto-compact')
    })

    it('includes compacting message for compact stage', () => {
      const stats = { usageRatio: 0.95 } as any
      const msg = formatStageWarning('compact', stats)
      expect(msg).toContain('compacting')
    })
  })

  describe('formatCompactPlan', () => {
    it('shows summary of plan', () => {
      const msgs = makeMessages(20, 500)
      const plan = planCompaction(msgs)
      const out = formatCompactPlan(plan)
      expect(out).toContain('Compaction Plan')
      expect(out).toContain('summarize')
      expect(out).toContain('keep')
      expect(out).toContain('savings')
    })
  })

  describe('formatStats', () => {
    it('includes key metrics', () => {
      const stats = analyzeContext(makeMessages(5), {
        ...DEFAULT_COMPACT_CONFIG,
        contextWindow: 100_000,
      })
      const out = formatStats(stats)
      expect(out).toContain('Context Window')
      expect(out).toContain('Remaining')
      expect(out).toContain('Messages')
      expect(out).toContain('Stage')
    })
  })

  describe('getContextWindowForModel', () => {
    it('returns known model context window', () => {
      expect(getContextWindowForModel('gpt-4o')).toBe(128_000)
      expect(getContextWindowForModel('claude-3-sonnet')).toBe(200_000)
      expect(getContextWindowForModel('gemini-1.5-pro')).toBe(2_000_000)
    })

    it('matches partial model names', () => {
      expect(getContextWindowForModel('gpt-4o-2024-05-13')).toBe(128_000)
      expect(getContextWindowForModel('claude-3-5-sonnet-20241022')).toBe(200_000)
    })

    it('returns default for unknown models', () => {
      expect(getContextWindowForModel('unknown-model')).toBe(DEFAULT_COMPACT_CONFIG.contextWindow)
    })

    it('MODEL_CONTEXT_WINDOWS has major models', () => {
      expect(Object.keys(MODEL_CONTEXT_WINDOWS).length).toBeGreaterThan(10)
    })
  })

  describe('createConfigForModel', () => {
    it('creates config with correct context window', () => {
      const config = createConfigForModel('gpt-4o')
      expect(config.contextWindow).toBe(128_000)
    })

    it('allows overrides', () => {
      const config = createConfigForModel('gpt-4o', { keepRecent: 20 })
      expect(config.contextWindow).toBe(128_000)
      expect(config.keepRecent).toBe(20)
    })

    it('uses default for unknown model', () => {
      const config = createConfigForModel('unknown')
      expect(config.contextWindow).toBe(DEFAULT_COMPACT_CONFIG.contextWindow)
    })
  })
})
