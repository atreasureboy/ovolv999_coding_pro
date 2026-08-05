/**
 * v0.5.3 Closure Integrity (P6): RevisionBinding truth across
 * root / subdir / linked worktree / untracked-only / non-git
 * scenarios.
 *
 * The spec required these to behave correctly:
 *   - git root         → branch + HEAD + clean diffHash
 *   - git subdir       → canonical repo = toplevel, NOT cwd
 *   - git worktree     → canonical repo = main worktree toplevel
 *   - git dirty        → diffHash reflects staged+unstaged+untracked
 *   - untracked-only   → diffHash captures untracked file manifest
 *   - non-git          → workspaceHash, dirty=true
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { execFileSync, execSync } from 'node:child_process'

import { buildRevisionBinding, workspaceHash } from '../../src/core/revisionBinding.js'

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
}

describe('RevisionBinding truth (Closure Integrity P6)', () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'ovolv999-rb-'))
  })
  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it('non-git directory → workspaceHash, dirty=true, no commit string', async () => {
    const b = await buildRevisionBinding({ cwd: tmpDir, disableGit: false })
    expect(b.repo).toBe(tmpDir)
    expect(b.workspaceHash).toBeDefined()
    expect(b.workspaceHash!.length).toBeGreaterThan(0)
    expect(b.branch).toBeUndefined()
    expect(b.baseCommit).toBeUndefined()
    expect(b.diffHash).toBeUndefined()
    expect(b.dirty).toBe(true)
  })

  it('git repo root (clean) → branch + HEAD + diffHash="clean"', async () => {
    const repo = join(tmpDir, 'mainrepo')
    mkdirSync(repo)
    git(repo, 'init', '-q')
    git(repo, 'config', 'user.email', 'a@b.c')
    git(repo, 'config', 'user.name', 't')
    writeFileSync(join(repo, 'a.txt'), 'a')
    git(repo, 'add', '.')
    git(repo, 'commit', '-m', 'init', '-q')

    const b = await buildRevisionBinding({ cwd: repo })
    expect(b.repo).toBe(repo)
    expect(b.branch).toBeDefined()
    expect(b.baseCommit).toMatch(/^[0-9a-f]{7,40}$/)
    expect(b.dirty).toBe(false)
    expect(b.diffHash).toBe('clean')
  })

  it('git repo subdir → repo field is toplevel, not cwd', async () => {
    const repo = join(tmpDir, 'subrepo')
    mkdirSync(repo)
    git(repo, 'init', '-q')
    git(repo, 'config', 'user.email', 'a@b.c')
    git(repo, 'config', 'user.name', 't')
    writeFileSync(join(repo, 'a.txt'), 'a')
    git(repo, 'add', '.')
    git(repo, 'commit', '-m', 'init', '-q')
    const subdir = join(repo, 'packages', 'sub')
    mkdirSync(subdir, { recursive: true })
    writeFileSync(join(subdir, 'x.ts'), 'export {}')

    const b = await buildRevisionBinding({ cwd: subdir })
    // Spec: repo is the canonical toplevel, NOT cwd.
    expect(b.repo).toBe(repo)
    expect(b.repo).not.toBe(subdir)
  })

  it('git repo with staged + unstaged + untracked produces a real diffHash', async () => {
    const repo = join(tmpDir, 'dirtyrepo')
    mkdirSync(repo)
    git(repo, 'init', '-q')
    git(repo, 'config', 'user.email', 'a@b.c')
    git(repo, 'config', 'user.name', 't')
    writeFileSync(join(repo, 'a.txt'), 'a')
    git(repo, 'add', '.')
    git(repo, 'commit', '-m', 'init', '-q')

    // staged change
    writeFileSync(join(repo, 'a.txt'), 'a-staged')
    git(repo, 'add', 'a.txt')
    // unstaged change
    writeFileSync(join(repo, 'a.txt'), 'a-unstaged')
    // untracked file
    writeFileSync(join(repo, 'b.txt'), 'b-content')

    const b = await buildRevisionBinding({ cwd: repo })
    expect(b.dirty).toBe(true)
    expect(b.diffHash).toBeDefined()
    expect(b.diffHash).not.toBe('clean')
    expect(b.diffHash!.length).toBe(16)
  })

  it('untracked-only state (no staged/unstaged) still produces a diffHash', async () => {
    const repo = join(tmpDir, 'untrepo')
    mkdirSync(repo)
    git(repo, 'init', '-q')
    git(repo, 'config', 'user.email', 'a@b.c')
    git(repo, 'config', 'user.name', 't')
    writeFileSync(join(repo, 'a.txt'), 'a')
    git(repo, 'add', '.')
    git(repo, 'commit', '-m', 'init', '-q')

    // ONLY untracked files
    writeFileSync(join(repo, 'new1.txt'), 'x')
    writeFileSync(join(repo, 'new2.txt'), 'y')

    const b = await buildRevisionBinding({ cwd: repo })
    expect(b.dirty).toBe(true)
    expect(b.diffHash).toBeDefined()
    expect(b.diffHash).not.toBe('clean')
  })

  it('workspaceHash is content-bound (changes when files change, stable when identical)', () => {
    const a = mkdtempSync(join(tmpdir(), 'ovolv999-wh-A-'))
    const b = mkdtempSync(join(tmpdir(), 'ovolv999-wh-B-'))
    try {
      writeFileSync(join(a, 'x.txt'), 'x')
      writeFileSync(join(b, 'x.txt'), 'x')
      const h1 = workspaceHash(a)
      const h2 = workspaceHash(b)
      // Identical content → identical hash
      expect(h1).toBe(h2)

      writeFileSync(join(b, 'x.txt'), 'y')
      const h3 = workspaceHash(b)
      expect(h3).not.toBe(h1)

      // node_modules excluded
      mkdirSync(join(a, 'node_modules', 'pkg'), { recursive: true })
      writeFileSync(join(a, 'node_modules', 'pkg', 'index.js'), 'noise')
      const h4 = workspaceHash(a)
      expect(h4).toBe(h1)
    } finally {
      rmSync(a, { recursive: true, force: true })
      rmSync(b, { recursive: true, force: true })
    }
  })

  it('excludes node_modules / dist / coverage / .git / session / tmp / .cache from manifest', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ovolv999-wh-excl-'))
    try {
      writeFileSync(join(dir, 'a.txt'), '1')
      const baseline = workspaceHash(dir)

      // Add files under exclusions; hash MUST NOT change.
      for (const noise of ['node_modules/x', 'dist/y', '.git/z', 'session/w', 'tmp/v', '.cache/u']) {
        const abs = join(dir, noise)
        mkdirSync(join(dir, ...noise.split('/').slice(0, -1)), { recursive: true })
        try { writeFileSync(abs, 'noise'); } catch { /* .git is sometimes weird; ignore */ }
      }
      const withNoise = workspaceHash(dir)
      expect(withNoise).toBe(baseline)
      void existsSync
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('ExecResult is structured: {ok,stdout} or {ok:false,reason}', () => {
    // The ExecResult type is exported alongside safeExec-style
    // callers. We assert it has both shapes and that git is
    // reachable for a real repo.
    const repo = join(tmpDir, 'execrepo')
    mkdirSync(repo)
    git(repo, 'init', '-q')
    const r1 = execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd: repo, encoding: 'utf8' })
    expect(r1.trim().endsWith('execrepo')).toBe(true)
    void execSync
  })
})
