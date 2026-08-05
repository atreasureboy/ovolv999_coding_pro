/**
 * v0.5.3 Post-Release Integrity Hotfix §3 — baseCommit single
 * protocol.
 *
 * The canonical internal field is `baseCommit`. The legacy `commit`
 * field is a read-only compat alias. Round-trip:
 *   - RevisionBinding (baseCommit) → MemoryCandidate →
 *     decidePromotion → LongTermMemory.record → query
 *   - two records with same content but different baseCommit
 *     produce two records
 *   - same content + same baseCommit produces one record
 *   - legacy record carrying only `commit` is normalised on load
 *     and merges with new-style baseCommit records.
 */
import { describe, it, expect } from 'vitest'
import {
  InMemoryMemoryBackend,
  LongTermMemory,
  type MemoryRecord,
  type MemoryRecordInput,
} from '../../src/core/longTermMemory.js'

describe('baseCommit single protocol', () => {
  it('records with same content but different baseCommit stay separate', () => {
    const backend = new InMemoryMemoryBackend()
    const ltm = new LongTermMemory({ backend })
    const baseInput = {
      kind: 'semantic' as const,
      content: 'shared fact about project',
      repo: '/repo',
      branch: 'main',
      dirty: false,
      sourceRunId: 'run-A',
      origin: 'memory_promotion:run-A',
      confidence: 0.9,
      verified: true,
      tags: [],
      expiresAt: undefined,
    }
    ltm.record({ ...baseInput, baseCommit: 'commit-A', sourceRunId: 'run-A' })
    ltm.record({ ...baseInput, baseCommit: 'commit-B', sourceRunId: 'run-B' })
    const all = ltm.query({ kind: 'semantic', repo: '/repo' })
    expect(all.length).toBe(2)
    const commits = all.map((r) => r.baseCommit).sort()
    expect(commits).toEqual(['commit-A', 'commit-B'])
  })

  it('same content + same baseCommit merges into one record', () => {
    const backend = new InMemoryMemoryBackend()
    const ltm = new LongTermMemory({ backend })
    const baseInput = {
      kind: 'semantic' as const,
      content: 'shared fact',
      repo: '/repo',
      branch: 'main',
      dirty: false,
      baseCommit: 'commit-A',
      sourceRunId: 'run-A',
      origin: 'memory_promotion:run-A',
      confidence: 0.9,
      verified: true,
      tags: [],
      expiresAt: undefined,
    }
    ltm.record(baseInput)
    ltm.record({ ...baseInput, sourceRunId: 'run-A2', confidence: 0.95 })
    const all = ltm.query({ kind: 'semantic', repo: '/repo' })
    expect(all.length).toBe(1)
    expect(all[0].baseCommit).toBe('commit-A')
  })

  it('legacy record carrying only `commit` is normalised on read', () => {
    // Simulate a legacy row from pre-v0.5.3 JSONL.
    const legacyRow: MemoryRecord = {
      id: 'legacy-1',
      createdAt: new Date().toISOString(),
      kind: 'semantic',
      content: 'legacy fact',
      repo: '/repo',
      branch: 'main',
      commit: 'commit-LEGACY',
      dirty: false,
      sourceRunId: 'run-LEGACY',
      origin: 'memory_promotion:run-LEGACY',
      confidence: 0.9,
      verified: true,
      tags: [],
      expiresAt: undefined,
    }
    const backend = new InMemoryMemoryBackend()
    backend.upsert(legacyRow)
    const ltm = new LongTermMemory({ backend })
    const all = ltm.query({ kind: 'semantic', repo: '/repo' })
    expect(all.length).toBe(1)
    // After the hotfix §3 read normalisation, the loaded record
    // carries the canonical `baseCommit` derived from legacy
    // `commit`. contentKey() also resolves to the same value.
    const loaded = all[0]
    expect(loaded.baseCommit ?? loaded.commit).toBe('commit-LEGACY')
  })

  it('canonicalCommit R3 binding accepts both baseCommit and commit', () => {
    const backend = new InMemoryMemoryBackend()
    const ltm = new LongTermMemory({ backend })
    const codeInput: MemoryRecordInput = {
      kind: 'semantic',
      content: 'the function `applyPolicy` lives in src/runtime.ts',
      repo: '/repo',
      branch: 'main',
      // legacy `commit` only — must still satisfy R3 binding gate
      commit: 'commit-X',
      dirty: false,
      sourceRunId: 'run-X',
      origin: 'memory_promotion:run-X',
      confidence: 0.9,
      verified: true,
      tags: [],
      expiresAt: undefined,
    }
    expect(() => ltm.record(codeInput)).not.toThrow()
    const all = ltm.query({ kind: 'semantic', repo: '/repo' })
    expect(all.length).toBe(1)
    expect(all[0].baseCommit ?? all[0].commit).toBe('commit-X')
  })

  it('new record input carrying only `commit` (no baseCommit) is rewritten to baseCommit on save', () => {
    const backend = new InMemoryMemoryBackend()
    const ltm = new LongTermMemory({ backend })
    ltm.record({
      kind: 'semantic',
      content: 'legacy write path',
      repo: '/repo',
      branch: 'main',
      commit: 'commit-LEGACY-W',
      dirty: false,
      sourceRunId: 'run-W',
      origin: 'memory_promotion:run-W',
      confidence: 0.9,
      verified: true,
      tags: [],
      expiresAt: undefined,
    })
    const all = ltm.query({ kind: 'semantic', repo: '/repo' })
    expect(all.length).toBe(1)
    // The record() guard normalises legacy `commit` → baseCommit.
    expect(all[0].baseCommit).toBe('commit-LEGACY-W')
  })
})