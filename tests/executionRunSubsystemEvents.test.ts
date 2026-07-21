/**
 * GAP-B: subsystem event types (tool, artifact, verification, run.steered).
 *
 * Verifies:
 *   - Each subsystem emitter assigns monotonic sequence
 *   - Events persist BEFORE fan-out
 *   - Orphan events (unknown runId) are silently skipped
 *   - run.steered / tool / artifact / verification all round-trip
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { tmpdir } from 'os'
import { mkdtempSync, rmSync } from 'fs'
import { join } from 'path'
import { ExecutionRunRegistry, type CreateRunInput } from '../src/core/executionRun.js'
import {
  ExecutionRunEventBus,
  JsonlEventStore,
  type RunEventEnvelope,
} from '../src/core/executionRunEvents.js'

let tmp = ''

beforeEach(() => {
  tmp = mkdtempSync(`${tmpdir()}/gapB-`)
})
afterEach(() => {
  rmSync(tmp, { recursive: true, force: true })
})

function agentRun(overrides: Partial<CreateRunInput> = {}): CreateRunInput {
  return {
    kind: 'agent',
    goal: 'test',
    workspace: { cwd: '/repo' },
    ...overrides,
  }
}

function setup() {
  const registry = new ExecutionRunRegistry()
  const store = new JsonlEventStore(join(tmp, 'logs'))
  const bus = new ExecutionRunEventBus(registry, store)
  return { registry, store, bus }
}

describe('GAP-B: subsystem events', () => {
  it('emitToolRequested persists + fans out', () => {
    const { registry, bus } = setup()
    const run = registry.create(agentRun())
    const events: RunEventEnvelope[] = []
    bus.on((e) => events.push(e))

    bus.emitToolRequested(run.runId, {
      toolCallId: 'tc1',
      toolName: 'Bash',
      input: { command: 'ls' },
    })
    const last = events[events.length - 1]!
    expect(last.type).toBe('tool.requested')
    expect(last.payload).toMatchObject({ toolCallId: 'tc1', toolName: 'Bash' })
    expect(last.sequence).toBeGreaterThan(0)
  })

  it('emitToolStarted/Completed round-trip', () => {
    const { registry, bus } = setup()
    const run = registry.create(agentRun())
    const types: string[] = []
    bus.on((e) => types.push(e.type))

    bus.emitToolStarted(run.runId, { toolCallId: 'tc1', toolName: 'Bash' })
    bus.emitToolCompleted(run.runId, {
      toolCallId: 'tc1',
      toolName: 'Bash',
      status: 'success',
      summary: 'ok',
      exitCode: 0,
    })
    expect(types).toContain('tool.started')
    expect(types).toContain('tool.completed')
  })

  it('emitToolFailed carries error message', () => {
    const { registry, bus } = setup()
    const run = registry.create(agentRun())
    const events: RunEventEnvelope[] = []
    bus.on((e) => events.push(e))

    bus.emitToolFailed(run.runId, {
      toolCallId: 'tc1',
      toolName: 'Bash',
      error: 'command not found',
    })
    expect(events[events.length - 1]!.payload).toMatchObject({ error: 'command not found' })
  })

  it('emitArtifactCreated persists artifact metadata', () => {
    const { registry, bus, store } = setup()
    const run = registry.create(agentRun())

    bus.emitArtifactCreated(run.runId, {
      artifactId: 'art1',
      kind: 'log',
      path: '/tmp/log.txt',
      sizeBytes: 1024,
    })
    const events = store.readAll()
    expect(events.some((e) => e.type === 'artifact.created')).toBe(true)
  })

  it('emitVerificationStarted/Completed/Failed cover the gate lifecycle', () => {
    const { registry, bus } = setup()
    const run = registry.create(agentRun())
    const types: string[] = []
    bus.on((e) => types.push(e.type))

    bus.emitVerificationStarted(run.runId, { commands: ['npm test'] })
    bus.emitVerificationCompleted(run.runId, {
      passed: true,
      commands: [{ command: 'npm test', passed: true, exitCode: 0 }],
    })
    bus.emitVerificationFailed(run.runId, { error: 'gate crashed' })
    expect(types).toContain('verification.started')
    expect(types).toContain('verification.completed')
    expect(types).toContain('verification.failed')
  })

  it('emitSteered records the steering instruction', () => {
    const { registry, bus } = setup()
    const run = registry.create(agentRun())
    const events: RunEventEnvelope[] = []
    bus.on((e) => events.push(e))

    bus.emitSteered(run.runId, 'focus on tests next')
    const steered = events.find((e) => e.type === 'run.steered')!
    expect(steered).toBeDefined()
    expect(steered.payload).toMatchObject({ instruction: 'focus on tests next' })
  })

  it('sequence is monotonic across mixed registry + subsystem events', () => {
    const { registry, bus } = setup()
    const run = registry.create(agentRun())
    const events: RunEventEnvelope[] = []
    bus.on((e) => events.push(e))

    registry.transition(run.runId, 'preparing')
    bus.emitToolRequested(run.runId, { toolCallId: 't1', toolName: 'X', input: {} })
    bus.emitToolCompleted(run.runId, { toolCallId: 't1', toolName: 'X', status: 'success', summary: 'ok' })
    registry.transition(run.runId, 'running')

    const seqs = events.map((e) => e.sequence)
    for (let i = 1; i < seqs.length; i++) {
      expect(seqs[i]).toBeGreaterThan(seqs[i - 1]!)
    }
  })

  it('subsystem events for unknown runId are silently dropped', () => {
    const { registry, bus, store } = setup()
    const events: RunEventEnvelope[] = []
    bus.on((e) => events.push(e))

    bus.emitToolRequested('does-not-exist', {
      toolCallId: 'x',
      toolName: 'X',
      input: {},
    })
    expect(events).toEqual([])
    expect(store.readAll()).toEqual([])
    void registry
  })

  it('persistence happens BEFORE fan-out', () => {
    const { registry, bus, store } = setup()
    const run = registry.create(agentRun())
    let storeHadEvent = false
    bus.on(() => {
      storeHadEvent = store.readAll().some((e) => e.type === 'tool.started')
    })

    bus.emitToolStarted(run.runId, { toolCallId: 'x', toolName: 'X' })
    expect(storeHadEvent).toBe(true)
  })

  it('subsystem events survive recovery via readAll()', () => {
    const { registry, store } = setup()
    const bus = new ExecutionRunEventBus(registry, store)
    const run = registry.create(agentRun())

    bus.emitArtifactCreated(run.runId, { artifactId: 'a1', kind: 'patch' })
    bus.emitToolCompleted(run.runId, {
      toolCallId: 't1',
      toolName: 'Edit',
      status: 'success',
      summary: 'edited',
    })

    const events = store.readAll()
    expect(events.some((e) => e.type === 'artifact.created')).toBe(true)
    expect(events.some((e) => e.type === 'tool.completed')).toBe(true)
  })
})
