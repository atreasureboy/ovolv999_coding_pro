/**
 * Tests for src/utils/cacheStats.ts
 */

import { describe, it, expect, beforeEach, beforeAll, afterAll, vi } from 'vitest'
import {
  resetCacheStats,
  recordCacheEntry,
  getCacheStats,
  checkCacheHealth,
  estimateCostSavings,
  formatCacheStats,
  formatCacheWarning,
} from '../src/utils/cacheStats.js'
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

let storeDir: string
let origStoreDir: string | undefined

beforeAll(() => {
  // Never touch the real ~/.ovolv999 ledger from tests.
  storeDir = mkdtempSync(join(tmpdir(), 'ovolv999-cache-stats-'))
  origStoreDir = process.env.OVOLV999_TEST_STORE_DIR
  process.env.OVOLV999_TEST_STORE_DIR = storeDir
})

afterAll(() => {
  if (origStoreDir !== undefined) process.env.OVOLV999_TEST_STORE_DIR = origStoreDir
  else delete process.env.OVOLV999_TEST_STORE_DIR
  rmSync(storeDir, { recursive: true, force: true })
})

beforeEach(() => {
  resetCacheStats()
})

describe('cacheStats', () => {
  describe('recordCacheEntry / getCacheStats', () => {
    it('returns empty stats initially', () => {
      const stats = getCacheStats()
      expect(stats.totalRequests).toBe(0)
      expect(stats.cacheHits).toBe(0)
      expect(stats.cacheMisses).toBe(0)
      expect(stats.hitRate).toBe(0)
    })

    it('records hits', () => {
      recordCacheEntry('claude-sonnet-4', true, { inputTokens: 1000, outputTokens: 100, cacheReadTokens: 800 })
      recordCacheEntry('claude-sonnet-4', true, { inputTokens: 500, outputTokens: 50, cacheReadTokens: 400 })
      const stats = getCacheStats()
      expect(stats.cacheHits).toBe(2)
      expect(stats.cacheMisses).toBe(0)
      expect(stats.hitRate).toBeCloseTo(1.0)
    })

    it('records misses', () => {
      recordCacheEntry('claude-sonnet-4', false, { inputTokens: 800, outputTokens: 100 })
      const stats = getCacheStats()
      expect(stats.cacheHits).toBe(0)
      expect(stats.cacheMisses).toBe(1)
      expect(stats.hitRate).toBe(0)
    })

    it('computes hit rate', () => {
      for (let i = 0; i < 7; i++) recordCacheEntry('m', true, { inputTokens: 100, outputTokens: 10 })
      for (let i = 0; i < 3; i++) recordCacheEntry('m', false, { inputTokens: 100, outputTokens: 10 })
      const stats = getCacheStats()
      expect(stats.cacheHits).toBe(7)
      expect(stats.cacheMisses).toBe(3)
      expect(stats.hitRate).toBeCloseTo(0.7, 5)
    })

    it('tracks per-model stats as a record', () => {
      recordCacheEntry('gpt-4', true, { inputTokens: 100, outputTokens: 10 })
      recordCacheEntry('gpt-4', false, { inputTokens: 200, outputTokens: 20 })
      recordCacheEntry('claude', true, { inputTokens: 300, outputTokens: 30 })
      const stats = getCacheStats()
      expect(stats.byModel['gpt-4'].hits).toBe(1)
      expect(stats.byModel['gpt-4'].misses).toBe(1)
      expect(stats.byModel['claude'].hits).toBe(1)
      expect(stats.byModel['claude'].misses).toBe(0)
    })

    it('aggregates cache read/write tokens', () => {
      recordCacheEntry('m', true, { inputTokens: 100, outputTokens: 10, cacheReadTokens: 500, cacheWriteTokens: 200 })
      recordCacheEntry('m', true, { inputTokens: 100, outputTokens: 10, cacheReadTokens: 300, cacheWriteTokens: 100 })
      const stats = getCacheStats()
      expect(stats.totalCacheReadTokens).toBe(800)
      expect(stats.totalCacheWriteTokens).toBe(300)
    })

    it('resetCacheStats clears state', () => {
      recordCacheEntry('m', true, { inputTokens: 100, outputTokens: 10 })
      expect(getCacheStats().cacheHits).toBe(1)
      resetCacheStats()
      expect(getCacheStats().cacheHits).toBe(0)
    })
  })

  describe('checkCacheHealth', () => {
    it('returns null when hit rate is healthy', () => {
      for (let i = 0; i < 8; i++) recordCacheEntry('m', true, { inputTokens: 100, outputTokens: 10 })
      for (let i = 0; i < 2; i++) recordCacheEntry('m', false, { inputTokens: 100, outputTokens: 10 })
      expect(checkCacheHealth(0.3)).toBeNull()
    })

    it('returns warning when hit rate is below threshold', () => {
      for (let i = 0; i < 2; i++) recordCacheEntry('m', true, { inputTokens: 100, outputTokens: 10 })
      for (let i = 0; i < 8; i++) recordCacheEntry('m', false, { inputTokens: 100, outputTokens: 10 })
      const warning = checkCacheHealth(0.3)
      expect(warning).not.toBeNull()
      expect(warning!.level).toMatch(/warning|critical/)
    })

    it('returns null with fewer than 10 requests', () => {
      for (let i = 0; i < 5; i++) recordCacheEntry('m', false, { inputTokens: 100, outputTokens: 10 })
      expect(checkCacheHealth(0.3)).toBeNull()
    })
  })

  describe('estimateCostSavings', () => {
    it('estimates savings from cache hits', () => {
      // 10000 cacheRead tokens, $3/M input price, $0.30/M cache read, $3.75/M write
      const savings = estimateCostSavings(10_000, 0, 3.0, 0.3, 3.75)
      // input cost would have been 10000 * 3 / 1M = 0.03
      // cache read cost is 10000 * 0.3 / 1M = 0.003
      // savings = 0.03 - 0.003 = 0.027
      expect(savings).toBeCloseTo(0.027, 4)
    })

    it('subtracts write cost', () => {
      const savings = estimateCostSavings(10_000, 1_000, 3.0, 0.3, 3.75)
      // 0.03 - 0.003 - (1000*3.75/1M=0.00375)
      expect(savings).toBeCloseTo(0.02325, 4)
    })

    it('returns ~0 when nothing cached', () => {
      expect(estimateCostSavings(0, 0, 3.0, 0.3, 3.75)).toBe(0)
    })
  })

  describe('formatCacheStats', () => {
    it('formats non-empty stats', () => {
      recordCacheEntry('m', true, { inputTokens: 500, outputTokens: 10, cacheReadTokens: 400 })
      const out = formatCacheStats(getCacheStats())
      expect(typeof out).toBe('string')
      expect(out).toContain('Cache Stats')
      expect(out).toContain('Hit rate')
    })

    it('formats empty stats', () => {
      const out = formatCacheStats(getCacheStats())
      expect(out).toContain('0')
    })

    it('lists per-model breakdown when more than one model', () => {
      recordCacheEntry('a', true, { inputTokens: 100, outputTokens: 10 })
      recordCacheEntry('b', true, { inputTokens: 100, outputTokens: 10 })
      const out = formatCacheStats(getCacheStats())
      expect(out).toContain('By model')
    })
  })

  describe('formatCacheWarning', () => {
    it('formats a warning', () => {
      for (let i = 0; i < 9; i++) recordCacheEntry('m', false, { inputTokens: 100, outputTokens: 10 })
      recordCacheEntry('m', true, { inputTokens: 100, outputTokens: 10 })
      const warning = checkCacheHealth(0.3)
      expect(warning).not.toBeNull()
      const out = formatCacheWarning(warning!)
      expect(out.length).toBeGreaterThan(0)
    })
  })
})

describe('cache-stats store corruption guard', () => {
  it('preserves a corrupt ledger, then the next record rebuilds it', async () => {
    const path = join(storeDir, 'cache-stats.json')
    const backup = `${path}.corrupt`
    writeFileSync(path, '[{"timestamp": torn', 'utf8')

    // Fresh module instance — loadEntries latches `initialized` on first read.
    vi.resetModules()
    const mod = await import('../src/utils/cacheStats.js')
    mod.recordCacheEntry('m', true, { inputTokens: 100, outputTokens: 10 })

    expect(readFileSync(backup, 'utf8')).toBe('[{"timestamp": torn')
    const stats = mod.getCacheStats()
    expect(stats.totalRequests).toBe(1)
    expect(mod.recordCacheEntry('m', true, { inputTokens: 100, outputTokens: 10 }))
    expect(readFileSync(backup, 'utf8')).toBe('[{"timestamp": torn')
  })

  it('rejects shape-violating entries (non-boolean cacheHit)', async () => {
    const path = join(storeDir, 'cache-stats.json')
    writeFileSync(path, JSON.stringify([{ timestamp: 't', model: 'm', cacheHit: 'yes' }]), 'utf8')
    vi.resetModules()
    const mod = await import('../src/utils/cacheStats.js')
    expect(mod.getCacheStats().totalRequests).toBe(0)
  })
})
