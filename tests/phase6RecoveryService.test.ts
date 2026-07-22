/**
 * Phase 6 (five_goal §十四 P2-7): Boot recovery distinguishes
 * reattachable workers from dead ones.
 *
 *   external_worker + live session  → reattach (kept alive)
 *   external_worker + dead session  → 'lost'
 *   agent/turn/workflow             → 'failed' (cannot survive restart)
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { join } from 'path'
import { writeFileSync, mkdirSync, mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { ExecutionEngine } from '../src/core/engine.js'
import type { Renderer } from '../src/ui/renderer.js'

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
} as unknown as Renderer

let tmp = ''

function makeConfig(logDir?: string) {
  return {
    model: 'gpt-4o-mini',
    apiKey: 'sk-test',
    maxIterations: 1,
    cwd: tmp,
    permissionMode: 'auto' as const,
    executionRunLogDir: logDir,
  } as never
}

function writeJsonlEvents(logDir: string, events: object[]): void {
  mkdirSync(logDir, { recursive: true })
  writeFileSync(
    join(logDir, 'runs.jsonl'),
    events.map((e) => JSON.stringify(e)).join('\n') + '\n',
  )
}

function makeEvent(runId: string, seq: number, kind: string, status: string, phase: string, worker?: string): object {
  return {
    eventId: `e${seq}`,
    runId,
    sequence: seq,
    timestamp: `2026-01-01T00:00:0${seq}.000Z`,
    type: seq === 1 ? 'run.created' : status === 'queued' ? 'run.created' : 'run.progress',
    payload: {
      from: seq > 1 ? 'queued' : undefined,
      phase,
      run: {
        runId,
        kind,
        goal: 'task',
        status,
        phase,
        worker,
        workspace: { cwd: '/repo' },
        acceptance: [], budget: {}, resources: [], artifacts: [],
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: `2026-01-01T00:00:0${seq}.000Z`,
      },
    },
  }
}

describe('P2-7: Boot recovery distinguishes worker and non-worker runs', () => {
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'p2-recovery-'))
  })
  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true })
  })

  it('non-worker runs (agent/turn) are marked failed at boot', () => {
    const logDir = join(tmp, 'logs')
    const runId = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'
    writeJsonlEvents(logDir, [
      makeEvent(runId, 1, 'agent', 'queued', 'created'),
      makeEvent(runId, 2, 'agent', 'preparing', 'preparing'),
      makeEvent(runId, 3, 'agent', 'running', 'running'),
    ])

    const engine = new ExecutionEngine(makeConfig(logDir), noopRenderer)
    const run = engine.getRunRegistry()!.get(runId)!
    expect(run.status).toBe('failed')
    expect(run.error).toMatch(/process restarted/)
  })

  it('external_worker runs are kept non-terminal pending reattach', () => {
    const logDir = join(tmp, 'logs')
    const runId = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'
    writeJsonlEvents(logDir, [
      makeEvent(runId, 1, 'external_worker', 'queued', 'created', 'worker-1'),
      makeEvent(runId, 2, 'external_worker', 'preparing', 'start-spawning', 'worker-1'),
      makeEvent(runId, 3, 'external_worker', 'running', 'task-sent', 'worker-1'),
      makeEvent(runId, 4, 'external_worker', 'waiting', 'dispatched', 'worker-1'),
    ])

    const engine = new ExecutionEngine(makeConfig(logDir), noopRenderer)
    const run = engine.getRunRegistry()!.get(runId)!
    expect(run.status).toBe('waiting')
    expect(run.phase).toBe('recovery-pending-reattach')
  })

  it('recoverWorkers() marks dead sessions as lost', async () => {
    const logDir = join(tmp, 'logs')
    const runId = 'cccccccc-cccc-cccc-cccc-cccccccccccc'
    writeJsonlEvents(logDir, [
      makeEvent(runId, 1, 'external_worker', 'queued', 'created', 'dead-session'),
      makeEvent(runId, 2, 'external_worker', 'preparing', 'start-spawning', 'dead-session'),
      makeEvent(runId, 3, 'external_worker', 'running', 'task-sent', 'dead-session'),
      makeEvent(runId, 4, 'external_worker', 'waiting', 'dispatched', 'dead-session'),
    ])

    const engine = new ExecutionEngine(makeConfig(logDir), noopRenderer)
    expect(engine.getRunRegistry()!.get(runId)!.status).toBe('waiting')

    const result = await engine.recoverWorkers()
    expect(result.lost).toBe(1)
    expect(result.reattached).toBe(0)

    const run = engine.getRunRegistry()!.get(runId)!
    expect(run.status).toBe('lost')
    expect(run.phase).toBe('recovery-reattach-failed')
  })

  it('recoverWorkers() is a no-op when no pending runs', async () => {
    const logDir = join(tmp, 'logs')
    const runId = 'dddddddd-dddd-dddd-dddd-dddddddddddd'
    writeJsonlEvents(logDir, [
      makeEvent(runId, 1, 'external_worker', 'succeeded', 'finalized', 'ok-session'),
    ])

    const engine = new ExecutionEngine(makeConfig(logDir), noopRenderer)
    const result = await engine.recoverWorkers()
    expect(result.reattached).toBe(0)
    expect(result.lost).toBe(0)
  })

  it('terminal runs are untouched by recovery', () => {
    const logDir = join(tmp, 'logs')
    const runId = 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee'
    writeJsonlEvents(logDir, [
      makeEvent(runId, 1, 'agent', 'succeeded', 'completed'),
    ])

    const engine = new ExecutionEngine(makeConfig(logDir), noopRenderer)
    const run = engine.getRunRegistry()!.get(runId)!
    expect(run.status).toBe('succeeded')
  })
})
