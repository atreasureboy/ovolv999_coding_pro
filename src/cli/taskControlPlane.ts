import { createHash } from 'node:crypto'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { TaskControlPlane } from '../core/taskControlPlane.js'
import { TaskControlPlaneServer } from '../server/taskControlPlaneServer.js'

function defaultStore(cwd: string): string {
  const workspace = createHash('sha256').update(resolve(cwd)).digest('hex').slice(0, 16)
  return join(homedir(), '.ovogo', 'control-plane', workspace, 'tasks.jsonl')
}

export async function startTaskControlPlane(cwd: string, port = 7727): Promise<void> {
  if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error(`invalid task control plane port: ${port}`)
  const eventFile = process.env.OVOGO_TASK_STORE?.trim()
    ? resolve(process.env.OVOGO_TASK_STORE)
    : defaultStore(cwd)
  const plane = new TaskControlPlane(eventFile)
  const server = new TaskControlPlaneServer({ plane, port, host: '127.0.0.1' })
  const address = await server.start()
  process.stderr.write(`[task-server] listening on http://${address.host}:${address.port}\n`)
  process.stderr.write(`[task-server] store ${eventFile}\n`)

  let finish: (() => void) | undefined
  const stopped = new Promise<void>((resolveStopped) => { finish = resolveStopped })
  const shutdown = (): void => {
    server.stop().finally(() => finish?.()).catch(() => {})
  }
  process.once('SIGINT', shutdown)
  process.once('SIGTERM', shutdown)
  await stopped
  process.removeListener('SIGINT', shutdown)
  process.removeListener('SIGTERM', shutdown)
}
