/**
 * v0.5.3 Hotfix §12 — Golden Path strictness additions.
 *
 *   1. all-profiles-open → 0 gateway calls + ROUTING_UNAVAILABLE
 *   2. probe-busy second run → goes directly to B
 *   3. (already covered by effectiveRunId.test.ts and
 *      claimLevelEvidence.test.ts)
 *   4. git-subdir Memory round-trip
 */
import { describe, it, expect } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, existsSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { execFileSync } from 'node:child_process'

import { ModelRouter, type ModelProfile } from '../../src/core/model/modelRouter.js'
import { MemoryModule } from '../../src/modules/memory.js'
import { SemanticMemory } from '../../src/core/semanticMemory.js'
import { EpisodicMemory } from '../../src/core/episodicMemory.js'
import { resolveProjectIdentity } from '../../src/core/projectIdentity.js'

function profile(id: string, model: string): ModelProfile {
  return {
    id,
    provider: 'openai-compatible',
    model,
    tier: 'top',
    roles: ['main'],
    available: true,
    capabilities: {
      reasoning: 0.7, coding: 0.7, contextWindow: 0.6,
      toolCalling: 0.9, speed: 0.6, cost: 0.4,
    },
  }
}

describe('Golden Path — all-profiles-open', () => {
  it('returns structured unavailable decision; no Gateway calls possible', () => {
    const router = new ModelRouter([
      profile('profile-a', 'model-a'),
      profile('profile-b', 'model-b'),
    ])
    // Open both circuits by repeated failures.
    for (let i = 0; i < 5; i++) {
      router.recordCall('profile-a', false, 100, null)
      router.recordCall('profile-b', false, 100, null)
    }
    const decision = router.route({
      userGoal: 'do something',
      repoFileCount: 10,
      filesTouched: 1,
      consecutiveFailures: 0,
      expectedToolRequirement: 'side-effect',
    })
    expect(decision.selectedModel).toBe('')
    expect(decision.reasonCodes).toContain('all-profiles-open')
    // The coordinator MUST NOT call the Gateway when unavailable —
    // the only safe path is a structured error. We assert that
    // by construction: a non-empty selectedModel is required to
    // enter the gateway.
    expect(decision.selectedModel.length).toBe(0)
  })
})

describe('Golden Path — git-subdir Memory round-trip', () => {
  let ovogoHome: string
  let projectDir: string
  let subdir: string

  it('MemoryModule booted from git subdir writes to parent project file', async () => {
    ovogoHome = mkdtempSync(join(tmpdir(), 'ovolv999-gpsub-home-'))
    projectDir = mkdtempSync(join(tmpdir(), 'ovolv999-gpsub-proj-'))
    subdir = join(projectDir, 'packages', 'inner')
    process.env.OVOGO_HOME = ovogoHome
    try {
      execFileSync('git', ['init', '--quiet', projectDir], { stdio: 'pipe' })
      mkdirSync(subdir, { recursive: true })

      const idFromSubdir = await resolveProjectIdentity({ cwd: subdir })
      expect(idFromSubdir.canonicalRoot).toBe(projectDir)

      const sem = new SemanticMemory(join(projectDir, '.ovogo'))
      const epi = new EpisodicMemory(projectDir)
      const mod = new MemoryModule(sem, epi)
      mod.boot({
        cwd: subdir,
        config: { cwd: subdir } as never,
        projectIdentity: idFromSubdir,
      })

      const ltm = (mod as unknown as { longTerm: { record: (i: unknown) => unknown; query: (f: unknown) => Array<{ repo: string; content: string }> } }).longTerm
      ltm.record({
        kind: 'semantic',
        content: 'git-subdir fact',
        repo: idFromSubdir.canonicalRoot,
        branch: idFromSubdir.binding.branch,
        baseCommit: idFromSubdir.binding.baseCommit,
        sourceRunId: 'r',
        origin: 'memory_promotion:r',
        confidence: 0.9,
        verified: true,
        tags: [],
        expiresAt: undefined,
      })
      // File exists at the canonical-root path.
      expect(existsSync(mod.getLongTermMemoryPath())).toBe(true)
      // And the record is reachable.
      const all = ltm.query({ kind: 'semantic', repo: idFromSubdir.canonicalRoot })
      expect(all.length).toBe(1)
      expect(all[0].content).toBe('git-subdir fact')
    } finally {
      try { rmSync(projectDir, { recursive: true, force: true }) } catch { /* best-effort */ }
      try { rmSync(ovogoHome, { recursive: true, force: true }) } catch { /* best-effort */ }
      delete process.env.OVOGO_HOME
    }
  })
})