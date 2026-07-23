import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { tmpdir } from 'os'
import { mkdtempSync, rmSync } from 'fs'
import { join } from 'path'
import { JsonlEventStore, type RunEventEnvelope } from '../src/core/executionRunEvents.js'

let dir = ''
beforeEach(() => { dir = mkdtempSync(`${tmpdir}/es5-`) })
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

const ev = (id: string, seq: number, runId = 'r1'): RunEventEnvelope => ({
  eventId: id, runId, parentRunId: undefined, sequence: seq,
  timestamp: 't', type: 'run.started', payload: {},
})

describe('EventStore Phase 5 — atomic batch + idempotent replay', () => {
  it('appendBatch writes all events in one atomic write', () => {
    const s = new JsonlEventStore(dir)
    s.appendBatch([ev('a', 1), ev('b', 2), ev('c', 3)])
    expect(s.readAll()).toHaveLength(3)
    expect(s.readAll().map((e) => e.eventId)).toEqual(['a', 'b', 'c'])
  })

  it('readAll is idempotent on duplicate eventId (last wins)', () => {
    const s = new JsonlEventStore(dir)
    s.append(ev('dup', 1))
    // Simulate a recovery re-apply of the same event with updated payload.
    s.append({ ...ev('dup', 1), payload: { v: 2 } })
    const out = s.readAll()
    expect(out).toHaveLength(1)
    expect((out[0].payload as { v: number }).v).toBe(2)
  })

  it('non-duplicate events are all retained', () => {
    const s = new JsonlEventStore(dir)
    s.appendBatch([ev('x', 1), ev('y', 2), ev('z', 3), ev('w', 4)])
    expect(s.readAll()).toHaveLength(4)
  })
})
