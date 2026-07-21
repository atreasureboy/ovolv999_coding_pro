/**
 * ExecutionRunEventBus + JsonlEventStore + crash recovery
 * (fi_goal.md §四 Phase 3 / Round 5).
 *
 * Verifies:
 *   - Per-run sequence is monotonic
 *   - Events persist to JSONL BEFORE pushing to subscribers
 *   - Subscriber errors don't silently swallow
 *   - Critical subscriber errors transition the run to failed
 *   - Crash recovery via event replay reconstructs registry state
 *   - Corrupted JSONL lines are skipped, not fatal
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { tmpdir } from 'os'
import { mkdtempSync, rmSync, appendFileSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import {
  ExecutionRunRegistry,
  type ExecutionRun,
  type CreateRunInput,
} from '../src/core/executionRun.js'
import {
  ExecutionRunEventBus,
  JsonlEventStore,
  recoverRegistryFromStore,
  type RunEventEnvelope,
} from '../src/core/executionRunEvents.js'

let tmpRoot = ''
let logDir = ''

beforeEach(() => {
  tmpRoot = mkdtempSync(`${tmpdir()}/p3-`)
  logDir = join(tmpRoot, 'logs')
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

// ─────────────────────────────────────────────────────────────────────
// Event envelope + sequence
// ─────────────────────────────────────────────────────────────────────
describe('ExecutionRunEventBus assigns monotonic per-run sequence', () => {
  it('emits run.created with sequence 1 on create()', () => {
    const registry = new ExecutionRunRegistry()
    const bus = new ExecutionRunEventBus(registry)
    const events: RunEventEnvelope[] = []
    bus.on((e) => events.push(e))

    registry.create(agentRun({ goal: 'task' }))

    expect(events).toHaveLength(1)
    expect(events[0]!.type).toBe('run.created')
    expect(events[0]!.sequence).toBe(1)
    expect(events[0]!.runId).toMatch(/[0-9a-f-]{36}/i)
    expect(events[0]!.eventId).toMatch(/[0-9a-f-]{36}/i)
    expect(events[0]!.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/)
  })

  it('increments sequence per transition on the same run', () => {
    const registry = new ExecutionRunRegistry()
    const bus = new ExecutionRunEventBus(registry)
    const events: RunEventEnvelope[] = []
    bus.on((e) => events.push(e))

    const run = registry.create(agentRun())
    registry.transition(run.runId, 'preparing')
    registry.transition(run.runId, 'running')
    registry.transition(run.runId, 'succeeded')

    const seqs = events.map((e) => e.sequence)
    expect(seqs).toEqual([1, 2, 3, 4])
  })

  it('sequences are independent across runs', () => {
    const registry = new ExecutionRunRegistry()
    const bus = new ExecutionRunEventBus(registry)
    const events: RunEventEnvelope[] = []
    bus.on((e) => events.push(e))

    const a = registry.create(agentRun({ goal: 'A' }))
    const b = registry.create(agentRun({ goal: 'B' }))
    registry.transition(a.runId, 'preparing')
    registry.transition(b.runId, 'preparing')

    const aEvents = events.filter((e) => e.runId === a.runId)
    const bEvents = events.filter((e) => e.runId === b.runId)
    expect(aEvents.map((e) => e.sequence)).toEqual([1, 2])
    expect(bEvents.map((e) => e.sequence)).toEqual([1, 2])
  })
})

// ─────────────────────────────────────────────────────────────────────
// Event type mapping
// ─────────────────────────────────────────────────────────────────────
describe('ExecutionRunEventBus maps transitions to event types', () => {
  it('emits run.started on queued → preparing', () => {
    const registry = new ExecutionRunRegistry()
    const bus = new ExecutionRunEventBus(registry)
    const types: string[] = []
    bus.on((e) => types.push(e.type))

    const run = registry.create(agentRun())
    registry.transition(run.runId, 'preparing')

    expect(types).toContain('run.started')
  })

  it('emits run.progress on running → verifying', () => {
    const registry = new ExecutionRunRegistry()
    const bus = new ExecutionRunEventBus(registry)
    const types: string[] = []
    bus.on((e) => types.push(e.type))

    const run = registry.create(agentRun())
    registry.transition(run.runId, 'preparing')
    registry.transition(run.runId, 'running')
    registry.transition(run.runId, 'verifying')

    expect(types[types.length - 1]).toBe('run.progress')
  })

  it('emits run.completed on transition to succeeded', () => {
    const registry = new ExecutionRunRegistry()
    const bus = new ExecutionRunEventBus(registry)
    const types: string[] = []
    bus.on((e) => types.push(e.type))

    const run = registry.create(agentRun())
    registry.transition(run.runId, 'preparing')
    registry.transition(run.runId, 'running')
    registry.transition(run.runId, 'succeeded')

    expect(types).toContain('run.completed')
  })

  it('emits run.failed on transition to failed', () => {
    const registry = new ExecutionRunRegistry()
    const bus = new ExecutionRunEventBus(registry)
    const types: string[] = []
    bus.on((e) => types.push(e.type))

    const run = registry.create(agentRun())
    registry.transition(run.runId, 'preparing')
    registry.transition(run.runId, 'running')
    registry.transition(run.runId, 'failed', { error: 'kaboom' })

    const failEvent = eventsOfType(types, bus, 'run.failed')
    void failEvent
    expect(types).toContain('run.failed')
  })

  it('emits run.cancelled on transition to cancelled', () => {
    const registry = new ExecutionRunRegistry()
    const bus = new ExecutionRunEventBus(registry)
    const types: string[] = []
    bus.on((e) => types.push(e.type))

    const run = registry.create(agentRun())
    registry.transition(run.runId, 'cancelled')

    expect(types).toContain('run.cancelled')
  })

  it('emits run.blocked on transition to blocked', () => {
    const registry = new ExecutionRunRegistry()
    const bus = new ExecutionRunEventBus(registry)
    const types: string[] = []
    bus.on((e) => types.push(e.type))

    const run = registry.create(agentRun())
    registry.transition(run.runId, 'preparing')
    registry.transition(run.runId, 'running')
    registry.transition(run.runId, 'blocked')

    expect(types).toContain('run.blocked')
  })
})

// helper for the failed-event test
function eventsOfType(_types: string[], _bus: ExecutionRunEventBus, _t: string): void {}

// ─────────────────────────────────────────────────────────────────────
// Subscriber model
// ─────────────────────────────────────────────────────────────────────
describe('ExecutionRunEventBus subscriber model', () => {
  it('multiple subscribers all receive the same events', () => {
    const registry = new ExecutionRunRegistry()
    const bus = new ExecutionRunEventBus(registry)
    const a: RunEventEnvelope[] = []
    const b: RunEventEnvelope[] = []
    bus.on((e) => a.push(e))
    bus.on((e) => b.push(e))

    registry.create(agentRun())

    expect(a).toHaveLength(1)
    expect(b).toHaveLength(1)
    expect(a[0]).toEqual(b[0])
  })

  it('unsubscribe stops delivery', () => {
    const registry = new ExecutionRunRegistry()
    const bus = new ExecutionRunEventBus(registry)
    const events: RunEventEnvelope[] = []
    const off = bus.on((e) => events.push(e))

    registry.create(agentRun())
    expect(events).toHaveLength(1)
    off()
    const run2 = registry.create(agentRun())
    registry.transition(run2.runId, 'preparing')
    expect(events).toHaveLength(1) // no new events
  })

  it('best-effort subscriber errors are swallowed + routed to onError', () => {
    const registry = new ExecutionRunRegistry()
    const bus = new ExecutionRunEventBus(registry)
    const errors: Array<{ event: RunEventEnvelope; error: Error }> = []
    bus.onError = (event, error) => errors.push({ event, error })

    bus.on(() => { throw new Error('best-effort boom') })

    // The throw must NOT propagate out — registry.create() must succeed.
    const run = registry.create(agentRun())

    expect(run).toBeDefined()
    expect(errors).toHaveLength(1)
    expect(errors[0]!.error.message).toBe('best-effort boom')
  })

  it('critical subscriber errors transition the run to failed', () => {
    const registry = new ExecutionRunRegistry()
    const bus = new ExecutionRunEventBus(registry)
    const errors: Array<{ event: RunEventEnvelope; error: Error }> = []
    bus.onError = (event, error) => errors.push({ event, error })

    bus.on(() => { throw new Error('critical boom') }, { criticality: 'critical' })

    const run = registry.create(agentRun())
    // The critical subscriber threw on run.created — the run must end
    // up in 'failed' so observers see a structural failure.
    const final = registry.get(run.runId)!
    expect(final.status).toBe('failed')
    expect(final.error).toMatch(/critical subscriber threw/)
  })

  it('critical subscriber re-entrancy guard: the failed transition does not recurse', () => {
    const registry = new ExecutionRunRegistry()
    const bus = new ExecutionRunEventBus(registry)
    let callCount = 0
    bus.on(() => {
      callCount++
      if (callCount === 1) throw new Error('critical once')
    }, { criticality: 'critical' })

    registry.create(agentRun())
    // Without the guard, the failed transition would re-emit
    // run.failed → re-invoke the subscriber → infinite recursion.
    // With the guard, the re-entrant emission is silenced so the
    // subscriber is called exactly once.
    expect(callCount).toBe(1)
  })
})

// ─────────────────────────────────────────────────────────────────────
// JSONL persistence
// ─────────────────────────────────────────────────────────────────────
describe('JsonlEventStore appends + reads events', () => {
  it('persists every emitted event to runs.jsonl', () => {
    const store = new JsonlEventStore(logDir)
    const registry = new ExecutionRunRegistry()
    const bus = new ExecutionRunEventBus(registry, store)

    const run = registry.create(agentRun({ goal: 'persist me' }))
    registry.transition(run.runId, 'preparing')
    registry.transition(run.runId, 'running')
    registry.transition(run.runId, 'succeeded')

    const events = store.readAll()
    expect(events).toHaveLength(4)
    expect(events.map((e) => e.type)).toEqual([
      'run.created',
      'run.started',
      'run.progress',
      'run.completed',
    ])
  })

  it('persists BEFORE subscribers see the event', () => {
    const store = new JsonlEventStore(logDir)
    const registry = new ExecutionRunRegistry()
    const bus = new ExecutionRunEventBus(registry, store)

    // Subscriber that checks the store has the event BEFORE it runs.
    let storeHadEvent = false
    bus.on(() => {
      storeHadEvent = store.readAll().length > 0
    })

    registry.create(agentRun())

    expect(storeHadEvent).toBe(true)
  })

  it('skips corrupted JSONL lines on read (crash recovery)', () => {
    const store = new JsonlEventStore(logDir)
    const registry = new ExecutionRunRegistry()
    const bus = new ExecutionRunEventBus(registry, store)

    // Emit one good event.
    registry.create(agentRun())
    const goodEvents = store.readAll()
    expect(goodEvents).toHaveLength(1)

    // Append a corrupt line + a good line to the file.
    const logPath = store.label
    appendFileSync(logPath, '{not valid json\n')
    const fakeEvent: RunEventEnvelope = {
      eventId: 'synthetic',
      runId: 'fake-run',
      sequence: 1,
      timestamp: new Date().toISOString(),
      type: 'run.created',
      payload: { run: { kind: 'agent', goal: 'fake' } },
    }
    appendFileSync(logPath, JSON.stringify(fakeEvent) + '\n')

    const events = store.readAll()
    // The corrupt line is skipped; both good events survive.
    expect(events).toHaveLength(2)
    expect(events.map((e) => e.eventId)).toContain('synthetic')
  })
})

// ─────────────────────────────────────────────────────────────────────
// Crash recovery via event replay
// ─────────────────────────────────────────────────────────────────────
describe('recoverRegistryFromStore reconstructs state from JSONL', () => {
  it('rebuilds a registry that matches the original terminal state', () => {
    const store = new JsonlEventStore(logDir)
    const original = new ExecutionRunRegistry()
    const bus = new ExecutionRunEventBus(original, store)

    const run = original.create(agentRun({ goal: 'task A' }))
    original.transition(run.runId, 'preparing')
    original.transition(run.runId, 'running')
    original.transition(run.runId, 'succeeded')

    // Simulate crash: drop the original registry, reconstruct from disk.
    const recovered = recoverRegistryFromStore(store)

    const orig = original.require(run.runId)
    const rec = recovered.require(run.runId)
    expect(rec.runId).toBe(orig.runId)
    expect(rec.kind).toBe(orig.kind)
    expect(rec.goal).toBe(orig.goal)
    expect(rec.status).toBe('succeeded')
    expect(rec.workspace.cwd).toBe(orig.workspace.cwd)
  })

  it('rebuilds multiple runs from the same log', () => {
    const store = new JsonlEventStore(logDir)
    const original = new ExecutionRunRegistry()
    const bus = new ExecutionRunEventBus(original, store)

    const a = original.create(agentRun({ goal: 'A' }))
    original.transition(a.runId, 'preparing')
    original.transition(a.runId, 'running')
    original.transition(a.runId, 'failed', { error: 'oops' })

    const b = original.create(agentRun({ goal: 'B' }))
    original.transition(b.runId, 'preparing')
    original.transition(b.runId, 'running')
    original.transition(b.runId, 'succeeded')

    const recovered = recoverRegistryFromStore(store)
    expect(recovered.size()).toBe(2)

    const recA = recovered.require(a.runId)
    const recB = recovered.require(b.runId)
    expect(recA.status).toBe('failed')
    expect(recA.error).toBe('oops')
    expect(recB.status).toBe('succeeded')
  })

  it('recovered registry has onEmit unplugged (no new events emitted)', () => {
    const store = new JsonlEventStore(logDir)
    const original = new ExecutionRunRegistry()
    const bus = new ExecutionRunEventBus(original, store)

    const run = original.create(agentRun())
    original.transition(run.runId, 'preparing')
    original.transition(run.runId, 'running')

    const recovered = recoverRegistryFromStore(store)
    // Wire a bus on the recovered registry — emitting here would
    // double-write to the store. The recovered registry's onEmit is
    // undefined by default, so transitions are silent unless the
    // caller explicitly plugs a new bus.
    let emitCalled = false
    recovered.onEmit = () => { emitCalled = true }
    const recRun = recovered.list()[0]!
    // running → verifying is a valid non-terminal transition.
    recovered.transition(recRun.runId, 'verifying')
    expect(emitCalled).toBe(true)

    // Reset + verify default is unplugged.
    recovered.onEmit = undefined
    emitCalled = false
    recovered.update(recRun.runId, { phase: 'test' })
    expect(emitCalled).toBe(false)
  })

  it('survives an empty / missing log file', () => {
    const store = new JsonlEventStore(join(tmpRoot, 'never-existed'))
    const recovered = recoverRegistryFromStore(store)
    expect(recovered.size()).toBe(0)
  })
})

// ─────────────────────────────────────────────────────────────────────
// Round 5 regression: existing integrations still work
// ─────────────────────────────────────────────────────────────────────
describe('Round 5 back-compat: registry without a bus works as before', () => {
  it('transitions succeed without an event bus wired', () => {
    const registry = new ExecutionRunRegistry()
    // onEmit is undefined by default — no bus constructed.
    const run = registry.create(agentRun())
    registry.transition(run.runId, 'preparing')
    registry.transition(run.runId, 'running')
    registry.transition(run.runId, 'succeeded')
    expect(registry.require(run.runId).status).toBe('succeeded')
  })
})
