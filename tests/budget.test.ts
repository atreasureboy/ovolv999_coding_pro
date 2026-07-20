import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import {
  setBudget, removeBudget, getBudget, listBudgets,
  recordUsage, getUsage, checkBudget, checkAllBudgets,
  resetUsage, getBudgetSnapshot,
  formatBudgetUsage, formatProgressBar, formatBudgetSummary,
  formatBudgetSnapshot, applyPreset, BUDGET_PRESETS,
  getPeriodKey, getPeriodStart, getPeriodEnd,
  loadBudgetStore,
  type BudgetType, type BudgetPeriod,
} from '../src/core/budget.js'
import { mkdtempSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

function makeTempDir(): string {
  return mkdtempSync(join(tmpdir(), 'ovolv999-budget-'))
}

describe('Token Budget Management', () => {
  let cwd: string

  beforeEach(() => {
    cwd = makeTempDir()
  })

  afterEach(() => {
    rmSync(cwd, { recursive: true, force: true })
  })

  describe('period helpers', () => {
    it('getPeriodKey for daily', () => {
      const date = new Date('2025-01-15T12:00:00Z')
      expect(getPeriodKey('daily', date)).toBe('2025-01-15')
    })

    it('getPeriodKey for monthly', () => {
      const date = new Date('2025-03-20T12:00:00Z')
      expect(getPeriodKey('monthly', date)).toBe('2025-03')
    })

    it('getPeriodKey for session', () => {
      expect(getPeriodKey('session')).toBe('session')
    })

    it('getPeriodKey for weekly returns Monday date', () => {
      const date = new Date('2025-01-15T12:00:00Z') // Wednesday
      const key = getPeriodKey('weekly', date)
      // Monday of that week
      const monday = new Date('2025-01-13T00:00:00Z')
      expect(key).toBe(monday.toISOString().slice(0, 10))
    })

    it('getPeriodStart for daily returns midnight', () => {
      const date = new Date('2025-06-15T14:30:00Z')
      const start = getPeriodStart('daily', date)
      expect(start.getHours()).toBe(0)
    })

    it('getPeriodEnd for daily is start + 24h', () => {
      const date = new Date('2025-06-15T00:00:00Z')
      const end = getPeriodEnd('daily', date)
      const diff = end.getTime() - date.getTime()
      expect(diff).toBe(24 * 60 * 60 * 1000)
    })

    it('getPeriodEnd for monthly is start of next month', () => {
      const date = new Date('2025-01-15T00:00:00Z')
      const end = getPeriodEnd('monthly', date)
      expect(end.getMonth()).toBe(1) // February
    })
  })

  describe('setBudget', () => {
    it('creates a budget with defaults', () => {
      const bm = setBudget(cwd, {
        name: 'daily-tokens',
        type: 'tokens',
        period: 'daily',
        limit: 100_000,
      })
      expect(bm.name).toBe('daily-tokens')
      expect(bm.enforced).toBe(true)
      expect(bm.enabled).toBe(true)
      expect(bm.warningThreshold).toBe(0.8)
    })

    it('allows overriding defaults', () => {
      const bm = setBudget(cwd, {
        name: 'advisory-cost',
        type: 'cost',
        period: 'monthly',
        limit: 50,
        enforced: false,
        warningThreshold: 0.5,
        enabled: false,
      })
      expect(bm.enforced).toBe(false)
      expect(bm.warningThreshold).toBe(0.5)
      expect(bm.enabled).toBe(false)
    })

    it('overwrites existing budget with same name', () => {
      setBudget(cwd, { name: 'b1', type: 'tokens', period: 'daily', limit: 1000 })
      setBudget(cwd, { name: 'b1', type: 'cost', period: 'daily', limit: 5 })
      const bm = getBudget(cwd, 'b1')!
      expect(bm.type).toBe('cost')
      expect(bm.limit).toBe(5)
    })
  })

  describe('removeBudget', () => {
    it('removes budget', () => {
      setBudget(cwd, { name: 'b1', type: 'tokens', period: 'daily', limit: 1000 })
      expect(removeBudget(cwd, 'b1')).toBe(true)
      expect(getBudget(cwd, 'b1')).toBeNull()
    })

    it('returns false for missing budget', () => {
      expect(removeBudget(cwd, 'nope')).toBe(false)
    })

    it('cleans up usage data', () => {
      setBudget(cwd, { name: 'b1', type: 'tokens', period: 'daily', limit: 1000 })
      recordUsage(cwd, 'b1', 500)
      removeBudget(cwd, 'b1')
      const store = loadBudgetStore(cwd)
      expect(store.usage['b1']).toBeUndefined()
    })
  })

  describe('listBudgets', () => {
    it('returns all budgets', () => {
      setBudget(cwd, { name: 'b1', type: 'tokens', period: 'daily', limit: 1000 })
      setBudget(cwd, { name: 'b2', type: 'cost', period: 'monthly', limit: 10 })
      expect(listBudgets(cwd)).toHaveLength(2)
    })

    it('returns empty when no budgets', () => {
      expect(listBudgets(cwd)).toEqual([])
    })
  })

  describe('recordUsage and getUsage', () => {
    it('accumulates usage within period', () => {
      setBudget(cwd, { name: 'b1', type: 'tokens', period: 'daily', limit: 1000 })
      recordUsage(cwd, 'b1', 300)
      recordUsage(cwd, 'b1', 200)
      const usage = getUsage(cwd, 'b1')!
      expect(usage.spent).toBe(500)
      expect(usage.percent).toBe(50)
    })

    it('returns null for missing budget', () => {
      expect(getUsage(cwd, 'nope')).toBeNull()
    })

    it('tracks usage per period key', () => {
      setBudget(cwd, { name: 'b1', type: 'tokens', period: 'daily', limit: 1000 })
      const date1 = new Date('2025-01-15T12:00:00Z')
      const date2 = new Date('2025-01-16T12:00:00Z')
      recordUsage(cwd, 'b1', 400, date1)
      recordUsage(cwd, 'b1', 300, date2)
      const usage1 = getUsage(cwd, 'b1', date1)!
      expect(usage1.spent).toBe(400)
    })

    it('detects exceeded budget', () => {
      setBudget(cwd, { name: 'b1', type: 'tokens', period: 'daily', limit: 100 })
      recordUsage(cwd, 'b1', 150)
      const usage = getUsage(cwd, 'b1')!
      expect(usage.exceeded).toBe(true)
      expect(usage.remaining).toBe(0)
    })

    it('detects warning threshold', () => {
      setBudget(cwd, { name: 'b1', type: 'tokens', period: 'daily', limit: 100, warningThreshold: 0.8 })
      recordUsage(cwd, 'b1', 85)
      const usage = getUsage(cwd, 'b1')!
      expect(usage.warning).toBe(true)
      expect(usage.exceeded).toBe(false)
    })

    it('calculates remaining correctly', () => {
      setBudget(cwd, { name: 'b1', type: 'cost', period: 'daily', limit: 10 })
      recordUsage(cwd, 'b1', 3.5)
      const usage = getUsage(cwd, 'b1')!
      expect(usage.remaining).toBeCloseTo(6.5, 5)
    })

    it('does not record for disabled budget', () => {
      setBudget(cwd, { name: 'b1', type: 'tokens', period: 'daily', limit: 100, enabled: false })
      const result = recordUsage(cwd, 'b1', 50)
      expect(result).toBeNull()
    })
  })

  describe('checkBudget', () => {
    it('allows when under limit', () => {
      setBudget(cwd, { name: 'b1', type: 'tokens', period: 'daily', limit: 1000 })
      recordUsage(cwd, 'b1', 200)
      const check = checkBudget(cwd, 'b1')
      expect(check.allowed).toBe(true)
    })

    it('blocks when exceeded and enforced', () => {
      setBudget(cwd, { name: 'b1', type: 'tokens', period: 'daily', limit: 100, enforced: true })
      recordUsage(cwd, 'b1', 150)
      const check = checkBudget(cwd, 'b1')
      expect(check.allowed).toBe(false)
      expect(check.reason).toContain('exceeded')
    })

    it('allows when exceeded but advisory', () => {
      setBudget(cwd, { name: 'b1', type: 'tokens', period: 'daily', limit: 100, enforced: false })
      recordUsage(cwd, 'b1', 150)
      const check = checkBudget(cwd, 'b1')
      expect(check.allowed).toBe(true)
      expect(check.reason).toContain('advisory')
    })

    it('warns at threshold', () => {
      setBudget(cwd, { name: 'b1', type: 'tokens', period: 'daily', limit: 100, warningThreshold: 0.8 })
      recordUsage(cwd, 'b1', 85)
      const check = checkBudget(cwd, 'b1')
      expect(check.allowed).toBe(true)
      expect(check.reason).toContain('WARNING')
    })

    it('returns allowed for missing budget', () => {
      const check = checkBudget(cwd, 'nope')
      expect(check.allowed).toBe(true)
    })

    it('returns allowed for disabled budget', () => {
      setBudget(cwd, { name: 'b1', type: 'tokens', period: 'daily', limit: 100, enabled: false })
      const check = checkBudget(cwd, 'b1')
      expect(check.allowed).toBe(true)
    })
  })

  describe('checkAllBudgets', () => {
    it('checks all active budgets', () => {
      setBudget(cwd, { name: 'b1', type: 'tokens', period: 'daily', limit: 100 })
      setBudget(cwd, { name: 'b2', type: 'cost', period: 'daily', limit: 10 })
      recordUsage(cwd, 'b1', 150)
      const result = checkAllBudgets(cwd)
      expect(result.allAllowed).toBe(false)
      expect(result.results).toHaveLength(2)
    })

    it('allAllowed true when nothing exceeded', () => {
      setBudget(cwd, { name: 'b1', type: 'tokens', period: 'daily', limit: 1000 })
      const result = checkAllBudgets(cwd)
      expect(result.allAllowed).toBe(true)
    })
  })

  describe('resetUsage', () => {
    it('clears usage for a budget', () => {
      setBudget(cwd, { name: 'b1', type: 'tokens', period: 'daily', limit: 100 })
      recordUsage(cwd, 'b1', 80)
      resetUsage(cwd, 'b1')
      const usage = getUsage(cwd, 'b1')!
      expect(usage.spent).toBe(0)
    })

    it('returns false for missing budget', () => {
      expect(resetUsage(cwd, 'nope')).toBe(false)
    })
  })

  describe('getBudgetSnapshot', () => {
    it('returns full snapshot', () => {
      setBudget(cwd, { name: 'b1', type: 'tokens', period: 'daily', limit: 1000 })
      recordUsage(cwd, 'b1', 300)
      const snap = getBudgetSnapshot(cwd, 'b1')!
      expect(snap.config.name).toBe('b1')
      expect(snap.usage.spent).toBe(300)
      expect(snap.periodStart).toBeDefined()
      expect(snap.periodEnd).toBeDefined()
    })

    it('returns null for missing budget', () => {
      expect(getBudgetSnapshot(cwd, 'nope')).toBeNull()
    })
  })

  describe('formatProgressBar', () => {
    it('renders empty bar', () => {
      const bar = formatProgressBar(0, 10)
      expect(bar).toBe('[░░░░░░░░░░]')
    })

    it('renders full bar', () => {
      const bar = formatProgressBar(1, 10)
      expect(bar).toBe('[██████████]')
    })

    it('renders partial bar', () => {
      const bar = formatProgressBar(0.5, 10)
      expect(bar).toBe('[█████░░░░░]')
    })

    it('clamps overflow', () => {
      const bar = formatProgressBar(1.5, 10)
      expect(bar).toBe('[██████████]')
    })

    it('clamps negative', () => {
      const bar = formatProgressBar(-0.5, 10)
      expect(bar).toBe('[░░░░░░░░░░]')
    })
  })

  describe('formatBudgetUsage', () => {
    it('includes name, type, percent', () => {
      setBudget(cwd, { name: 'daily-tok', type: 'tokens', period: 'daily', limit: 1000 })
      recordUsage(cwd, 'daily-tok', 500)
      const config = getBudget(cwd, 'daily-tok')!
      const usage = getUsage(cwd, 'daily-tok')!
      const out = formatBudgetUsage(config, usage)
      expect(out).toContain('daily-tok')
      expect(out).toContain('tokens')
      expect(out).toContain('50%')
      expect(out).toContain('500 / 1.0K')
    })

    it('shows OK status when healthy', () => {
      setBudget(cwd, { name: 'b1', type: 'cost', period: 'daily', limit: 10 })
      const config = getBudget(cwd, 'b1')!
      const usage = getUsage(cwd, 'b1')!
      const out = formatBudgetUsage(config, usage)
      expect(out).toContain('OK')
    })

    it('shows WARNING status at threshold', () => {
      setBudget(cwd, { name: 'b1', type: 'cost', period: 'daily', limit: 10, warningThreshold: 0.5 })
      recordUsage(cwd, 'b1', 6)
      const config = getBudget(cwd, 'b1')!
      const usage = getUsage(cwd, 'b1')!
      const out = formatBudgetUsage(config, usage)
      expect(out).toContain('WARNING')
    })

    it('shows EXCEEDED when over limit', () => {
      setBudget(cwd, { name: 'b1', type: 'cost', period: 'daily', limit: 10 })
      recordUsage(cwd, 'b1', 15)
      const config = getBudget(cwd, 'b1')!
      const usage = getUsage(cwd, 'b1')!
      const out = formatBudgetUsage(config, usage)
      expect(out).toContain('EXCEEDED')
    })

    it('marks advisory budgets', () => {
      setBudget(cwd, { name: 'b1', type: 'cost', period: 'daily', limit: 10, enforced: false })
      const config = getBudget(cwd, 'b1')!
      const usage = getUsage(cwd, 'b1')!
      const out = formatBudgetUsage(config, usage)
      expect(out).toContain('[advisory]')
    })
  })

  describe('formatBudgetSummary', () => {
    it('shows message when no budgets', () => {
      expect(formatBudgetSummary(cwd)).toContain('No budgets')
    })

    it('lists all budgets', () => {
      setBudget(cwd, { name: 'b1', type: 'tokens', period: 'daily', limit: 1000 })
      setBudget(cwd, { name: 'b2', type: 'cost', period: 'monthly', limit: 50 })
      const out = formatBudgetSummary(cwd)
      expect(out).toContain('b1')
      expect(out).toContain('b2')
      expect(out).toContain('Total: 2 budget')
    })
  })

  describe('formatBudgetSnapshot', () => {
    it('includes period info', () => {
      setBudget(cwd, { name: 'b1', type: 'tokens', period: 'daily', limit: 1000 })
      recordUsage(cwd, 'b1', 100)
      const snap = getBudgetSnapshot(cwd, 'b1')!
      const out = formatBudgetSnapshot(snap)
      expect(out).toContain('Period:')
      expect(out).toContain('10%')
    })
  })

  describe('presets', () => {
    it('conservative preset has 2 budgets', () => {
      const budgets = applyPreset(cwd, 'conservative')
      expect(budgets).toHaveLength(2)
      expect(budgets[0].name).toBe('daily-tokens')
      expect(budgets[1].name).toBe('daily-cost')
    })

    it('moderate preset has 3 budgets', () => {
      const budgets = applyPreset(cwd, 'moderate')
      expect(budgets).toHaveLength(3)
    })

    it('heavy preset has higher limits', () => {
      const lightBudgets = applyPreset(cwd, 'conservative')
      rmSync(cwd, { recursive: true, force: true })
      cwd = makeTempDir()
      const heavyBudgets = applyPreset(cwd, 'heavy')
      const lightDaily = lightBudgets.find(b => b.name === 'daily-tokens')!
      const heavyDaily = heavyBudgets.find(b => b.name === 'daily-tokens')!
      expect(heavyDaily.limit).toBeGreaterThan(lightDaily.limit)
    })

    it('BUDGET_PRESETS has all presets', () => {
      expect(Object.keys(BUDGET_PRESETS)).toEqual(['conservative', 'moderate', 'heavy'])
    })
  })
})
