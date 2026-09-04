import { afterEach, describe, expect, it } from 'vitest'
import { appendFileSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { TaskControlPlane, TaskOwnershipError, TaskWorker } from '../src/core/taskControlPlane.js'

const dirs: string[] = []

function plane(now: () => number = Date.now): { value: TaskControlPlane; file: string } {
  const dir = mkdtempSync(join(tmpdir(), 'ovogo-control-plane-'))
  dirs.push(dir)
  const file = join(dir, 'tasks.jsonl')
  return { value: new TaskControlPlane(file, now), file }
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('TaskControlPlane', () => {
  it('persists queue state and returns priority order', () => {
    const { value, file } = plane()
    const low = value.enqueue({ goal: 'low', cwd: '/tmp', priority: 1 })
    const high = value.enqueue({ goal: 'high', cwd: '/tmp', priority: 10 })
    const restored = new TaskControlPlane(file)
    expect(restored.list().map((task) => task.id)).toEqual([high.id, low.id])
    expect(restored.events(high.id).map((event) => event.type)).toEqual(['enqueued'])
  })

  it('claims exclusively and checks worker ownership', () => {
    const { value } = plane()
    value.enqueue({ goal: 'work', cwd: '/tmp' })
    const claimed = value.claim('worker-a')!
    expect(claimed.status).toBe('running')
    expect(value.claim('worker-b')).toBeNull()
    expect(() => value.complete(claimed.id, 'worker-b', {})).toThrow(TaskOwnershipError)
    expect(value.complete(claimed.id, 'worker-a', { summary: 'done' }).status).toBe('succeeded')
    expect(value.events(claimed.id).map((event) => event.type)).toEqual(['enqueued', 'claimed', 'completed'])
  })

  it('requeues an expired lease before exhausting attempts', () => {
    let now = 1_700_000_000_000
    const { value } = plane(() => now)
    const task = value.enqueue({ goal: 'retry', cwd: '/tmp', maxAttempts: 2 })
    value.claim('worker-a', 1_000)
    now += 1_001
    expect(value.recoverExpiredLeases()[0]?.status).toBe('queued')
    const retry = value.claim('worker-b', 1_000)!
    now += 1_001
    expect(value.recoverExpiredLeases()[0]?.status).toBe('failed')
    expect(value.get(task.id)?.attempt).toBe(2)
    expect(retry.workerId).toBe('worker-b')
  })

  it('runs a claimed task through the worker callback', async () => {
    const { value } = plane()
    const task = value.enqueue({ goal: 'execute', cwd: '/tmp' })
    const worker = new TaskWorker(value, {
      workerId: 'worker-a',
      execute: async (claimed) => ({ summary: claimed.goal, changedFiles: ['a.ts'] }),
    })
    const completed = await worker.runOnce()
    expect(completed?.id).toBe(task.id)
    expect(completed?.status).toBe('succeeded')
    expect(completed?.result?.changedFiles).toEqual(['a.ts'])
  })

  it('resolves with the terminal state when a run is cancelled mid-flight', async () => {
    const { value } = plane()
    const task = value.enqueue({ goal: 'doomed', cwd: '/tmp' })
    const worker = new TaskWorker(value, {
      workerId: 'worker-a',
      execute: async () => {
        value.cancel(task.id)
        return { summary: 'finished anyway' }
      },
    })
    const outcome = await worker.runOnce()
    expect(outcome?.status).toBe('cancelled')
    expect(value.events(task.id).map((event) => event.type)).toEqual(['enqueued', 'claimed', 'cancelled'])
  })

  it('skips malformed store lines instead of poisoning state', () => {
    const { value, file } = plane()
    const task = value.enqueue({ goal: 'real', cwd: '/tmp' })
    // A line that parses but carries a garbage task must not enter the
    // replayed state (NaN sorts, /tasks serving a statusless task).
    appendFileSync(file, JSON.stringify({ sequence: 999, taskId: 'bogus', type: 'enqueued', timestamp: 'x', task: { id: 'bogus', goal: 7, cwd: null, status: 42, priority: 'high', createdAt: 1 } }) + '\n')
    appendFileSync(file, 'not json at all\n')
    const restored = new TaskControlPlane(file)
    expect(restored.list().map((entry) => entry.id)).toEqual([task.id])
    expect(restored.events()).toHaveLength(1)
  })

  it('bounds the in-memory event tail while the store keeps full history', () => {
    const { file } = plane()
    const capped = new TaskControlPlane(file, Date.now, 2)
    capped.enqueue({ goal: 'one', cwd: '/tmp' })
    capped.enqueue({ goal: 'two', cwd: '/tmp' })
    const three = capped.enqueue({ goal: 'three', cwd: '/tmp' })
    expect(capped.events()).toHaveLength(2)
    expect(capped.events().at(-1)?.taskId).toBe(three.id)
    // Sequence continuity survives the trim.
    expect(capped.enqueue({ goal: 'four', cwd: '/tmp' }).id).toBeTruthy()
    // An uncapped reader replays the complete store history.
    expect(new TaskControlPlane(file).events()).toHaveLength(4)
  })

  it('rejects non-string goal/cwd with a clear error', () => {
    const { value } = plane()
    expect(() => value.enqueue({ goal: 42 as unknown as string, cwd: '/tmp' })).toThrow('task goal must be a string')
    expect(() => value.enqueue({ goal: 'x', cwd: 7 as unknown as string })).toThrow('task cwd must be a string')
  })
})
