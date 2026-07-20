import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import {
  createSnapshot, removeSnapshot, getSnapshot, listSnapshots,
  updateSnapshot, addFileToSnapshot, addTodoToSnapshot, toggleTodoInSnapshot,
  diffSnapshots,
  formatSnapshot, formatSnapshotList, formatSnapshotDiff,
  getGitState,
  type WorkspaceSnapshot,
} from '../src/core/workspace.js'
import { mkdtempSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

function makeTempDir(): string {
  return mkdtempSync(join(tmpdir(), 'ovolv999-snap-'))
}

describe('Workspace Snapshot Manager', () => {
  let cwd: string

  beforeEach(() => { cwd = makeTempDir() })
  afterEach(() => { rmSync(cwd, { recursive: true, force: true }) })

  describe('getGitState', () => {
    it('returns nulls for non-git directory', () => {
      const state = getGitState(cwd)
      expect(state.branch).toBeNull()
      expect(state.commit).toBeNull()
      expect(state.dirty).toBe(false)
    })
  })

  describe('createSnapshot', () => {
    it('creates a snapshot with auto-generated id', () => {
      const snap = createSnapshot(cwd, 'feature-work')
      expect(snap.id).toMatch(/^snap_/)
      expect(snap.name).toBe('feature-work')
      expect(snap.files).toEqual([])
      expect(snap.todos).toEqual([])
    })

    it('captures options', () => {
      const snap = createSnapshot(cwd, 'task', {
        files: ['src/a.ts', 'src/b.ts'],
        activeFile: 'src/a.ts',
        cursor: { line: 10, column: 5 },
        todos: [{ text: 'write tests', done: false }],
        metadata: { custom: 'value' },
        notes: 'working on auth',
      })
      expect(snap.files).toHaveLength(2)
      expect(snap.activeFile).toBe('src/a.ts')
      expect(snap.cursor).toEqual({ line: 10, column: 5 })
      expect(snap.todos).toHaveLength(1)
      expect(snap.metadata.custom).toBe('value')
      expect(snap.notes).toBe('working on auth')
    })

    it('replaces existing snapshot with same name', () => {
      createSnapshot(cwd, 'task', { files: ['a.ts'] })
      createSnapshot(cwd, 'task', { files: ['b.ts'] })
      const snaps = listSnapshots(cwd)
      expect(snaps).toHaveLength(1)
      expect(snaps[0].files).toEqual(['b.ts'])
    })
  })

  describe('removeSnapshot', () => {
    it('removes by id', () => {
      const snap = createSnapshot(cwd, 'task')
      expect(removeSnapshot(cwd, snap.id)).toBe(true)
      expect(listSnapshots(cwd)).toHaveLength(0)
    })

    it('removes by name', () => {
      createSnapshot(cwd, 'task')
      expect(removeSnapshot(cwd, 'task')).toBe(true)
      expect(listSnapshots(cwd)).toHaveLength(0)
    })

    it('returns false for missing snapshot', () => {
      expect(removeSnapshot(cwd, 'nope')).toBe(false)
    })
  })

  describe('getSnapshot', () => {
    it('finds by id', () => {
      const snap = createSnapshot(cwd, 'task')
      const found = getSnapshot(cwd, snap.id)
      expect(found?.name).toBe('task')
    })

    it('finds by name', () => {
      createSnapshot(cwd, 'my-task')
      const found = getSnapshot(cwd, 'my-task')
      expect(found).not.toBeNull()
    })

    it('returns null for missing', () => {
      expect(getSnapshot(cwd, 'nope')).toBeNull()
    })
  })

  describe('listSnapshots', () => {
    it('returns all snapshots', () => {
      createSnapshot(cwd, 'a')
      createSnapshot(cwd, 'b')
      createSnapshot(cwd, 'c')
      expect(listSnapshots(cwd)).toHaveLength(3)
    })

    it('returns empty when none exist', () => {
      expect(listSnapshots(cwd)).toEqual([])
    })
  })

  describe('updateSnapshot', () => {
    it('updates fields', () => {
      const snap = createSnapshot(cwd, 'task', { notes: 'old' })
      const updated = updateSnapshot(cwd, snap.id, { notes: 'new' })
      expect(updated?.notes).toBe('new')
    })

    it('returns null for missing', () => {
      expect(updateSnapshot(cwd, 'nope', { notes: 'x' })).toBeNull()
    })
  })

  describe('addFileToSnapshot', () => {
    it('adds file without duplicates', () => {
      const snap = createSnapshot(cwd, 'task')
      addFileToSnapshot(cwd, snap.id, 'src/a.ts')
      addFileToSnapshot(cwd, snap.id, 'src/a.ts') // dup
      addFileToSnapshot(cwd, snap.id, 'src/b.ts')
      const found = getSnapshot(cwd, snap.id)!
      expect(found.files).toHaveLength(2)
    })
  })

  describe('addTodoToSnapshot', () => {
    it('adds todo as not done', () => {
      const snap = createSnapshot(cwd, 'task')
      addTodoToSnapshot(cwd, snap.id, 'write tests')
      const found = getSnapshot(cwd, snap.id)!
      expect(found.todos).toHaveLength(1)
      expect(found.todos[0].done).toBe(false)
    })
  })

  describe('toggleTodoInSnapshot', () => {
    it('toggles todo completion', () => {
      const snap = createSnapshot(cwd, 'task')
      addTodoToSnapshot(cwd, snap.id, 'write tests')
      toggleTodoInSnapshot(cwd, snap.id, 0)
      const found = getSnapshot(cwd, snap.id)!
      expect(found.todos[0].done).toBe(true)
      toggleTodoInSnapshot(cwd, snap.id, 0)
      expect(getSnapshot(cwd, snap.id)!.todos[0].done).toBe(false)
    })

    it('returns null for invalid index', () => {
      const snap = createSnapshot(cwd, 'task')
      expect(toggleTodoInSnapshot(cwd, snap.id, 99)).toBeNull()
    })
  })

  describe('diffSnapshots', () => {
    it('detects file changes', () => {
      const old: WorkspaceSnapshot = {
        id: 'old', name: 'old', createdAt: new Date().toISOString(),
        gitBranch: null, gitCommit: null, gitDirty: false,
        files: ['a.ts', 'b.ts'], todos: [], metadata: {},
      }
      const current: WorkspaceSnapshot = {
        id: 'cur', name: 'cur', createdAt: new Date().toISOString(),
        gitBranch: null, gitCommit: null, gitDirty: false,
        files: ['b.ts', 'c.ts'], todos: [], metadata: {},
      }
      const diff = diffSnapshots(old, current)
      expect(diff.filesAdded).toEqual(['c.ts'])
      expect(diff.filesRemoved).toEqual(['a.ts'])
    })

    it('detects todo additions', () => {
      const old: WorkspaceSnapshot = {
        id: 'old', name: 'old', createdAt: new Date().toISOString(),
        gitBranch: null, gitCommit: null, gitDirty: false,
        files: [], todos: [{ text: 'task1', done: false }], metadata: {},
      }
      const current: WorkspaceSnapshot = {
        id: 'cur', name: 'cur', createdAt: new Date().toISOString(),
        gitBranch: null, gitCommit: null, gitDirty: false,
        files: [], todos: [
          { text: 'task1', done: true },
          { text: 'task2', done: false },
        ], metadata: {},
      }
      const diff = diffSnapshots(old, current)
      expect(diff.todosAdded).toEqual(['task2'])
      expect(diff.todosCompleted).toEqual(['task1'])
    })

    it('detects branch and commit changes', () => {
      const old: WorkspaceSnapshot = {
        id: 'old', name: 'old', createdAt: new Date().toISOString(),
        gitBranch: 'main', gitCommit: 'abc123', gitDirty: false,
        files: [], todos: [], metadata: {},
      }
      const current: WorkspaceSnapshot = {
        id: 'cur', name: 'cur', createdAt: new Date().toISOString(),
        gitBranch: 'feature', gitCommit: 'def456', gitDirty: false,
        files: [], todos: [], metadata: {},
      }
      const diff = diffSnapshots(old, current)
      expect(diff.branchChanged).toBe(true)
      expect(diff.commitChanged).toBe(true)
    })

    it('shows no changes when identical', () => {
      const snap: WorkspaceSnapshot = {
        id: 'x', name: 'x', createdAt: new Date().toISOString(),
        gitBranch: 'main', gitCommit: 'abc', gitDirty: false,
        files: ['a.ts'], todos: [], metadata: {},
      }
      const diff = diffSnapshots(snap, { ...snap })
      expect(diff.filesAdded).toHaveLength(0)
      expect(diff.filesRemoved).toHaveLength(0)
      expect(diff.branchChanged).toBe(false)
    })
  })

  describe('formatSnapshot', () => {
    it('includes name and date', () => {
      const snap = createSnapshot(cwd, 'my-task')
      const out = formatSnapshot(snap)
      expect(out).toContain('my-task')
      expect(out).toContain('Created:')
    })

    it('shows files', () => {
      const snap = createSnapshot(cwd, 'task', {
        files: ['a.ts', 'b.ts'],
        activeFile: 'a.ts',
      })
      const out = formatSnapshot(snap)
      expect(out).toContain('a.ts')
      expect(out).toContain('← active')
    })

    it('shows todos', () => {
      const snap = createSnapshot(cwd, 'task', {
        todos: [
          { text: 'done task', done: true },
          { text: 'pending task', done: false },
        ],
      })
      const out = formatSnapshot(snap)
      expect(out).toContain('✓ done task')
      expect(out).toContain('○ pending task')
      expect(out).toContain('1/2')
    })

    it('shows notes when present', () => {
      const snap = createSnapshot(cwd, 'task', { notes: 'remember to test' })
      const out = formatSnapshot(snap)
      expect(out).toContain('remember to test')
    })
  })

  describe('formatSnapshotList', () => {
    it('shows empty message', () => {
      expect(formatSnapshotList([])).toBe('No snapshots saved.')
    })

    it('lists snapshots with details', () => {
      createSnapshot(cwd, 'task1', { files: ['a.ts'] })
      createSnapshot(cwd, 'task2', {
        todos: [{ text: 'x', done: true }, { text: 'y', done: false }],
      })
      const out = formatSnapshotList(listSnapshots(cwd))
      expect(out).toContain('task1')
      expect(out).toContain('task2')
      expect(out).toContain('1 files')
      expect(out).toContain('1/2 todos')
    })
  })

  describe('formatSnapshotDiff', () => {
    it('shows added and removed files', () => {
      const diff = {
        filesAdded: ['new.ts'],
        filesRemoved: ['old.ts'],
        todosAdded: [],
        todosCompleted: [],
        branchChanged: false,
        commitChanged: false,
      }
      const out = formatSnapshotDiff(diff, 'v1', 'v2')
      expect(out).toContain('+ new.ts')
      expect(out).toContain('- old.ts')
    })

    it('shows no changes when empty', () => {
      const diff = {
        filesAdded: [],
        filesRemoved: [],
        todosAdded: [],
        todosCompleted: [],
        branchChanged: false,
        commitChanged: false,
      }
      const out = formatSnapshotDiff(diff, 'v1', 'v2')
      expect(out).toContain('No changes')
    })
  })
})
