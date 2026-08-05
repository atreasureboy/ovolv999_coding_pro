/**
 * v0.5.3 Closure Integrity (P7): conflict provenance.
 *
 * The same content seen under two different RevisionBindings
 * (branch / commit / dirty / diffHash / workspaceHash) MUST NOT
 * merge — they are observations from different revision states
 * and need independent entries to preserve provenance.
 */
import { describe, it, expect } from 'vitest'
import { InMemoryMemoryBackend } from '../../src/core/longTermMemory.js'
import { LongTermMemory } from '../../src/core/longTermMemory.js'

function record(over: Record<string, unknown>) {
  return {
    kind: 'semantic' as const,
    content: 'snake_case variable naming is mandatory',
    repo: '/proj',
    branch: undefined,
    baseCommit: undefined,
    dirty: undefined,
    diffHash: undefined,
    workspaceHash: undefined,
    sourceRunId: 'r1',
    origin: 'test',
    confidence: 0.9,
    verified: true,
    tags: [],
    expiresAt: undefined,
    ...over,
  }
}

describe('Memory conflict provenance (Closure Integrity P7)', () => {
  it('same content + same RevisionBinding → merges', () => {
    const ltm = new LongTermMemory({ backend: new InMemoryMemoryBackend() })
    ltm.record(record({ baseCommit: 'abc123' }))
    ltm.record(record({ baseCommit: 'abc123' }))
    const all = ltm.query({ kind: 'semantic' })
    expect(all.length).toBe(1)
  })

  it('same content + different baseCommit → two records (no merge)', () => {
    const ltm = new LongTermMemory({ backend: new InMemoryMemoryBackend() })
    ltm.record(record({ baseCommit: 'abc123' }))
    ltm.record(record({ baseCommit: 'def456' }))
    const all = ltm.query({ kind: 'semantic' })
    expect(all.length).toBe(2)
  })

  it('same content + clean vs dirty → two records (dirty diffHash differs)', () => {
    const ltm = new LongTermMemory({ backend: new InMemoryMemoryBackend() })
    ltm.record(record({ baseCommit: 'abc123', dirty: false, diffHash: 'clean' }))
    ltm.record(record({ baseCommit: 'abc123', dirty: true, diffHash: 'abcdef0123456789' }))
    const all = ltm.query({ kind: 'semantic' })
    expect(all.length).toBe(2)
  })

  it('same content + git vs non-git workspace → two records', () => {
    const ltm = new LongTermMemory({ backend: new InMemoryMemoryBackend() })
    ltm.record(record({ branch: 'main', baseCommit: 'abc123' }))
    ltm.record(record({ repo: '/proj', workspaceHash: 'wh1234567890abc' }))
    const all = ltm.query({ kind: 'semantic' })
    expect(all.length).toBe(2)
  })

  it('same content + different branches → two records', () => {
    const ltm = new LongTermMemory({ backend: new InMemoryMemoryBackend() })
    ltm.record(record({ branch: 'main', baseCommit: 'abc123' }))
    ltm.record(record({ branch: 'feature/foo', baseCommit: 'abc123' }))
    const all = ltm.query({ kind: 'semantic' })
    expect(all.length).toBe(2)
  })

  it('provenance fields survive merge when content is identical under identical binding', () => {
    const ltm = new LongTermMemory({ backend: new InMemoryMemoryBackend() })
    ltm.record(record({ baseCommit: 'abc123', confidence: 0.8 }))
    ltm.record(record({ baseCommit: 'abc123', confidence: 0.95 }))
    const all = ltm.query({ kind: 'semantic' })
    expect(all.length).toBe(1)
    // mergeConflict picks higher confidence.
    expect(all[0].confidence).toBe(0.95)
    expect(all[0].baseCommit ?? all[0].commit).toBe('abc123')
  })
})
