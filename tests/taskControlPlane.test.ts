import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
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
})
