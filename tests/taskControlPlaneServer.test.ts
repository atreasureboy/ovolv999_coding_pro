import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { TaskControlPlane } from '../src/core/taskControlPlane.js'
import { TaskControlPlaneServer } from '../src/server/taskControlPlaneServer.js'

const dirs: string[] = []
const servers: TaskControlPlaneServer[] = []

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.stop()))
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

async function server(): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), 'ovogo-control-server-'))
  dirs.push(dir)
  const value = new TaskControlPlane(join(dir, 'tasks.jsonl'))
  const instance = new TaskControlPlaneServer({ plane: value, port: 0 })
  servers.push(instance)
  const address = await instance.start()
  return `http://${address.host}:${address.port}`
}

describe('TaskControlPlaneServer', () => {
  it('exposes enqueue, claim, heartbeat, completion, and query endpoints', async () => {
    const base = await server()
    const created = await fetch(`${base}/tasks`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ goal: 'fix it', cwd: '/tmp', maxAttempts: 2 }),
    }).then((response) => response.json()) as { task: { id: string } }
    const claimed = await fetch(`${base}/tasks/claim`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ workerId: 'worker-a', leaseMs: 5_000 }),
    }).then((response) => response.json()) as { task: { id: string; status: string } }
    expect(claimed.task).toMatchObject({ id: created.task.id, status: 'running' })

    const heartbeat = await fetch(`${base}/tasks/${created.task.id}/heartbeat`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ workerId: 'worker-a', leaseMs: 5_000 }),
    })
    expect(heartbeat.status).toBe(200)

    const completed = await fetch(`${base}/tasks/${created.task.id}/complete`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ workerId: 'worker-a', result: { summary: 'done' } }),
    })
    expect(completed.status).toBe(200)

    const queried = await fetch(`${base}/tasks/${created.task.id}`).then((response) => response.json()) as { task: { status: string; result: { summary: string } } }
    expect(queried.task).toMatchObject({ status: 'succeeded', result: { summary: 'done' } })

    const history = await fetch(`${base}/events?taskId=${created.task.id}`).then((response) => response.json()) as { events: Array<{ type: string }> }
    expect(history.events.map((event) => event.type)).toEqual(['enqueued', 'claimed', 'heartbeat', 'completed'])
  })

  it('rejects completion from a worker that does not own the lease', async () => {
    const base = await server()
    const created = await fetch(`${base}/tasks`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ goal: 'fix it', cwd: '/tmp' }),
    }).then((response) => response.json()) as { task: { id: string } }
    await fetch(`${base}/tasks/claim`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ workerId: 'worker-a' }),
    })
    const response = await fetch(`${base}/tasks/${created.task.id}/complete`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ workerId: 'worker-b' }),
    })
    expect(response.status).toBe(409)
  })
})
