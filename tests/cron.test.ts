import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import {
  parseField,
  parseCron,
  parseEveryDuration,
  getNextRun,
  CronParseError,
  createTask,
  addTask,
  removeTask,
  enableTask,
  disableTask,
  getDueTasks,
  markTaskRun,
  loadSchedules,
  saveSchedules,
  formatTaskList,
  formatTaskDetail,
  type ScheduledTask,
} from '../src/core/cron.js'
import { mkdtempSync, rmSync, existsSync, writeFileSync, mkdirSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

describe('cron', () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'cron-test-'))
  })

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true })
  })

  describe('parseField', () => {
    it('parses * as full range', () => {
      expect(parseField('*', 'minute', 0, 59)).toEqual(
        Array.from({ length: 60 }, (_, i) => i),
      )
    })

    it('parses single value', () => {
      expect(parseField('5', 'minute', 0, 59)).toEqual([5])
    })

    it('parses comma list', () => {
      expect(parseField('1,5,10', 'minute', 0, 59)).toEqual([1, 5, 10])
    })

    it('parses range', () => {
      expect(parseField('1-5', 'hour', 0, 23)).toEqual([1, 2, 3, 4, 5])
    })

    it('parses step', () => {
      expect(parseField('*/15', 'minute', 0, 59)).toEqual([0, 15, 30, 45])
    })

    it('parses range with step', () => {
      expect(parseField('0-10/2', 'minute', 0, 59)).toEqual([0, 2, 4, 6, 8, 10])
    })

    it('parses month names', () => {
      expect(parseField('JAN', 'month', 1, 12)).toEqual([1])
      expect(parseField('JUN', 'month', 1, 12)).toEqual([6])
    })

    it('parses DOW names', () => {
      expect(parseField('MON', 'dow', 0, 6)).toEqual([1])
      expect(parseField('FRI', 'dow', 0, 6)).toEqual([5])
    })

    it('deduplicates values', () => {
      expect(parseField('5,5,5', 'minute', 0, 59)).toEqual([5])
    })

    it('sorts values', () => {
      expect(parseField('10,5,1', 'minute', 0, 59)).toEqual([1, 5, 10])
    })

    it('throws for out of range', () => {
      expect(() => parseField('60', 'minute', 0, 59)).toThrow(CronParseError)
      expect(() => parseField('-1', 'minute', 0, 59)).toThrow(CronParseError)
    })

    it('throws for invalid step', () => {
      expect(() => parseField('*/0', 'minute', 0, 59)).toThrow(CronParseError)
    })

    it('throws for invalid range', () => {
      expect(() => parseField('10-5', 'minute', 0, 59)).toThrow(CronParseError)
    })

    it('throws for invalid month name', () => {
      expect(() => parseField('XYZ', 'month', 1, 12)).toThrow(CronParseError)
    })

    it('allows DOW 7 as Sunday', () => {
      expect(() => parseField('7', 'dow', 0, 6)).not.toThrow()
    })
  })

  describe('parseCron', () => {
    it('parses standard 5-field expression', () => {
      const parsed = parseCron('0 9 * * 1-5')
      expect(parsed.minute).toEqual([0])
      expect(parsed.hour).toEqual([9])
      expect(parsed.dow).toEqual([1, 2, 3, 4, 5])
    })

    it('handles @hourly', () => {
      const parsed = parseCron('@hourly')
      expect(parsed.minute).toEqual([0])
      expect(parseCron('@hourly').hour.length).toBe(24)
    })

    it('handles @daily', () => {
      const parsed = parseCron('@daily')
      expect(parsed.minute).toEqual([0])
      expect(parsed.hour).toEqual([0])
    })

    it('handles @weekly', () => {
      const parsed = parseCron('@weekly')
      expect(parsed.minute).toEqual([0])
      expect(parsed.hour).toEqual([0])
      expect(parsed.dow).toEqual([0])
    })

    it('handles @monthly', () => {
      const parsed = parseCron('@monthly')
      expect(parsed.minute).toEqual([0])
      expect(parsed.hour).toEqual([0])
      expect(parsed.dom).toEqual([1])
    })

    it('handles @yearly', () => {
      const parsed = parseCron('@yearly')
      expect(parsed.minute).toEqual([0])
      expect(parsed.hour).toEqual([0])
      expect(parsed.dom).toEqual([1])
      expect(parsed.month).toEqual([1])
    })

    it('throws for @every (use parseEveryDuration)', () => {
      expect(() => parseCron('@every 5m')).toThrow(CronParseError)
    })

    it('throws for wrong field count', () => {
      expect(() => parseCron('0 9')).toThrow(CronParseError)
      expect(() => parseCron('0 9 * * * *')).toThrow(CronParseError)
    })

    it('throws for invalid expression', () => {
      expect(() => parseCron('abc def ghi jkl mno')).toThrow(CronParseError)
    })
  })

  describe('parseEveryDuration', () => {
    it('parses seconds', () => {
      expect(parseEveryDuration('@every 30s')).toBe(30)
    })

    it('parses minutes', () => {
      expect(parseEveryDuration('@every 5m')).toBe(300)
    })

    it('parses hours', () => {
      expect(parseEveryDuration('@every 2h')).toBe(7200)
    })

    it('parses days', () => {
      expect(parseEveryDuration('@every 1d')).toBe(86400)
    })

    it('parses combined durations', () => {
      expect(parseEveryDuration('@every 1h30m')).toBe(5400)
    })

    it('throws for zero duration', () => {
      expect(() => parseEveryDuration('@every 0s')).toThrow(CronParseError)
    })

    it('throws for invalid format', () => {
      expect(() => parseEveryDuration('@every abc')).toThrow(CronParseError)
    })
  })

  describe('getNextRun', () => {
    it('finds next minute for * * * * *', () => {
      const parsed = parseCron('* * * * *')
      const from = new Date('2024-01-15T10:30:00Z')
      const next = getNextRun(parsed, from)
      expect(next.getMinutes()).toBe(31)
    })

    it('finds next hour for 0 * * * *', () => {
      const parsed = parseCron('0 * * * *')
      const from = new Date('2024-01-15T10:30:00')
      const next = getNextRun(parsed, from)
      expect(next.getMinutes()).toBe(0)
      expect(next.getHours()).toBe(11)
    })

    it('handles specific hour', () => {
      const parsed = parseCron('0 9 * * *')
      const from = new Date('2024-01-15T10:00:00')
      const next = getNextRun(parsed, from)
      expect(next.getHours()).toBe(9)
      // Should be next day
      expect(next.getDate()).toBe(16)
    })

    it('handles specific DOW', () => {
      const parsed = parseCron('0 0 * * 1') // Monday midnight
      const from = new Date('2024-01-15T10:00:00') // Monday Jan 15
      const next = getNextRun(parsed, from)
      // Should be next Monday (Jan 22)
      expect(next.getDay()).toBe(1)
      expect(next.getDate()).toBe(22)
    })

    it('always returns a future date', () => {
      const parsed = parseCron('0 0 * * *')
      const from = new Date()
      const next = getNextRun(parsed, from)
      expect(next.getTime()).toBeGreaterThan(from.getTime())
    })

    it('handles month boundaries', () => {
      const parsed = parseCron('0 0 1 * *') // 1st of month
      const from = new Date('2024-01-31T10:00:00')
      const next = getNextRun(parsed, from)
      expect(next.getDate()).toBe(1)
      expect(next.getMonth()).toBe(1) // February
    })
  })

  describe('task management', () => {
    it('creates a task with valid cron', () => {
      const task = createTask('test', '0 9 * * *', 'run tests')
      expect(task.id).toMatch(/^task_\d+_/)
      expect(task.name).toBe('test')
      expect(task.cron).toBe('0 9 * * *')
      expect(task.prompt).toBe('run tests')
      expect(task.enabled).toBe(true)
      expect(task.nextRun).not.toBeNull()
      expect(task.runCount).toBe(0)
    })

    it('creates a task with @every', () => {
      const task = createTask('periodic', '@every 5m', 'check status')
      expect(task.nextRun).not.toBeNull()
    })

    it('creates a task with invalid cron (nextRun null)', () => {
      const task = createTask('bad', 'invalid', 'do something')
      expect(task.nextRun).toBeNull()
    })

    it('addTask persists to disk', () => {
      const task = createTask('test', '0 9 * * *', 'run tests')
      addTask(tmpDir, task)
      const store = loadSchedules(tmpDir)
      expect(store.tasks.length).toBe(1)
    })

    it('removeTask by id', () => {
      const task = createTask('test', '0 9 * * *', 'run tests')
      addTask(tmpDir, task)
      expect(removeTask(tmpDir, task.id)).toBe(true)
      expect(loadSchedules(tmpDir).tasks.length).toBe(0)
    })

    it('removeTask by name', () => {
      const task = createTask('test', '0 9 * * *', 'run tests')
      addTask(tmpDir, task)
      expect(removeTask(tmpDir, 'test')).toBe(true)
      expect(loadSchedules(tmpDir).tasks.length).toBe(0)
    })

    it('removeTask returns false for unknown', () => {
      expect(removeTask(tmpDir, 'nonexistent')).toBe(false)
    })

    it('enableTask', () => {
      const task = createTask('test', '0 9 * * *', 'run tests')
      task.enabled = false
      addTask(tmpDir, task)
      expect(enableTask(tmpDir, 'test')).toBe(true)
      const store = loadSchedules(tmpDir)
      expect(store.tasks[0].enabled).toBe(true)
    })

    it('disableTask', () => {
      const task = createTask('test', '0 9 * * *', 'run tests')
      addTask(tmpDir, task)
      expect(disableTask(tmpDir, 'test')).toBe(true)
      const store = loadSchedules(tmpDir)
      expect(store.tasks[0].enabled).toBe(false)
    })

    it('enableTask returns false for unknown', () => {
      expect(enableTask(tmpDir, 'unknown')).toBe(false)
    })

    it('getDueTasks returns enabled tasks with past nextRun', () => {
      const task = createTask('past', '@every 1s', 'do thing')
      // Force nextRun to be in the past
      task.nextRun = new Date(Date.now() - 60000).toISOString()
      addTask(tmpDir, task)

      const due = getDueTasks(tmpDir)
      expect(due.length).toBe(1)
      expect(due[0].name).toBe('past')
    })

    it('getDueTasks excludes disabled tasks', () => {
      const task = createTask('disabled', '@every 1s', 'do thing')
      task.enabled = false
      task.nextRun = new Date(Date.now() - 60000).toISOString()
      addTask(tmpDir, task)

      expect(getDueTasks(tmpDir).length).toBe(0)
    })

    it('markTaskRun updates lastRun and nextRun', () => {
      const task = createTask('test', '0 9 * * *', 'do thing')
      addTask(tmpDir, task)

      markTaskRun(tmpDir, task.id, 'result text')

      const store = loadSchedules(tmpDir)
      const updated = store.tasks[0]
      expect(updated.lastRun).not.toBeNull()
      expect(updated.runCount).toBe(1)
      expect(updated.lastResult).toBe('result text')
      expect(updated.nextRun).not.toBeNull()
    })
  })

  describe('loadSchedules / saveSchedules', () => {
    it('returns empty store for non-existent file', () => {
      expect(loadSchedules(tmpDir)).toEqual({ tasks: [] })
    })

    it('round-trips data', () => {
      const store = { tasks: [createTask('t1', '0 9 * * *', 'p1')] }
      saveSchedules(tmpDir, store)
      const loaded = loadSchedules(tmpDir)
      expect(loaded.tasks.length).toBe(1)
      expect(loaded.tasks[0].name).toBe('t1')
    })

    it('creates .ovolv999 directory', () => {
      saveSchedules(tmpDir, { tasks: [] })
      expect(existsSync(join(tmpDir, '.ovolv999'))).toBe(true)
    })

    it('returns empty store on parse error', () => {
      mkdirSync(join(tmpDir, '.ovolv999'), { recursive: true })
      writeFileSync(join(tmpDir, '.ovolv999', 'schedules.json'), 'not json{')
      expect(loadSchedules(tmpDir)).toEqual({ tasks: [] })
    })
  })

  describe('formatting', () => {
    const sampleTask: ScheduledTask = {
      id: 'task_123_abc',
      name: 'Daily tests',
      cron: '0 9 * * *',
      prompt: 'Run the test suite',
      enabled: true,
      createdAt: '2024-01-15T10:00:00Z',
      lastRun: '2024-01-16T09:00:00Z',
      nextRun: '2024-01-17T09:00:00Z',
      runCount: 5,
      lastResult: 'All tests passed',
    }

    it('formatTaskList shows task summary', () => {
      const out = formatTaskList([sampleTask])
      expect(out).toContain('Daily tests')
      expect(out).toContain('0 9 * * *')
      expect(out).toContain('Run the test suite')
    })

    it('formatTaskList handles empty', () => {
      expect(formatTaskList([])).toContain('No scheduled tasks')
    })

    it('formatTaskList shows status', () => {
      const disabled = { ...sampleTask, enabled: false }
      const out = formatTaskList([disabled])
      expect(out).toContain('✗')
    })

    it('formatTaskDetail shows all fields', () => {
      const out = formatTaskDetail(sampleTask)
      expect(out).toContain('Daily tests')
      expect(out).toContain('task_123_abc')
      expect(out).toContain('0 9 * * *')
      expect(out).toContain('Run the test suite')
      expect(out).toContain('5')
      expect(out).toContain('All tests passed')
    })
  })
})
