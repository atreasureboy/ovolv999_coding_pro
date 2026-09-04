/**
 * Task Timer
 *
 * Track time spent on coding tasks. Multiple timers can run concurrently.
 * Persisted to .ovolv999/timers.json.
 */

import { existsSync, readFileSync } from 'fs'
import { atomicWriteSync, preserveCorruptFile } from './atomicWrite.js'
import { join, resolve } from 'path'

// ── Types ───────────────────────────────────────────────────────────────────

export interface TimerEntry {
  /** Unique ID */
  id: string
  /** Task name/description */
  name: string
  /** When the timer was started */
  startedAt: string
  /** When the timer was stopped (null if running) */
  stoppedAt: string | null
  /** Accumulated time in ms (for paused/resumed timers) */
  accumulatedMs: number
  /** Whether the timer is currently running */
  running: boolean
  /** Optional category/tag */
  category?: string
  /** Tags */
  tags?: string[]
  /** Notes */
  notes?: string
}

export interface TimerStore {
  timers: TimerEntry[]
}

// ── Persistence ─────────────────────────────────────────────────────────────

export function getTimerPath(cwd: string): string {
  return join(resolve(cwd), '.ovolv999', 'timers.json')
}

export function loadTimers(cwd: string): TimerStore {
  const path = getTimerPath(cwd)
  if (!existsSync(path)) return { timers: [] }
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as TimerStore
    if (!isShapedTimerStore(parsed)) throw new Error('timer store shape violation')
    return parsed
  } catch {
    // §timer store: preserve the corrupt bytes before resetting — timers
    // accumulate tracked time that a silent reset would destroy.
    preserveCorruptFile(path)
    return { timers: [] }
  }
}

function isShapedTimerStore(parsed: unknown): parsed is TimerStore {
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return false
  const timers = (parsed as TimerStore).timers
  if (!Array.isArray(timers)) return false
  return timers.every((t) =>
    typeof t === 'object' && t !== null &&
    typeof t.id === 'string' && typeof t.name === 'string' && typeof t.running === 'boolean')
}

export function saveTimers(cwd: string, store: TimerStore): void {
  atomicWriteSync(getTimerPath(cwd), JSON.stringify(store, null, 2))
}

// ── Timer Operations ────────────────────────────────────────────────────────

export function startTimer(
  cwd: string,
  name: string,
  options: { category?: string; tags?: string[]; notes?: string } = {},
): TimerEntry {
  const store = loadTimers(cwd)
  const entry: TimerEntry = {
    id: `tmr_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    name,
    startedAt: new Date().toISOString(),
    stoppedAt: null,
    accumulatedMs: 0,
    running: true,
    category: options.category,
    tags: options.tags,
    notes: options.notes,
  }
  store.timers.push(entry)
  saveTimers(cwd, store)
  return entry
}

export function stopTimer(cwd: string, idOrName: string): TimerEntry | null {
  const store = loadTimers(cwd)
  const timer = findTimer(store, idOrName)
  if (!timer || !timer.running) return null

  timer.running = false
  timer.stoppedAt = new Date().toISOString()
  timer.accumulatedMs += Date.now() - new Date(timer.startedAt).getTime()
  saveTimers(cwd, store)
  return timer
}

export function pauseTimer(cwd: string, idOrName: string): TimerEntry | null {
  const store = loadTimers(cwd)
  const timer = findTimer(store, idOrName)
  if (!timer || !timer.running) return null

  timer.accumulatedMs += Date.now() - new Date(timer.startedAt).getTime()
  timer.running = false
  // Don't set stoppedAt — this is a pause, not a stop
  saveTimers(cwd, store)
  return timer
}

export function resumeTimer(cwd: string, idOrName: string): TimerEntry | null {
  const store = loadTimers(cwd)
  const timer = findTimer(store, idOrName)
  if (!timer || timer.running) return null
  if (timer.stoppedAt) return null // Can't resume a stopped timer

  timer.running = true
  timer.startedAt = new Date().toISOString() // Reset startedAt for new accumulation
  saveTimers(cwd, store)
  return timer
}

export function removeTimer(cwd: string, idOrName: string): boolean {
  const store = loadTimers(cwd)
  const idx = store.timers.findIndex(t => matchesTimer(t, idOrName))
  if (idx === -1) return false
  store.timers.splice(idx, 1)
  saveTimers(cwd, store)
  return true
}

export function getTimer(cwd: string, id: string): TimerEntry | null {
  const store = loadTimers(cwd)
  return store.timers.find(t => t.id === id) ?? null
}

// ── Timer Calculation ───────────────────────────────────────────────────────

export function getElapsedMs(timer: TimerEntry, now = Date.now()): number {
  let total = timer.accumulatedMs
  if (timer.running) {
    total += now - new Date(timer.startedAt).getTime()
  }
  return total
}

export function getElapsedSeconds(timer: TimerEntry, now = Date.now()): number {
  return Math.floor(getElapsedMs(timer, now) / 1000)
}

export function getRunningTimers(cwd: string): TimerEntry[] {
  const store = loadTimers(cwd)
  return store.timers.filter(t => t.running)
}

export function getStoppedTimers(cwd: string): TimerEntry[] {
  const store = loadTimers(cwd)
  return store.timers.filter(t => !t.running && t.stoppedAt)
}

export function getAllTimers(cwd: string): TimerEntry[] {
  return loadTimers(cwd).timers
}

export function getTimersByCategory(cwd: string, category: string): TimerEntry[] {
  const store = loadTimers(cwd)
  return store.timers.filter(t => t.category === category)
}

// ── Aggregate Stats ─────────────────────────────────────────────────────────

export interface TimerStats {
  totalTimers: number
  runningCount: number
  stoppedCount: number
  totalTimeMs: number
  totalTimeByCategory: Record<string, number>
  totalTimeByTag: Record<string, number>
  averageTimeMs: number
  longestTimerMs: number
  shortestTimerMs: number
}

export function getTimerStats(cwd: string): TimerStats {
  const store = loadTimers(cwd)
  const timers = store.timers

  const running = timers.filter(t => t.running)
  const stopped = timers.filter(t => !t.running && t.stoppedAt)

  let totalTime = 0
  const byCategory: Record<string, number> = {}
  const byTag: Record<string, number> = {}

  const times = timers.map(t => {
    const ms = getElapsedMs(t)
    totalTime += ms
    if (t.category) {
      byCategory[t.category] = (byCategory[t.category] ?? 0) + ms
    }
    for (const tag of t.tags ?? []) {
      byTag[tag] = (byTag[tag] ?? 0) + ms
    }
    return ms
  })

  return {
    totalTimers: timers.length,
    runningCount: running.length,
    stoppedCount: stopped.length,
    totalTimeMs: totalTime,
    totalTimeByCategory: byCategory,
    totalTimeByTag: byTag,
    averageTimeMs: times.length > 0 ? totalTime / times.length : 0,
    longestTimerMs: times.length > 0 ? Math.max(...times) : 0,
    shortestTimerMs: times.length > 0 ? Math.min(...times) : 0,
  }
}

// ── Formatting ──────────────────────────────────────────────────────────────

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`
  const seconds = Math.floor(ms / 1000)
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  const remainingSeconds = seconds % 60
  if (minutes < 60) return `${minutes}m ${remainingSeconds}s`
  const hours = Math.floor(minutes / 60)
  const remainingMinutes = minutes % 60
  if (hours < 24) return `${hours}h ${remainingMinutes}m`
  const days = Math.floor(hours / 24)
  const remainingHours = hours % 24
  return `${days}d ${remainingHours}h`
}

export function formatTimer(timer: TimerEntry, now = Date.now()): string {
  const elapsed = getElapsedMs(timer, now)
  const status = timer.running ? '▶ running'
    : timer.stoppedAt ? '■ stopped'
    : '⏸ paused'

  const parts = [
    `${status}  ${timer.name}`,
    `  ${formatDuration(elapsed)}`,
  ]

  if (timer.category) parts.push(`  [${timer.category}]`)
  if (timer.tags?.length) parts.push(`  #${timer.tags.join(' #')}`)
  parts.push(`  id: ${timer.id}`)

  return parts.join('\n')
}

export function formatTimerList(timers: TimerEntry[], now = Date.now()): string {
  if (timers.length === 0) return 'No timers.'

  const lines: string[] = [`Timers (${timers.length}):`]
  for (let i = 0; i < timers.length; i++) {
    const t = timers[i]
    const elapsed = formatDuration(getElapsedMs(t, now))
    const status = t.running ? '▶' : t.stoppedAt ? '■' : '⏸'
    const cat = t.category ? ` [${t.category}]` : ''
    lines.push(`  ${i + 1}. ${status} ${t.name}${cat} — ${elapsed}`)
  }

  const totalMs = timers.reduce((s, t) => s + getElapsedMs(t, now), 0)
  lines.push(`\n  Total: ${formatDuration(totalMs)}`)

  return lines.join('\n')
}

export function formatTimerStats(stats: TimerStats): string {
  const lines: string[] = [
    'Timer Statistics:',
    `  Total timers: ${stats.totalTimers}`,
    `  Running: ${stats.runningCount}`,
    `  Stopped: ${stats.stoppedCount}`,
    `  Total time: ${formatDuration(stats.totalTimeMs)}`,
    `  Average: ${formatDuration(stats.averageTimeMs)}`,
    `  Longest: ${formatDuration(stats.longestTimerMs)}`,
    `  Shortest: ${formatDuration(stats.shortestTimerMs)}`,
  ]

  const categories = Object.entries(stats.totalTimeByCategory)
    .sort((a, b) => b[1] - a[1])
  if (categories.length > 0) {
    lines.push('  By category:')
    for (const [cat, ms] of categories) {
      lines.push(`    ${cat}: ${formatDuration(ms)}`)
    }
  }

  const tags = Object.entries(stats.totalTimeByTag)
    .sort((a, b) => b[1] - a[1])
  if (tags.length > 0) {
    lines.push('  By tag:')
    for (const [tag, ms] of tags) {
      lines.push(`    #${tag}: ${formatDuration(ms)}`)
    }
  }

  return lines.join('\n')
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function findTimer(store: TimerStore, idOrName: string): TimerEntry | undefined {
  return store.timers.find(t => matchesTimer(t, idOrName))
}

function matchesTimer(timer: TimerEntry, idOrName: string): boolean {
  if (timer.id === idOrName) return true
  // Also match by name (case-insensitive)
  return timer.name.toLowerCase().includes(idOrName.toLowerCase())
}
