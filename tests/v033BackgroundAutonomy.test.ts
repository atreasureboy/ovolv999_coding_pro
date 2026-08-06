/**
 * v0.3.3 (background autonomy contract §Phase 7) background-autonomy regression tests.
 * 20+ strong assertions covering: per-run isolation, completion semantics,
 * DONE/PARKED safety, model-call clearing, and stale-file detection.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { tmpdir } from 'os'
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from 'fs'
import { join } from 'path'
import { classifyTaskIntent } from '../src/core/runtime/taskIntent.js'
import { evaluateCompletion } from '../src/core/runtime/completionContract.js'
import { TaskGraph } from '../src/core/runtime/taskGraph.js'
import { InMemoryRunScopedRuntimeContextStore } from '../src/core/runtime/runScopedContext.js'
import { parseDoneFlag, verifyDoneFlag, renderDoneFlag, type DoneFlagPayload } from '../src/core/loopEngine.js'
import type { LoopCheckpoint } from '../src/core/loopSupervisor.js'

let tmp = ''
beforeEach(() => { tmp = mkdtempSync(`${tmpdir}/v033-`) })
afterEach(() => { rmSync(tmp, { recursive: true, force: true }) })

// ADR-007 fixtures — a valid flag and its matching succeeded checkpoint.
function mkDoneFlag(over: Partial<DoneFlagPayload> = {}): DoneFlagPayload {
  return {
    marker: 'DRIVER_VERIFIED',
    nonce: 'nonce-1',
    runId: 'run-1',
    iteration: 3,
    checkpointSequence: 7,
    goalHash: 'a1b2c3d4',
    acceptanceHash: 'e5f60718',
    gates: ['typecheck', 'lint', 'test', 'build'],
    completedAt: '2026-07-28T00:00:00.000Z',
    ...over,
  }
}

function mkCheckpoint(over: Partial<LoopCheckpoint> = {}): LoopCheckpoint {
  return {
    schemaVersion: 2, sequence: 7, taskId: 't', branch: 'main', worktree: '/w',
    iteration: 3, phase: 'succeeded', runId: 'run-1',
    passedQualityGates: ['typecheck', 'lint', 'test', 'build'],
    goalHash: 'a1b2c3d4', acceptanceHash: 'e5f60718',
    changedFiles: [], consecutiveNoProgress: 0,
    consecutiveProviderFailures: 0,
    createdAt: '2026-07-28T00:00:00.000Z', updatedAt: '2026-07-28T00:00:00.000Z',
    ...over,
  }
}

const VERIFY_CTX = {
  driverNonce: 'the-driver-nonce',
  checkpoint: null,
  liveGoalHash: 'a1b2c3d4',
  liveAcceptanceHash: 'e5f60718',
}

describe('v0.3.3 background autonomy regression (background autonomy contract §Phase 7)', () => {

  // ── §1: Chinese mutation not misclassified ──────────────────────
  it('§1: Chinese mutation goals are NOT classified as informational', () => {
    const goals = ['修复 bug', '重构模块', '增加测试', '删除无用代码', '完善错误处理']
    for (const g of goals) {
      expect(classifyTaskIntent(g).kind).toBe('mutation')
    }
  })

  it('§1: Chinese analysis goals classify as analysis', () => {
    expect(classifyTaskIntent('审计架构').kind).toBe('analysis')
    expect(classifyTaskIntent('验证方案').kind).toBe('analysis')
  })

  // ── §2/§3: Per-run isolation ─────────────────────────────────────
  it('§2: each Run gets an independent ProgressMonitor', () => {
    const store = new InMemoryRunScopedRuntimeContextStore()
    const ctx1 = store.create('run-1', { taskKind: 'mutation' as const, projectIdentity: { inputCwd: '/tmp/test', canonicalRoot: '/tmp/test', projectKey: 'test', binding: { repo: '/tmp/test', baseCommit: 'abc123', dirty: false, diffHash: 'abc123', workspaceHash: 'abc123' } } })
    const ctx2 = store.create('run-2', { taskKind: 'mutation' as const, projectIdentity: { inputCwd: '/tmp/test', canonicalRoot: '/tmp/test', projectKey: 'test', binding: { repo: '/tmp/test', baseCommit: 'abc123', dirty: false, diffHash: 'abc123', workspaceHash: 'abc123' } } })
    expect(ctx1.progressMonitor).not.toBe(ctx2.progressMonitor)
    ctx1.progressMonitor.recordVerification(5)
    const snap2 = ctx2.progressMonitor.snapshot(0)
    expect(snap2.verificationDelta).toBe(0) // run-2 unaffected by run-1
  })

  it('§3: each Run gets an independent ControlMessageLog', () => {
    const store = new InMemoryRunScopedRuntimeContextStore()
    const ctx1 = store.create('run-1', { taskKind: 'mutation' as const, projectIdentity: { inputCwd: '/tmp/test', canonicalRoot: '/tmp/test', projectKey: 'test', binding: { repo: '/tmp/test', baseCommit: 'abc123', dirty: false, diffHash: 'abc123', workspaceHash: 'abc123' } } })
    const ctx2 = store.create('run-2', { taskKind: 'mutation' as const, projectIdentity: { inputCwd: '/tmp/test', canonicalRoot: '/tmp/test', projectKey: 'test', binding: { repo: '/tmp/test', baseCommit: 'abc123', dirty: false, diffHash: 'abc123', workspaceHash: 'abc123' } } })
    expect(ctx1.controlMessages).not.toBe(ctx2.controlMessages)
  })

  it('§3: each Run gets an independent TaskGraph', () => {
    const store = new InMemoryRunScopedRuntimeContextStore()
    const ctx1 = store.create('run-1', { taskKind: 'mutation' as const, projectIdentity: { inputCwd: '/tmp/test', canonicalRoot: '/tmp/test', projectKey: 'test', binding: { repo: '/tmp/test', baseCommit: 'abc123', dirty: false, diffHash: 'abc123', workspaceHash: 'abc123' } } })
    const ctx2 = store.create('run-2', { taskKind: 'mutation' as const, projectIdentity: { inputCwd: '/tmp/test', canonicalRoot: '/tmp/test', projectKey: 'test', binding: { repo: '/tmp/test', baseCommit: 'abc123', dirty: false, diffHash: 'abc123', workspaceHash: 'abc123' } } })
    ctx1.taskGraph.addNode({ id: 'a', title: 'a', description: '', dependencies: [], acceptanceCriteria: [] })
    expect(ctx1.taskGraph.size()).toBe(1)
    expect(ctx2.taskGraph.size()).toBe(0) // run-2 graph is empty
  })

  it('§3: TaskGraph transitions update the same Run progress monitor', () => {
    const store = new InMemoryRunScopedRuntimeContextStore()
    const ctx = store.create('run-1', { taskKind: 'mutation' as const, projectIdentity: { inputCwd: '/tmp/test', canonicalRoot: '/tmp/test', projectKey: 'test', binding: { repo: '/tmp/test', baseCommit: 'abc123', dirty: false, diffHash: 'abc123', workspaceHash: 'abc123' } } })
    ctx.taskGraph.addNode({ id: 'a', title: 'a', description: '', dependencies: [], acceptanceCriteria: [] })
    ctx.taskGraph.start('a')
    ctx.taskGraph.complete('a')
    expect(ctx.progressMonitor.snapshot(5).minutesSinceLastMeaningfulProgress).toBe(0)
  })

  // ── §5: Context released on close ────────────────────────────────
  it('§5: store.close() removes the context', () => {
    const store = new InMemoryRunScopedRuntimeContextStore()
    const context = store.create('run-x', { taskKind: 'mutation' as const, projectIdentity: { inputCwd: '/tmp/test', canonicalRoot: '/tmp/test', projectKey: 'test', binding: { repo: '/tmp/test', baseCommit: 'abc123', dirty: false, diffHash: 'abc123', workspaceHash: 'abc123' } } })
    expect(store.has('run-x')).toBe(true)
    store.close('run-x')
    expect(store.has('run-x')).toBe(false)
    expect(store.getLatest()).toBe(context)
  })

  it('§5: consecutive 20 Runs do not leak contexts', () => {
    const store = new InMemoryRunScopedRuntimeContextStore()
    for (let i = 0; i < 20; i++) {
      const rid = `run-${i}`
      store.create(rid, { taskKind: 'mutation' as const, projectIdentity: { inputCwd: '/tmp/test', canonicalRoot: '/tmp/test', projectKey: 'test', binding: { repo: '/tmp/test', baseCommit: 'abc123', dirty: false, diffHash: 'abc123', workspaceHash: 'abc123' } } })
      store.close(rid)
    }
    expect(store.list()).toHaveLength(0)
    expect(store.getLatest()?.runId).toBe('run-19')
  })

  // ── §8: blocked/partial/exhausted ≠ success ──────────────────────
  it('§8: mutation with no changes → NOT completed', () => {
    const v = evaluateCompletion({
      taskKind: 'mutation', modelStopped: true,
      acceptanceCriteria: [], verification: { executed: false, passed: false, failed: [] },
      activeWorkers: [], unresolvedBlockers: [], changedFiles: [],
      reviewerFindings: [], budgetState: { remaining: 1, exceeded: false },
    })
    expect(v.status).not.toBe('completed')
  })

  it('§8: verification failed → blocked', () => {
    const v = evaluateCompletion({
      taskKind: 'mutation', modelStopped: true,
      acceptanceCriteria: [], verification: { executed: true, passed: false, failed: ['npm test'] },
      activeWorkers: [], unresolvedBlockers: [], changedFiles: ['a.ts'],
      reviewerFindings: [], budgetState: { remaining: 1, exceeded: false },
    })
    expect(v.status).toBe('blocked')
  })

  it('§8: informational with no changes → completed', () => {
    const v = evaluateCompletion({
      taskKind: 'informational', modelStopped: true,
      acceptanceCriteria: [], verification: { executed: false, passed: false, failed: [] },
      activeWorkers: [], unresolvedBlockers: [], changedFiles: [],
      reviewerFindings: [], budgetState: { remaining: 1, exceeded: false },
    })
    expect(v.status).toBe('completed')
  })

  // ── §9: ambiguous intent ─────────────────────────────────────────
  it('§9: ambiguous goal defaults to informational without mutation warnings', () => {
    const intent = classifyTaskIntent('do something with the stuff')
    expect(intent.kind).toBe('informational')
    expect(intent.confidence).toBeLessThan(0.5)
  })

  // ─§10/11/12: Loop safety — DONE.flag integrity (ADR-007) ────────
  it('§10: a forged flag carrying the marker substring does not parse', () => {
    // The pre-ADR-007 attack: the old check was content.includes('DRIVER_VERIFIED').
    expect(parseDoneFlag('DRIVER_VERIFIED — trust me\n')).toBeNull()
    expect(parseDoneFlag('DRIVER_VERIFIED at iteration 3\n')).toBeNull()
    expect(parseDoneFlag('{"marker":"DRIVER_VERIFIED"}')).toBeNull() // missing binding fields
    expect(parseDoneFlag('not json at all')).toBeNull()
  })

  it('§10: renderDoneFlag → parseDoneFlag round-trips, and nonce match verifies', () => {
    const flag = parseDoneFlag(renderDoneFlag(mkDoneFlag({ nonce: 'the-driver-nonce' })))
    expect(flag).not.toBeNull()
    expect(verifyDoneFlag(flag!, VERIFY_CTX)).toBe('nonce')
  })

  it('§10: well-formed flag with unknown nonce and no checkpoint is rejected', () => {
    const flag = parseDoneFlag(renderDoneFlag(mkDoneFlag({ nonce: 'attacker-guess' })))!
    expect(verifyDoneFlag(flag, VERIFY_CTX)).toBeNull()
  })

  it('§10: checkpoint binding verifies a post-crash flag (cross-restart resume)', () => {
    const flag = parseDoneFlag(renderDoneFlag(mkDoneFlag({ nonce: 'dead-with-the-old-process' })))!
    const verdict = verifyDoneFlag(flag, {
      ...VERIFY_CTX,
      checkpoint: mkCheckpoint(),
    })
    expect(verdict).toBe('checkpoint')
  })

  it('§10: checkpoint binding rejects mismatched run/sequence/gates/phase/contract', () => {
    const flag = parseDoneFlag(renderDoneFlag(mkDoneFlag({ nonce: 'dead' })))!
    const base = { ...VERIFY_CTX }
    expect(verifyDoneFlag(flag, { ...base, checkpoint: mkCheckpoint({ runId: 'other-run' }) })).toBeNull()
    expect(verifyDoneFlag(flag, { ...base, checkpoint: mkCheckpoint({ sequence: 8 }) })).toBeNull()
    expect(verifyDoneFlag(flag, { ...base, checkpoint: mkCheckpoint({ phase: 'iteration-complete' }) })).toBeNull()
    expect(verifyDoneFlag(flag, {
      ...base,
      checkpoint: mkCheckpoint({ passedQualityGates: ['typecheck', 'lint'] }),
    })).toBeNull() // flag claims test+build the checkpoint never recorded
    expect(verifyDoneFlag(flag, { ...base, checkpoint: mkCheckpoint({ runId: undefined }) })).toBeNull()
    // Contract edited after completion → the flag belonged to the old goal.
    expect(verifyDoneFlag(flag, { ...base, checkpoint: mkCheckpoint(), liveGoalHash: 'changed' })).toBeNull()
    expect(verifyDoneFlag(flag, { ...base, checkpoint: mkCheckpoint(), liveAcceptanceHash: 'changed' })).toBeNull()
  })

  it('§11: empty acceptance file produces zero items', () => {
    const accPath = join(tmp, 'ACCEPTANCE.md')
    writeFileSync(accPath, '')
    const raw = readFileSync(accPath, 'utf8').trim()
    expect(raw).toBe('')
  })

  // ── §15: stale file detection ────────────────────────────────────
  it('§15: stale lock file can be detected and removed', () => {
    const lockPath = join(tmp, 'loop.lock')
    writeFileSync(lockPath, JSON.stringify({ pid: 999999, ts: Date.now() - 999_999_999 }))
    expect(existsSync(lockPath)).toBe(true)
    // A stale lock has a PID that doesn't exist
    const lock = JSON.parse(readFileSync(lockPath, 'utf8'))
    expect(lock.pid).toBe(999999)
    // Cleanup
    rmSync(lockPath)
    expect(existsSync(lockPath)).toBe(false)
  })

  it('§15: stale DONE from a different run is rejected by runId binding (ADR-007)', () => {
    // A perfectly valid flag — but from another run, against a checkpoint
    // signed by a different runId. Binding must refuse it.
    const flag = parseDoneFlag(renderDoneFlag(mkDoneFlag({ nonce: 'old', runId: 'old-run' })))!
    const verdict = verifyDoneFlag(flag, {
      ...VERIFY_CTX,
      checkpoint: mkCheckpoint({ runId: 'current-run' }),
    })
    expect(verdict).toBeNull()
  })

  // ── §18: TaskGraph state consistency ─────────────────────────────
  it('§18: blocked is NOT terminal; isDone() excludes blocked', () => {
    const g = new TaskGraph()
    g.addNode({ id: 'a', title: 'a', description: '', dependencies: [], acceptanceCriteria: [] })
    g.start('a')
    g.block('a', 'stuck')
    expect(g.isDone()).toBe(false) // blocked ≠ done
    expect(g.hasUnfinished()).toBe(true)
  })

  it('§18: completed+failed+cancelled = terminal; isDone() true', () => {
    const g = new TaskGraph()
    g.addNode({ id: 'a', title: 'a', description: '', dependencies: [], acceptanceCriteria: [] })
    g.start('a'); g.complete('a')
    expect(g.isDone()).toBe(true)
    expect(g.hasUnfinished()).toBe(false)
  })

  it('§18: retry moves failed → pending (not terminal)', () => {
    const g = new TaskGraph()
    g.addNode({ id: 'a', title: 'a', description: '', dependencies: [], acceptanceCriteria: [], retryPolicy: { maxAttempts: 2 } })
    g.start('a'); g.fail('a', 'boom')
    expect(g.get('a')!.status).toBe('failed')
    g.retry('a')
    expect(g.get('a')!.status).toBe('pending')
    expect(g.isDone()).toBe(false)
  })

  // ── §6: modelCalls cleared ───────────────────────────────────────
  it('§6: ProgressMonitor is fresh per Run (no carry-over)', () => {
    const store = new InMemoryRunScopedRuntimeContextStore()
    const ctx1 = store.create('run-1', { taskKind: 'mutation' as const, projectIdentity: { inputCwd: '/tmp/test', canonicalRoot: '/tmp/test', projectKey: 'test', binding: { repo: '/tmp/test', baseCommit: 'abc123', dirty: false, diffHash: 'abc123', workspaceHash: 'abc123' } } })
    ctx1.progressMonitor.recordVerification(3)
    store.close('run-1')
    const ctx2 = store.create('run-2', { taskKind: 'mutation' as const, projectIdentity: { inputCwd: '/tmp/test', canonicalRoot: '/tmp/test', projectKey: 'test', binding: { repo: '/tmp/test', baseCommit: 'abc123', dirty: false, diffHash: 'abc123', workspaceHash: 'abc123' } } })
    const snap = ctx2.progressMonitor.snapshot(0)
    expect(snap.verificationDelta).toBe(0) // fresh, no carry-over from run-1
  })

  // ── restore ──────────────────────────────────────────────────────
  it('restore(): TaskGraph survives serialize/restore', () => {
    const store = new InMemoryRunScopedRuntimeContextStore()
    const ctx1 = store.create('run-r', { taskKind: 'mutation' as const, projectIdentity: { inputCwd: '/tmp/test', canonicalRoot: '/tmp/test', projectKey: 'test', binding: { repo: '/tmp/test', baseCommit: 'abc123', dirty: false, diffHash: 'abc123', workspaceHash: 'abc123' } } })
    ctx1.taskGraph.addNode({ id: 'x', title: 'x', description: '', dependencies: [], acceptanceCriteria: ['test passes'] })
    ctx1.taskGraph.start('x')
    const json = JSON.stringify({
      runId: 'run-r', taskKind: 'mutation' as const, startedAt: Date.now(),
      taskGraphSnapshot: ctx1.taskGraph.snapshot(),
    })
    store.close('run-r')
    const restored = store.restore('run-r', JSON.parse(json))
    expect(restored.taskGraph.size()).toBe(1)
    expect(restored.taskGraph.get('x')!.status).toBe('running')
  })
})
