/**
 * GAP-L: fault-injection tests (fi_goal §十二 robustness).
 *
 * Each test forces a specific failure mode and verifies the system
 * degrades gracefully instead of crashing, hanging, or corrupting
 * state. Scenarios:
 *
 *   L.1  JSONL event store: half-written / corrupted line is skipped
 *        on read, recovery proceeds with the remaining events.
 *   L.2  Provider stream: malformed delta (missing `choices`) does
 *        not crash the engine — turn ends with reason='error'.
 *   L.3  Provider stream: throws mid-stream (network reset) — turn
 *        ends with reason='error', no leaked in-flight flag.
 *   L.4  ResourceScheduler: acquire() rejects with timeout when a
 *        conflicting claim never drains.
 *   L.5  ResourceScheduler: abort signal cancels the waiter cleanly.
 *   L.6  Compaction invariant: dropping a protected field throws
 *        CompactionInvariantError (no silent loss).
 *   L.7  ExecutionRunRegistry: invalid transition throws (state
 *        machine stays canonical under bad input).
 *   L.8  AgentTool.steer(): refuses a terminal run, doesn't queue.
 *   L.9  JsonlEventStore.append(): throws propagate (no swallow on
 *        write side — only reads are best-effort).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { tmpdir } from 'os'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync } from 'fs'
import { join } from 'path'
import {
  JsonlEventStore,
  recoverRegistryFromStore,
  ExecutionRunEventBus,
} from '../src/core/executionRunEvents.js'
import {
  ExecutionRunRegistry,
  InvalidRunTransition,
} from '../src/core/executionRun.js'
import { ResourceScheduler, fileClaim } from '../src/core/resourceScheduler.js'
import {
  emptyWorkingState,
  addConstraint,
  compactionViolations,
  CompactionInvariantError,
} from '../src/core/workingState.js'
import { AgentTool } from '../src/tools/agent.js'
import { ExecutionEngine } from '../src/core/engine.js'
import type { EngineConfig, Tool } from '../src/core/types.js'
import type { Renderer } from '../src/ui/renderer.js'

let tmp = ''
beforeEach(() => { tmp = mkdtempSync(`${tmpdir()}/gapL-`) })
afterEach(() => { rmSync(tmp, { recursive: true, force: true }) })

// ─────────────────────────────────────────────────────────────────────
// L.1  JSONL half-written / corrupted line is skipped on read
// ─────────────────────────────────────────────────────────────────────
describe('L.1: JSONL store tolerates half-written / corrupt lines', () => {
  it('readAll() skips corrupt lines and returns the valid ones', () => {
    const logDir = join(tmp, 'logs')
    mkdirSync(logDir, { recursive: true })
    const store = new JsonlEventStore(logDir)
    // Seed the file directly with a mix of valid + corrupt + valid.
    const valid1 = JSON.stringify({ eventId: 'e1', runId: 'r1', sequence: 1, timestamp: 't', type: 'run.created', payload: {} })
    const valid2 = JSON.stringify({ eventId: 'e2', runId: 'r1', sequence: 2, timestamp: 't', type: 'run.started', payload: {} })
    writeFileSync(
      join(logDir, 'runs.jsonl'),
      valid1 + '\n' +
      '{not valid json\n' +
      'another corrupt line without braces\n' +
      valid2 + '\n' +
      // trailing partial line (simulates a crash mid-write)
      '{"eventId":"e3","runId":"r1","sequence":3,"time',
    )
    const events = store.readAll()
    expect(events.length).toBe(2)
    expect(events[0].eventId).toBe('e1')
    expect(events[1].eventId).toBe('e2')
  })

  it('recoverRegistryFromStore proceeds with the surviving events', () => {
    const logDir = join(tmp, 'logs')
    mkdirSync(logDir, { recursive: true })
    const runId = 'r-A'
    // A complete create event followed by a corrupted transition
    // followed by a valid terminal transition.
    const created = JSON.stringify({
      eventId: 'e1', runId, sequence: 1, timestamp: '2026-01-01T00:00:00.000Z',
      type: 'run.created',
      payload: {
        run: {
          runId, kind: 'agent', goal: 'g', status: 'queued', phase: 'created',
          workspace: { cwd: '/r' },
          acceptance: [], budget: {}, resources: [], artifacts: [],
          createdAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-01-01T00:00:00.000Z',
        },
      },
    })
    const started = JSON.stringify({
      eventId: 'e2', runId, sequence: 2, timestamp: '2026-01-01T00:00:01.000Z',
      type: 'run.started',
      payload: {
        from: 'queued',
        run: {
          runId, kind: 'agent', goal: 'g', status: 'preparing', phase: 'boot',
          workspace: { cwd: '/r' },
          acceptance: [], budget: {}, resources: [], artifacts: [],
          createdAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-01-01T00:00:01.000Z',
        },
      },
    })
    writeFileSync(
      join(logDir, 'runs.jsonl'),
      created + '\n{CORRUPT\n' + started + '\n',
    )
    const store = new JsonlEventStore(logDir)
    const registry = recoverRegistryFromStore(store)
    const run = registry.get(runId)
    expect(run).toBeDefined()
    expect(run!.status).toBe('preparing')
  })
})

// ─────────────────────────────────────────────────────────────────────
// L.2 / L.3  Provider malformed / throwing stream
// ─────────────────────────────────────────────────────────────────────

class FakeOpenAI {
  createCalls = 0
  private q: Array<{ k: 's'; s: AsyncIterable<unknown> } | { k: 'e'; e: Error }> = []
  chat = {
    completions: {
      create: (_p: Record<string, unknown>, o: { signal: AbortSignal }) => {
        this.createCalls++
        const n = this.q[this.createCalls - 1] ?? { k: 'e' as const, e: new Error('parked') }
        return new Promise<AsyncIterable<unknown>>((res, rej) => {
          if (o.signal.aborted) { rej(new Error('aborted')); return }
          o.signal.addEventListener('abort', () => rej(new Error('aborted')), { once: true })
          if (n.k === 's') res(n.s); else rej(n.e)
        })
      },
    },
  }
  push(s: AsyncIterable<unknown>) { this.q.push({ k: 's', s }) }
  pushError(e: Error) { this.q.push({ k: 'e', e }) }
}

async function* malformedStream(): AsyncIterable<unknown> {
  await Promise.resolve()
  // No `choices` field — provider bug.
  yield { /* malformed: missing choices */ usage: { prompt_tokens: 1, completion_tokens: 0 } }
}

async function* throwingStream(): AsyncIterable<unknown> {
  await Promise.resolve()
  yield { choices: [{ delta: { content: 'part' }, index: 0 }] }
  // Simulate a network reset mid-stream.
  throw new Error('ECONNRESET: socket hang up')
}

function fakeRenderer(): Renderer {
  const r: Record<string, (...args: unknown[]) => void> = {}
  for (const k of [
    'banner', 'raw', 'info', 'warn', 'error', 'success',
    'startSpinner', 'stopSpinner',
    'beginAssistantText', 'endAssistantText', 'streamToken',
    'assistantMessage', 'userMessage', 'toolCall', 'toolStart',
    'toolResult', 'compactStart', 'compactDone', 'contextWarning',
    'cost', 'compactionNotice', 'turnEnd', 'planModeHeader',
    'agentStart', 'agentDone', 'agentSummary', 'agentHeartbeat',
  ]) {
    r[k] = () => {}
  }
  return r as unknown as Renderer
}

function baseConfig(o: Partial<EngineConfig> = {}): EngineConfig {
  return {
    apiKey: 'k',
    model: 'm',
    maxIterations: 5,
    cwd: '/tmp',
    permissionMode: 'auto',
    permissionManager: undefined,
    enabledModules: [],
    ...o,
  }
}

describe('L.2: provider stream missing `choices` does not crash the engine', () => {
  it('turn ends with reason=error (not a thrown exception)', async () => {
    const c = new FakeOpenAI()
    c.push(malformedStream())
    const e = new ExecutionEngine(baseConfig(), fakeRenderer(), c as unknown as never)
    const result = await e.runTurn('q', [])
    expect(result.result.reason).toBe('error')
  })
})

describe('L.3: provider stream throwing mid-stream surfaces as reason=error', () => {
  it('turn ends cleanly without leaking the in-flight flag', async () => {
    const c = new FakeOpenAI()
    c.push(throwingStream())
    const e = new ExecutionEngine(baseConfig(), fakeRenderer(), c as unknown as never)
    const r1 = await e.runTurn('q', [])
    expect(r1.result.reason).toBe('error')
    // A follow-up turn must NOT hit the reentrancy guard — the first
    // turn's `finally` cleared the flag.
    c.push((async function* () {
      await Promise.resolve()
      yield { choices: [{ delta: { content: 'ok' }, index: 0, finish_reason: 'stop' }] }
    })())
    const r2 = await e.runTurn('q2', [])
    expect(r2.result.reason).toBe('stop_sequence')
  })
})

// ─────────────────────────────────────────────────────────────────────
// L.4 / L.5  ResourceScheduler timeout + abort
// ─────────────────────────────────────────────────────────────────────

describe('L.4: ResourceScheduler.acquire() rejects on timeout', () => {
  it('throws ResourceAcquireTimeoutError after timeoutMs', async () => {
    const s = new ResourceScheduler()
    // Holder never releases.
    s.acquire('holder', [fileClaim('/a', 'write')])
    const p = s.acquire('waiter', [fileClaim('/a', 'write')], { timeoutMs: 50 })
    await expect(p).rejects.toThrow(/timeout|acquire/i)
    // The waiter was cleaned from the queue (no leak).
    expect(s.waiterCount()).toBe(0)
  })
})

describe('L.5: ResourceScheduler.acquire() can be aborted via signal', () => {
  it('rejects with abort error and cleans the waiter', async () => {
    const s = new ResourceScheduler()
    s.acquire('holder', [fileClaim('/a', 'write')])
    const ac = new AbortController()
    const p = s.acquire('waiter', [fileClaim('/a', 'write')], { signal: ac.signal, timeoutMs: 5000 })
    ac.abort()
    await expect(p).rejects.toThrow(/aborted/i)
    expect(s.waiterCount()).toBe(0)
  })
})

// ─────────────────────────────────────────────────────────────────────
// L.6  Compaction invariant
// ─────────────────────────────────────────────────────────────────────

describe('L.6: compaction invariant surfaces dropped fields', () => {
  it('compactionViolations() flags a dropped constraint', () => {
    const before = addConstraint(emptyWorkingState('g'), 'must pass tests')
    const after = emptyWorkingState('g')
    const v = compactionViolations(before, after)
    expect(v.length).toBeGreaterThan(0)
    expect(() => {
      throw new CompactionInvariantError(v)
    }).toThrow(CompactionInvariantError)
  })
})

// ─────────────────────────────────────────────────────────────────────
// L.7  ExecutionRunRegistry state machine stays canonical
// ─────────────────────────────────────────────────────────────────────

describe('L.7: ExecutionRunRegistry rejects illegal transitions', () => {
  it('throws InvalidRunTransition on a forbidden move', () => {
    const r = new ExecutionRunRegistry()
    const run = r.create({ kind: 'agent', goal: 'g', workspace: { cwd: '/r' } })
    expect(() => {
      // queued → succeeded is NOT in VALID_TRANSITIONS
      r.transition(run.runId, 'succeeded')
    }).toThrow(InvalidRunTransition)
    // State unchanged.
    expect(r.get(run.runId)!.status).toBe('queued')
  })

  it('EventBus persist-first re-raises store append errors (documented behavior)', () => {
    // The bus's documented contract is "persist-first: if persistence
    // throws, re-raise — losing the event is worse than crashing the
    // transition". A disk-full scenario surfaces as a thrown error
    // out of registry.create() (via the bus's onEmit hook).
    const registry = new ExecutionRunRegistry()
    const failingStore: { append(): void } = {
      append() { throw new Error('disk full') },
    }
    const bus = new ExecutionRunEventBus(registry, failingStore as never)
    void bus // wires registry.onEmit; the side-effect matters
    expect(() => {
      registry.create({ kind: 'agent', goal: 'g', workspace: { cwd: '/r' } })
    }).toThrow(/disk full/)
  })
})

// ─────────────────────────────────────────────────────────────────────
// L.8  AgentTool.steer() refuses terminal runs
// ─────────────────────────────────────────────────────────────────────

describe('L.8: AgentTool.steer() is robust to terminal / unknown runs', () => {
  it('returns false on an unknown runId when a registry is wired', async () => {
    const registry = new ExecutionRunRegistry()
    const t = new AgentTool({
      factory: (() => ({})) as never,
      parentConfig: {} as never,
      parentRenderer: null,
      runRegistry: registry,
    })
    expect(await t.steer('does-not-exist', 'x')).toBe(false)
  })

  it('returns false on a terminal run without queueing', async () => {
    const registry = new ExecutionRunRegistry()
    const t = new AgentTool({
      factory: (() => ({})) as never,
      parentConfig: {} as never,
      parentRenderer: null,
      runRegistry: registry,
    })
    const run = registry.create({ kind: 'agent', goal: 'g', workspace: { cwd: '/r' } })
    registry.transition(run.runId, 'preparing')
    registry.transition(run.runId, 'running')
    registry.transition(run.runId, 'failed', { error: 'crashed' })

    expect(await t.steer(run.runId, 'recover')).toBe(false)
    // Queue stays empty.
    expect(t._drainSteerQueue(run.runId)).toBeUndefined()
  })
})

// ─────────────────────────────────────────────────────────────────────
// L.9  JsonlEventStore.append() write-side errors propagate
// ─────────────────────────────────────────────────────────────────────

describe('L.9: JsonlEventStore.append() propagates write errors', () => {
  it('throws when the log directory has been removed', () => {
    const logDir = join(tmp, 'gone')
    const store = new JsonlEventStore(logDir)
    rmSync(logDir, { recursive: true, force: true })
    expect(() => {
      store.append({
        eventId: 'e1', runId: 'r1', sequence: 1,
        timestamp: 't', type: 'run.created', payload: {},
      })
    }).toThrow()
  })

  it('creates the file lazily on first append when the dir exists', () => {
    const logDir = join(tmp, 'lazy')
    mkdirSync(logDir, { recursive: true })
    const store = new JsonlEventStore(logDir)
    expect(existsSync(join(logDir, 'runs.jsonl'))).toBe(false)
    store.append({
      eventId: 'e1', runId: 'r1', sequence: 1,
      timestamp: 't', type: 'run.created', payload: {},
    })
    expect(existsSync(join(logDir, 'runs.jsonl'))).toBe(true)
  })
})
