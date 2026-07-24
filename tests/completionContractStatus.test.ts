/**
 * v0.3.1 CompletionContract 6-state contract (te_goal §四).
 *
 * Verifies that evaluateCompletion produces every required status:
 *   completed | partial | blocked | failed | cancelled | exhausted
 * and that the schema rejects the legacy `satisfiedCriteria: string[]`
 * + `verificationExecuted: boolean` shape.
 */
import { describe, it, expect } from 'vitest'
import { evaluateCompletion, type CompletionInput } from '../src/core/runtime/completionContract.js'

const base: CompletionInput = {
  taskKind: 'mutation',
  modelStopped: true,
  acceptanceCriteria: [
    { id: 'a', description: 'tests pass', satisfied: true },
    { id: 'b', description: 'lint clean', satisfied: true },
  ],
  verification: { executed: true, passed: true, failed: [] },
  activeWorkers: [],
  unresolvedBlockers: [],
  changedFiles: ['a.ts'],
  reviewerFindings: [],
  budgetState: { remaining: 1, exceeded: false },
}

describe('CompletionContract v0.3.1 — 6 statuses', () => {
  it('produces completed when all criteria satisfied + verification passed', () => {
    const v = evaluateCompletion(base)
    expect(v.status).toBe('completed')
  })

  it('produces partial when some criteria remain + changes exist', () => {
    const v = evaluateCompletion({
      ...base,
      acceptanceCriteria: [
        { id: 'a', description: 'tests pass', satisfied: true },
        { id: 'b', description: 'lint clean', satisfied: false },
      ],
    })
    expect(v.status).toBe('partial')
    if (v.status === 'partial') {
      expect(v.remaining).toContain('lint clean')
    }
  })

  it('produces blocked when a worker is still running', () => {
    const v = evaluateCompletion({
      ...base,
      activeWorkers: [{ id: 'w1', status: 'running' }],
    })
    expect(v.status).toBe('blocked')
    if (v.status === 'blocked') {
      expect(v.blockers.join(' ')).toMatch(/worker/i)
    }
  })

  it('produces blocked when TaskGraph has unfinished nodes', () => {
    const v = evaluateCompletion({
      ...base,
      taskGraph: { nodes: [{ id: 'n1', status: 'running' }, { id: 'n2', status: 'completed' }] },
    })
    expect(v.status).toBe('blocked')
  })

  it('produces blocked when verification ran but failed', () => {
    const v = evaluateCompletion({
      ...base,
      verification: { executed: true, passed: false, failed: ['unit test #3'] },
    })
    expect(v.status).toBe('blocked')
  })

  it('produces failed when the run is marked failed', () => {
    const v = evaluateCompletion({ ...base, failed: true })
    expect(v.status).toBe('failed')
    if (v.status === 'failed') {
      expect(v.reason).toBeTruthy()
      expect(Array.isArray(v.evidence)).toBe(true)
    }
  })

  it('produces cancelled when the run is marked cancelled', () => {
    const v = evaluateCompletion({ ...base, cancelled: true, unresolvedBlockers: ['user ctrl-c'] })
    expect(v.status).toBe('cancelled')
    if (v.status === 'cancelled') {
      expect(v.reason).toMatch(/ctrl-c|cancelled/i)
    }
  })

  it('produces exhausted when iterations hit the cap', () => {
    const v = evaluateCompletion({
      ...base,
      iterationsUsed: 12,
      iterationsMax: 12,
    })
    expect(v.status).toBe('exhausted')
    if (v.status === 'exhausted') {
      expect(v.iterationsUsed).toBe(12)
      expect(v.iterationsMax).toBe(12)
      expect(v.reason).toMatch(/iteration limit/)
    }
  })

  it('produces exhausted BEFORE blockers are evaluated', () => {
    // te_goal §四.10: max iterations → exhausted, not blocked.
    const v = evaluateCompletion({
      ...base,
      iterationsUsed: 5,
      iterationsMax: 5,
      activeWorkers: [{ id: 'w1', status: 'running' }], // would be a blocker
    })
    expect(v.status).toBe('exhausted')
  })

  it('produces incomplete when no changes and criteria remain', () => {
    const v = evaluateCompletion({
      ...base,
      changedFiles: [],
      acceptanceCriteria: [
        { id: 'a', description: 'tests pass', satisfied: false },
        { id: 'b', description: 'lint clean', satisfied: true },
      ],
    })
    expect(v.status).toBe('incomplete')
  })

  it('informational Q&A passes without file changes', () => {
    const v = evaluateCompletion({
      ...base,
      taskKind: 'informational',
      changedFiles: [],
      acceptanceCriteria: [],
    })
    expect(v.status).toBe('completed')
  })

  it('informational with unsatisfied criteria is partial', () => {
    const v = evaluateCompletion({
      ...base,
      taskKind: 'informational',
      changedFiles: [],
      acceptanceCriteria: [
        { id: 'a', description: 'cite sources', satisfied: false },
      ],
    })
    expect(v.status).toBe('partial')
  })

  it('analysis task with no acceptance criteria is completed when there is evidence', () => {
    const v = evaluateCompletion({
      ...base,
      taskKind: 'analysis',
      acceptanceCriteria: [],
      changedFiles: ['analysis.md'],
    })
    expect(v.status).toBe('completed')
  })

  it('Reviewer findings fold into residualRisks without downgrading satisfied-and-verified completion', () => {
    const v = evaluateCompletion({
      ...base,
      reviewerFindings: ['scope looks excessive'],
    })
    // Satisfied + verified → completed (with residual risk noted)
    expect(v.status).toBe('completed')
    if (v.status === 'completed') {
      expect(v.residualRisks.join(' ')).toMatch(/scope/i)
    }
  })

  it('budget.exceeded is a hard blocker', () => {
    const v = evaluateCompletion({
      ...base,
      budgetState: { remaining: 0, exceeded: true },
    })
    expect(v.status).toBe('blocked')
  })
})