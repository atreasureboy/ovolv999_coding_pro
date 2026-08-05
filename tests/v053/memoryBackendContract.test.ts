/**
 * v0.5.3 Closure Integrity (P4): MemoryBackend contract suite.
 *
 * Every backend (InMemoryMemoryBackend, JsonlMemoryBackend) MUST
 * satisfy:
 *   - upsert(record) with the same id REPLACES the previous record
 *     (not appends; load() returns it once).
 *   - load(now) returns each id at most once; TTL is honored.
 *   - delete(id) is idempotent and removes only that id.
 *   - load() return order is deterministic (insertion order).
 *
 * The same test suite runs against both backends, parametrized.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

import {
  InMemoryMemoryBackend,
  JsonlMemoryBackend,
  type MemoryBackend,
  type MemoryRecord,
} from '../../src/core/longTermMemory.js'

function rec(id: string, content: string, createdAt: string, expiresAt?: string): MemoryRecord {
  return {
    id,
    kind: 'semantic',
    content,
    repo: '/tmp/proj-a',
    sourceRunId: 'run-X',
    origin: 'test',
    confidence: 0.9,
    verified: true,
    tags: [],
    createdAt,
    ...(expiresAt ? { expiresAt } : {}),
  }
}

interface BackendFixture {
  name: string
  build: (filePath?: string) => MemoryBackend
  cleanup?: () => void
}

const FIXTURES: BackendFixture[] = [
  {
    name: 'InMemoryMemoryBackend',
    build: () => new InMemoryMemoryBackend(),
  },
  {
    name: 'JsonlMemoryBackend',
    build: (filePath?: string) => new JsonlMemoryBackend(filePath ?? '/tmp/never.jsonl'),
  },
]

for (const fx of FIXTURES) {
  describe(`MemoryBackend ${fx.name} (Closure Integrity P4 contract)`, () => {
    let tmpDir: string | undefined
    let backend: MemoryBackend

    beforeEach(() => {
      if (fx.name === 'JsonlMemoryBackend') {
        tmpDir = mkdtempSync(join(tmpdir(), 'ovolv999-backend-'))
        const filePath = join(tmpDir, 'memory.jsonl')
        backend = fx.build(filePath)
      } else {
        backend = fx.build()
      }
    })
    afterEach(() => {
      if (tmpDir) {
        rmSync(tmpDir, { recursive: true, force: true })
        tmpDir = undefined
      }
    })

    it('upsert with same id REPLACES (load returns id once)', () => {
      backend.upsert(rec('m1', 'first', '2026-01-01T00:00:00Z'))
      backend.upsert(rec('m1', 'REPLACED', '2026-01-01T00:00:01Z'))
      const all = backend.load('2026-12-31T00:00:00Z')
      const m1 = all.filter((r) => r.id === 'm1')
      expect(m1.length).toBe(1)
      expect(m1[0].content).toBe('REPLACED')
    })

    it('load returns each id at most once even after 100 upserts', () => {
      for (let i = 0; i < 100; i++) {
        backend.upsert(rec('m1', `rev-${i}`, '2026-01-01T00:00:00Z'))
      }
      const all = backend.load('2026-12-31T00:00:00Z')
      expect(all.filter((r) => r.id === 'm1').length).toBe(1)
    })

    it('load respects TTL: expired records disappear', () => {
      backend.upsert(rec('live', 'kept', '2026-01-01T00:00:00Z'))
      backend.upsert(rec('dead', 'gone', '2026-01-01T00:00:00Z', '2026-06-01T00:00:00Z'))
      const all = backend.load('2026-12-31T00:00:00Z')
      expect(all.find((r) => r.id === 'live')).toBeDefined()
      expect(all.find((r) => r.id === 'dead')).toBeUndefined()
    })

    it('delete is idempotent', () => {
      backend.upsert(rec('m1', 'x', '2026-01-01T00:00:00Z'))
      backend.delete('m1')
      backend.delete('m1')
      backend.delete('nonexistent')
      expect(backend.load('2026-12-31T00:00:00Z').length).toBe(0)
    })

    it('return order is deterministic (insertion order of new ids)', () => {
      backend.upsert(rec('a', 'a', '2026-01-01T00:00:00Z'))
      backend.upsert(rec('b', 'b', '2026-01-01T00:00:01Z'))
      backend.upsert(rec('c', 'c', '2026-01-01T00:00:02Z'))
      const ids = backend.load('2026-12-31T00:00:00Z').map((r) => r.id)
      // Map preserves insertion order; JsonlMemoryBackend reads
      // in file order which for sequential upserts matches.
      expect(ids).toEqual(['a', 'b', 'c'])
    })
  })
}
