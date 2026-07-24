import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { execSync } from 'child_process'
import {
  WorktreeManager,
  EnterWorktreeTool,
  ExitWorktreeTool,
  ListWorktreesTool,
  getWorktreeManager,
  _resetWorktreeManagersForTest,
} from '../src/tools/worktree.js'
import type { ToolContext } from '../src/core/types.js'

function makeCtx(cwd: string): ToolContext {
  return { cwd, permissionMode: 'auto' }
}

function initGitRepo(dir: string): void {
  execSync('git init -b main', { cwd: dir, stdio: 'pipe' })
  execSync('git config user.email "test@test.com"', { cwd: dir, stdio: 'pipe' })
  execSync('git config user.name "Test"', { cwd: dir, stdio: 'pipe' })
  writeFileSync(join(dir, 'README.md'), '# Test\n')
  execSync('git add -A', { cwd: dir, stdio: 'pipe' })
  execSync('git commit -m "initial"', { cwd: dir, stdio: 'pipe' })
}

describe('WorktreeManager', () => {
  let dir: string

  beforeEach(() => {
    _resetWorktreeManagersForTest()
    dir = mkdtempSync(join(tmpdir(), 'wt-test-'))
    initGitRepo(dir)
  })

  afterEach(() => {
    _resetWorktreeManagersForTest()
    try { rmSync(dir, { recursive: true, force: true }) } catch { /* best-effort */ }
  })

  it('detects git repo', () => {
    const mgr = new WorktreeManager(dir)
    expect(mgr.isGitRepo()).toBe(true)
  })

  it('detects non-git directory', () => {
    const nonGit = mkdtempSync(join(tmpdir(), 'wt-nongit-'))
    try {
      const mgr = new WorktreeManager(nonGit)
      expect(mgr.isGitRepo()).toBe(false)
    } finally {
      rmSync(nonGit, { recursive: true, force: true })
    }
  })

  it('gets current branch', () => {
    const mgr = new WorktreeManager(dir)
    expect(mgr.getCurrentBranch()).toBe('main')
  })

  it('creates a worktree', () => {
    const mgr = new WorktreeManager(dir)
    const info = mgr.createWorktree('feature-x')
    expect(info.name).toBe('feature-x')
    expect(info.branch).toBe('wt/feature-x')
    expect(info.baseBranch).toBe('main')
    expect(existsSync(info.path)).toBe(true)
  })

  it('worktree has independent working copy', () => {
    const mgr = new WorktreeManager(dir)
    const info = mgr.createWorktree('feature-y')
    // Write a file in the worktree
    writeFileSync(join(info.path, 'new-file.txt'), 'hello')
    // It should NOT appear in the main directory
    expect(existsSync(join(dir, 'new-file.txt'))).toBe(false)
  })

  it('lists worktrees', () => {
    const mgr = new WorktreeManager(dir)
    mgr.createWorktree('wt-a')
    mgr.createWorktree('wt-b')
    const list = mgr.listWorktrees()
    expect(list).toHaveLength(2)
    expect(list.map(w => w.name).sort()).toEqual(['wt-a', 'wt-b'])
  })

  it('rejects duplicate worktree name', () => {
    const mgr = new WorktreeManager(dir)
    mgr.createWorktree('dup')
    expect(() => mgr.createWorktree('dup')).toThrow(/already exists/)
  })

  it('rejects creation in non-git repo', () => {
    const nonGit = mkdtempSync(join(tmpdir(), 'wt-nongit-'))
    try {
      const mgr = new WorktreeManager(nonGit)
      expect(() => mgr.createWorktree('test')).toThrow(/Not a git repository/)
    } finally {
      rmSync(nonGit, { recursive: true, force: true })
    }
  })

  it('removes a worktree with discard action', () => {
    const mgr = new WorktreeManager(dir)
    const info = mgr.createWorktree('discard-me')
    expect(existsSync(info.path)).toBe(true)
    mgr.removeWorktree('discard-me', { merge: false, deleteBranch: true })
    expect(existsSync(info.path)).toBe(false)
    expect(mgr.getWorktree('discard-me')).toBeUndefined()
  })

  it('merges worktree changes back to base', () => {
    const mgr = new WorktreeManager(dir)
    const info = mgr.createWorktree('merge-me')
    // Make a commit in the worktree
    writeFileSync(join(info.path, 'merged.txt'), 'data')
    execSync('git add -A && git commit -m "work in worktree"', {
      cwd: info.path, stdio: 'pipe',
    })
    mgr.removeWorktree('merge-me', { merge: true, deleteBranch: true })
    // File should now be in main
    expect(existsSync(join(dir, 'merged.txt'))).toBe(true)
  })

  it('persists metadata across instances', () => {
    const mgr1 = new WorktreeManager(dir)
    mgr1.createWorktree('persist-test')
    // Create a fresh instance — should load from JSON
    const mgr2 = new WorktreeManager(dir)
    expect(mgr2.getWorktree('persist-test')).toBeDefined()
  })

  it('detects worktree paths', () => {
    const mgr = new WorktreeManager(dir)
    const info = mgr.createWorktree('path-test')
    expect(mgr.isWorktreePath(info.path)).toBe(true)
    expect(mgr.isWorktreePath(dir)).toBe(false)
  })

  it('sanitizes unsafe names', () => {
    const mgr = new WorktreeManager(dir)
    const info = mgr.createWorktree('unsafe/name with spaces')
    expect(info.branch).toBe('wt/unsafe-name-with-spaces')
  })
})

describe('EnterWorktreeTool', () => {
  let dir: string

  beforeEach(() => {
    _resetWorktreeManagersForTest()
    dir = mkdtempSync(join(tmpdir(), 'wt-tool-'))
    initGitRepo(dir)
  })

  afterEach(() => {
    _resetWorktreeManagersForTest()
    try { rmSync(dir, { recursive: true, force: true }) } catch { /* best-effort */ }
  })

  it('creates a worktree via tool', async () => {
    const tool = new EnterWorktreeTool()
    const result = await tool.execute({ name: 'via-tool' }, makeCtx(dir))
    expect(result.isError).toBe(false)
    expect(result.content).toContain('via-tool')
    expect(result.content).toContain('Created worktree')
  })

  it('errors without name', async () => {
    const tool = new EnterWorktreeTool()
    const result = await tool.execute({}, makeCtx(dir))
    expect(result.isError).toBe(true)
    expect(result.content).toContain('name is required')
  })

  it('errors on duplicate', async () => {
    const tool = new EnterWorktreeTool()
    await tool.execute({ name: 'dup' }, makeCtx(dir))
    const result = await tool.execute({ name: 'dup' }, makeCtx(dir))
    expect(result.isError).toBe(true)
    expect(result.content).toContain('already exists')
  })

  it('supports custom base branch', async () => {
    // Create a feature branch first
    execSync('git checkout -b feature-base', { cwd: dir, stdio: 'pipe' })
    writeFileSync(join(dir, 'base.txt'), 'base')
    execSync('git add -A && git commit -m "base work"', { cwd: dir, stdio: 'pipe' })
    execSync('git checkout main', { cwd: dir, stdio: 'pipe' })

    const tool = new EnterWorktreeTool()
    const result = await tool.execute({
      name: 'from-feature',
      base_branch: 'feature-base',
    }, makeCtx(dir))
    expect(result.isError).toBe(false)
    expect(result.content).toContain('feature-base')
  })
})

describe('ExitWorktreeTool', () => {
  let dir: string

  beforeEach(() => {
    _resetWorktreeManagersForTest()
    dir = mkdtempSync(join(tmpdir(), 'wt-exit-'))
    initGitRepo(dir)
  })

  afterEach(() => {
    _resetWorktreeManagersForTest()
    try { rmSync(dir, { recursive: true, force: true }) } catch { /* best-effort */ }
  })

  it('returns message when no worktrees', async () => {
    const tool = new ExitWorktreeTool()
    const result = await tool.execute({}, makeCtx(dir))
    expect(result.isError).toBe(false)
    expect(result.content).toContain('No active worktrees')
  })

  it('exits single worktree without name', async () => {
    const enter = new EnterWorktreeTool()
    await enter.execute({ name: 'solo' }, makeCtx(dir))
    const exit = new ExitWorktreeTool()
    const result = await exit.execute({ action: 'discard' }, makeCtx(dir))
    expect(result.isError).toBe(false)
    expect(result.content).toContain('discarded')
  })

  it('asks for name when multiple worktrees', async () => {
    const enter = new EnterWorktreeTool()
    await enter.execute({ name: 'a' }, makeCtx(dir))
    await enter.execute({ name: 'b' }, makeCtx(dir))
    const exit = new ExitWorktreeTool()
    const result = await exit.execute({ action: 'discard' }, makeCtx(dir))
    expect(result.content).toContain('Multiple worktrees')
  })

  it('errors on unknown name', async () => {
    const exit = new ExitWorktreeTool()
    const result = await exit.execute({ name: 'nonexistent' }, makeCtx(dir))
    expect(result.isError).toBe(true)
    expect(result.content).toContain('not found')
  })

  it('merges changes back', async () => {
    const enter = new EnterWorktreeTool()
    const info = await enter.execute({ name: 'merging' }, makeCtx(dir))
    // Extract path from result
    const pathMatch = info.content.match(/Path: (.+)/)
    expect(pathMatch).toBeTruthy()
    const wtPath = pathMatch![1]
    writeFileSync(join(wtPath, 'merged.txt'), 'data')
    execSync('git add -A && git commit -m "work"', { cwd: wtPath, stdio: 'pipe' })

    const exit = new ExitWorktreeTool()
    const result = await exit.execute({ name: 'merging', action: 'merge' }, makeCtx(dir))
    expect(result.isError).toBe(false)
    expect(result.content).toContain('merged')
    expect(existsSync(join(dir, 'merged.txt'))).toBe(true)
  })
})

describe('ListWorktreesTool', () => {
  let dir: string

  beforeEach(() => {
    _resetWorktreeManagersForTest()
    dir = mkdtempSync(join(tmpdir(), 'wt-list-'))
    initGitRepo(dir)
  })

  afterEach(() => {
    _resetWorktreeManagersForTest()
    try { rmSync(dir, { recursive: true, force: true }) } catch { /* best-effort */ }
  })

  it('lists no worktrees', async () => {
    const tool = new ListWorktreesTool()
    const result = await tool.execute({}, makeCtx(dir))
    expect(result.isError).toBe(false)
    expect(result.content).toContain('No active worktrees')
  })

  it('lists active worktrees', async () => {
    const enter = new EnterWorktreeTool()
    await enter.execute({ name: 'alpha' }, makeCtx(dir))
    await enter.execute({ name: 'beta' }, makeCtx(dir))
    const tool = new ListWorktreesTool()
    const result = await tool.execute({}, makeCtx(dir))
    expect(result.content).toContain('alpha')
    expect(result.content).toContain('beta')
    expect(result.content).toContain('Active worktrees (2)')
  })
})

describe('getWorktreeManager (singleton)', () => {
  beforeEach(() => _resetWorktreeManagersForTest())
  afterEach(() => _resetWorktreeManagersForTest())

  it('returns same instance for same cwd', () => {
    const a = getWorktreeManager('/tmp')
    const b = getWorktreeManager('/tmp')
    expect(a).toBe(b)
  })

  it('returns different instances for different cwds', () => {
    const a = getWorktreeManager('/tmp')
    const b = getWorktreeManager('/var')
    expect(a).not.toBe(b)
  })
})
