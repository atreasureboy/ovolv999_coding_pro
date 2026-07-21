/**
 * LongTermMemory tests (fi_goal.md §八 Phase 7 / Round 9).
 *
 * Verifies the six spec'd gates:
 *   R1 verification, R2 source marking, R3 commit binding,
 *   R4 expiration, R5 conflict-aware, R6 embedding-optional.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { tmpdir } from 'os'
import { mkdtempSync, rmSync } from 'fs'
import { join } from 'path'
import {
  LongTermMemory,
  JsonlMemoryBackend,
  MemoryVerificationError,
  MemoryCommitBindingError,
  referencesCode,
  type MemoryRecordInput,
} from '../src/core/longTermMemory.js'

let tmp = ''

beforeEach(() => {
  tmp = mkdtempSync(`${tmpdir()}/p7-`)
})
afterEach(() => {
  rmSync(tmp, { recursive: true, force: true })
})

function backend() {
  return new JsonlMemoryBackend(join(tmp, 'mem.jsonl'))
}

function freshMemory(): LongTermMemory {
  return new LongTermMemory({
    backend: backend(),
    now: () => '2026-01-01T00:00:00.000Z',
  })
}

function goodRecord(overrides: Partial<MemoryRecordInput> = {}): MemoryRecordInput {
  return {
    kind: 'semantic',
    content: 'engine uses ESM imports',
    repo: '/repo',
    sourceRunId: 'run_1',
    origin: 'tool:read',
    confidence: 0.9,
    verified: true,
    tags: [],
    commit: 'abc123',
    ...overrides,
  }
}

// ─────────────────────────────────────────────────────────────────────
// R1 — Verification gate
// ─────────────────────────────────────────────────────────────────────
describe('R1: verification gate', () => {
  it('rejects unverified records by default', () => {
    const mem = freshMemory()
    expect(() => mem.record({ ...goodRecord(), verified: false })).toThrow(MemoryVerificationError)
    expect(mem.size()).toBe(0)
  })

  it('allows unverified when allowUnverified is set', () => {
    const mem = new LongTermMemory({
      backend: backend(),
      allowUnverified: true,
      now: () => '2026-01-01T00:00:00.000Z',
    })
    const rec = mem.record({ ...goodRecord(), verified: false })
    expect(rec.verified).toBe(false)
    expect(mem.size()).toBe(1)
  })

  it('verified records pass', () => {
    const mem = freshMemory()
    mem.record(goodRecord())
    expect(mem.size()).toBe(1)
  })
})

// ─────────────────────────────────────────────────────────────────────
// R2 — Source marking (Reflection)
// ─────────────────────────────────────────────────────────────────────
describe('R2: reflection source marking', () => {
  it('rejects reflection memory without reflection:* origin', () => {
    const mem = freshMemory()
    expect(() =>
      mem.record({ ...goodRecord(), kind: 'reflection', origin: 'tool:agent' }),
    ).toThrow(/reflection memory must have origin starting with 'reflection:/)
  })

  it('accepts reflection memory with reflection:* origin', () => {
    const mem = freshMemory()
    const rec = mem.record({
      ...goodRecord(),
      kind: 'reflection',
      origin: 'reflection:dream-2026-01-01',
    })
    expect(rec.kind).toBe('reflection')
    expect(rec.origin).toBe('reflection:dream-2026-01-01')
  })

  it('non-reflection kinds accept any origin', () => {
    const mem = freshMemory()
    const rec = mem.record({ ...goodRecord(), kind: 'episodic', origin: 'tool:bash' })
    expect(rec.origin).toBe('tool:bash')
  })
})

// ─────────────────────────────────────────────────────────────────────
// R3 — Commit binding for code memories
// ─────────────────────────────────────────────────────────────────────
describe('R3: code memories bind to commit', () => {
  it('referencesCode detects code content', () => {
    expect(referencesCode('see engine.ts for the ESM setup')).toBe(true)
    expect(referencesCode('npm test fails on line 42')).toBe(true)
    expect(referencesCode('class Foo extends Bar')).toBe(true)
    expect(referencesCode('the weather is sunny')).toBe(false)
  })

  it('rejects semantic memory about code without commit', () => {
    const mem = freshMemory()
    expect(() =>
      mem.record({ ...goodRecord(), content: 'see engine.ts for ESM', commit: undefined }),
    ).toThrow(MemoryCommitBindingError)
  })

  it('rejects procedural memory about code without commit', () => {
    const mem = freshMemory()
    expect(() =>
      mem.record({
        ...goodRecord(),
        kind: 'procedural',
        content: 'run npm test to verify',
        commit: undefined,
      }),
    ).toThrow(MemoryCommitBindingError)
  })

  it('accepts non-code semantic memory without commit', () => {
    const mem = freshMemory()
    mem.record({
      ...goodRecord(),
      content: 'the user prefers tabs over spaces',
      commit: undefined,
    })
    expect(mem.size()).toBe(1)
  })

  it('accepts code semantic memory WITH commit', () => {
    const mem = freshMemory()
    mem.record({ ...goodRecord(), content: 'engine.ts uses ESM', commit: 'abc123' })
    expect(mem.size()).toBe(1)
  })

  it('episodic memories are exempt from R3 (events, not facts)', () => {
    const mem = freshMemory()
    mem.record({
      ...goodRecord(),
      kind: 'episodic',
      content: 'npm test failed in engine.ts',
      commit: undefined,
    })
    expect(mem.size()).toBe(1)
  })

  it('allowCodeWithoutCommit bypasses R3', () => {
    const mem = new LongTermMemory({
      backend: backend(),
      allowCodeWithoutCommit: true,
      now: () => '2026-01-01T00:00:00.000Z',
    })
    mem.record({ ...goodRecord(), content: 'engine.ts uses ESM', commit: undefined })
    expect(mem.size()).toBe(1)
  })
})

// ─────────────────────────────────────────────────────────────────────
// R4 — Expiration / TTL
// ─────────────────────────────────────────────────────────────────────
describe('R4: expiration', () => {
  it('expired records are filtered from query results', () => {
    let clock = '2026-01-01T00:00:00.000Z'
    const mem = new LongTermMemory({
      backend: backend(),
      now: () => clock,
    })
    mem.record({
      ...goodRecord(),
      content: 'temporary fact',
      expiresAt: '2026-02-01T00:00:00.000Z',
    })
    expect(mem.query()).toHaveLength(1)
    clock = '2026-03-01T00:00:00.000Z'
    expect(mem.query()).toHaveLength(0)
  })

  it('collectGarbage removes expired records from the backend', () => {
    let clock = '2026-01-01T00:00:00.000Z'
    const mem = new LongTermMemory({
      backend: backend(),
      now: () => clock,
    })
    mem.record({
      ...goodRecord(),
      content: 'temp',
      expiresAt: '2026-02-01T00:00:00.000Z',
    })
    clock = '2026-03-01T00:00:00.000Z'
    expect(mem.collectGarbage()).toBe(1)
    expect(mem.size()).toBe(0)
    // Garbage collection is idempotent.
    expect(mem.collectGarbage()).toBe(0)
  })

  it('non-expired records survive collectGarbage', () => {
    let clock = '2026-01-01T00:00:00.000Z'
    const mem = new LongTermMemory({
      backend: backend(),
      now: () => clock,
    })
    mem.record({
      ...goodRecord(),
      content: 'fresh',
      expiresAt: '2027-01-01T00:00:00.000Z',
    })
    expect(mem.collectGarbage()).toBe(0)
    expect(mem.size()).toBe(1)
  })
})

// ─────────────────────────────────────────────────────────────────────
// R5 — Conflict-aware merging
// ─────────────────────────────────────────────────────────────────────
describe('R5: conflict-aware merging', () => {
  it('exact duplicate content merges into existing record (no second row)', () => {
    const mem = freshMemory()
    mem.record(goodRecord())
    mem.record(goodRecord())
    expect(mem.size()).toBe(1)
  })

  it('lower-confidence incoming does NOT overwrite higher-confidence existing', () => {
    const mem = freshMemory()
    mem.record({ ...goodRecord(), confidence: 0.9 })
    mem.record({ ...goodRecord(), confidence: 0.5 })
    const all = mem.query()
    expect(all).toHaveLength(1)
    expect(all[0]!.confidence).toBe(0.9)
  })

  it('higher-confidence incoming overwrites (same content)', () => {
    const mem = freshMemory()
    mem.record({ ...goodRecord(), confidence: 0.5 })
    mem.record({ ...goodRecord(), confidence: 0.95 })
    const all = mem.query()
    expect(all).toHaveLength(1)
    expect(all[0]!.confidence).toBe(0.95)
  })

  it('verified existing is NOT overwritten by unverified incoming', () => {
    const mem = new LongTermMemory({
      backend: backend(),
      allowUnverified: true,
      now: () => '2026-01-01T00:00:00.000Z',
    })
    mem.record({ ...goodRecord(), confidence: 0.5, verified: true })
    mem.record({
      ...goodRecord(),
      confidence: 0.99,
      verified: false,
    })
    const all = mem.query()
    expect(all).toHaveLength(1)
    expect(all[0]!.verified).toBe(true)
  })

  it('merge unions tags', () => {
    const mem = freshMemory()
    mem.record({ ...goodRecord(), tags: ['a', 'b'] })
    mem.record({ ...goodRecord(), tags: ['b', 'c'] })
    const all = mem.query()
    expect(all).toHaveLength(1)
    expect(all[0]!.tags.sort()).toEqual(['a', 'b', 'c'])
  })
})

// ─────────────────────────────────────────────────────────────────────
// R6 — Embedding-optional
// ─────────────────────────────────────────────────────────────────────
describe('R6: embedding optional', () => {
  it('writing without embedding succeeds', () => {
    const mem = freshMemory()
    const rec = mem.record(goodRecord())
    expect(rec.embedding).toBeUndefined()
  })

  it('writing with embedding persists it', () => {
    const mem = freshMemory()
    const rec = mem.record({ ...goodRecord(), embedding: [0.1, 0.2, 0.3] })
    expect(rec.embedding).toEqual([0.1, 0.2, 0.3])
    const found = mem.query({ fullText: 'engine' })
    expect(found[0]!.embedding).toEqual([0.1, 0.2, 0.3])
  })
})

// ─────────────────────────────────────────────────────────────────────
// Query filter
// ─────────────────────────────────────────────────────────────────────
describe('query filters', () => {
  beforeEach(() => {
    // sanity
  })

  it('filters by repo', () => {
    const mem = freshMemory()
    mem.record({ ...goodRecord(), repo: '/A' })
    mem.record({ ...goodRecord(), repo: '/B', content: 'other repo' })
    expect(mem.query({ repo: '/A' })).toHaveLength(1)
  })

  it('filters by kind', () => {
    const mem = freshMemory()
    mem.record({ ...goodRecord(), kind: 'semantic' })
    mem.record({
      ...goodRecord(),
      kind: 'episodic',
      content: 'npm test failed',
      commit: undefined,
    })
    expect(mem.query({ kind: 'episodic' })).toHaveLength(1)
  })

  it('filters by tag', () => {
    const mem = freshMemory()
    mem.record({ ...goodRecord(), tags: ['bug'] })
    mem.record({ ...goodRecord(), tags: ['feature'], content: 'new thing' })
    expect(mem.query({ tag: 'bug' })).toHaveLength(1)
  })

  it('filters by sourceRunId', () => {
    const mem = freshMemory()
    mem.record({ ...goodRecord(), sourceRunId: 'run_a' })
    mem.record({ ...goodRecord(), sourceRunId: 'run_b', content: 'other run' })
    expect(mem.query({ sourceRunId: 'run_a' })).toHaveLength(1)
  })

  it('fullText is case-insensitive substring', () => {
    const mem = freshMemory()
    mem.record({ ...goodRecord(), content: 'Engine Uses ESM' })
    mem.record({ ...goodRecord(), content: 'unrelated', commit: undefined })
    expect(mem.query({ fullText: 'engine' })).toHaveLength(1)
  })

  it('results sorted by descending confidence, then descending createdAt', () => {
    let clock = '2026-01-01T00:00:00.000Z'
    const mem = new LongTermMemory({
      backend: backend(),
      now: () => clock,
    })
    mem.record({ ...goodRecord(), confidence: 0.5, content: 'low' })
    clock = '2026-01-02T00:00:00.000Z'
    mem.record({ ...goodRecord(), confidence: 0.9, content: 'high' })
    clock = '2026-01-03T00:00:00.000Z'
    mem.record({ ...goodRecord(), confidence: 0.9, content: 'high newer' })
    const all = mem.query()
    expect(all.map((r) => r.content)).toEqual(['high newer', 'high', 'low'])
  })

  it('limit caps results', () => {
    const mem = freshMemory()
    for (let i = 0; i < 5; i++) {
      mem.record({ ...goodRecord(), content: `fact ${i}`, confidence: 0.5 })
    }
    expect(mem.query({ limit: 2 })).toHaveLength(2)
  })
})

// ─────────────────────────────────────────────────────────────────────
// Backend durability
// ─────────────────────────────────────────────────────────────────────
describe('JSONL backend durability', () => {
  it('records survive backend recreation (reopen the same file)', () => {
    const path = join(tmp, 'persist.jsonl')
    const b1 = new JsonlMemoryBackend(path)
    const mem1 = new LongTermMemory({
      backend: b1,
      now: () => '2026-01-01T00:00:00.000Z',
    })
    mem1.record({ ...goodRecord(), content: 'persistent fact' })

    // New backend pointed at the same file.
    const b2 = new JsonlMemoryBackend(path)
    const mem2 = new LongTermMemory({
      backend: b2,
      now: () => '2026-01-01T00:00:00.000Z',
    })
    expect(mem2.query({ fullText: 'persistent' })).toHaveLength(1)
  })

  it('corrupted lines are skipped on load', () => {
    const path = join(tmp, 'corrupt.jsonl')
    const b = new JsonlMemoryBackend(path)
    const mem = new LongTermMemory({
      backend: b,
      now: () => '2026-01-01T00:00:00.000Z',
    })
    mem.record(goodRecord())
    // Append a corrupted line directly.
    const { appendFileSync } = require('fs')
    appendFileSync(path, '{not valid json\n')
    expect(mem.query()).toHaveLength(1) // corrupted line skipped
  })

  it('delete removes by id', () => {
    const mem = freshMemory()
    const rec = mem.record(goodRecord())
    mem.delete(rec.id)
    expect(mem.size()).toBe(0)
  })

  it('delete on missing id is a no-op', () => {
    const mem = freshMemory()
    expect(() => mem.delete('nonexistent')).not.toThrow()
  })
})

// ─────────────────────────────────────────────────────────────────────
// Integration with ExecutionRun: only verified runs enter memory
// ─────────────────────────────────────────────────────────────────────
describe('integration: only verified runs enter memory', () => {
  it('a typical post-run write with all gates passing', () => {
    const mem = freshMemory()
    const rec = mem.record({
      kind: 'semantic',
      content: 'tests live under tests/ and use vitest',
      repo: '/repo',
      sourceRunId: 'run_42',
      origin: 'tool:bash',
      confidence: 0.85,
      verified: true,
      tags: ['convention'],
      commit: 'deadbeef',
    })
    expect(rec.id).toMatch(/^mem_/)
    expect(rec.createdAt).toBe('2026-01-01T00:00:00.000Z')
  })

  it('a failed-run write is rejected by default', () => {
    const mem = freshMemory()
    expect(() =>
      mem.record({
        ...goodRecord(),
        verified: false,
        content: 'failed run leftover',
      }),
    ).toThrow(MemoryVerificationError)
  })
})
