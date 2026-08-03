import { describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  canPromoteCompletion,
  canReuseGateEvidence,
  parseCompletionCandidate,
  shouldParkLoop,
} from '../src/core/loopEngine.js'
import {
  CheckpointManager,
  LoopLeaseManager,
  getProcessIdentity,
  hashContract,
  type LoopCheckpoint,
} from '../src/core/loopSupervisor.js'

describe('v0.3.6 reliability closure', () => {
  it('rejects bare and stale completion candidates', () => {
    expect(parseCompletionCandidate('DONE')).toBeNull()
    expect(parseCompletionCandidate(JSON.stringify({
      runId: 'run-old',
      completionStatus: 'completed',
      goalHash: 'old',
      acceptanceHash: 'old',
    }))).toBeNull()
  })

  it('accepts only a fully-bound completed candidate', () => {
    expect(parseCompletionCandidate(JSON.stringify({
      runId: 'run-1',
      completionStatus: 'completed',
      goalHash: hashContract('goal'),
      acceptanceHash: hashContract('acceptance'),
      checkpointSequence: 4,
    }))).toEqual({
      runId: 'run-1',
      completionStatus: 'completed',
      goalHash: hashContract('goal'),
      acceptanceHash: hashContract('acceptance'),
      checkpointSequence: 4,
    })
    expect(parseCompletionCandidate(JSON.stringify({
      runId: 'run-1',
      completionStatus: 'blocked',
      goalHash: 'a',
      acceptanceHash: 'b',
      checkpointSequence: 4,
    }))).toBeNull()
  })

  it('uses a stable process start identity rather than RSS', () => {
    const first = getProcessIdentity(process.pid)
    const pressure = Array.from({ length: 10_000 }, (_, index) => `allocation-${index}`)
    expect(pressure.length).toBe(10_000)
    expect(getProcessIdentity(process.pid)).toBe(first)
    expect(first).toContain(`:${process.pid}:`)
  })

  it('heartbeat liveness does not reset real progress stall detection', () => {
    expect(shouldParkLoop({ heartbeatWriteFailures: 0, consecutiveNoProgress: 3 })).toBe('stall')
    expect(shouldParkLoop({ heartbeatWriteFailures: 3, consecutiveNoProgress: 0 })).toBe('heartbeat')
    expect(shouldParkLoop({ heartbeatWriteFailures: 0, consecutiveNoProgress: 2 })).toBeNull()
  })

  it('never promotes blocked or partial outcomes even when tests pass', () => {
    const base = {
      acceptancePassed: true,
      fastGatesPassed: true,
      candidateMatches: true,
      taskGraphPassed: true,
      workersPassed: true,
    }
    expect(canPromoteCompletion({ ...base, completionStatus: 'blocked' })).toBe(false)
    expect(canPromoteCompletion({ ...base, completionStatus: 'partial' })).toBe(false)
    expect(canPromoteCompletion({ ...base, completionStatus: 'completed' })).toBe(true)
    expect(canPromoteCompletion({ ...base, completionStatus: 'completed', workersPassed: false })).toBe(false)
  })

  it('does not take over a stale lease owned by the same live process', () => {
    const dir = mkdtempSync(join(tmpdir(), 'v036-lease-'))
    try {
      const owner = new LoopLeaseManager(dir, { staleAfterMs: 0 })
      const lease = owner.acquire('task', dir)
      const contender = new LoopLeaseManager(dir, { staleAfterMs: 0 })
      expect(contender.tryTakeover('task', dir)).toBeNull()
      expect(JSON.parse(readFileSync(join(dir, 'loop.lock'), 'utf8')).ownerToken).toBe(lease.ownerToken)
      owner.release()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('detects PID reuse when the live PID start identity differs', () => {
    const dir = mkdtempSync(join(tmpdir(), 'v036-reuse-'))
    try {
      const lockPath = join(dir, 'loop.lock')
      const owner = new LoopLeaseManager(dir, { staleAfterMs: 0 })
      const lease = owner.acquire('task', dir)
      const stale = {
        ...lease,
        ownerToken: 'stale-owner',
        heartbeatAt: new Date(0).toISOString(),
        processStartFingerprint: 'identity-from-previous-process',
      }
      writeFileSync(lockPath, JSON.stringify(stale))
      const contender = new LoopLeaseManager(dir, { staleAfterMs: 0 })
      const taken = contender.tryTakeover('task', dir)
      expect(taken?.ownerToken).not.toBe('stale-owner')
      contender.release()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('round-trips restart evidence needed to avoid repeated phases', () => {
    const dir = mkdtempSync(join(tmpdir(), 'v036-checkpoint-'))
    try {
      const checkpoint: LoopCheckpoint = {
        schemaVersion: 2,
        sequence: 8,
        taskId: 'task',
        branch: 'main',
        worktree: dir,
        iteration: 3,
        phase: 'verification',
        runId: 'run-1',
        turnOutcome: { completion: { status: 'partial' } },
        taskGraph: { nodes: [{ id: 'test', status: 'done' }] },
        passedQualityGates: ['typecheck', 'lint'],
        providerCircuit: { status: 'half-open', consecutiveFailures: 4, failureBudget: 5 },
        recentCommands: ['npm test'],
        workerReferences: [{
          runId: 'worker-1',
          status: 'blocked',
          modelProfile: 'builder',
          modelRole: 'builder',
          modelTier: 'secondary',
          model: 'coding-model',
          provider: 'minimax',
          worktree: '/tmp/wt',
        }],
        goalHash: 'goal',
        acceptanceHash: 'acceptance',
        head: 'abc123',
        changedFiles: ['src/a.ts'],
        workspaceEvidenceHash: 'workspace',
        consecutiveNoProgress: 1,
        consecutiveProviderFailures: 4,
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:01:00.000Z',
      }
      const manager = new CheckpointManager(dir)
      manager.save(checkpoint)
      expect(manager.load()).toEqual(checkpoint)
      const workspace = { branch: 'main', head: 'abc123', changedFiles: ['src/a.ts'], evidenceHash: 'workspace' }
      expect(canReuseGateEvidence(manager.load(), 'goal', 'acceptance', ['typecheck', 'lint'], workspace)).toBe(true)
      expect(canReuseGateEvidence(manager.load(), 'changed-goal', 'acceptance', ['typecheck'], workspace)).toBe(false)
      expect(canReuseGateEvidence(manager.load(), 'goal', 'acceptance', ['build'], workspace)).toBe(false)
      expect(canReuseGateEvidence(manager.load(), 'goal', 'acceptance', ['typecheck'], {
        ...workspace,
        head: 'new-head',
      })).toBe(false)
      expect(canReuseGateEvidence(manager.load(), 'goal', 'acceptance', ['typecheck'], {
        ...workspace,
        evidenceHash: 'changed-diff',
      })).toBe(false)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
