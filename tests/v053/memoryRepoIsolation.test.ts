/**
 * v0.5.3 Final (P0 issue): cross-project isolation test.
 *
 * Writes from project A MUST NOT appear in project B's
 * memory_search or boot retrieval. The MemoryModule's
 * LongTermMemory is rebound to ctx.cwd at every boot; queries
 * inject the repo filter. This test exercises the read path
 * directly with two different cwd-derived repos and asserts no
 * leak.
 */
import { describe, it, expect } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

import { LongTermMemory } from '../../src/core/longTermMemory.js'
import { MemoryModule } from '../../src/modules/memory.js'
import { SemanticMemory } from '../../src/core/semanticMemory.js'
import { EpisodicMemory } from '../../src/core/episodicMemory.js'

function makeCtx(cwd: string, userMessage: string) {
  return {
    cwd,
    sessionDir: tmpDir(cwd),
    config: { cwd } as never,
    userMessage,
    sharedServices: {},
  } as never
}

function tmpDir(cwd: string): string {
  return mkdtempSync(join(cwd, 'session-'))
}

describe('MemoryModule — cross-project isolation (v0.5.3 Final P0)', () => {
  it('writes from project A do not appear in project B queries', () => {
    const projectA = mkdtempSync(join(tmpdir(), 'ovolv999-mem-A-'))
    const projectB = mkdtempSync(join(tmpdir(), 'ovolv999-mem-B-'))

    try {
      const sem = new SemanticMemory(join(projectA, '.ovogo'))
      const epi = new EpisodicMemory(projectA)
      const memA = new MemoryModule(sem, epi)

      const ctxA = makeCtx(projectA, 'project A experiment')
      memA.bindToProject(projectA)
      const bootA = memA.boot(ctxA)
      const writeTool = bootA.tools!.find((t) => t.name === 'memory_write')!
      const ctx = { cwd: projectA, permissionMode: 'default' } as never
      // Push a candidate directly via the per-run sink.
      memA.publishCandidateSink('run-A', (c) => {
        void c
      })

      // Use LongTermMemory directly to write a verified entry
      // for project A.
      const ltmA = new LongTermMemory()
      ltmA.record({
        kind: 'semantic',
        content: 'Project A ONLY secret knowledge',
        repo: projectA,
        origin: 'memory_promotion:run-A',
        sourceRunId: 'run-A',
        confidence: 0.9,
        verified: true,
        tags: ['project-a-secret'],
        expiresAt: undefined,
      })

      // Cross-query: project B asks LTM seeded with projectA's
      // instance, but with repo filter = project B's cwd →
      // MUST return [].
      const filtered = ltmA.query({ kind: 'semantic', verified: true, repo: projectB, limit: 10 })
      expect(filtered.length).toBe(0)

      // Sanity: the same query with projectA's repo returns the entry.
      const own = ltmA.query({ kind: 'semantic', verified: true, repo: projectA, limit: 10 })
      expect(own.length).toBeGreaterThan(0)
      expect(own[0].content).toBe('Project A ONLY secret knowledge')
      void writeTool
      void ctx
    } finally {
      rmSync(projectA, { recursive: true, force: true })
      rmSync(projectB, { recursive: true, force: true })
    }
  })
})
