import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import {
  startTimer, stopTimer, pauseTimer, resumeTimer, removeTimer, getTimer,
  getElapsedMs,
  getRunningTimers, getStoppedTimers, getAllTimers, getTimersByCategory,
  getTimerStats,
  formatDuration, formatTimer, formatTimerList, formatTimerStats,
} from '../src/core/taskTimer.js'
import { mkdtempSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

function makeTempDir(): string {
  return mkdtempSync(join(tmpdir(), 'ovolv999-tmr-'))
}

describe('Task Timer', () => {
  let cwd: string

  beforeEach(() => { cwd = makeTempDir() })
  afterEach(() => { rmSync(cwd, { recursive: true, force: true }) })

  describe('startTimer', () => {
    it('creates a running timer', () => {
      const t = startTimer(cwd, 'write tests')
      expect(t.name).toBe('write tests')
      expect(t.running).toBe(true)
      expect(t.stoppedAt).toBeNull()
      expect(t.accumulatedMs).toBe(0)
    })

    it('stores optional fields', () => {
      const t = startTimer(cwd, 'task', {
        category: 'backend',
        tags: ['urgent', 'api'],
        notes: 'fix the bug',
      })
      expect(t.category).toBe('backend')
      expect(t.tags).toEqual(['urgent', 'api'])
      expect(t.notes).toBe('fix the bug')
    })

    it('generates unique ids', () => {
      const t1 = startTimer(cwd, 'a')
      const t2 = startTimer(cwd, 'b')
      expect(t1.id).not.toBe(t2.id)
    })
  })

  describe('stopTimer', () => {
    it('stops a running timer', async () => {
      const t = startTimer(cwd, 'task')
      await new Promise(r => setTimeout(r, 10))
      const stopped = stopTimer(cwd, t.id)
      expect(stopped?.running).toBe(false)
      expect(stopped?.stoppedAt).not.toBeNull()
      expect(stopped?.accumulatedMs).toBeGreaterThan(0)
    })

    it('works with name instead of id', () => {
      startTimer(cwd, 'my task name')
      const stopped = stopTimer(cwd, 'my task')
      expect(stopped).not.toBeNull()
    })

    it('returns null for already stopped timer', () => {
      const t = startTimer(cwd, 'task')
      stopTimer(cwd, t.id)
      expect(stopTimer(cwd, t.id)).toBeNull()
    })

    it('returns null for missing timer', () => {
      expect(stopTimer(cwd, 'nope')).toBeNull()
    })
  })

  describe('pauseTimer and resumeTimer', () => {
    it('pauses a running timer', () => {
      const t = startTimer(cwd, 'task')
      const paused = pauseTimer(cwd, t.id)
      expect(paused?.running).toBe(false)
      expect(paused?.stoppedAt).toBeNull() // Not stopped, just paused
    })

    it('resumes a paused timer', () => {
      const t = startTimer(cwd, 'task')
      pauseTimer(cwd, t.id)
      const resumed = resumeTimer(cwd, t.id)
      expect(resumed?.running).toBe(true)
    })

    it('cannot resume a stopped timer', () => {
      const t = startTimer(cwd, 'task')
      stopTimer(cwd, t.id)
      expect(resumeTimer(cwd, t.id)).toBeNull()
    })

    it('cannot pause an already paused timer', () => {
      const t = startTimer(cwd, 'task')
      pauseTimer(cwd, t.id)
      expect(pauseTimer(cwd, t.id)).toBeNull()
    })

    it('accumulates time across pause/resume cycles', () => {
      const t = startTimer(cwd, 'task')
      pauseTimer(cwd, t.id)
      const pausedMs = t.accumulatedMs
      resumeTimer(cwd, t.id)
      pauseTimer(cwd, t.id)
      const t2 = getTimer(cwd, t.id)!
      expect(t2.accumulatedMs).toBeGreaterThanOrEqual(pausedMs)
    })
  })

  describe('removeTimer', () => {
    it('removes a timer', () => {
      const t = startTimer(cwd, 'task')
      expect(removeTimer(cwd, t.id)).toBe(true)
      expect(getTimer(cwd, t.id)).toBeNull()
    })

    it('returns false for missing timer', () => {
      expect(removeTimer(cwd, 'nope')).toBe(false)
    })
  })

  describe('getElapsedMs', () => {
    it('returns accumulated time for stopped timer', async () => {
      const t = startTimer(cwd, 'task')
      await new Promise(r => setTimeout(r, 10))
      pauseTimer(cwd, t.id)
      const t2 = getTimer(cwd, t.id)!
      const elapsed = getElapsedMs(t2)
      expect(elapsed).toBeGreaterThan(0)
      expect(elapsed).toBe(t2.accumulatedMs)
    })

    it('returns accumulated + current session for running timer', () => {
      const t = startTimer(cwd, 'task')
      const elapsed = getElapsedMs(t)
      expect(elapsed).toBeGreaterThanOrEqual(0)
    })
  })

  describe('query functions', () => {
    beforeEach(() => {
      startTimer(cwd, 'running task 1')
      startTimer(cwd, 'running task 2')
      const t = startTimer(cwd, 'stopped task')
      stopTimer(cwd, t.id)
    })

    it('getRunningTimers returns only running', () => {
      expect(getRunningTimers(cwd)).toHaveLength(2)
    })

    it('getStoppedTimers returns only stopped', () => {
      expect(getStoppedTimers(cwd)).toHaveLength(1)
    })

    it('getAllTimers returns all', () => {
      expect(getAllTimers(cwd)).toHaveLength(3)
    })

    it('getTimersByCategory filters', () => {
      startTimer(cwd, 'cat task', { category: 'frontend' })
      const results = getTimersByCategory(cwd, 'frontend')
      expect(results).toHaveLength(1)
    })
  })

  describe('getTimerStats', () => {
    it('returns stats for empty store', () => {
      const stats = getTimerStats(cwd)
      expect(stats.totalTimers).toBe(0)
      expect(stats.totalTimeMs).toBe(0)
    })

    it('counts timers correctly', () => {
      startTimer(cwd, 't1')
      const t = startTimer(cwd, 't2')
      stopTimer(cwd, t.id)
      const stats = getTimerStats(cwd)
      expect(stats.totalTimers).toBe(2)
      expect(stats.runningCount).toBe(1)
      expect(stats.stoppedCount).toBe(1)
    })

    it('tracks time by category', async () => {
      const t1 = startTimer(cwd, 'a', { category: 'frontend' })
      const t2 = startTimer(cwd, 'b', { category: 'backend' })
      await new Promise(r => setTimeout(r, 10))
      stopTimer(cwd, t1.id)
      stopTimer(cwd, t2.id)
      const stats = getTimerStats(cwd)
      expect(stats.totalTimeByCategory.frontend).toBeGreaterThan(0)
      expect(stats.totalTimeByCategory.backend).toBeGreaterThan(0)
    })

    it('tracks time by tag', async () => {
      const t = startTimer(cwd, 'a', { tags: ['bug', 'critical'] })
      await new Promise(r => setTimeout(r, 10))
      stopTimer(cwd, t.id)
      const stats = getTimerStats(cwd)
      expect(stats.totalTimeByTag.bug).toBeGreaterThan(0)
      expect(stats.totalTimeByTag.critical).toBeGreaterThan(0)
    })

    it('calculates average and extremes', async () => {
      const t1 = startTimer(cwd, 'short')
      stopTimer(cwd, t1.id)
      const t2 = startTimer(cwd, 'long')
      await new Promise(r => setTimeout(r, 10))
      stopTimer(cwd, t2.id)
      const stats = getTimerStats(cwd)
      expect(stats.averageTimeMs).toBeGreaterThan(0)
      expect(stats.longestTimerMs).toBeGreaterThanOrEqual(stats.shortestTimerMs)
    })
  })

  describe('formatDuration', () => {
    it('formats milliseconds', () => {
      expect(formatDuration(500)).toBe('500ms')
    })
    it('formats seconds', () => {
      expect(formatDuration(5000)).toBe('5s')
    })
    it('formats minutes', () => {
      expect(formatDuration(65_000)).toBe('1m 5s')
    })
    it('formats hours', () => {
      expect(formatDuration(3_660_000)).toBe('1h 1m')
    })
    it('formats days', () => {
      expect(formatDuration(90_000_000)).toBe('1d 1h')
    })
  })

  describe('formatTimer', () => {
    it('shows running status', () => {
      const t = startTimer(cwd, 'my task')
      const out = formatTimer(t)
      expect(out).toContain('running')
      expect(out).toContain('my task')
    })

    it('shows stopped status', () => {
      const t = startTimer(cwd, 'done')
      stopTimer(cwd, t.id)
      const t2 = getTimer(cwd, t.id)!
      const out = formatTimer(t2)
      expect(out).toContain('stopped')
    })

    it('includes category and tags', () => {
      const t = startTimer(cwd, 'task', { category: 'api', tags: ['v2'] })
      const out = formatTimer(t)
      expect(out).toContain('[api]')
      expect(out).toContain('#v2')
    })
  })

  describe('formatTimerList', () => {
    it('shows empty message', () => {
      expect(formatTimerList([])).toBe('No timers.')
    })

    it('lists timers with total', () => {
      startTimer(cwd, 'task1')
      startTimer(cwd, 'task2')
      const out = formatTimerList(getAllTimers(cwd))
      expect(out).toContain('task1')
      expect(out).toContain('task2')
      expect(out).toContain('Total:')
    })
  })

  describe('formatTimerStats', () => {
    it('includes key stats', () => {
      startTimer(cwd, 'task', { category: 'dev', tags: ['wip'] })
      const stats = getTimerStats(cwd)
      const out = formatTimerStats(stats)
      expect(out).toContain('Total timers')
      expect(out).toContain('Running')
      expect(out).toContain('Total time')
    })

    it('shows category breakdown', () => {
      const t = startTimer(cwd, 'task', { category: 'frontend' })
      stopTimer(cwd, t.id)
      const stats = getTimerStats(cwd)
      const out = formatTimerStats(stats)
      expect(out).toContain('By category')
      expect(out).toContain('frontend')
    })

    it('shows tag breakdown', () => {
      const t = startTimer(cwd, 'task', { tags: ['review'] })
      stopTimer(cwd, t.id)
      const stats = getTimerStats(cwd)
      const out = formatTimerStats(stats)
      expect(out).toContain('By tag')
      expect(out).toContain('#review')
    })
  })
})
