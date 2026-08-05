/**
 * v0.5.3 Post-Release Integrity Hotfix §5 — per-project Memory
 * backend (real file-system split, no shared global default).
 *
 * Spec contracts:
 *   - MemoryModule constructor does NOT create a default JSONL file
 *   - Boot binds a JsonlMemoryBackend at defaultMemoryPath(canonicalRoot)
 *   - getLongTermMemoryPath() returns the current project's real path
 *   - Git root + git subdir → same path
 *   - Project A and Project B → different paths
 *   - Tests must NOT touch real HOME (use OVOGO_HOME override)
 *   - Reject direct `ltm.query(...)` substitutes for memory_search
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, existsSync, statSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { execFileSync } from 'node:child_process'

import { defaultMemoryPath } from '../../src/core/longTermMemory.js'
import { MemoryModule } from '../../src/modules/memory.js'
import { SemanticMemory } from '../../src/core/semanticMemory.js'
import { EpisodicMemory } from '../../src/core/episodicMemory.js'
import { resolveProjectIdentity } from '../../src/core/projectIdentity.js'

describe('Memory per-project backend (Hotfix §5)', () => {
  let ovogoHome: string

  beforeEach(() => {
    // Pin HOME so defaultMemoryPath uses this tmp dir, never the
    // developer's real ~/.ovogo. Real HOME is left untouched.
    ovogoHome = mkdtempSync(join(tmpdir(), 'ovolv999-memhome-'))
    process.env.OVOGO_HOME = ovogoHome
  })
  afterEach(() => {
    try { rmSync(ovogoHome, { recursive: true, force: true }) } catch { /* best-effort */ }
    delete process.env.OVOGO_HOME
  })

  it('defaultMemoryPath includes slug + sha256 prefix (collision-safe)', () => {
    const p1 = defaultMemoryPath('/repo')
    const p2 = defaultMemoryPath('/repo')
    const p3 = defaultMemoryPath('/REPO') // case-only collision
    expect(p1).toBe(p2)
    expect(p1).not.toBe(p3) // different sha256 prefix → different file
    expect(p1).toContain('.ovogo/projects/')
  })

  it('git root and git subdir resolve to the same canonicalRoot → same path', async () => {
    const repoRoot = mkdtempSync(join(tmpdir(), 'ovolv999-memroot-'))
    const subdir = join(repoRoot, 'packages', 'a')
    try {
      execFileSync('git', ['init', '--quiet', repoRoot], { stdio: 'pipe' })
      execFileSync('mkdir', ['-p', subdir], { stdio: 'pipe' })

      const idRoot = await resolveProjectIdentity({ cwd: repoRoot })
      const idSub = await resolveProjectIdentity({ cwd: subdir })
      expect(idRoot.canonicalRoot).toBe(idSub.canonicalRoot)
      expect(idRoot.projectKey).toBe(idSub.projectKey)

      // Same canonicalRoot → same per-project file
      expect(defaultMemoryPath(idRoot.canonicalRoot))
        .toBe(defaultMemoryPath(idSub.canonicalRoot))
    } finally {
      rmSync(repoRoot, { recursive: true, force: true })
    }
  })

  it('projects A and B resolve to different paths', () => {
    const a = mkdtempSync(join(tmpdir(), 'ovolv999-memA-'))
    const b = mkdtempSync(join(tmpdir(), 'ovolv999-memB-'))
    try {
      const pathA = defaultMemoryPath(a)
      const pathB = defaultMemoryPath(b)
      expect(pathA).not.toBe(pathB)
    } finally {
      rmSync(a, { recursive: true, force: true })
      rmSync(b, { recursive: true, force: true })
    }
  })

  it('MemoryModule constructor does NOT create a default JSONL file', () => {
    const projectDir = mkdtempSync(join(tmpdir(), 'ovolv999-memmod-'))
    try {
      const sem = new SemanticMemory(join(projectDir, '.ovogo'))
      const epi = new EpisodicMemory(projectDir)
      const mod = new MemoryModule(sem, epi)
      void mod
      // No boot happened. The MemoryModule has not yet bound a
      // backend, so defaultMemoryPath(projectDir) was never
      // called and no file was created.
      const expectedPath = defaultMemoryPath(projectDir)
      expect(existsSync(expectedPath)).toBe(false)
    } finally {
      rmSync(projectDir, { recursive: true, force: true })
    }
  })

  it('MemoryModule.boot binds a per-project JSONL file', async () => {
    const projectDir = mkdtempSync(join(tmpdir(), 'ovolv999-memboot-'))
    try {
      const id = await resolveProjectIdentity({ cwd: projectDir })
      const sem = new SemanticMemory(join(projectDir, '.ovogo'))
      const epi = new EpisodicMemory(projectDir)
      const mod = new MemoryModule(sem, epi)
      mod.boot({
        cwd: projectDir,
        config: { cwd: projectDir } as never,
        userMessage: '',
        projectIdentity: id,
      })
      const expectedPath = defaultMemoryPath(projectDir)
      // Boot eagerly constructs the file (JsonlMemoryBackend's
      // ctor writes a zero-byte stub). The path matches what
      // getLongTermMemoryPath() reports.
      expect(existsSync(expectedPath)).toBe(true)
      expect(mod.getLongTermMemoryPath()).toBe(expectedPath)
      expect(statSync(expectedPath).size).toBe(0)
    } finally {
      rmSync(projectDir, { recursive: true, force: true })
    }
  })

  it('two MemoryModules in two projects do not share files', async () => {
    const projectA = mkdtempSync(join(tmpdir(), 'ovolv999-memA2-'))
    const projectB = mkdtempSync(join(tmpdir(), 'ovolv999-memB2-'))
    try {
      const idA = await resolveProjectIdentity({ cwd: projectA })
      const idB = await resolveProjectIdentity({ cwd: projectB })
      const semA = new SemanticMemory(join(projectA, '.ovogo'))
      const semB = new SemanticMemory(join(projectB, '.ovogo'))
      const modA = new MemoryModule(semA, new EpisodicMemory(projectA))
      const modB = new MemoryModule(semB, new EpisodicMemory(projectB))
      modA.boot({ cwd: projectA, config: { cwd: projectA } as never, projectIdentity: idA })
      modB.boot({ cwd: projectB, config: { cwd: projectB } as never, projectIdentity: idB })
      expect(modA.getLongTermMemoryPath()).not.toBe(modB.getLongTermMemoryPath())
      expect(existsSync(modA.getLongTermMemoryPath())).toBe(true)
      expect(existsSync(modB.getLongTermMemoryPath())).toBe(true)
    } finally {
      rmSync(projectA, { recursive: true, force: true })
      rmSync(projectB, { recursive: true, force: true })
    }
  })
})