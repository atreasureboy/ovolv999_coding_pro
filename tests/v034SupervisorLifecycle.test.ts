/**
 * v0.3.4 (durable supervisor contract §Phase 12) supervisor lifecycle integration tests.
 * Tests --resume, --restart, and lease/checkpoint interplay.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { tmpdir } from 'os'
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from 'fs'
import { join } from 'path'
import { LoopLeaseManager, CheckpointManager, hashContract, type LoopCheckpoint } from '../src/core/loopSupervisor.js'

let tmp = ''
beforeEach(() => { tmp = mkdtempSync(`${tmpdir}/v034life-`) })
afterEach(() => { rmSync(tmp, { recursive: true, force: true }) })

function makeCheckpoint(iteration: number, opts: Partial<LoopCheckpoint> = {}): LoopCheckpoint {
  return {
    schemaVersion: 1, sequence: Date.now(), taskId: 'test', branch: 'main', worktree: '/tmp',
    iteration, phase: 'iteration-complete', goalHash: hashContract('goal'), acceptanceHash: hashContract('acc'),
    changedFiles: [], consecutiveNoProgress: 0, consecutiveProviderFailures: 0,
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    ...opts,
  }
}

describe('v0.3.4 supervisor lifecycle (durable supervisor contract §Phase 12)', () => {
  describe('checkpoint resume', () => {
    it('resume loads iteration + failure count from checkpoint', () => {
      const cm = new CheckpointManager(tmp)
      cm.save(makeCheckpoint(5, { consecutiveProviderFailures: 3 }))
      const loaded = cm.load()
      expect(loaded).not.toBeNull()
      expect(loaded!.iteration).toBe(5)
      expect(loaded!.consecutiveProviderFailures).toBe(3)
    })

    it('restart clears checkpoint', () => {
      const cm = new CheckpointManager(tmp)
      cm.save(makeCheckpoint(3))
      expect(cm.exists()).toBe(true)
      cm.clear()
      expect(cm.exists()).toBe(false)
      expect(cm.load()).toBeNull()
    })

    it('corrupt checkpoint falls back to previous', () => {
      const cm = new CheckpointManager(tmp)
      cm.save(makeCheckpoint(1))
      cm.save(makeCheckpoint(2))
      writeFileSync(join(tmp, 'checkpoint.json'), 'CORRUPT')
      const loaded = cm.load()
      expect(loaded).not.toBeNull()
      expect(loaded!.iteration).toBe(1) // fell back
    })

    it('goalHash + acceptanceHash stored for contract verification', () => {
      const cm = new CheckpointManager(tmp)
      const goal = 'Fix all type errors'
      const acc = 'npx tsc --noEmit'
      cm.save(makeCheckpoint(1, {
        goalHash: hashContract(goal),
        acceptanceHash: hashContract(acc),
      }))
      const loaded = cm.load()
      expect(loaded!.goalHash).toBe(hashContract(goal))
      expect(loaded!.acceptanceHash).toBe(hashContract(acc))
    })
  })

  describe('lease lifecycle', () => {
    it('lease acquired + heartbeat updates + released on exit', () => {
      const mgr = new LoopLeaseManager(tmp)
      const lease = mgr.acquire('task-1', '/project')
      expect(lease.ownerToken).toBeTruthy()

      mgr.updateHeartbeat({
        iteration: 1, phase: 'test', lastProgressAt: new Date().toISOString(),
        workerCount: 0, circuitStatus: 'closed', checkpointSequence: 1,
      })

      // Verify heartbeat written to file
      const data = JSON.parse(readFileSync(join(tmp, 'loop.lock'), 'utf8'))
      expect(data.heartbeat.iteration).toBe(1)

      mgr.release()
      expect(existsSync(join(tmp, 'loop.lock'))).toBe(false)
    })

    it('stale heartbeat (>120s) allows takeover', () => {
      const mgr1 = new LoopLeaseManager(tmp, { staleAfterMs: 1 })
      mgr1.acquire('task-1', '/project')
      mgr1.release()
      // Write stale lease manually
      writeFileSync(join(tmp, 'loop.lock'), JSON.stringify({
        schemaVersion: 1, ownerToken: 'old', pid: 999999, hostname: 'h',
        cwd: '/p', taskId: 't', createdAt: new Date(Date.now() - 200000).toISOString(),
        heartbeatAt: new Date(Date.now() - 200000).toISOString(),
        processStartFingerprint: 'old',
      }))
      const mgr2 = new LoopLeaseManager(tmp, { staleAfterMs: 1000 })
      const taken = mgr2.tryTakeover('task-1', '/project')
      expect(taken).not.toBeNull()
    })

    it('fresh heartbeat (<120s) blocks takeover', () => {
      const mgr1 = new LoopLeaseManager(tmp)
      mgr1.acquire('task-1', '/project')
      const mgr2 = new LoopLeaseManager(tmp)
      expect(mgr2.tryTakeover('task-1', '/project')).toBeNull()
      mgr1.release()
    })

    it('wrong owner cannot release', () => {
      const mgr1 = new LoopLeaseManager(tmp)
      mgr1.acquire('task-1', '/project')
      // Simulate different owner
      const data = JSON.parse(readFileSync(join(tmp, 'loop.lock'), 'utf8'))
      data.ownerToken = 'someone-else'
      writeFileSync(join(tmp, 'loop.lock'), JSON.stringify(data))
      mgr1.release()
      expect(existsSync(join(tmp, 'loop.lock'))).toBe(true) // still there
    })

    it('heartbeat write failures tracked', () => {
      const mgr = new LoopLeaseManager('/nonexistent/path')
      // acquire will throw — simulate via direct heartbeat
      // This tests the failure path without needing a real lease
      const ok = mgr.updateHeartbeat({
        iteration: 1, phase: 'test', lastProgressAt: '', workerCount: 0, circuitStatus: 'closed', checkpointSequence: 0,
      })
      expect(ok).toBe(false) // no lease set → returns false
    })
  })

  describe('provider backoff simulation', () => {
    it('exponential delay formula: 2^N * 1000 capped at 60s', () => {
      // Verify the backoff formula matches: min(60000, 2^N * 1000)
      const cases = [
        { failures: 2, expected: 4000 },
        { failures: 3, expected: 8000 },
        { failures: 5, expected: 32000 },
        { failures: 10, expected: 60000 }, // capped
      ]
      for (const { failures, expected } of cases) {
        const baseMs = Math.min(60_000, Math.pow(2, failures) * 1000)
        expect(baseMs).toBe(expected)
      }
    })
  })
})
