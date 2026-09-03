/**
 * The EvidenceStore's revision was a dead field: record() stamped 0 forever,
 * nothing ever incremented it, and `valid` never flipped — so evidence
 * recorded BEFORE a later code edit still satisfied criteria at
 * complete_node (the classic "test passed, then I kept editing, then claimed
 * done" hole). The store header's promise — "when code changes, prior
 * evidence becomes stale automatically" — is now real: the coordinator bumps
 * the revision whenever a tool batch mutates the workspace, and validity
 * means "stamped at the current revision".
 */
import { describe, it, expect } from 'vitest'
import { EvidenceStore } from '../src/core/runtime/evidence.js'

function record(store: EvidenceStore, exitCode = 0): void {
  store.record({
    runId: 'r1', nodeId: 'impl', criterionId: 'impl::0',
    kind: 'test_result', summary: 'tests pass', source: 'tool',
    command: 'npm test', exitCode,
  })
}

describe('evidence revision staleness', () => {
  it('evidence recorded at the current revision satisfies its criterion', () => {
    const store = new EvidenceStore()
    record(store)
    expect(store.getRevision()).toBe(0)
    expect(store.computeCriterionStatus('impl', 'impl::0', 'tests pass').status).toBe('satisfied')
  })

  it('bumpRevision() invalidates prior evidence — the criterion reads stale', () => {
    const store = new EvidenceStore()
    record(store)
    expect(store.bumpRevision()).toBe(1)
    const state = store.computeCriterionStatus('impl', 'impl::0', 'tests pass')
    expect(state.status).toBe('stale')
    expect(state.evidenceId).toBeUndefined()
    expect(store.getValidEvidence('impl', 'impl::0')).toEqual([])
  })

  it('re-recording after the bump re-satisfies the criterion', () => {
    const store = new EvidenceStore()
    record(store)
    store.bumpRevision()
    record(store)
    const state = store.computeCriterionStatus('impl', 'impl::0', 'tests pass')
    expect(state.status).toBe('satisfied')
    expect(store.getValidEvidence('impl', 'impl::0')).toHaveLength(1)
  })

  it('a failed record stays failed across bumps — staleness never hides a failure', () => {
    const store = new EvidenceStore()
    record(store, 1)
    store.bumpRevision()
    expect(store.computeCriterionStatus('impl', 'impl::0', 'tests pass').status).toBe('failed')
  })

  it('unrelated criteria are not resurrected by another criterion’s fresh record', () => {
    const store = new EvidenceStore()
    store.record({
      runId: 'r1', nodeId: 'impl', criterionId: 'impl::0',
      kind: 'test_result', summary: 'ok', source: 'tool', exitCode: 0,
    })
    store.record({
      runId: 'r1', nodeId: 'impl', criterionId: 'impl::1',
      kind: 'test_result', summary: 'ok', source: 'tool', exitCode: 0,
    })
    store.bumpRevision()
    record(store) // only impl::0 re-recorded
    expect(store.computeCriterionStatus('impl', 'impl::0', 'a').status).toBe('satisfied')
    expect(store.computeCriterionStatus('impl', 'impl::1', 'b').status).toBe('stale')
  })

  it('multiple bumps keep counting; the store survives an empty bump', () => {
    const store = new EvidenceStore()
    expect(store.bumpRevision()).toBe(1)
    expect(store.bumpRevision()).toBe(2)
    expect(store.computeCriterionStatus('impl', 'impl::0', 'tests pass').status).toBe('pending')
  })
})
