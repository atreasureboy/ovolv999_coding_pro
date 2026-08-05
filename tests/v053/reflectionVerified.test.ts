/**
 * v0.5.3 (P0.4): Reflection verified truth.
 *
 * Success entries require:
 *   CompletionStatus=completed + verification.passed + no
 *   verification.failed + no completion blockers.
 * Failed / partial / blocked / cancelled / exhausted runs can only
 * write `kind: 'failure'` entries — never `kind: 'semantic'`.
 */
import { describe, it, expect } from 'vitest'
import { LongTermMemory } from '../../src/core/longTermMemory.js'

function makeLtm(): LongTermMemory {
  return new LongTermMemory({
    backend: { upsert() {}, load: () => [], delete() {} },
    allowUnverified: false,
    allowCodeWithoutCommit: false,
  })
}

describe('Reflection verified truth (P0.4)', () => {
  it('success: kind=semantic, verified=true, gate passes', () => {
    const ltm = makeLtm()
    const rec = ltm.record({
      kind: 'semantic',
      content: 'prefer tabs',
      repo: 'reflection',
      origin: 'reflection:success',
      sourceRunId: 'run-success-1',
      confidence: 0.8,
      verified: true,
      tags: ['outcome:success'],
    })
    expect(rec.verified).toBe(true)
    expect(rec.kind).toBe('semantic')
  })

  it('failed run: kind must be failure, verified=false', () => {
    const ltm = makeLtm()
    const rec = ltm.record({
      kind: 'failure',
      content: 'npm test failed: assertion count mismatch',
      repo: 'reflection',
      origin: 'reflection:failed',
      sourceRunId: 'run-failed-1',
      confidence: 0.9,
      verified: false,
      tags: ['outcome:failed'],
    })
    expect(rec.kind).toBe('failure')
    expect(rec.verified).toBe(false)
  })

  it('failure entries do NOT require a commit (R3 skip)', () => {
    const ltm = makeLtm()
    expect(() => ltm.record({
      kind: 'failure',
      content: 'export function foo() { return undefined }',
      repo: 'reflection',
      origin: 'reflection:failed',
      sourceRunId: 'run-failed-2',
      confidence: 0.5,
      verified: false,
      tags: [],
    })).not.toThrow()
  })

  it('semantic with verified=false and allowUnverified=false is rejected', () => {
    const ltm = makeLtm()
    expect(() => ltm.record({
      kind: 'semantic',
      content: 'foo',
      repo: 'reflection',
      origin: 'reflection:success',
      sourceRunId: 'run',
      confidence: 0.5,
      verified: false,
      tags: [],
    })).toThrow(/refusing to write unverified memory/)
  })

  it('failed run CANNOT save a verified semantic entry (gate rejects)', () => {
    // This is the v0.5.2 anti-pattern the gate is meant to kill:
    // a failed run trying to save "verified: true". The semantic
    // kind with code in content + no commit is rejected by R3.
    const ltm = makeLtm()
    expect(() => ltm.record({
      kind: 'semantic',
      content: 'export function helper() {}',
      repo: 'reflection',
      origin: 'reflection:failed',
      sourceRunId: 'run-failed-3',
      confidence: 0.7,
      verified: true,
      tags: [],
    })).toThrow(/must bind to a commit/)
  })
})