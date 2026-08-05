/**
 * v0.5.3 Post-Release Integrity Hotfix §4 — ProjectIdentity.
 *
 * The Engine resolves ProjectIdentity ONCE per run and threads it
 * to every subsystem. Key contracts:
 *   - canonicalRoot == git toplevel for git-subdir launch
 *   - canonicalRoot == absolute cwd for non-git
 *   - projectKey == sha256(canonicalRoot)[:16]
 *   - MemoryModule.bindToProjectIdentity(identity) sets
 *     projectRepo = canonicalRoot, not the launch cwd
 *   - MemoryModule.boot(ctx) with projectIdentity uses canonical
 */
import { describe, it, expect } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { execFileSync } from 'node:child_process'

import { resolveProjectIdentity } from '../../src/core/projectIdentity.js'
import { MemoryModule } from '../../src/modules/memory.js'
import { SemanticMemory } from '../../src/core/semanticMemory.js'
import { EpisodicMemory } from '../../src/core/episodicMemory.js'

describe('ProjectIdentity (Hotfix §4)', () => {
  function freshTmp(prefix: string): string {
    return mkdtempSync(join(tmpdir(), prefix))
  }

  it('non-git cwd: canonicalRoot == inputCwd', async () => {
    const cwd = freshTmp('ovolv999-pi-nongit-')
    try {
      const id = await resolveProjectIdentity({ cwd })
      expect(id.inputCwd).toBe(cwd)
      expect(id.canonicalRoot).toBe(cwd)
      expect(id.projectKey.length).toBe(16)
      expect(id.binding.workspaceHash).toBeDefined()
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  })

  it('git-repo cwd: canonicalRoot == git toplevel', async () => {
    const cwd = freshTmp('ovolv999-pi-git-')
    try {
      execFileSync('git', ['init', '--quiet', cwd], { stdio: 'pipe' })
      const id = await resolveProjectIdentity({ cwd })
      expect(id.canonicalRoot).toBe(cwd) // launch == toplevel
      expect(id.binding.repo).toBe(cwd)
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  })

  it('git subdir cwd: canonicalRoot == git toplevel (NOT cwd)', async () => {
    const repoRoot = freshTmp('ovolv999-pi-gitsub-')
    const subdir = join(repoRoot, 'packages', 'a')
    try {
      execFileSync('git', ['init', '--quiet', repoRoot], { stdio: 'pipe' })
      execFileSync('mkdir', ['-p', subdir], { stdio: 'pipe' })
      const id = await resolveProjectIdentity({ cwd: subdir })
      expect(id.inputCwd).toBe(subdir)
      expect(id.canonicalRoot).toBe(repoRoot)
      expect(id.canonicalRoot).not.toBe(subdir)
    } finally {
      rmSync(repoRoot, { recursive: true, force: true })
    }
  })

  it('projectKey is stable for same canonicalRoot, different for different', async () => {
    const a = freshTmp('ovolv999-pi-keyA-')
    const b = freshTmp('ovolv999-pi-keyB-')
    try {
      const idA = await resolveProjectIdentity({ cwd: a })
      const idA2 = await resolveProjectIdentity({ cwd: a })
      const idB = await resolveProjectIdentity({ cwd: b })
      expect(idA.projectKey).toBe(idA2.projectKey)
      expect(idA.projectKey).not.toBe(idB.projectKey)
    } finally {
      rmSync(a, { recursive: true, force: true })
      rmSync(b, { recursive: true, force: true })
    }
  })

  it('MemoryModule.bindToProjectIdentity sets projectRepo = canonicalRoot', async () => {
    const repoRoot = freshTmp('ovolv999-pi-bind-')
    const subdir = join(repoRoot, 'sub')
    try {
      execFileSync('git', ['init', '--quiet', repoRoot], { stdio: 'pipe' })
      execFileSync('mkdir', ['-p', subdir], { stdio: 'pipe' })
      const id = await resolveProjectIdentity({ cwd: subdir })
      expect(id.canonicalRoot).toBe(repoRoot)
      const sem = new SemanticMemory(join(repoRoot, '.ovogo'))
      const epi = new EpisodicMemory(repoRoot)
      const mod = new MemoryModule(sem, epi)
      mod.bindToProjectIdentity(id)
      // The MemoryModule now considers the parent git repo its
      // projectRepo, never the subdir.
      const filter = (mod as unknown as { projectRepo: string }).projectRepo
      expect(filter).toBe(repoRoot)
      expect(filter).not.toBe(subdir)
    } finally {
      rmSync(repoRoot, { recursive: true, force: true })
    }
  })
})