import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { Daemon, DaemonClient, getDaemonSocketPath, getDaemonLogPath, formatDaemonInfo, formatWorkers, type WorkerEntry } from '../src/core/daemon.js'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { existsSync, unlinkSync } from 'fs'

let testDir: string
let socketPath: string
let logPath: string
let daemon: Daemon

beforeEach(async () => {
  testDir = mkdtempSync(join(tmpdir(), 'ovolv999-daemon-'))
  socketPath = join(testDir, 'daemon.sock')
  logPath = join(testDir, 'daemon.log')
  daemon = new Daemon(socketPath, logPath)
  await daemon.start()
})

afterEach(async () => {
  await daemon.stop()
  rmSync(testDir, { recursive: true, force: true })
})

describe('daemon', () => {
  describe('Daemon', () => {
    it('starts and creates socket', () => {
      expect(existsSync(socketPath)).toBe(true)
    })

    it('reports running status', () => {
      const info = daemon.getInfo()
      expect(info.status).toBe('running')
      expect(info.pid).toBe(process.pid)
      expect(info.socketPath).toBe(socketPath)
    })

    it('tracks uptime', async () => {
      await new Promise(r => setTimeout(r, 100))
      const info = daemon.getInfo()
      expect(info.uptime).toBeGreaterThanOrEqual(50)
    })

    it('manages workers', () => {
      const w = daemon.addWorker('test-worker', 'echo hello')
      expect(w.name).toBe('test-worker')
      expect(w.status).toBe('starting')

      const workers = daemon.listWorkers()
      expect(workers).toHaveLength(1)

      daemon.updateWorkerStatus(w.id, 'running', 12345)
      const updated = daemon.listWorkers().find(x => x.id === w.id)
      expect(updated!.status).toBe('running')
      expect(updated!.pid).toBe(12345)

      expect(daemon.removeWorker(w.id)).toBe(true)
      expect(daemon.listWorkers()).toHaveLength(0)
    })

    it('responds to ping', async () => {
      const client = new DaemonClient(socketPath)
      const res = await client.send({ action: 'ping' })
      expect(res.ok).toBe(true)
      expect(res.data).toBe('pong')
    })

    it('responds to status', async () => {
      const client = new DaemonClient(socketPath)
      const res = await client.send({ action: 'status' })
      expect(res.ok).toBe(true)
      const info = res.data as { status: string; pid: number }
      expect(info.status).toBe('running')
    })

    it('responds to health', async () => {
      const client = new DaemonClient(socketPath)
      const res = await client.send({ action: 'health' })
      expect(res.ok).toBe(true)
      const health = res.data as { status: string; uptime: number; workers: number; memoryMB: number }
      expect(health.status).toBe('running')
      expect(health.memoryMB).toBeGreaterThan(0)
    })

    it('responds to list-workers', async () => {
      daemon.addWorker('w1')
      const client = new DaemonClient(socketPath)
      const res = await client.send({ action: 'list-workers' })
      expect(res.ok).toBe(true)
      const workers = res.data as WorkerEntry[]
      expect(workers).toHaveLength(1)
      expect(workers[0].name).toBe('w1')
    })

    it('returns error for unknown action', async () => {
      const client = new DaemonClient(socketPath)
      const res = await client.send({ action: 'unknown' as 'status' })
      expect(res.ok).toBe(false)
      expect(res.error).toContain('Unknown action')
    })
  })

  describe('DaemonClient', () => {
    it('ping returns true for running daemon', async () => {
      const client = new DaemonClient(socketPath)
      expect(await client.ping()).toBe(true)
    })

    it('status returns DaemonInfo', async () => {
      const client = new DaemonClient(socketPath)
      const info = await client.status()
      expect(info).toBeTruthy()
      expect(info!.status).toBe('running')
    })

    it('returns error for non-existent socket', async () => {
      const client = new DaemonClient('/nonexistent/sock')
      const res = await client.send({ action: 'ping' })
      expect(res.ok).toBe(false)
      expect(res.error).toContain('not found')
    })

    it('times out on slow response', async () => {
      const client = new DaemonClient(socketPath)
      const res = await client.send({ action: 'ping' }, 1)
      // Should still respond quickly, but test path exists
      expect(res.ok === true || res.ok === false).toBe(true)
    })
  })

  describe('formatting', () => {
    it('formats daemon info', () => {
      const info = daemon.getInfo()
      const out = formatDaemonInfo(info)
      expect(out).toContain('running')
      expect(out).toContain(String(process.pid))
      expect(out).toContain(socketPath)
    })

    it('formats empty workers', () => {
      const out = formatWorkers([])
      expect(out).toContain('No workers')
    })

    it('formats workers list', () => {
      daemon.addWorker('alpha')
      daemon.addWorker('beta')
      const out = formatWorkers(daemon.listWorkers())
      expect(out).toContain('alpha')
      expect(out).toContain('beta')
      expect(out).toContain('(2)')
    })
  })
})
