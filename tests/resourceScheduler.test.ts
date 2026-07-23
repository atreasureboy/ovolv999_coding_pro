/**
 * Resource scheduler tests (fi_goal.md §五 Phase 4 / Round 7).
 *
 * Verifies:
 *   - Conflict matrix: read/read OK, write blocks read, exclusive blocks all
 *   - Atomic acquire (all-or-nothing on conflict)
 *   - Lease release frees claims for waiters
 *   - Acquire timeout
 *   - AbortSignal
 *   - Run terminal → auto-release via event bus
 *   - Worktree isolation
 *   - Git serialization
 *   - noWait fast-fail
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { tmpdir } from 'os'
import { mkdtempSync, rmSync } from 'fs'
import { join } from 'path'
import {
  ResourceScheduler,
  ResourceConflictError,
  ResourceAcquireTimeoutError,
  fileClaim,
  directoryClaim,
  gitClaim,
  portClaim,
} from '../src/core/resourceScheduler.js'
import { ExecutionRunRegistry, type CreateRunInput } from '../src/core/executionRun.js'
import { ExecutionRunEventBus, JsonlEventStore } from '../src/core/executionRunEvents.js'

let tmpRoot = ''

beforeEach(() => {
  tmpRoot = mkdtempSync(`${tmpdir()}/p4-`)
})
afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true })
})

function agentRun(overrides: Partial<CreateRunInput> = {}): CreateRunInput {
  return {
    kind: 'agent',
    goal: 'do something',
    workspace: { cwd: '/repo' },
    ...overrides,
  }
}

function bus() {
  const registry = new ExecutionRunRegistry()
  const store = new JsonlEventStore(join(tmpRoot, 'logs'))
  const eventBus = new ExecutionRunEventBus(registry, store)
  return { registry, store, eventBus }
}

// ─────────────────────────────────────────────────────────────────────
// Conflict matrix
// ─────────────────────────────────────────────────────────────────────
describe('conflict matrix', () => {
  it('two read claims on the same file coexist', async () => {
    const s = new ResourceScheduler()
    const a = await s.acquire('runA', [fileClaim('/a.txt', 'read')])
    const b = await s.acquire('runB', [fileClaim('/a.txt', 'read')])
    expect(a.released).toBe(false)
    expect(b.released).toBe(false)
    s.releaseAll()
  })

  it('write claim blocks subsequent read claim on same key', async () => {
    const s = new ResourceScheduler()
    await s.acquire('runW', [fileClaim('/a.txt', 'write')])
    await expect(
      s.acquire('runR', [fileClaim('/a.txt', 'read')], { noWait: true }),
    ).rejects.toBeInstanceOf(ResourceConflictError)
    s.releaseAll()
  })

  it('read claim blocks subsequent write claim on same key', async () => {
    const s = new ResourceScheduler()
    await s.acquire('runR', [fileClaim('/a.txt', 'read')])
    await expect(
      s.acquire('runW', [fileClaim('/a.txt', 'write')], { noWait: true }),
    ).rejects.toBeInstanceOf(ResourceConflictError)
    s.releaseAll()
  })

  it('two write claims on same key conflict', async () => {
    const s = new ResourceScheduler()
    await s.acquire('runW1', [fileClaim('/a.txt', 'write')])
    await expect(
      s.acquire('runW2', [fileClaim('/a.txt', 'write')], { noWait: true }),
    ).rejects.toBeInstanceOf(ResourceConflictError)
    s.releaseAll()
  })

  it('exclusive claim blocks read', async () => {
    const s = new ResourceScheduler()
    await s.acquire('runE', [directoryClaim('/repo', 'exclusive')])
    await expect(
      s.acquire('runR', [directoryClaim('/repo', 'read')], { noWait: true }),
    ).rejects.toBeInstanceOf(ResourceConflictError)
    s.releaseAll()
  })

  it('exclusive claim blocks write', async () => {
    const s = new ResourceScheduler()
    await s.acquire('runE', [directoryClaim('/repo', 'exclusive')])
    await expect(
      s.acquire('runW', [directoryClaim('/repo', 'write')], { noWait: true }),
    ).rejects.toBeInstanceOf(ResourceConflictError)
    s.releaseAll()
  })

  it('claims on different keys never conflict', async () => {
    const s = new ResourceScheduler()
    const a = await s.acquire('r1', [fileClaim('/a', 'exclusive')])
    const b = await s.acquire('r2', [fileClaim('/b', 'exclusive')])
    expect(a.released).toBe(false)
    expect(b.released).toBe(false)
    s.releaseAll()
  })
})

// ─────────────────────────────────────────────────────────────────────
// Atomic acquire
// ─────────────────────────────────────────────────────────────────────
describe('atomic acquire (all-or-nothing)', () => {
  it('acquires nothing when one of N claims conflicts', async () => {
    const s = new ResourceScheduler()
    // Pre-hold /b exclusively.
    await s.acquire('blocker', [fileClaim('/b', 'exclusive')])
    // Try to acquire /a (free) + /b (blocked) atomically.
    await expect(
      s.acquire(
        'requester',
        [fileClaim('/a', 'write'), fileClaim('/b', 'read')],
        { noWait: true },
      ),
    ).rejects.toBeInstanceOf(ResourceConflictError)
    // /a must NOT have been acquired (no partial hold).
    expect(s.snapshotHoldings().filter((h) => h.runId === 'requester')).toEqual([])
    // /a is still free for another acquirer.
    const c = await s.acquire('other', [fileClaim('/a', 'write')], { noWait: true })
    expect(c.released).toBe(false)
    s.releaseAll()
  })

  it('empty claim list returns an empty lease immediately', async () => {
    const s = new ResourceScheduler()
    const lease = await s.acquire('runX', [])
    expect(lease.claims).toEqual([])
    expect(lease.released).toBe(false)
    lease.release()
    expect(lease.released).toBe(true)
  })
})

// ─────────────────────────────────────────────────────────────────────
// Lease lifecycle
// ─────────────────────────────────────────────────────────────────────
describe('lease lifecycle', () => {
  it('release() makes held claims available again', async () => {
    const s = new ResourceScheduler()
    const a = await s.acquire('r1', [fileClaim('/a', 'write')])
    a.release()
    const b = await s.acquire('r2', [fileClaim('/a', 'write')], { noWait: true })
    expect(b.released).toBe(false)
    s.releaseAll()
  })

  it('release() is idempotent', async () => {
    const s = new ResourceScheduler()
    const a = await s.acquire('r1', [fileClaim('/a', 'write')])
    a.release()
    a.release()
    a.release()
    expect(a.released).toBe(true)
    expect(s.snapshotHoldings()).toHaveLength(0)
  })

  it('releaseRun() releases every lease tied to a run', async () => {
    const s = new ResourceScheduler()
    const l1 = await s.acquire('r1', [fileClaim('/a', 'read')])
    const l2 = await s.acquire('r1', [fileClaim('/b', 'read')])
    expect(s.releaseRun('r1')).toBe(2)
    expect(l1.released).toBe(true)
    expect(l2.released).toBe(true)
    expect(s.snapshotHoldings()).toHaveLength(0)
  })

  it('releaseRun() is a no-op for runs with no leases', () => {
    const s = new ResourceScheduler()
    expect(s.releaseRun('unknown')).toBe(0)
  })
})

// ─────────────────────────────────────────────────────────────────────
// Waiting + drain
// ─────────────────────────────────────────────────────────────────────
describe('waiter pump', () => {
  it('queued acquirer resumes when the blocker releases', async () => {
    const s = new ResourceScheduler()
    const blocker = await s.acquire('b', [fileClaim('/a', 'write')])
    const acquired = s.acquire('w', [fileClaim('/a', 'write')], { timeoutMs: 5000 })
    // Still queued.
    expect(s.waiterCount()).toBe(1)
    blocker.release()
    const lease = await acquired
    expect(lease.released).toBe(false)
    expect(s.waiterCount()).toBe(0)
    s.releaseAll()
  })

  it('multiple queued writers drain in FIFO order (one at a time)', async () => {
    const s = new ResourceScheduler()
    const blocker = await s.acquire('b', [fileClaim('/a', 'write')])
    const order: string[] = []
    let w1Lease: { release: () => void } | null = null
    const p1 = s.acquire('w1', [fileClaim('/a', 'write')], { timeoutMs: 5000 })
      .then((l) => { w1Lease = l; order.push('w1') })
    const p2 = s.acquire('w2', [fileClaim('/a', 'write')], { timeoutMs: 5000 })
      .then(() => { order.push('w2') })
    blocker.release()
    await p1
    expect(order).toEqual(['w1'])
    // w2 still queued because w1 holds the write.
    expect(s.waiterCount()).toBe(1)
    w1Lease!.release()
    await p2
    expect(order).toEqual(['w1', 'w2'])
    s.releaseAll()
  })

  it('two queued readers both resume when compatible readers come free', async () => {
    const s = new ResourceScheduler()
    // Hold the file with one writer.
    const blocker = await s.acquire('b', [fileClaim('/a', 'write')])
    const p1 = s.acquire('w1', [fileClaim('/a', 'read')])
    const p2 = s.acquire('w2', [fileClaim('/a', 'read')])
    blocker.release()
    const [l1, l2] = await Promise.all([p1, p2])
    expect(l1.released).toBe(false)
    expect(l2.released).toBe(false)
    s.releaseAll()
  })
})

// ─────────────────────────────────────────────────────────────────────
// Timeout + abort
// ─────────────────────────────────────────────────────────────────────
describe('acquire timeout + abort', () => {
  it('rejects with ResourceAcquireTimeoutError after the timeout elapses', async () => {
    vi.useFakeTimers()
    try {
      const s = new ResourceScheduler()
      await s.acquire('b', [fileClaim('/a', 'write')])
      const p = s.acquire('w', [fileClaim('/a', 'write')], { timeoutMs: 1000 })
      vi.advanceTimersByTime(1001)
      await expect(p).rejects.toBeInstanceOf(ResourceAcquireTimeoutError)
      s.releaseAll()
    } finally {
      vi.useRealTimers()
    }
  })

  it('aborts via AbortSignal', async () => {
    const s = new ResourceScheduler()
    await s.acquire('b', [fileClaim('/a', 'write')])
    const ac = new AbortController()
    const p = s.acquire('w', [fileClaim('/a', 'write')], { signal: ac.signal, timeoutMs: 5000 })
    ac.abort()
    await expect(p).rejects.toThrow(/aborted/)
    expect(s.waiterCount()).toBe(0)
    s.releaseAll()
  })

  it('timeout cleans the waiter from the queue', async () => {
    vi.useFakeTimers()
    try {
      const s = new ResourceScheduler()
      await s.acquire('b', [fileClaim('/a', 'write')])
      const p = s.acquire('w', [fileClaim('/a', 'write')], { timeoutMs: 100 })
      vi.advanceTimersByTime(101)
      await expect(p).rejects.toBeInstanceOf(ResourceAcquireTimeoutError)
      expect(s.waiterCount()).toBe(0)
      s.releaseAll()
    } finally {
      vi.useRealTimers()
    }
  })
})

// ─────────────────────────────────────────────────────────────────────
// Run terminal auto-release
// ─────────────────────────────────────────────────────────────────────
describe('run terminal → auto-release via event bus', () => {
  it('releases all leases when the run transitions to succeeded', async () => {
    const { registry, eventBus } = bus()
    const s = new ResourceScheduler({ eventBus })
    const run = registry.create(agentRun())
    registry.transition(run.runId, 'preparing')
    registry.transition(run.runId, 'running')

    const lease = await s.acquire(run.runId, [
      fileClaim('/a', 'write'),
      fileClaim('/b', 'read'),
    ])
    expect(lease.released).toBe(false)

    registry.transition(run.runId, 'succeeded')
    expect(lease.released).toBe(true)
    expect(s.snapshotHoldings()).toHaveLength(0)
  })

  it('releases on failed transition', async () => {
    const { registry, eventBus } = bus()
    const s = new ResourceScheduler({ eventBus })
    const run = registry.create(agentRun())
    registry.transition(run.runId, 'preparing')
    registry.transition(run.runId, 'running')
    const lease = await s.acquire(run.runId, [fileClaim('/a', 'write')])
    registry.transition(run.runId, 'failed', { error: 'kaboom' })
    expect(lease.released).toBe(true)
  })

  it('releases on cancelled transition', async () => {
    const { registry, eventBus } = bus()
    const s = new ResourceScheduler({ eventBus })
    const run = registry.create(agentRun())
    registry.transition(run.runId, 'preparing')
    registry.transition(run.runId, 'running')
    const lease = await s.acquire(run.runId, [fileClaim('/a', 'write')])
    registry.transition(run.runId, 'cancelled')
    expect(lease.released).toBe(true)
  })

  it('does NOT release on non-terminal transition', async () => {
    const { registry, eventBus } = bus()
    const s = new ResourceScheduler({ eventBus })
    const run = registry.create(agentRun())
    const lease = await s.acquire(run.runId, [fileClaim('/a', 'write')])
    registry.transition(run.runId, 'preparing')
    expect(lease.released).toBe(false)
    registry.transition(run.runId, 'running')
    expect(lease.released).toBe(false)
    s.releaseAll()
  })

  it('released claim unblocks a queued acquirer from a DIFFERENT run', async () => {
    const { registry, eventBus } = bus()
    const s = new ResourceScheduler({ eventBus })
    const runA = registry.create(agentRun({ goal: 'A' }))
    registry.transition(runA.runId, 'preparing')
    registry.transition(runA.runId, 'running')
    const runB = registry.create(agentRun({ goal: 'B' }))
    registry.transition(runB.runId, 'preparing')
    registry.transition(runB.runId, 'running')

    await s.acquire(runA.runId, [fileClaim('/a', 'write')])
    const queued = s.acquire(runB.runId, [fileClaim('/a', 'write')], { timeoutMs: 5000 })
    expect(s.waiterCount()).toBe(1)

    // Terminating runA should release the lock + wake runB.
    registry.transition(runA.runId, 'succeeded')
    const leaseB = await queued
    expect(leaseB.released).toBe(false)
    registry.transition(runB.runId, 'succeeded')
  })
})

// ─────────────────────────────────────────────────────────────────────
// Worktree isolation
// ─────────────────────────────────────────────────────────────────────
describe('worktree isolation', () => {
  it('claims with different workspaceKey never conflict', async () => {
    const s1 = new ResourceScheduler({ workspaceKey: '/repo/wt-a' })
    const s2 = new ResourceScheduler({ workspaceKey: '/repo/wt-b' })
    const a = await s1.acquire('r1', [fileClaim('/repo/file.txt', 'write')], { noWait: true })
    const b = await s2.acquire('r2', [fileClaim('/repo/file.txt', 'write')], { noWait: true })
    expect(a.released).toBe(false)
    expect(b.released).toBe(false)
    s1.releaseAll()
    s2.releaseAll()
  })

  it('claims with same workspaceKey do conflict', async () => {
    const s = new ResourceScheduler({ workspaceKey: '/repo/wt-a' })
    await s.acquire('r1', [fileClaim('/repo/file.txt', 'write')])
    await expect(
      s.acquire('r2', [fileClaim('/repo/file.txt', 'write')], { noWait: true }),
    ).rejects.toBeInstanceOf(ResourceConflictError)
    s.releaseAll()
  })
})

// ─────────────────────────────────────────────────────────────────────
// Git serialization
// ─────────────────────────────────────────────────────────────────────
describe('git serialization', () => {
  it('two git claims on the same ref never coexist (both forced to exclusive)', async () => {
    const s = new ResourceScheduler()
    await s.acquire('r1', [gitClaim('main')])
    await expect(
      s.acquire('r2', [gitClaim('main')], { noWait: true }),
    ).rejects.toBeInstanceOf(ResourceConflictError)
    s.releaseAll()
  })

  it('git claim blocks even a read on the same ref', async () => {
    const s = new ResourceScheduler()
    await s.acquire('r1', [gitClaim('main')])
    // Even though we pass 'read' explicitly, the git serializer
    // upgrades it to exclusive internally.
    await expect(
      s.acquire('r2', [{ type: 'git', key: 'main', access: 'read' }], { noWait: true }),
    ).rejects.toBeInstanceOf(ResourceConflictError)
    s.releaseAll()
  })
})

// ─────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────
describe('claim helpers', () => {
  it('fileClaim/directoryClaim/portClaim shape', () => {
    expect(fileClaim('/a', 'read')).toEqual({ type: 'file', key: '/a', access: 'read' })
    expect(directoryClaim('/d', 'write')).toEqual({ type: 'directory', key: '/d', access: 'write' })
    expect(portClaim(3000, 'exclusive')).toEqual({ type: 'port', key: '3000', access: 'exclusive' })
    expect(gitClaim('main')).toEqual({ type: 'git', key: 'main', access: 'write' })
  })

  it('conflictsFor() returns blockers without acquiring', async () => {
    const s = new ResourceScheduler()
    await s.acquire('b', [portClaim(3000, 'exclusive')])
    const blockers = s.conflictsFor([portClaim(3000, 'read')])
    expect(blockers).toHaveLength(1)
    expect(blockers[0].blockerRunId).toBe('b')
    expect(blockers[0].blockerAccess).toBe('exclusive')
    s.releaseAll()
  })
})
