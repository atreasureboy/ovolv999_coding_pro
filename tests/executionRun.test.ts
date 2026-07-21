/**
 * ExecutionRun state machine + registry unit tests (fi_goal.md §三).
 *
 * Covers:
 *   - status definitions and terminal-set membership
 *   - VALID_TRANSITIONS map (forward moves, blocks out of terminals)
 *   - idempotent self-transitions
 *   - registry create/get/list/require
 *   - transition validation + InvalidRunTransition
 *   - update() for non-status patching
 *   - returned runs are frozen (immutability contract)
 *   - parent/child linkage via parentRunId filter
 */

import { describe, it, expect } from 'vitest'
import {
  ExecutionRunRegistry,
  InvalidRunTransition,
  RunNotFound,
  TERMINAL_RUN_STATES,
  canTransition,
  isTerminalRunStatus,
  type RunStatus,
  type CreateRunInput,
} from '../src/core/executionRun.js'

// ── Helpers ────────────────────────────────────────────────────────────────

function agentRun(overrides: Partial<CreateRunInput> = {}): CreateRunInput {
  return {
    kind: 'agent',
    goal: 'do the thing',
    workspace: { cwd: '/repo' },
    ...overrides,
  }
}

// ── Terminal-state predicates ──────────────────────────────────────────────

describe('TERMINAL_RUN_STATES / isTerminalRunStatus', () => {
  it('marks succeeded/failed/cancelled/timed_out/verification_failed as terminal', () => {
    const expected: RunStatus[] = [
      'succeeded',
      'failed',
      'cancelled',
      'timed_out',
      'verification_failed',
    ]
    for (const s of expected) {
      expect(isTerminalRunStatus(s)).toBe(true)
      expect(TERMINAL_RUN_STATES.has(s)).toBe(true)
    }
  })

  it('treats queued/preparing/running/waiting/verifying/blocked as non-terminal', () => {
    const active: RunStatus[] = ['queued', 'preparing', 'running', 'waiting', 'verifying', 'blocked']
    for (const s of active) {
      expect(isTerminalRunStatus(s)).toBe(false)
    }
  })
})

// ── canTransition ──────────────────────────────────────────────────────────

describe('canTransition', () => {
  it('permits the canonical forward path', () => {
    expect(canTransition('queued', 'preparing')).toBe(true)
    expect(canTransition('preparing', 'running')).toBe(true)
    expect(canTransition('running', 'waiting')).toBe(true)
    expect(canTransition('waiting', 'running')).toBe(true)
    expect(canTransition('running', 'verifying')).toBe(true)
    expect(canTransition('verifying', 'succeeded')).toBe(true)
  })

  it('permits cancellation from any non-terminal state', () => {
    const nonTerminal: RunStatus[] = ['queued', 'preparing', 'running', 'waiting', 'verifying', 'blocked']
    for (const s of nonTerminal) {
      expect(canTransition(s, 'cancelled')).toBe(true)
    }
  })

  it('permits failed from any non-terminal state', () => {
    const nonTerminal: RunStatus[] = ['queued', 'preparing', 'running', 'waiting', 'verifying', 'blocked']
    for (const s of nonTerminal) {
      expect(canTransition(s, 'failed')).toBe(true)
    }
  })

  it('permits resume from blocked back to running', () => {
    expect(canTransition('blocked', 'running')).toBe(true)
  })

  it('treats self-transitions as idempotent-allowed', () => {
    const all: RunStatus[] = [
      'queued', 'preparing', 'running', 'waiting', 'verifying',
      'succeeded', 'failed', 'cancelled', 'timed_out', 'blocked', 'verification_failed',
    ]
    for (const s of all) {
      expect(canTransition(s, s)).toBe(true)
    }
  })

  it('rejects transitions OUT of terminal states to anything else', () => {
    const terminals: RunStatus[] = ['succeeded', 'failed', 'cancelled', 'timed_out', 'verification_failed']
    const others: RunStatus[] = [
      'queued', 'preparing', 'running', 'waiting', 'verifying', 'blocked',
    ]
    for (const t of terminals) {
      for (const o of others) {
        expect(canTransition(t, o)).toBe(false)
      }
    }
  })

  it('rejects skipping the preparing stage (queued must not jump to running)', () => {
    expect(canTransition('queued', 'running')).toBe(false)
    expect(canTransition('queued', 'verifying')).toBe(false)
    expect(canTransition('queued', 'succeeded')).toBe(false)
  })

  it('rejects backward transitions on the happy path', () => {
    expect(canTransition('running', 'preparing')).toBe(false)
    expect(canTransition('verifying', 'running')).toBe(false)
    expect(canTransition('succeeded', 'verifying')).toBe(false)
  })

  it('permits verification_failed only from verifying', () => {
    expect(canTransition('verifying', 'verification_failed')).toBe(true)
    // Not reachable directly from running/waiting/queued.
    expect(canTransition('running', 'verification_failed')).toBe(false)
    expect(canTransition('waiting', 'verification_failed')).toBe(false)
    expect(canTransition('queued', 'verification_failed')).toBe(false)
  })

  it('permits timed_out from running/waiting only', () => {
    expect(canTransition('running', 'timed_out')).toBe(true)
    expect(canTransition('waiting', 'timed_out')).toBe(true)
    expect(canTransition('queued', 'timed_out')).toBe(false)
    expect(canTransition('verifying', 'timed_out')).toBe(false)
  })
})

// ── ExecutionRunRegistry.create / get / require ───────────────────────────

describe('ExecutionRunRegistry.create / get / require', () => {
  it('creates a run with default status=queued and phase=created', () => {
    const reg = new ExecutionRunRegistry()
    const run = reg.create(agentRun())
    expect(run.status).toBe('queued')
    expect(run.phase).toBe('created')
    expect(run.runId).toMatch(/[0-9a-f-]{36}/i)
    expect(run.acceptance).toEqual([])
    expect(run.budget).toEqual({})
    expect(run.resources).toEqual([])
    expect(run.artifacts).toEqual([])
    expect(run.createdAt).toBe(run.updatedAt)
  })

  it('creates a run with caller-supplied status/phase (resume path)', () => {
    const reg = new ExecutionRunRegistry()
    const run = reg.create(agentRun({ status: 'running', phase: 'mid-flight' }))
    expect(run.status).toBe('running')
    expect(run.phase).toBe('mid-flight')
  })

  it('propagates caller-supplied acceptance/budget/resources/artifacts', () => {
    const reg = new ExecutionRunRegistry()
    const run = reg.create(agentRun({
      acceptance: [{ description: 'tests pass', command: 'npm test', required: true }],
      budget: { maxDurationMs: 60_000, maxIterations: 10 },
      resources: [{ type: 'git', key: 'main', access: 'exclusive' }],
      artifacts: [{ id: 'a1', kind: 'log', path: '/tmp/log' }],
    }))
    expect(run.acceptance).toHaveLength(1)
    expect(run.budget.maxDurationMs).toBe(60_000)
    expect(run.resources).toHaveLength(1)
    expect(run.artifacts).toHaveLength(1)
  })

  it('assigns a fresh runId on every create()', () => {
    const reg = new ExecutionRunRegistry()
    const ids = new Set<string>()
    for (let i = 0; i < 50; i++) ids.add(reg.create(agentRun()).runId)
    expect(ids.size).toBe(50)
  })

  it('get returns undefined for unknown ids', () => {
    const reg = new ExecutionRunRegistry()
    expect(reg.get('nope')).toBeUndefined()
  })

  it('require throws RunNotFound for unknown ids', () => {
    const reg = new ExecutionRunRegistry()
    expect(() => reg.require('nope')).toThrow(RunNotFound)
    expect(() => reg.require('nope')).toThrow(/ExecutionRun not found: nope/)
  })
})

// ── ExecutionRunRegistry.transition ───────────────────────────────────────

describe('ExecutionRunRegistry.transition', () => {
  it('walks the canonical happy path', () => {
    const reg = new ExecutionRunRegistry()
    const run = reg.create(agentRun())
    const id = run.runId

    reg.transition(id, 'preparing')
    reg.transition(id, 'running')
    reg.transition(id, 'verifying')
    const final = reg.transition(id, 'succeeded')

    expect(final.status).toBe('succeeded')
    // updatedAt is always an ISO string; we don't assert it's strictly
    // greater than createdAt because the transitions can land inside
    // the same millisecond on fast machines.
    expect(final.updatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/)
    expect(final.runId).toBe(id)
  })

  it('throws InvalidRunTransition on an illegal move', () => {
    const reg = new ExecutionRunRegistry()
    const run = reg.create(agentRun())
    expect(() => reg.transition(run.runId, 'running')).toThrow(InvalidRunTransition)
    expect(() => reg.transition(run.runId, 'running')).toThrow(/queued → running/)
  })

  it('throws RunNotFound when transitioning a missing run', () => {
    const reg = new ExecutionRunRegistry()
    expect(() => reg.transition('ghost', 'preparing')).toThrow(RunNotFound)
  })

  it('accepts a patch alongside the transition', () => {
    const reg = new ExecutionRunRegistry()
    const run = reg.create(agentRun())
    const next = reg.transition(run.runId, 'preparing', { phase: 'spawning-child' })
    expect(next.phase).toBe('spawning-child')
  })

  it('stamps error on transition to failed', () => {
    const reg = new ExecutionRunRegistry()
    const run = reg.create(agentRun())
    reg.transition(run.runId, 'preparing')
    reg.transition(run.runId, 'running')
    const failed = reg.transition(run.runId, 'failed', { error: 'engine crashed' })
    expect(failed.status).toBe('failed')
    expect(failed.error).toBe('engine crashed')
  })

  it('stamps verification on transition to verification_failed', () => {
    const reg = new ExecutionRunRegistry()
    const run = reg.create(agentRun())
    reg.transition(run.runId, 'preparing')
    reg.transition(run.runId, 'running')
    reg.transition(run.runId, 'verifying')
    const v = reg.transition(run.runId, 'verification_failed', {
      verification: {
        passed: false,
        commands: [{ command: 'tsc', passed: false, exitCode: 1 }],
        startedAt: '2026-01-01T00:00:00Z',
        completedAt: '2026-01-01T00:00:05Z',
      },
    })
    expect(v.status).toBe('verification_failed')
    expect(v.verification?.passed).toBe(false)
  })

  it('blocks transitions out of terminal states', () => {
    const reg = new ExecutionRunRegistry()
    const run = reg.create(agentRun())
    reg.transition(run.runId, 'preparing')
    reg.transition(run.runId, 'running')
    reg.transition(run.runId, 'verifying')
    reg.transition(run.runId, 'succeeded')

    // Now in terminal — every further transition must fail.
    expect(() => reg.transition(run.runId, 'running')).toThrow(InvalidRunTransition)
    expect(() => reg.transition(run.runId, 'failed')).toThrow(InvalidRunTransition)
    expect(() => reg.transition(run.runId, 'cancelled')).toThrow(InvalidRunTransition)
  })

  it('idempotent self-transition is a no-op but updates updatedAt', async () => {
    const reg = new ExecutionRunRegistry()
    const run = reg.create(agentRun())
    reg.transition(run.runId, 'preparing')
    reg.transition(run.runId, 'running')

    // Wait a tick so the timestamp differs.
    await new Promise((r) => setTimeout(r, 5))

    const again = reg.transition(run.runId, 'running')
    expect(again.status).toBe('running')
    expect(again.updatedAt).not.toBe(run.updatedAt)
  })
})

// ── ExecutionRunRegistry.update ───────────────────────────────────────────

describe('ExecutionRunRegistry.update', () => {
  it('patches mutable fields without touching status', () => {
    const reg = new ExecutionRunRegistry()
    const run = reg.create(agentRun())
    const updated = reg.update(run.runId, {
      phase: 'mid-flight',
      artifacts: [{ id: 'a1', kind: 'log' }],
    })
    expect(updated.phase).toBe('mid-flight')
    expect(updated.artifacts).toHaveLength(1)
    expect(updated.status).toBe('queued')
  })

  it('cannot patch status via update() — that goes through transition()', () => {
    const reg = new ExecutionRunRegistry()
    const run = reg.create(agentRun())
    // update()'s signature excludes status, so this is a type-level guard.
    // For paranoia, also check that the field didn't accidentally move:
    const updated = reg.update(run.runId, { phase: 'working' })
    expect(updated.status).toBe('queued')
  })

  it('throws RunNotFound for unknown id', () => {
    const reg = new ExecutionRunRegistry()
    expect(() => reg.update('ghost', { phase: 'x' })).toThrow(RunNotFound)
  })
})

// ── ExecutionRunRegistry.list ─────────────────────────────────────────────

describe('ExecutionRunRegistry.list', () => {
  it('filters by status', () => {
    const reg = new ExecutionRunRegistry()
    const a = reg.create(agentRun({ goal: 'a' }))
    const b = reg.create(agentRun({ goal: 'b' }))
    reg.transition(a.runId, 'preparing')
    reg.transition(b.runId, 'preparing')
    reg.transition(b.runId, 'running')

    expect(reg.list({ status: 'queued' })).toHaveLength(0)
    expect(reg.list({ status: 'preparing' })).toHaveLength(1)
    expect(reg.list({ status: 'running' })).toHaveLength(1)
  })

  it('filters by kind', () => {
    const reg = new ExecutionRunRegistry()
    reg.create(agentRun({ kind: 'agent' }))
    reg.create(agentRun({ kind: 'turn' }))
    reg.create(agentRun({ kind: 'agent' }))

    expect(reg.list({ kind: 'agent' })).toHaveLength(2)
    expect(reg.list({ kind: 'turn' })).toHaveLength(1)
  })

  it('filters by parentRunId', () => {
    const reg = new ExecutionRunRegistry()
    const parent = reg.create(agentRun({ goal: 'parent' }))
    reg.create(agentRun({ goal: 'child1', parentRunId: parent.runId }))
    reg.create(agentRun({ goal: 'child2', parentRunId: parent.runId }))
    reg.create(agentRun({ goal: 'orphan' }))

    expect(reg.list({ parentRunId: parent.runId })).toHaveLength(2)
  })

  it('returns everything when no filter is supplied', () => {
    const reg = new ExecutionRunRegistry()
    reg.create(agentRun())
    reg.create(agentRun())
    expect(reg.list()).toHaveLength(2)
  })
})

// ── Immutability contract ──────────────────────────────────────────────────

describe('returned runs are frozen', () => {
  it('throws when a caller tries to mutate a returned run', () => {
    const reg = new ExecutionRunRegistry()
    const run = reg.create(agentRun())
    expect(() => {
      ;(run as { status: string }).status = 'running'
    }).toThrow(TypeError)
  })

  it('throws when a caller tries to mutate a transitioned run', () => {
    const reg = new ExecutionRunRegistry()
    const run = reg.create(agentRun())
    const next = reg.transition(run.runId, 'preparing')
    expect(() => {
      ;(next as { phase: string }).phase = 'hacked'
    }).toThrow(TypeError)
  })

  it('mutations via transition() do not corrupt earlier snapshots', () => {
    const reg = new ExecutionRunRegistry()
    const run = reg.create(agentRun())
    const originalStatus = run.status
    reg.transition(run.runId, 'preparing')
    // The earlier-snapshotted object still reflects its own state at
    // the time of return — important for log/UI code that holds a
    // reference for async rendering.
    expect(run.status).toBe(originalStatus)
    expect(reg.require(run.runId).status).toBe('preparing')
  })
})

// ── delete / size ──────────────────────────────────────────────────────────

describe('ExecutionRunRegistry.delete / size', () => {
  it('removes a run and decrements size', () => {
    const reg = new ExecutionRunRegistry()
    const r1 = reg.create(agentRun())
    const r2 = reg.create(agentRun())
    expect(reg.size()).toBe(2)
    expect(reg.delete(r1.runId)).toBe(true)
    expect(reg.size()).toBe(1)
    expect(reg.get(r1.runId)).toBeUndefined()
    expect(reg.get(r2.runId)).toBeDefined()
    expect(reg.delete('nope')).toBe(false)
  })
})
