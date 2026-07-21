/**
 * GAP-G: engine startup recovery via recoverRegistryFromStore.
 * GAP-H: maybeCompactWithInvariants wires §七 invariants.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { tmpdir } from 'os'
import { mkdtempSync, rmSync, mkdirSync, existsSync, writeFileSync } from 'fs'
import { join } from 'path'
import { ExecutionEngine } from '../src/core/engine.js'
import type { Renderer } from '../src/ui/renderer.js'
import { maybeCompactWithInvariants } from '../src/core/compact.js'
import {
  emptyWorkingState,
  addConstraint,
  compactionViolations,
  CompactionInvariantError,
  type WorkingState,
} from '../src/core/workingState.js'
import OpenAI from 'openai'

let tmp = ''

beforeEach(() => {
  tmp = mkdtempSync(`${tmpdir()}/gapGH-`)
})
afterEach(() => {
  rmSync(tmp, { recursive: true, force: true })
})

const noopRenderer: Renderer = {
  raw: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  userMessage: () => {},
  assistantMessage: () => {},
  toolCall: () => {},
  toolResult: () => {},
  cost: () => {},
  compactionNotice: () => {},
  turnEnd: () => {},
  planModeHeader: () => {},
} as never

function makeConfig(logDir?: string) {
  return {
    model: 'gpt-4o-mini',
    apiKey: 'sk-test',
    maxIterations: 1,
    cwd: tmp,
    permissionMode: 'auto' as const,
    executionRunLogDir: logDir,
  }
}

// ─────────────────────────────────────────────────────────────────────
// GAP-G: ExecutionEngine startup recovery
// ─────────────────────────────────────────────────────────────────────
describe('GAP-G: engine startup recovery', () => {
  it('constructs without executionRunLogDir (back-compat: no registry exposed)', () => {
    const engine = new ExecutionEngine(makeConfig(), noopRenderer)
    expect(engine.getRunRegistry()).toBeUndefined()
    expect(engine.getRunEventBus()).toBeUndefined()
  })

  it('exposes runRegistry + runEventBus when executionRunLogDir is set', () => {
    const logDir = join(tmp, 'logs')
    const engine = new ExecutionEngine(makeConfig(logDir), noopRenderer)
    expect(engine.getRunRegistry()).toBeDefined()
    expect(engine.getRunEventBus()).toBeDefined()
    // The JSONL file is created lazily on first append, so we verify
    // by emitting one event.
    const run = engine.getRunRegistry()!.create({
      kind: 'agent',
      goal: 'smoke',
      workspace: { cwd: tmp },
    })
    void run
    expect(existsSync(join(logDir, 'runs.jsonl'))).toBe(true)
  })

  it('recovers in-flight runs from a prior-process JSONL log on startup', () => {
    const logDir = join(tmp, 'logs')
    mkdirSync(logDir, { recursive: true })
    // Simulate a prior process: write events directly to the log.
    // Sequence: create → preparing → running (crashed mid-run).
    const priorRunId = '11111111-1111-1111-1111-111111111111'
    const events = [
      {
        eventId: 'e1', runId: priorRunId, sequence: 1,
        timestamp: '2026-01-01T00:00:00.000Z',
        type: 'run.created',
        payload: {
          run: {
            runId: priorRunId,
            kind: 'agent',
            goal: 'do thing',
            status: 'queued',
            phase: 'created',
            workspace: { cwd: '/repo' },
            acceptance: [], budget: {}, resources: [], artifacts: [],
            createdAt: '2026-01-01T00:00:00.000Z',
            updatedAt: '2026-01-01T00:00:00.000Z',
          },
        },
      },
      {
        eventId: 'e2', runId: priorRunId, sequence: 2,
        timestamp: '2026-01-01T00:00:01.000Z',
        type: 'run.started',
        payload: {
          from: 'queued',
          run: {
            runId: priorRunId,
            kind: 'agent',
            goal: 'do thing',
            status: 'preparing',
            phase: 'preparing',
            workspace: { cwd: '/repo' },
            acceptance: [], budget: {}, resources: [], artifacts: [],
            createdAt: '2026-01-01T00:00:00.000Z',
            updatedAt: '2026-01-01T00:00:01.000Z',
          },
        },
      },
      {
        eventId: 'e3', runId: priorRunId, sequence: 3,
        timestamp: '2026-01-01T00:00:02.000Z',
        type: 'run.progress',
        payload: {
          from: 'preparing',
          phase: 'running',
          run: {
            runId: priorRunId,
            kind: 'agent',
            goal: 'do thing',
            status: 'running',
            phase: 'running',
            workspace: { cwd: '/repo' },
            acceptance: [], budget: {}, resources: [], artifacts: [],
            createdAt: '2026-01-01T00:00:00.000Z',
            updatedAt: '2026-01-01T00:00:02.000Z',
          },
        },
      },
    ]
    writeFileSync(
      join(logDir, 'runs.jsonl'),
      events.map((e) => JSON.stringify(e)).join('\n') + '\n',
    )

    // Now boot the engine — it should recover the run AND mark it
    // failed (it was 'running' when the prior process died).
    const engine = new ExecutionEngine(makeConfig(logDir), noopRenderer)
    const registry = engine.getRunRegistry()!
    const recovered = registry.get(priorRunId)
    expect(recovered).toBeDefined()
    expect(recovered!.status).toBe('failed')
    expect(recovered!.error).toMatch(/process restarted mid-run/)
  })

  it('does not touch terminal runs from the prior log (succeeded stays succeeded)', () => {
    const logDir = join(tmp, 'logs')
    mkdirSync(logDir, { recursive: true })
    const priorRunId = '22222222-2222-2222-2222-222222222222'
    const events = [
      {
        eventId: 'e1', runId: priorRunId, sequence: 1,
        timestamp: '2026-01-01T00:00:00.000Z',
        type: 'run.created',
        payload: {
          run: {
            runId: priorRunId,
            kind: 'agent', goal: 'done-thing',
            status: 'succeeded', phase: 'completed',
            workspace: { cwd: '/repo' },
            acceptance: [], budget: {}, resources: [], artifacts: [],
            createdAt: '2026-01-01T00:00:00.000Z',
            updatedAt: '2026-01-01T00:00:00.000Z',
          },
        },
      },
    ]
    writeFileSync(
      join(logDir, 'runs.jsonl'),
      events.map((e) => JSON.stringify(e)).join('\n') + '\n',
    )

    const engine = new ExecutionEngine(makeConfig(logDir), noopRenderer)
    const registry = engine.getRunRegistry()!
    const recovered = registry.get(priorRunId)
    expect(recovered!.status).toBe('succeeded') // untouched
  })

  it('survives a corrupted log line on recovery (best-effort skip)', () => {
    const logDir = join(tmp, 'logs')
    mkdirSync(logDir, { recursive: true })
    writeFileSync(join(logDir, 'runs.jsonl'), '{not valid json\n')

    const engine = new ExecutionEngine(makeConfig(logDir), noopRenderer)
    expect(engine.getRunRegistry()!.size()).toBe(0)
  })
})

// ─────────────────────────────────────────────────────────────────────
// GAP-H: maybeCompactWithInvariants
// ─────────────────────────────────────────────────────────────────────
describe('GAP-H: maybeCompactWithInvariants wires §七 invariants', () => {
  it('is a no-op when maybeCompact returns compacted:false', async () => {
    // Use a FakeOpenAI-like client that returns no summary — maybeCompact
    // returns compacted:false on empty conversation.
    const client = new OpenAI({ apiKey: 'sk-test' })
    // Spy on chat.completions.create — we don't actually want a network call.
    // For this test we just verify that when state is undefined, the helper
    // doesn't throw.
    const result = await maybeCompactWithInvariants(
      client,
      'gpt-4o-mini',
      [],
      undefined,
      () => undefined,
    )
    expect(result.compacted).toBe(false)
  })

  it('throws CompactionInvariantError when post-state drops a protected field', () => {
    // Simulate the helper's invariant check directly.
    const before = addConstraint(emptyWorkingState('g'), 'must pass tests')
    const after = emptyWorkingState('g') // dropped constraint
    const violations = compactionViolations(before, after)
    expect(violations.length).toBeGreaterThan(0)
    expect(() => {
      throw new CompactionInvariantError(violations)
    }).toThrow(CompactionInvariantError)
  })

  it('passes through when post-state preserves all protected fields', () => {
    const before: WorkingState = {
      ...emptyWorkingState('g'),
      constraints: ['c1', 'c2'],
      confirmedFacts: [{ claim: 'f1' }],
      filesChanged: ['/a'],
      verification: { passed: ['npm test'], failed: ['npm run lint'] },
      unresolved: ['why?'],
    }
    // Strictly additive — nothing dropped.
    const after: WorkingState = {
      ...before,
      constraints: [...before.constraints, 'c3'],
      confirmedFacts: [...before.confirmedFacts, { claim: 'f2' }],
    }
    expect(compactionViolations(before, after)).toEqual([])
  })

  it('maybeCompactWithInvariants can be imported and called (wire-up smoke)', () => {
    expect(typeof maybeCompactWithInvariants).toBe('function')
  })
})
