import { describe, it, expect, beforeEach } from 'vitest'
import {
  EFFORT_PRESETS,
  getCurrentEffort,
  setEffort,
  getEffortConfig,
  cycleEffort,
  getEffortPrompt,
  formatEffort,
  formatEffortList,
} from '../src/core/effort.js'

describe('effort', () => {
  beforeEach(() => {
    setEffort('medium')
  })

  describe('EFFORT_PRESETS', () => {
    it('has 5 levels', () => {
      expect(Object.keys(EFFORT_PRESETS)).toHaveLength(5)
    })

    it('has minimal', () => {
      expect(EFFORT_PRESETS.minimal.thinkingTokens).toBe(0)
      expect(EFFORT_PRESETS.minimal.verificationDepth).toBe('none')
    })

    it('has maximum with high tokens', () => {
      expect(EFFORT_PRESETS.maximum.thinkingTokens).toBe(10000)
      expect(EFFORT_PRESETS.maximum.multiApproach).toBe(true)
    })

    it('escalates thinking tokens monotonically', () => {
      const levels = ['minimal', 'low', 'medium', 'high', 'maximum'] as const
      for (let i = 1; i < levels.length; i++) {
        expect(EFFORT_PRESETS[levels[i]].thinkingTokens).toBeGreaterThanOrEqual(
          EFFORT_PRESETS[levels[i - 1]].thinkingTokens
        )
      }
    })

    it('escalates search results monotonically', () => {
      const levels = ['minimal', 'low', 'medium', 'high', 'maximum'] as const
      for (let i = 1; i < levels.length; i++) {
        expect(EFFORT_PRESETS[levels[i]].maxSearchResults).toBeGreaterThanOrEqual(
          EFFORT_PRESETS[levels[i - 1]].maxSearchResults
        )
      }
    })
  })

  describe('getCurrentEffort / setEffort', () => {
    it('defaults to medium', () => {
      expect(getCurrentEffort()).toBe('medium')
    })

    it('sets effort', () => {
      setEffort('maximum')
      expect(getCurrentEffort()).toBe('maximum')
    })

    it('setEffort returns config', () => {
      const cfg = setEffort('high')
      expect(cfg.level).toBe('high')
    })
  })

  describe('getEffortConfig', () => {
    it('returns config for given level', () => {
      const cfg = getEffortConfig('minimal')
      expect(cfg.level).toBe('minimal')
      expect(cfg.thinkingTokens).toBe(0)
    })

    it('returns current config when no arg', () => {
      setEffort('low')
      const cfg = getEffortConfig()
      expect(cfg.level).toBe('low')
    })
  })

  describe('cycleEffort', () => {
    it('cycles through levels', () => {
      setEffort('minimal')
      expect(cycleEffort()).toBe('low')
      expect(cycleEffort()).toBe('medium')
      expect(cycleEffort()).toBe('high')
      expect(cycleEffort()).toBe('maximum')
      expect(cycleEffort()).toBe('minimal')
    })
  })

  describe('getEffortPrompt', () => {
    it('returns empty for minimal', () => {
      const p = getEffortPrompt('minimal')
      expect(p).toBeTruthy()
    })

    it('includes thinking tokens for high', () => {
      const p = getEffortPrompt('high')
      expect(p).toContain('thinking tokens')
    })

    it('includes multi-approach for high', () => {
      const p = getEffortPrompt('high')
      expect(p).toMatch(/multiple approaches/i)
    })

    it('includes edge cases for maximum', () => {
      const p = getEffortPrompt('maximum')
      expect(p).toMatch(/edge cases/i)
    })

    it('includes verification for thorough', () => {
      const p = getEffortPrompt('high')
      expect(p).toMatch(/verify/i)
    })
  })

  describe('formatEffort', () => {
    it('includes level name', () => {
      const s = formatEffort('medium')
      expect(s).toContain('medium')
    })

    it('includes icon', () => {
      const s = formatEffort('maximum')
      expect(s).toContain('★')
    })

    it('includes thinking tokens', () => {
      const s = formatEffort('high')
      expect(s).toContain('5000')
    })
  })

  describe('formatEffortList', () => {
    it('lists all 5 levels', () => {
      const s = formatEffortList()
      expect(s).toContain('minimal')
      expect(s).toContain('low')
      expect(s).toContain('medium')
      expect(s).toContain('high')
      expect(s).toContain('maximum')
    })

    it('marks active level', () => {
      setEffort('high')
      const s = formatEffortList()
      expect(s).toContain('active')
    })
  })
})
