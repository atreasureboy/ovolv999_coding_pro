/**
 * Token Budget Management
 *
 * Set and enforce token/cost budgets per session or per task.
 * Provides warnings when approaching limits and hard stops when exceeded.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { join, resolve } from 'path'

// ── Types ───────────────────────────────────────────────────────────────────

export type BudgetType = 'tokens' | 'cost' | 'requests'

export type BudgetPeriod = 'session' | 'daily' | 'weekly' | 'monthly'

export interface BudgetConfig {
  /** Unique name */
  name: string
  /** What to limit */
  type: BudgetType
  /** Time period */
  period: BudgetPeriod
  /** Maximum allowed value */
  limit: number
  /** Whether the budget is enforced (hard stop) or just advisory */
  enforced: boolean
  /** Warning threshold (0-1, default 0.8) */
  warningThreshold: number
  /** Whether this budget is enabled */
  enabled: boolean
}

export interface BudgetUsage {
  /** Current spent amount */
  spent: number
  /** Budget limit */
  limit: number
  /** Usage ratio (0-1+) */
  ratio: number
  /** Remaining budget */
  remaining: number
  /** Whether limit is exceeded */
  exceeded: boolean
  /** Whether warning threshold is reached */
  warning: boolean
  /** Percentage used (0-100) */
  percent: number
}

export interface BudgetSnapshot {
  config: BudgetConfig
  usage: BudgetUsage
  /** Period start timestamp */
  periodStart: string
  /** Period end timestamp (when it resets) */
  periodEnd: string
  /** History of resets */
  lastReset: string | null
}

export interface BudgetStore {
  budgets: Record<string, BudgetConfig>
  /** Usage tracking: name → period key → amount */
  usage: Record<string, Record<string, number>>
  /** Reset timestamps */
  resets: Record<string, string>
}

// ── Persistence ─────────────────────────────────────────────────────────────

export function getBudgetPath(cwd: string): string {
  return join(resolve(cwd), '.ovolv999', 'budgets.json')
}

export function loadBudgetStore(cwd: string): BudgetStore {
  const path = getBudgetPath(cwd)
  if (!existsSync(path)) {
    return { budgets: {}, usage: {}, resets: {} }
  }
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as BudgetStore
  } catch {
    return { budgets: {}, usage: {}, resets: {} }
  }
}

export function saveBudgetStore(cwd: string, store: BudgetStore): void {
  const dir = join(resolve(cwd), '.ovolv999')
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true })
  }
  writeFileSync(getBudgetPath(cwd), JSON.stringify(store, null, 2), 'utf8')
}

// ── Period Helpers ──────────────────────────────────────────────────────────

export function getPeriodKey(period: BudgetPeriod, date = new Date()): string {
  switch (period) {
    case 'session':
      return 'session'
    case 'daily':
      return date.toISOString().slice(0, 10) // YYYY-MM-DD
    case 'weekly': {
      // Get ISO week
      const tmp = new Date(date)
      tmp.setHours(0, 0, 0, 0)
      tmp.setDate(tmp.getDate() - ((tmp.getDay() + 6) % 7))
      return tmp.toISOString().slice(0, 10)
    }
    case 'monthly':
      return date.toISOString().slice(0, 7) // YYYY-MM
  }
}

export function getPeriodStart(period: BudgetPeriod, date = new Date()): Date {
  const d = new Date(date)
  switch (period) {
    case 'session':
      return d
    case 'daily':
      d.setHours(0, 0, 0, 0)
      return d
    case 'weekly': {
      d.setHours(0, 0, 0, 0)
      d.setDate(d.getDate() - ((d.getDay() + 6) % 7))
      return d
    }
    case 'monthly':
      d.setDate(1)
      d.setHours(0, 0, 0, 0)
      return d
  }
}

export function getPeriodEnd(period: BudgetPeriod, date = new Date()): Date {
  const start = getPeriodStart(period, date)
  switch (period) {
    case 'session':
      return new Date(8.64e15) // max date
    case 'daily':
      return new Date(start.getTime() + 24 * 60 * 60 * 1000)
    case 'weekly':
      return new Date(start.getTime() + 7 * 24 * 60 * 60 * 1000)
    case 'monthly':
      return new Date(start.getFullYear(), start.getMonth() + 1, 1)
  }
}

// ── Budget CRUD ─────────────────────────────────────────────────────────────

export function setBudget(
  cwd: string,
  config: Omit<BudgetConfig, 'enabled' | 'enforced' | 'warningThreshold'> &
    Partial<Pick<BudgetConfig, 'enabled' | 'enforced' | 'warningThreshold'>>,
): BudgetConfig {
  const store = loadBudgetStore(cwd)
  const budget: BudgetConfig = {
    name: config.name,
    type: config.type,
    period: config.period,
    limit: config.limit,
    enforced: config.enforced ?? true,
    warningThreshold: config.warningThreshold ?? 0.8,
    enabled: config.enabled ?? true,
  }
  store.budgets[budget.name] = budget
  saveBudgetStore(cwd, store)
  return budget
}

export function removeBudget(cwd: string, name: string): boolean {
  const store = loadBudgetStore(cwd)
  if (!store.budgets[name]) return false
  delete store.budgets[name]
  delete store.usage[name]
  delete store.resets[name]
  saveBudgetStore(cwd, store)
  return true
}

export function getBudget(cwd: string, name: string): BudgetConfig | null {
  const store = loadBudgetStore(cwd)
  return store.budgets[name] ?? null
}

export function listBudgets(cwd: string): BudgetConfig[] {
  const store = loadBudgetStore(cwd)
  return Object.values(store.budgets)
}

// ── Usage Tracking ──────────────────────────────────────────────────────────

export function recordUsage(
  cwd: string,
  budgetName: string,
  amount: number,
  date = new Date(),
): BudgetUsage | null {
  const store = loadBudgetStore(cwd)
  const config = store.budgets[budgetName]
  if (!config || !config.enabled) return null

  const periodKey = getPeriodKey(config.period, date)
  if (!store.usage[budgetName]) store.usage[budgetName] = {}
  store.usage[budgetName][periodKey] = (store.usage[budgetName][periodKey] ?? 0) + amount

  // Track reset
  if (!store.resets[budgetName]) {
    store.resets[budgetName] = new Date().toISOString()
  }

  saveBudgetStore(cwd, store)
  return getUsage(cwd, budgetName, date)
}

export function getUsage(
  cwd: string,
  budgetName: string,
  date = new Date(),
): BudgetUsage | null {
  const store = loadBudgetStore(cwd)
  const config = store.budgets[budgetName]
  if (!config) return null

  const periodKey = getPeriodKey(config.period, date)
  const spent = store.usage[budgetName]?.[periodKey] ?? 0
  const limit = config.limit
  const ratio = limit > 0 ? spent / limit : 0
  const remaining = Math.max(0, limit - spent)

  return {
    spent,
    limit,
    ratio,
    remaining,
    exceeded: spent >= limit,
    warning: ratio >= config.warningThreshold && !exceededOrEqual(spent, limit),
    percent: Math.round(ratio * 100),
  }
}

function exceededOrEqual(spent: number, limit: number): boolean {
  return spent >= limit
}

export function checkBudget(
  cwd: string,
  budgetName: string,
  date = new Date(),
): { allowed: boolean; reason: string; usage: BudgetUsage | null } {
  const config = getBudget(cwd, budgetName)
  if (!config || !config.enabled) {
    return { allowed: true, reason: 'No active budget', usage: null }
  }

  const usage = getUsage(cwd, budgetName, date)
  if (!usage) {
    return { allowed: true, reason: 'Unable to read usage', usage: null }
  }

  if (usage.exceeded) {
    if (config.enforced) {
      return {
        allowed: false,
        reason: `${config.type} budget "${config.name}" exceeded: ${usage.spent}/${usage.limit} (${usage.percent}%)`,
        usage,
      }
    }
    return {
      allowed: true,
      reason: `⚠ WARNING: ${config.type} budget "${config.name}" exceeded: ${usage.spent}/${usage.limit} (${usage.percent}%) [advisory]`,
      usage,
    }
  }

  if (usage.warning) {
    return {
      allowed: true,
      reason: `⚠ WARNING: ${config.type} budget "${config.name}" at ${usage.percent}% (${usage.spent}/${usage.limit})`,
      usage,
    }
  }

  return {
    allowed: true,
    reason: `${usage.percent}% of "${config.name}" budget used`,
    usage,
  }
}

export function checkAllBudgets(
  cwd: string,
  date = new Date(),
): { allAllowed: boolean; results: Array<{ name: string; config: BudgetConfig; result: ReturnType<typeof checkBudget> }> } {
  const budgets = listBudgets(cwd)
  const results = budgets.map(config => ({
    name: config.name,
    config,
    result: checkBudget(cwd, config.name, date),
  }))
  return {
    allAllowed: results.every(r => r.result.allowed),
    results,
  }
}

export function resetUsage(cwd: string, budgetName: string): boolean {
  const store = loadBudgetStore(cwd)
  if (!store.budgets[budgetName]) return false
  store.usage[budgetName] = {}
  store.resets[budgetName] = new Date().toISOString()
  saveBudgetStore(cwd, store)
  return true
}

// ── Snapshots ───────────────────────────────────────────────────────────────

export function getBudgetSnapshot(
  cwd: string,
  budgetName: string,
  date = new Date(),
): BudgetSnapshot | null {
  const config = getBudget(cwd, budgetName)
  if (!config) return null

  const usage = getUsage(cwd, budgetName, date)
  if (!usage) return null

  const store = loadBudgetStore(cwd)

  return {
    config,
    usage,
    periodStart: getPeriodStart(config.period, date).toISOString(),
    periodEnd: getPeriodEnd(config.period, date).toISOString(),
    lastReset: store.resets[budgetName] ?? null,
  }
}

// ── Formatting ──────────────────────────────────────────────────────────────

function formatAmount(type: BudgetType, amount: number): string {
  switch (type) {
    case 'tokens':
      return amount >= 1000 ? `${(amount / 1000).toFixed(1)}K` : String(amount)
    case 'cost':
      return `$${amount.toFixed(4)}`
    case 'requests':
      return String(amount)
  }
}

export function formatBudgetUsage(
  config: BudgetConfig,
  usage: BudgetUsage,
): string {
  const bar = formatProgressBar(usage.ratio, 20)
  const status = usage.exceeded ? '✗ EXCEEDED'
    : usage.warning ? '⚠ WARNING'
    : '✓ OK'

  return [
    `${config.name} (${config.type}/${config.period})${config.enforced ? '' : ' [advisory]'}${config.enabled ? '' : ' [disabled]'}`,
    `  ${bar} ${usage.percent}%`,
    `  ${formatAmount(config.type, usage.spent)} / ${formatAmount(config.type, usage.limit)} (${formatAmount(config.type, usage.remaining)} remaining)`,
    `  Status: ${status}`,
  ].join('\n')
}

export function formatProgressBar(ratio: number, width = 20): string {
  const clamped = Math.min(1, Math.max(0, ratio))
  const filled = Math.round(clamped * width)
  const empty = width - filled

  if (ratio >= 1) return `[${'█'.repeat(width)}]` // fully red
  if (ratio >= 0.8) return `[${'█'.repeat(filled)}${'░'.repeat(empty)}]`

  return `[${'█'.repeat(filled)}${'░'.repeat(empty)}]`
}

export function formatBudgetSnapshot(snapshot: BudgetSnapshot): string {
  const { config, usage, periodStart, periodEnd, lastReset } = snapshot
  const lines = [
    formatBudgetUsage(config, usage),
    `  Period: ${periodStart.slice(0, 10)} → ${periodEnd.slice(0, 10)}`,
  ]
  if (lastReset) lines.push(`  Last reset: ${lastReset.slice(0, 10)}`)
  return lines.join('\n')
}

export function formatBudgetSummary(cwd: string): string {
  const budgets = listBudgets(cwd)
  if (budgets.length === 0) return 'No budgets configured.'

  const lines: string[] = ['Budget Summary:', '']
  for (const config of budgets) {
    const usage = getUsage(cwd, config.name)
    if (!usage) continue
    lines.push(formatBudgetUsage(config, usage))
    lines.push('')
  }

  const { allAllowed, results } = checkAllBudgets(cwd)
  const exceeded = results.filter(r => r.result.usage?.exceeded).length
  const warning = results.filter(r => r.result.usage?.warning).length

  lines.push(
    `Total: ${budgets.length} budget(s) | ${exceeded} exceeded | ${warning} warning${allAllowed ? '' : ' | ⚠ BLOCKED'}`,
  )

  return lines.join('\n')
}

// ── Presets ─────────────────────────────────────────────────────────────────

export const BUDGET_PRESETS = {
  conservative: [
    { name: 'daily-tokens', type: 'tokens' as BudgetType, period: 'daily' as BudgetPeriod, limit: 50_000 },
    { name: 'daily-cost', type: 'cost' as BudgetType, period: 'daily' as BudgetPeriod, limit: 1.0 },
  ],
  moderate: [
    { name: 'daily-tokens', type: 'tokens' as BudgetType, period: 'daily' as BudgetPeriod, limit: 200_000 },
    { name: 'daily-cost', type: 'cost' as BudgetType, period: 'daily' as BudgetPeriod, limit: 5.0 },
    { name: 'monthly-cost', type: 'cost' as BudgetType, period: 'monthly' as BudgetPeriod, limit: 100.0 },
  ],
  heavy: [
    { name: 'daily-tokens', type: 'tokens' as BudgetType, period: 'daily' as BudgetPeriod, limit: 1_000_000 },
    { name: 'daily-cost', type: 'cost' as BudgetType, period: 'daily' as BudgetPeriod, limit: 25.0 },
    { name: 'monthly-cost', type: 'cost' as BudgetType, period: 'monthly' as BudgetPeriod, limit: 500.0 },
  ],
} satisfies Record<string, Array<{ name: string; type: BudgetType; period: BudgetPeriod; limit: number }>>

export function applyPreset(cwd: string, presetName: keyof typeof BUDGET_PRESETS): BudgetConfig[] {
  const preset = BUDGET_PRESETS[presetName]
  if (!preset) throw new Error(`Unknown preset: ${presetName}`)
  return preset.map(p => setBudget(cwd, p))
}
