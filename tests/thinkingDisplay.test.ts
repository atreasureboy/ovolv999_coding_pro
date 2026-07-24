import { describe, it, expect } from 'vitest'
import {
  hasUltrathinkTrigger,
  findUltrathinkPositions,
  rainbow,
  colorizeUltrathink,
  createThinkingBlock,
  finalizeThinkingBlock,
  getThinkingDuration,
  truncate,
  formatCollapsed,
  formatExpanded,
  formatThinking,
  ThinkingDisplayManager,
  ULTRATHINK_TRIGGERS,
  type ThinkingBlock,
} from '../src/ui/thinkingDisplay.js'

describe('thinkingDisplay', () => {
  describe('hasUltrathinkTrigger', () => {
    it('detects "ultrathink"', () => {
      expect(hasUltrathinkTrigger('please ultrathink about this')).toBe(true)
    })

    it('detects "think hard"', () => {
      expect(hasUltrathinkTrigger('think hard about this')).toBe(true)
    })

    it('detects "think harder"', () => {
      expect(hasUltrathinkTrigger('think harder')).toBe(true)
    })

    it('is case insensitive', () => {
      expect(hasUltrathinkTrigger('ULTRATHINK now')).toBe(true)
      expect(hasUltrathinkTrigger('Think Hard')).toBe(true)
    })

    it('returns false for no trigger', () => {
      expect(hasUltrathinkTrigger('just a normal prompt')).toBe(false)
    })

    it('returns false for empty string', () => {
      expect(hasUltrathinkTrigger('')).toBe(false)
    })

    it('detects multiple triggers', () => {
      expect(hasUltrathinkTrigger('ultrathink and think step by step')).toBe(true)
    })
  })

  describe('findUltrathinkPositions', () => {
    it('finds single trigger', () => {
      const positions = findUltrathinkPositions('hello ultrathink world')
      expect(positions.length).toBe(1)
      expect(positions[0].trigger).toBe('ultrathink')
      expect(positions[0].start).toBe(6)
      expect(positions[0].end).toBe(16)
    })

    it('finds multiple triggers', () => {
      const positions = findUltrathinkPositions('ultrathink and think hard')
      expect(positions.length).toBeGreaterThanOrEqual(2)
    })

    it('returns empty for no triggers', () => {
      expect(findUltrathinkPositions('no triggers here')).toEqual([])
    })

    it('sorts by position', () => {
      const positions = findUltrathinkPositions('think hard then ultrathink')
      expect(positions[0].start).toBeLessThan(positions[1].start)
    })
  })

  describe('rainbow', () => {
    it('wraps text in color codes', () => {
      const result = rainbow('abc')
      expect(result).toContain('\x1b[38;5;')
      expect(result).toContain('\x1b[0m')
    })

    it('applies different colors to different chars', () => {
      const result = rainbow('ab')
      // Should contain at least 2 different color codes
      // eslint-disable-next-line no-control-regex
      const colorCodes = result.match(/\x1b\[38;5;(\d+)m/g)
      expect(colorCodes!.length).toBeGreaterThanOrEqual(2)
    })

    it('resets at end', () => {
      const result = rainbow('x')
      expect(result.endsWith('\x1b[0m')).toBe(true)
    })

    it('handles empty string', () => {
      expect(rainbow('')).toBe('\x1b[0m')
    })
  })

  describe('colorizeUltrathink', () => {
    it('colorizes trigger words in text', () => {
      const result = colorizeUltrathink('hello ultrathink world')
      // The non-trigger text should not have color codes
      // The trigger word should
      expect(result).toContain('\x1b[38;5;')
      expect(result).toContain('hello')
      expect(result).toContain('world')
    })

    it('preserves non-trigger text', () => {
      const result = colorizeUltrathink('just normal text')
      expect(result).toBe('just normal text')
    })

    it('handles multiple triggers', () => {
      const result = colorizeUltrathink('ultrathink then think hard')
      expect(result).toContain('\x1b[38;5;')
    })
  })

  describe('createThinkingBlock', () => {
    it('creates a streaming block', () => {
      const block = createThinkingBlock('initial')
      expect(block.content).toBe('initial')
      expect(block.isStreaming).toBe(true)
      expect(block.endTime).toBeNull()
      expect(block.expanded).toBe(false)
      expect(block.ultrathink).toBe(false)
      expect(typeof block.startTime).toBe('number')
    })

    it('supports ultrathink flag', () => {
      const block = createThinkingBlock('', true)
      expect(block.ultrathink).toBe(true)
    })

    it('defaults to empty content', () => {
      const block = createThinkingBlock()
      expect(block.content).toBe('')
    })
  })

  describe('finalizeThinkingBlock', () => {
    it('sets endTime and stops streaming', () => {
      const block = createThinkingBlock('thinking...')
      const finalized = finalizeThinkingBlock(block)
      expect(finalized.isStreaming).toBe(false)
      expect(finalized.endTime).not.toBeNull()
      expect(finalized.endTime).toBeGreaterThanOrEqual(block.startTime)
    })
  })

  describe('getThinkingDuration', () => {
    it('calculates duration from start to end', () => {
      const block: ThinkingBlock = {
        content: 'x',
        startTime: 1000,
        endTime: 2500,
        isStreaming: false,
        expanded: false,
        ultrathink: false,
      }
      expect(getThinkingDuration(block)).toBe(1.5)
    })

    it('uses now for streaming blocks', () => {
      const block = createThinkingBlock('x')
      const duration = getThinkingDuration(block)
      expect(duration).toBeGreaterThanOrEqual(0)
      expect(duration).toBeLessThan(1) // Should be very small
    })
  })

  describe('truncate', () => {
    it('returns short text unchanged', () => {
      expect(truncate('hello', 100)).toBe('hello')
    })

    it('truncates long text', () => {
      const long = 'a'.repeat(200)
      const result = truncate(long, 50)
      expect(result.length).toBeLessThan(long.length)
      expect(result).toContain('...')
    })

    it('preserves start and end', () => {
      const text = 'START_MIDDLE_END'
      const result = truncate(text, 15)
      expect(result).toContain('START')
      expect(result).toContain('END')
    })
  })

  describe('formatCollapsed', () => {
    it('includes label', () => {
      const block = createThinkingBlock('thinking content', false)
      const finalized = finalizeThinkingBlock(block)
      const result = formatCollapsed(finalized)
      expect(result).toContain('Thinking')
    })

    it('shows streaming indicator while streaming', () => {
      const block = createThinkingBlock('thinking...')
      const result = formatCollapsed(block)
      expect(result).toContain('...')
    })

    it('shows timing after finalization', () => {
      const block = createThinkingBlock('thinking...')
      const finalized = finalizeThinkingBlock(block)
      const result = formatCollapsed(finalized)
      expect(result).toContain('thought for')
    })

    it('shows content preview', () => {
      const block = createThinkingBlock('Let me analyze this step by step')
      const finalized = finalizeThinkingBlock(block)
      const result = formatCollapsed(finalized)
      expect(result).toContain('Let me analyze')
    })

    it('uses different icon for ultrathink', () => {
      const block = createThinkingBlock('deep thoughts', true)
      const finalized = finalizeThinkingBlock(block)
      const result = formatCollapsed(finalized)
      expect(result).toContain('✻')
    })

    it('uses normal icon for regular thinking', () => {
      const block = createThinkingBlock('thoughts', false)
      const finalized = finalizeThinkingBlock(block)
      const result = formatCollapsed(finalized)
      expect(result).toContain('∴')
    })
  })

  describe('formatExpanded', () => {
    it('shows full content', () => {
      const block = createThinkingBlock('Full thinking content with details')
      const finalized = finalizeThinkingBlock(block)
      const result = formatExpanded(finalized)
      expect(result).toContain('Full thinking content')
    })

    it('includes header', () => {
      const block = createThinkingBlock('x')
      const result = formatExpanded(block)
      expect(result).toContain('Thinking')
    })

    it('includes end marker', () => {
      const block = createThinkingBlock('x')
      const result = formatExpanded(block)
      expect(result).toContain('End Thinking')
    })

    it('shows timing for finalized blocks', () => {
      const block = createThinkingBlock('x')
      const finalized = finalizeThinkingBlock(block)
      const result = formatExpanded(finalized)
      expect(result).toContain('Duration')
    })
  })

  describe('formatThinking', () => {
    it('formats collapsed when not expanded', () => {
      const block = createThinkingBlock('x')
      block.expanded = false
      const result = formatThinking(block)
      expect(result).toContain('Thinking')
      // Collapsed shows "Ctrl+O" hint
      // Actually only for finalized blocks
    })

    it('formats expanded when expanded', () => {
      const block = createThinkingBlock('deep thoughts')
      block.expanded = true
      const result = formatThinking(block)
      expect(result).toContain('deep thoughts')
      expect(result).toContain('End Thinking')
    })
  })

  describe('ThinkingDisplayManager', () => {
    it('starts and ends blocks', () => {
      const mgr = new ThinkingDisplayManager()
      mgr.startBlock('b1')
      mgr.appendContent('b1', 'thinking content')
      const finalized = mgr.endBlock('b1')
      expect(finalized).not.toBeNull()
      expect(finalized!.content).toBe('thinking content')
      expect(finalized!.isStreaming).toBe(false)
    })

    it('manages multiple blocks in order', () => {
      const mgr = new ThinkingDisplayManager()
      mgr.startBlock('b1')
      mgr.startBlock('b2')
      mgr.startBlock('b3')
      const blocks = mgr.getAll()
      expect(blocks.length).toBe(3)
    })

    it('toggleExpand flips state', () => {
      const mgr = new ThinkingDisplayManager()
      mgr.startBlock('b1')
      expect(mgr.getAll()[0].expanded).toBe(false)
      mgr.toggleExpand('b1')
      expect(mgr.getAll()[0].expanded).toBe(true)
      mgr.toggleExpand('b1')
      expect(mgr.getAll()[0].expanded).toBe(false)
    })

    it('expandAll and collapseAll', () => {
      const mgr = new ThinkingDisplayManager()
      mgr.startBlock('b1')
      mgr.startBlock('b2')
      mgr.expandAll()
      expect(mgr.getAll().every(b => b.expanded)).toBe(true)
      mgr.collapseAll()
      expect(mgr.getAll().every(b => !b.expanded)).toBe(true)
    })

    it('getTotalDuration sums all blocks', () => {
      const mgr = new ThinkingDisplayManager()
      mgr.startBlock('b1')
      mgr.endBlock('b1')
      mgr.startBlock('b2')
      mgr.endBlock('b2')
      const total = mgr.getTotalDuration()
      expect(total).toBeGreaterThanOrEqual(0)
    })

    it('getTotalChars sums content lengths', () => {
      const mgr = new ThinkingDisplayManager()
      mgr.startBlock('b1')
      mgr.appendContent('b1', 'abc')
      mgr.startBlock('b2')
      mgr.appendContent('b2', 'de')
      expect(mgr.getTotalChars()).toBe(5)
    })

    it('clear removes all blocks', () => {
      const mgr = new ThinkingDisplayManager()
      mgr.startBlock('b1')
      mgr.startBlock('b2')
      mgr.clear()
      expect(mgr.getAll().length).toBe(0)
    })

    it('formatSummary shows block count', () => {
      const mgr = new ThinkingDisplayManager()
      mgr.startBlock('b1')
      mgr.endBlock('b1')
      mgr.startBlock('b2')
      mgr.endBlock('b2')
      const summary = mgr.formatSummary()
      expect(summary).toContain('2 block')
      expect(summary).toContain('Total')
    })

    it('formatSummary returns empty for no blocks', () => {
      const mgr = new ThinkingDisplayManager()
      expect(mgr.formatSummary()).toBe('')
    })

    it('endBlock returns null for unknown id', () => {
      const mgr = new ThinkingDisplayManager()
      expect(mgr.endBlock('unknown')).toBeNull()
    })
  })

  describe('ULTRATHINK_TRIGGERS', () => {
    it('is a non-empty set', () => {
      expect(ULTRATHINK_TRIGGERS.size).toBeGreaterThan(5)
    })

    it('contains "ultrathink"', () => {
      expect(ULTRATHINK_TRIGGERS.has('ultrathink')).toBe(true)
    })
  })
})
