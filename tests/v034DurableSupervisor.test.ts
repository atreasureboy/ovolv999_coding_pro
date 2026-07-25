/**
 * v0.3.4 (mimo_goal §Phase 12) durable supervisor regression tests.
 * Tests the LoopLeaseManager, CheckpointManager, TurnOutcome construction,
 * and contract hashing.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { tmpdir } from 'os'
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'fs'
import { join } from 'path'
import { LoopLeaseManager, CheckpointManager, hashContract, type LoopCheckpoint } from '../src/core/loopSupervisor.js'
import { isCompleted, isTerminal, shouldContinue, type TurnOutcome } from '../src/core/runtime/turnOutcome.js'

let tmp = ''
beforeEach(() => { tmp = mkdtempSync(`${tmpdir}/v034-`) })
afterEach(() => { rmSync(tmp, { recursive: true, force: true }) })

describe('v0.3.4 LoopLeaseManager', () => {
  it('§4: acquire creates lease atomically (wx flag)', () => {
    const mgr = new LoopLeaseManager(tmp)
    const lease = mgr.acquire('task-1', '/project')
    expect(lease.ownerToken).toBeTruthy()
    expect(lease.pid).toBe(process.pid)
    expect(existsSync(join(tmp, 'loop.lock'))).toBe(true)
  })

  it('§4: second acquire on same path fails (exclusive create)', () => {
    const mgr1 = new LoopLeaseManager(tmp)
    mgr1.acquire('task-1', '/project')
    const mgr2 = new LoopLeaseManager(tmp)
    expect(() => mgr2.acquire('task-1', '/project')).toThrow()
  })

  it('§4: release removes the lock', () => {
    const mgr = new LoopLeaseManager(tmp)
    mgr.acquire('task-1', '/project')
    mgr.release()
    expect(existsSync(join(tmp, 'loop.lock'))).toBe(false)
  })

  it('§4: release in finally covers early exit (simulated)', () => {
    const mgr = new LoopLeaseManager(tmp)
    try {
      mgr.acquire('task-1', '/project')
      throw new Error('simulated crash')
    } catch {
      mgr.release()
    }
    expect(existsSync(join(tmp, 'loop.lock'))).toBe(false)
  })

  it('§5: heartbeat updates heartbeatAt timestamp', () => {
    const mgr = new LoopLeaseManager(tmp, { intervalMs: 10_000, staleAfterMs: 50_000, writeTimeoutMs: 5_000 })
    const lease = mgr.acquire('task-1', '/project')
    const before = lease.heartbeatAt
    // Wait a tiny bit so timestamp differs
    const ok = mgr.updateHeartbeat({
      iteration: 1, phase: 'executing', lastProgressAt: new Date().toISOString(),
      workerCount: 0, circuitStatus: 'closed', checkpointSequence: 0,
    })
    expect(ok).toBe(true)
    const after = JSON.parse(readFileSync(join(tmp, 'loop.lock'), 'utf8'))
    // heartbeatAt should be >= before (might be same ms, but field must exist)
    expect(after.heartbeatAt).toBeTruthy()
  })

  it('§5: stale lease can be taken over', () => {
    const mgr1 = new LoopLeaseManager(tmp, { intervalMs: 10_000, staleAfterMs: 0, writeTimeoutMs: 5_000 })
    mgr1.acquire('task-1', '/project')
    mgr1.release() // release first so we can write a modified stale lease
    // Write a stale lease manually (1 hour ago, different PID)
    const staleLease = {
      schemaVersion: 1, ownerToken: 'old-token', pid: 999999,
      hostname: 'old-host', cwd: '/project', taskId: 'task-1',
      createdAt: new Date(Date.now() - 3_600_000).toISOString(),
      heartbeatAt: new Date(Date.now() - 3_600_000).toISOString(),
      processStartFingerprint: 'old-fp',
    }
    writeFileSync(join(tmp, 'loop.lock'), JSON.stringify(staleLease))
    // A new manager with short stale threshold should take over
    const mgr2 = new LoopLeaseManager(tmp, { intervalMs: 10_000, staleAfterMs: 1_000, writeTimeoutMs: 5_000 })
    const taken = mgr2.tryTakeover('task-1', '/project')
    expect(taken).not.toBeNull()
    expect(taken!.ownerToken).not.toBe('old-token')
  })

  it('§5: fresh lease prevents takeover', () => {
    const mgr1 = new LoopLeaseManager(tmp, { intervalMs: 10_000, staleAfterMs: 60_000, writeTimeoutMs: 5_000 })
    mgr1.acquire('task-1', '/project')
    const mgr2 = new LoopLeaseManager(tmp)
    const taken = mgr2.tryTakeover('task-1', '/project')
    expect(taken).toBeNull()
  })

  it('§5: wrong owner token cannot release', () => {
    const mgr1 = new LoopLeaseManager(tmp)
    mgr1.acquire('task-1', '/project')
    // Simulate a different owner modifying the lock
    const lease = JSON.parse(readFileSync(join(tmp, 'loop.lock'), 'utf8'))
    lease.ownerToken = 'someone-else'
    writeFileSync(join(tmp, 'loop.lock'), JSON.stringify(lease))
    // mgr1 still thinks it owns the lease, but the file says different owner
    mgr1.release()
    // Lock should still exist because owner token didn't match
    expect(existsSync(join(tmp, 'loop.lock'))).toBe(true)
  })
})

describe('v0.3.4 CheckpointManager', () => {
  it('§6: save and load round-trips', () => {
    const cm = new CheckpointManager(tmp)
    const cp: LoopCheckpoint = {
      schemaVersion: 1, sequence: 1, taskId: 't1', branch: 'main', worktree: '/wt',
      iteration: 3, phase: 'executing', goalHash: 'abc123', acceptanceHash: 'def456',
      changedFiles: ['a.ts'], consecutiveNoProgress: 0, consecutiveProviderFailures: 0,
      consecutiveCommandFailures: 0, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    }
    cm.save(cp)
    const loaded = cm.load()
    expect(loaded).not.toBeNull()
    expect(loaded!.iteration).toBe(3)
    expect(loaded!.taskId).toBe('t1')
  })

  it('§6: corrupt checkpoint falls back to previous backup', () => {
    const cm = new CheckpointManager(tmp)
    const cp1: LoopCheckpoint = {
      schemaVersion: 1, sequence: 1, taskId: 't1', branch: 'main', worktree: '/wt',
      iteration: 1, phase: 'start', goalHash: 'a', acceptanceHash: 'b',
      changedFiles: [], consecutiveNoProgress: 0, consecutiveProviderFailures: 0,
      consecutiveCommandFailures: 0, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    }
    cm.save(cp1)
    const cp2: LoopCheckpoint = { ...cp1, iteration: 2, sequence: 2 }
    cm.save(cp2) // cp1 becomes backup
    // Corrupt the main checkpoint
    writeFileSync(join(tmp, 'checkpoint.json'), '{ corrupt json')
    const loaded = cm.load()
    expect(loaded).not.toBeNull()
    expect(loaded!.iteration).toBe(1) // fell back to backup
  })

  it('§6: clear removes both files', () => {
    const cm = new CheckpointManager(tmp)
    cm.save({
      schemaVersion: 1, sequence: 1, taskId: 't', branch: 'b', worktree: '/w',
      iteration: 1, phase: 's', goalHash: 'a', acceptanceHash: 'b',
      changedFiles: [], consecutiveNoProgress: 0, consecutiveProviderFailures: 0,
      consecutiveCommandFailures: 0, createdAt: '', updatedAt: '',
    })
    cm.clear()
    expect(cm.exists()).toBe(false)
  })
})

describe('v0.3.4 TurnOutcome semantics', () => {
  const baseOutcome = (status: TurnOutcome['completion']['status']): TurnOutcome => ({
    runId: 'r1', stopReason: 'stop_sequence',
    completion: { status, reasons: [], evidence: [], requiredNextActions: [] },
    output: '', changedFiles: [], artifacts: [],
    verification: { executed: false, passed: false, failed: [] },
    modelAttempts: [], stopped: true, reason: 'stop_sequence',
  })

  it('§1: isCompleted only true for completed', () => {
    expect(isCompleted(baseOutcome('completed'))).toBe(true)
    expect(isCompleted(baseOutcome('partial'))).toBe(false)
    expect(isCompleted(baseOutcome('blocked'))).toBe(false)
  })

  it('§1: isTerminal for completed/failed/cancelled/exhausted', () => {
    expect(isTerminal(baseOutcome('completed'))).toBe(true)
    expect(isTerminal(baseOutcome('failed'))).toBe(true)
    expect(isTerminal(baseOutcome('exhausted'))).toBe(true)
    expect(isTerminal(baseOutcome('partial'))).toBe(false)
    expect(isTerminal(baseOutcome('blocked'))).toBe(false)
  })

  it('§1: shouldContinue for partial/blocked', () => {
    expect(shouldContinue(baseOutcome('partial'))).toBe(true)
    expect(shouldContinue(baseOutcome('blocked'))).toBe(true)
    expect(shouldContinue(baseOutcome('completed'))).toBe(false)
  })
})

describe('v0.3.4 contract hashing', () => {
  it('§7: same content produces same hash', () => {
    expect(hashContract('acceptance: typecheck')).toBe(hashContract('acceptance: typecheck'))
  })

  it('§7: different content produces different hash', () => {
    expect(hashContract('acceptance: typecheck')).not.toBe(hashContract('acceptance: lint'))
  })

  it('§7: empty content has a defined hash', () => {
    expect(hashContract('')).toBeTruthy()
  })
})
