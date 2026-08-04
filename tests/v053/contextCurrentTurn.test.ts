/**
 * v0.5.3 (P1.6): Context current-turn snapshot.
 *
 * The snapshot carries runId; the Router MUST refuse a snapshot
 * whose runId differs from the active runId.
 */
import { describe, it, expect } from 'vitest'
import { ContextManager } from '../../src/core/context/contextManager.js'
import { silentRenderer } from '../helpers/renderer.js'

describe('Context current-turn snapshot (P1.6)', () => {
  it('snapshot is uninitialized before evaluateBudget', () => {
    const cm = new ContextManager({
      client: {} as never,
      model: 'fake',
      renderer: silentRenderer,
      eventLog: undefined,
    })
    const snap = cm.getBudgetSnapshot()
    expect(snap.initialized).toBe(false)
    expect(snap.runId).toBeNull()
  })

  it('snapshot carries the runId set by setActiveRunId', async () => {
    const cm = new ContextManager({
      client: {} as never,
      model: 'fake',
      renderer: silentRenderer,
      eventLog: undefined,
    })
    cm.setActiveRunId('run-A')
    await cm.evaluateBudget({ messages: [{ role: 'user', content: 'x' }], toolDefs: [], abortSignal: undefined })
    const snap = cm.getBudgetSnapshot()
    expect(snap.initialized).toBe(true)
    expect(snap.runId).toBe('run-A')
  })

  it('two sequential turns get independent snapshots', async () => {
    const cm = new ContextManager({
      client: {} as never,
      model: 'fake',
      renderer: silentRenderer,
      eventLog: undefined,
    })
    cm.setActiveRunId('run-A')
    await cm.evaluateBudget({ messages: [{ role: 'user', content: 'x' }], toolDefs: [], abortSignal: undefined })
    expect(cm.getBudgetSnapshot().runId).toBe('run-A')
    cm.setActiveRunId('run-B')
    await cm.evaluateBudget({ messages: [{ role: 'user', content: 'x y z' }], toolDefs: [], abortSignal: undefined })
    expect(cm.getBudgetSnapshot().runId).toBe('run-B')
  })
})