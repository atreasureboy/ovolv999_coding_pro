import { describe, it, expect, beforeEach } from 'vitest'
import { BackgroundTaskManager, formatTaskList, formatTaskDetail } from '../src/core/backgroundTaskManager.js'

// Helper: wait for a task to reach a non-running state
async function waitForDone(manager: BackgroundTaskManager, id: string, timeoutMs = 5000): Promise<void> {
  const info = await manager.waitForTask(id, timeoutMs)
  if (!info) throw new Error(`Task ${id} not found`)
  if (info.status === 'running') throw new Error(`Task ${id} did not complete within ${timeoutMs}ms`)
}

// Use platform-appropriate commands
const ECHO = process.platform === 'win32' ? 'echo hello' : 'echo hello'
const SLEEP = process.platform === 'win32' ? 'ping -n 2 127.0.0.1 > nul' : 'sleep 1'
const LONG_SLEEP = process.platform === 'win32' ? 'ping -n 30 127.0.0.1 > nul' : 'sleep 30'
const FAIL_CMD = process.platform === 'win32' ? 'exit 1' : 'false'

describe('BackgroundTaskManager', () => {
  let manager: BackgroundTaskManager

  beforeEach(() => {
    manager = new BackgroundTaskManager()
  })

  // ── createTask ────────────────────────────────────────────────────────────

  describe('createTask', () => {
    it('creates a task and returns an ID', () => {
      const id = manager.createTask(ECHO, { description: 'test echo' })
      expect(id).toMatch(/^task_/)
      const task = manager.getTask(id)
      expect(task).toBeDefined()
      expect(task!.command).toBe(ECHO)
      expect(task!.description).toBe('test echo')
      expect(task!.status).toBe('running')
      expect(task!.pid).not.toBeNull()
    })

    it('defaults description to command', () => {
      const id = manager.createTask(ECHO)
      const task = manager.getTask(id)
      expect(task!.description).toBe(ECHO)
    })

    it('stores metadata', () => {
      const id = manager.createTask(ECHO, { metadata: { tag: 'build', priority: 1 } })
      const task = manager.getTask(id)
      expect(task!.metadata).toEqual({ tag: 'build', priority: 1 })
    })
  })

  // ── getTask / getTaskDetail ───────────────────────────────────────────────

  describe('getTask & getTaskDetail', () => {
    it('returns undefined for non-existent task', () => {
      expect(manager.getTask('nonexistent')).toBeUndefined()
      expect(manager.getTaskDetail('nonexistent')).toBeUndefined()
    })

    it('returns task info without output in getTask', async () => {
      const id = manager.createTask(ECHO)
      await waitForDone(manager, id)
      const info = manager.getTask(id)!
      expect(info.status).toBe('completed')
      expect(info.exitCode).toBe(0)
      expect(info.endTime).not.toBeNull()
      expect(info.durationMs).not.toBeNull()
      // getTask does NOT include output
      expect((info as { output?: string }).output).toBeUndefined()
    })

    it('returns output in getTaskDetail', async () => {
      const id = manager.createTask(ECHO)
      await waitForDone(manager, id)
      const detail = manager.getTaskDetail(id)!
      expect(detail.output).toContain('hello')
    })

    it('reports failed status for non-zero exit', async () => {
      const id = manager.createTask(FAIL_CMD)
      await waitForDone(manager, id)
      const info = manager.getTask(id)!
      expect(info.status).toBe('failed')
      expect(info.exitCode).not.toBe(0)
    })
  })

  // ── listTasks ─────────────────────────────────────────────────────────────

  describe('listTasks', () => {
    it('returns empty list initially', () => {
      expect(manager.listTasks()).toHaveLength(0)
    })

    it('lists all tasks sorted by start time (newest first)', () => {
      const id1 = manager.createTask(ECHO, { description: 'first' })
      const id2 = manager.createTask(ECHO, { description: 'second' })
      const tasks = manager.listTasks()
      expect(tasks).toHaveLength(2)
      // Newest first
      expect(tasks[0].id).toBe(id2)
      expect(tasks[1].id).toBe(id1)
    })
  })

  // ── updateTask ────────────────────────────────────────────────────────────

  describe('updateTask', () => {
    it('updates description', () => {
      const id = manager.createTask(ECHO)
      const ok = manager.updateTask(id, { description: 'new desc' })
      expect(ok).toBe(true)
      expect(manager.getTask(id)!.description).toBe('new desc')
    })

    it('merges metadata', () => {
      const id = manager.createTask(ECHO, { metadata: { a: 1 } })
      manager.updateTask(id, { metadata: { b: 2 } })
      const task = manager.getTask(id)!
      expect(task.metadata).toEqual({ a: 1, b: 2 })
    })

    it('returns false for non-existent task', () => {
      expect(manager.updateTask('nope', { description: 'x' })).toBe(false)
    })
  })

  // ── stopTask ──────────────────────────────────────────────────────────────

  describe('stopTask', () => {
    it('stops a running task', async () => {
      const id = manager.createTask(LONG_SLEEP, { description: 'long sleep' })
      // Give it a moment to start
      await new Promise((r) => setTimeout(r, 200))

      const stopped = manager.stopTask(id)
      expect(stopped).toBe(true)

      const task = manager.getTask(id)!
      expect(task.status).toBe('stopped')
      expect(task.endTime).not.toBeNull()
    })

    it('returns false for non-existent task', () => {
      expect(manager.stopTask('nonexistent')).toBe(false)
    })

    it('returns false for already-completed task', async () => {
      const id = manager.createTask(ECHO)
      await waitForDone(manager, id)
      expect(manager.stopTask(id)).toBe(false)
    })

    // Regression: status stays 'stopped' even after process actually exits
    it('status remains stopped after killed process exits (no race)', async () => {
      const id = manager.createTask(LONG_SLEEP, { description: 'long' })
      await new Promise((r) => setTimeout(r, 200)) // let it start

      manager.stopTask(id)
      expect(manager.getTask(id)!.status).toBe('stopped')

      // Wait for the SIGTERM'd process to fully exit
      await new Promise((r) => setTimeout(r, 500))

      // Status should STILL be 'stopped', not overridden to 'failed'
      const finalInfo = manager.getTask(id)!
      expect(finalInfo.status).toBe('stopped')
    })
  })

  // ── waitForTask ───────────────────────────────────────────────────────────

  describe('waitForTask', () => {
    it('waits for a task to complete', async () => {
      const id = manager.createTask(SLEEP)
      const info = await manager.waitForTask(id, 5000)
      expect(info).not.toBeNull()
      expect(info!.status).not.toBe('running')
    })

    it('returns null for non-existent task', async () => {
      const info = await manager.waitForTask('nonexistent', 1000)
      expect(info).toBeNull()
    })

    it('returns immediately for already-completed task', async () => {
      const id = manager.createTask(ECHO)
      await waitForDone(manager, id)
      const start = Date.now()
      const info = await manager.waitForTask(id, 5000)
      expect(Date.now() - start).toBeLessThan(100)
      expect(info!.status).toBe('completed')
    })

    it('times out and returns running status for long task', async () => {
      const id = manager.createTask(LONG_SLEEP)
      const info = await manager.waitForTask(id, 200)
      expect(info).not.toBeNull()
      // Should still be running (timed out)
      expect(info!.status).toBe('running')
      // Clean up
      manager.stopTask(id)
    })
  })

  // ── clearCompleted ────────────────────────────────────────────────────────

  describe('clearCompleted', () => {
    it('removes completed tasks but keeps running ones', async () => {
      const id1 = manager.createTask(ECHO)
      const id2 = manager.createTask(LONG_SLEEP)
      await waitForDone(manager, id1)

      const removed = manager.clearCompleted()
      expect(removed).toBe(1)
      expect(manager.getTask(id1)).toBeUndefined()
      expect(manager.getTask(id2)).toBeDefined()

      manager.stopTask(id2)
    })
  })

  // ── Output capture ────────────────────────────────────────────────────────

  describe('output capture', () => {
    it('captures stdout', async () => {
      const id = manager.createTask(process.platform === 'win32' ? 'echo test123' : 'echo test123')
      await waitForDone(manager, id)
      const detail = manager.getTaskDetail(id)!
      expect(detail.output).toContain('test123')
    })

    it('captures stderr', async () => {
      const cmd = process.platform === 'win32'
        ? 'echo error456 1>&2'
        : 'echo error456 >&2'
      const id = manager.createTask(cmd)
      await waitForDone(manager, id)
      const detail = manager.getTaskDetail(id)!
      expect(detail.output).toContain('error456')
    })

    it('tracks outputLength', async () => {
      const id = manager.createTask(ECHO)
      await waitForDone(manager, id)
      const info = manager.getTask(id)!
      expect(info.outputLength).toBeGreaterThan(0)
    })

    // Regression: outputLength should track TOTAL bytes, not truncated buffer
    it('tracks total outputLength even when buffer exceeds cap', async () => {
      // Produce ~250KB of output (exceeds MAX_OUTPUT_BUFFER=200KB) via Node
      const cmd = 'node -e "process.stdout.write(\'X\'.repeat(250000))"'
      const id = manager.createTask(cmd)
      await waitForDone(manager, id, 10_000)
      const info = manager.getTask(id)!
      // outputLength should be >= 200KB (total produced), not capped at buffer size
      expect(info.outputLength).toBeGreaterThanOrEqual(200_000)
    })
  })

  // ── getOutputFile ─────────────────────────────────────────────────────────

  describe('getOutputFile', () => {
    it('returns null when no sessionDir provided', () => {
      const id = manager.createTask(ECHO)
      expect(manager.getOutputFile(id)).toBeNull()
    })
  })
})

// ── Formatting helpers ──────────────────────────────────────────────────────

describe('formatTaskList', () => {
  it('returns message for empty list', () => {
    expect(formatTaskList([])).toBe('No background tasks.')
  })

  it('formats tasks with status icons', () => {
    const tasks = [
      {
        id: 'task_abc', command: 'echo hi', description: 'test',
        status: 'completed' as const, exitCode: 0, pid: 123,
        startTime: 1000, endTime: 2000, durationMs: 1000, outputLength: 10,
        metadata: {},
      },
      {
        id: 'task_def', command: 'sleep 30', description: 'long',
        status: 'running' as const, exitCode: null, pid: 456,
        startTime: 3000, endTime: null, durationMs: null, outputLength: 0,
        metadata: {},
      },
    ]
    const result = formatTaskList(tasks)
    expect(result).toContain('✓')
    expect(result).toContain('task_abc')
    expect(result).toContain('completed')
    expect(result).toContain('◆')
    expect(result).toContain('task_def')
    expect(result).toContain('running')
  })

  it('shows exit code for non-zero', () => {
    const tasks = [
      {
        id: 'task_x', command: 'false', description: 'fail',
        status: 'failed' as const, exitCode: 1, pid: 789,
        startTime: 1000, endTime: 2000, durationMs: 1000, outputLength: 0,
        metadata: {},
      },
    ]
    const result = formatTaskList(tasks)
    expect(result).toContain('exit=1')
    expect(result).toContain('✗')
  })
})

describe('formatTaskDetail', () => {
  it('formats a completed task with output', () => {
    const detail = {
      id: 'task_abc', command: 'echo hi', description: 'test',
      status: 'completed' as const, exitCode: 0, pid: 123,
      startTime: 1000, endTime: 2000, durationMs: 1000, outputLength: 3,
      metadata: {}, output: 'hi\n',
    }
    const result = formatTaskDetail(detail)
    expect(result).toContain('Task task_abc: test')
    expect(result).toContain('Status: completed')
    expect(result).toContain('exit code: 0')
    expect(result).toContain('Command: echo hi')
    expect(result).toContain('Duration: 1.0s')
    expect(result).toContain('PID: 123')
    expect(result).toContain('hi')
  })

  it('formats a running task with "(still running)"', () => {
    const detail = {
      id: 'task_run', command: 'sleep 30', description: 'long',
      status: 'running' as const, exitCode: null, pid: 456,
      startTime: 1000, endTime: null, durationMs: null, outputLength: 0,
      metadata: {}, output: '',
    }
    const result = formatTaskDetail(detail)
    expect(result).toContain('(still running)')
    expect(result).toContain('(no output yet)')
  })
})
