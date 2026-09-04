/**
 * Cron Scheduler
 *
 * Schedules prompts to run at specified times using cron expressions.
 * Persisted to .ovolv999/schedules.json.
 *
 * Cron expression format (5 fields):
 *   ┌───────────── minute (0-59)
 *   │ ┌───────────── hour (0-23)
 *   │ │ ┌───────────── day of month (1-31)
 *   │ │ │ ┌───────────── month (1-12 or JAN-DEC)
 *   │ │ │ │ ┌───────────── day of week (0-6 or SUN-SAT, 7=Sunday)
 *   │ │ │ │ │
 *   * * * * *
 *
 * Special: @hourly, @daily, @weekly, @monthly, @yearly, @every <duration>
 */

import { existsSync, readFileSync } from 'fs'
import { join, resolve } from 'path'

import { atomicWrite, preserveCorruptFile } from './atomicWrite.js'

// ── Types ───────────────────────────────────────────────────────────────────

export interface ScheduledTask {
  /** Unique identifier */
  id: string
  /** Human-readable name */
  name: string
  /** Cron expression or @special */
  cron: string
  /** Prompt to execute when triggered */
  prompt: string
  /** Whether the task is enabled */
  enabled: boolean
  /** ISO timestamp of creation */
  createdAt: string
  /** ISO timestamp of last run */
  lastRun: string | null
  /** ISO timestamp of next scheduled run */
  nextRun: string | null
  /** Run count */
  runCount: number
  /** Last result (truncated) */
  lastResult: string | null
}

export interface ScheduleStore {
  tasks: ScheduledTask[]
}

export interface CronField {
  /** Field name */
  name: 'minute' | 'hour' | 'dom' | 'month' | 'dow'
  /** Allowed range */
  min: number
  max: number
  /** Values that match */
  values: number[]
}

// ── Cron Parsing ────────────────────────────────────────────────────────────

export class CronParseError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'CronParseError'
  }
}

const MONTH_NAMES: Record<string, number> = {
  JAN: 1, FEB: 2, MAR: 3, APR: 4, MAY: 5, JUN: 6,
  JUL: 7, AUG: 8, SEP: 9, OCT: 10, NOV: 11, DEC: 12,
}

const DOW_NAMES: Record<string, number> = {
  SUN: 0, MON: 1, TUE: 2, WED: 3, THU: 4, FRI: 5, SAT: 6,
}

/**
 * Parse a single cron field (supports comma lists, wildcards with step, ranges).
 */
export function parseField(
  field: string,
  name: CronField['name'],
  min: number,
  max: number,
): number[] {
  if (field === '*') {
    return range(min, max)
  }

  if (field.startsWith('*/')) {
    const step = parseInt(field.slice(2), 10)
    if (isNaN(step) || step <= 0) {
      throw new CronParseError(`Invalid step in "${field}" for ${name}`)
    }
    return range(min, max).filter(v => (v - min) % step === 0)
  }

  const values: number[] = []

  for (const part of field.split(',')) {
    // Handle step (e.g., "1-10/2")
    const [rangePart, stepPart] = part.split('/')
    const step = stepPart ? parseInt(stepPart, 10) : 1

    if (rangePart.includes('-')) {
      const [startStr, endStr] = rangePart.split('-')
      let start = parseInt(startStr, 10)
      let end = parseInt(endStr, 10)

      if (isNaN(start)) {
        start = name === 'month' ? (MONTH_NAMES[startStr.toUpperCase()] ?? NaN) : NaN
      }
      if (isNaN(end)) {
        end = name === 'month' ? (MONTH_NAMES[endStr.toUpperCase()] ?? NaN)
          : name === 'dow' ? (DOW_NAMES[endStr.toUpperCase()] ?? NaN) : NaN
      }

      if (isNaN(start) || isNaN(end)) {
        throw new CronParseError(`Invalid range "${rangePart}" for ${name}`)
      }
      if (start > end) {
        throw new CronParseError(`Invalid range "${rangePart}" for ${name}: start > end`)
      }

      for (let v = start; v <= end; v += step) {
        values.push(v)
      }
    } else {
      let val = parseInt(rangePart, 10)
      if (isNaN(val)) {
        val = name === 'month' ? (MONTH_NAMES[rangePart.toUpperCase()] ?? NaN)
          : name === 'dow' ? (DOW_NAMES[rangePart.toUpperCase()] ?? NaN) : NaN
      }
      if (isNaN(val)) {
        throw new CronParseError(`Invalid value "${rangePart}" for ${name}`)
      }
      values.push(val)
    }
  }

  // Validate range
  for (const v of values) {
    if (name === 'dow') {
      // 7 = Sunday in some systems
      if (v !== 7 && (v < 0 || v > 6)) {
        throw new CronParseError(`${name} value ${v} out of range (0-6 or 7)`)
      }
    } else {
      if (v < min || v > max) {
        throw new CronParseError(`${name} value ${v} out of range (${min}-${max})`)
      }
    }
  }

  return [...new Set(values)].sort((a, b) => a - b)
}

function range(start: number, end: number): number[] {
  const result: number[] = []
  for (let i = start; i <= end; i++) result.push(i)
  return result
}

export interface ParsedCron {
  minute: number[]
  hour: number[]
  dom: number[]
  month: number[]
  dow: number[]
}

/**
 * Parse a full cron expression.
 */
export function parseCron(expression: string): ParsedCron {
  const trimmed = expression.trim()

  // Handle special expressions
  switch (trimmed) {
    case '@hourly': return parseCron('0 * * * *')
    case '@daily':
    case '@midnight': return parseCron('0 0 * * *')
    case '@weekly': return parseCron('0 0 * * 0')
    case '@monthly': return parseCron('0 0 1 * *')
    case '@yearly':
    case '@annually': return parseCron('0 0 1 1 *')
  }

  if (trimmed.startsWith('@every ')) {
    // Not a real cron field, but mark as parseable for duration
    throw new CronParseError('@every is supported but requires duration parsing (use parseEvery)')
  }

  const parts = trimmed.split(/\s+/)
  if (parts.length !== 5) {
    throw new CronParseError(`Expected 5 fields, got ${parts.length}`)
  }

  return {
    minute: parseField(parts[0], 'minute', 0, 59),
    hour: parseField(parts[1], 'hour', 0, 23),
    dom: parseField(parts[2], 'dom', 1, 31),
    month: parseField(parts[3], 'month', 1, 12),
    dow: parseField(parts[4], 'dow', 0, 6),
  }
}

/**
 * Parse @every duration (e.g., "@every 5m", "@every 1h30m").
 */
export function parseEveryDuration(expr: string): number {
  const trimmed = expr.trim()
  if (!/^@every\s+/i.test(trimmed)) {
    throw new CronParseError(`Invalid @every expression: ${expr}`)
  }

  const durationStr = trimmed.replace(/^@every\s+/i, '').trim()
  let totalSeconds = 0
  const partRegex = /(\d+)([hmsd])/gi
  let match: RegExpExecArray | null
  let matched = false

  while ((match = partRegex.exec(durationStr)) !== null) {
    matched = true
    const n = parseInt(match[1], 10)
    const unit = match[2].toLowerCase()
    switch (unit) {
      case 's': totalSeconds += n; break
      case 'm': totalSeconds += n * 60; break
      case 'h': totalSeconds += n * 3600; break
      case 'd': totalSeconds += n * 86400; break
    }
  }

  if (!matched) {
    // Maybe it's just a number (assume seconds)
    const n = parseInt(durationStr, 10)
    if (!isNaN(n) && n > 0) totalSeconds = n
  }

  if (totalSeconds <= 0) {
    throw new CronParseError(`Duration must be positive: ${expr}`)
  }

  return totalSeconds
}

// ── Next Run Calculation ────────────────────────────────────────────────────

/**
 * Calculate the next time a cron expression will fire after `from`.
 */
export function getNextRun(parsed: ParsedCron, from: Date = new Date()): Date {
  const result = new Date(from)
  result.setSeconds(0, 0)
  result.setMinutes(result.getMinutes() + 1) // Start from next minute

  // Determine if dom/dow are restricted (not full range)
  const domRestricted = parsed.dom.length !== 31 // 1-31
  const dowRestricted = parsed.dow.length !== 7   // 0-6

  // Brute force search (max 1 year ahead)
  const maxIterations = 366 * 24 * 60 // minutes in a year
  for (let i = 0; i < maxIterations; i++) {
    const minute = result.getMinutes()
    const hour = result.getHours()
    const dom = result.getDate()
    const month = result.getMonth() + 1
    const dow = result.getDay()

    // Check standard fields
    if (!parsed.minute.includes(minute)) { result.setMinutes(result.getMinutes() + 1); continue }
    if (!parsed.hour.includes(hour)) { result.setMinutes(result.getMinutes() + 1); continue }
    if (!parsed.month.includes(month)) { result.setMinutes(result.getMinutes() + 1); continue }

    // DOM/DOW logic (standard cron behavior):
    // If BOTH are restricted: match if EITHER matches
    // If only ONE is restricted: only that one needs to match
    // If NEITHER is restricted: always matches (both are *)
    if (domRestricted && dowRestricted) {
      if (!parsed.dom.includes(dom) && !parsed.dow.includes(dow)) {
        result.setMinutes(result.getMinutes() + 1); continue
      }
    } else if (domRestricted) {
      if (!parsed.dom.includes(dom)) { result.setMinutes(result.getMinutes() + 1); continue }
    } else if (dowRestricted) {
      if (!parsed.dow.includes(dow)) { result.setMinutes(result.getMinutes() + 1); continue }
    }

    return result
  }

  throw new CronParseError('Could not find next run within 1 year')
}

// ── Store ───────────────────────────────────────────────────────────────────

export function getSchedulesPath(cwd: string): string {
  return join(resolve(cwd), '.ovolv999', 'schedules.json')
}

export function loadSchedules(cwd: string): ScheduleStore {
  const path = getSchedulesPath(cwd)
  if (!existsSync(path)) {
    return { tasks: [] }
  }
  let raw: string
  try {
    raw = readFileSync(path, 'utf8')
  } catch {
    return { tasks: [] }
  }
  try {
    const parsed = JSON.parse(raw) as { tasks?: unknown } | null
    if (!parsed || !Array.isArray(parsed.tasks)) {
      throw new Error('store shape violation')
    }
    if (!parsed.tasks.every(isShapedTask)) {
      throw new Error('store shape violation')
    }
    return { tasks: parsed.tasks.filter(isShapedTask) }
  } catch {
    // Runtime truth contract §schedule-store: schedules.json holds real user
    // data — preserve the corrupt bytes before the store resets to empty, or
    // the next save destroys the only copy of the task list.
    preserveCorruptFile(path)
    return { tasks: [] }
  }
}

/** Fields the read paths dereference without guarding (formatTaskList does
 *  `prompt.slice`, getDueTasks reads `enabled`/`nextRun`). An entry missing
 *  any of them makes the whole store unusable — it fails the shape gate and
 *  the file is preserved as corrupt rather than partially loaded. */
function isShapedTask(t: unknown): t is ScheduledTask {
  if (t === null || typeof t !== 'object') return false
  const task = t as Partial<ScheduledTask>
  return typeof task.id === 'string'
    && typeof task.name === 'string'
    && typeof task.cron === 'string'
    && typeof task.prompt === 'string'
    && typeof task.enabled === 'boolean'
    && typeof task.runCount === 'number'
}

export async function saveSchedules(cwd: string, store: ScheduleStore): Promise<void> {
  await atomicWrite(getSchedulesPath(cwd), JSON.stringify(store, null, 2))
}

// ── Task Management ─────────────────────────────────────────────────────────

export function createTask(
  name: string,
  cron: string,
  prompt: string,
): ScheduledTask {
  const id = `task_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
  let nextRun: string | null = null

  try {
    if (cron.startsWith('@every')) {
      const duration = parseEveryDuration(cron)
      nextRun = new Date(Date.now() + duration * 1000).toISOString()
    } else {
      const parsed = parseCron(cron)
      nextRun = getNextRun(parsed).toISOString()
    }
  } catch { /* leave null if invalid */ }

  return {
    id,
    name,
    cron,
    prompt,
    enabled: true,
    createdAt: new Date().toISOString(),
    lastRun: null,
    nextRun,
    runCount: 0,
    lastResult: null,
  }
}

export async function addTask(cwd: string, task: ScheduledTask): Promise<void> {
  const store = loadSchedules(cwd)
  store.tasks.push(task)
  await saveSchedules(cwd, store)
}

export async function removeTask(cwd: string, idOrName: string): Promise<boolean> {
  const store = loadSchedules(cwd)
  const before = store.tasks.length
  store.tasks = store.tasks.filter(t => t.id !== idOrName && t.name !== idOrName)
  if (store.tasks.length === before) return false
  await saveSchedules(cwd, store)
  return true
}

export async function enableTask(cwd: string, idOrName: string): Promise<boolean> {
  const store = loadSchedules(cwd)
  const task = store.tasks.find(t => t.id === idOrName || t.name === idOrName)
  if (!task) return false
  task.enabled = true
  await saveSchedules(cwd, store)
  return true
}

export async function disableTask(cwd: string, idOrName: string): Promise<boolean> {
  const store = loadSchedules(cwd)
  const task = store.tasks.find(t => t.id === idOrName || t.name === idOrName)
  if (!task) return false
  task.enabled = false
  await saveSchedules(cwd, store)
  return true
}

export function getDueTasks(cwd: string, now: Date = new Date()): ScheduledTask[] {
  const store = loadSchedules(cwd)
  const nowMs = now.getTime()

  return store.tasks.filter(task => {
    if (!task.enabled) return false
    if (!task.nextRun) return false
    const nextMs = new Date(task.nextRun).getTime()
    return nextMs <= nowMs
  })
}

export async function markTaskRun(cwd: string, id: string, result: string): Promise<void> {
  const store = loadSchedules(cwd)
  const task = store.tasks.find(t => t.id === id)
  if (!task) return

  task.lastRun = new Date().toISOString()
  task.runCount++
  task.lastResult = result.slice(0, 500)

  // Calculate next run
  try {
    if (task.cron.startsWith('@every')) {
      const duration = parseEveryDuration(task.cron)
      task.nextRun = new Date(Date.now() + duration * 1000).toISOString()
    } else {
      const parsed = parseCron(task.cron)
      task.nextRun = getNextRun(parsed).toISOString()
    }
  } catch {
    task.nextRun = null
  }

  await saveSchedules(cwd, store)
}

// ── Formatting ──────────────────────────────────────────────────────────────

export function formatTaskList(tasks: ScheduledTask[]): string {
  if (tasks.length === 0) return 'No scheduled tasks. Use /schedule create to add one.'

  const lines: string[] = [`Scheduled tasks (${tasks.length}):`]
  for (const t of tasks) {
    const status = t.enabled ? '✓' : '✗'
    const next = t.nextRun ? new Date(t.nextRun).toLocaleString() : 'N/A'
    const last = t.lastRun ? new Date(t.lastRun).toLocaleString() : 'never'
    lines.push('')
    lines.push(`  ${status} ${t.name}`)
    lines.push(`    ID: ${t.id}`)
    lines.push(`    Cron: ${t.cron}`)
    lines.push(`    Prompt: "${t.prompt.slice(0, 60)}${t.prompt.length > 60 ? '...' : ''}"`)
    lines.push(`    Next: ${next}`)
    lines.push(`    Last: ${last} (${t.runCount} runs)`)
  }

  return lines.join('\n')
}

export function formatTaskDetail(task: ScheduledTask): string {
  const lines: string[] = [
    `Task: ${task.name}`,
    `  ID: ${task.id}`,
    `  Cron: ${task.cron}`,
    `  Enabled: ${task.enabled}`,
    `  Prompt: ${task.prompt}`,
    `  Created: ${task.createdAt}`,
    `  Last run: ${task.lastRun ?? 'never'}`,
    `  Next run: ${task.nextRun ?? 'N/A'}`,
    `  Run count: ${task.runCount}`,
  ]
  if (task.lastResult) {
    lines.push(`  Last result: ${task.lastResult}`)
  }
  return lines.join('\n')
}
