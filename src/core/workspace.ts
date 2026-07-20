/**
 * Workspace Snapshot Manager
 *
 * Save and restore workspace states for quick task switching.
 * Captures: open files, git state, todos, env vars, custom metadata.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { join, resolve } from 'path'
import { execSync } from 'child_process'

// ── Types ───────────────────────────────────────────────────────────────────

export interface WorkspaceSnapshot {
  /** Unique ID */
  id: string
  /** Human-readable name */
  name: string
  /** When created */
  createdAt: string
  /** Git branch at snapshot time */
  gitBranch: string | null
  /** Git commit hash at snapshot time */
  gitCommit: string | null
  /** Whether there were uncommitted changes */
  gitDirty: boolean
  /** Relevant files (paths the user was working on) */
  files: string[]
  /** Active file */
  activeFile?: string
  /** Cursor position in active file */
  cursor?: { line: number; column: number }
  /** TODO items */
  todos: Array<{ text: string; done: boolean }>
  /** Custom metadata */
  metadata: Record<string, unknown>
  /** Notes for this snapshot */
  notes?: string
}

export interface SnapshotStore {
  snapshots: WorkspaceSnapshot[]
}

// ── Persistence ─────────────────────────────────────────────────────────────

export function getSnapshotPath(cwd: string): string {
  return join(resolve(cwd), '.ovolv999', 'snapshots.json')
}

export function loadSnapshots(cwd: string): SnapshotStore {
  const path = getSnapshotPath(cwd)
  if (!existsSync(path)) return { snapshots: [] }
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as SnapshotStore
  } catch {
    return { snapshots: [] }
  }
}

export function saveSnapshots(cwd: string, store: SnapshotStore): void {
  const dir = join(resolve(cwd), '.ovolv999')
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  writeFileSync(getSnapshotPath(cwd), JSON.stringify(store, null, 2), 'utf8')
}

// ── Git State ───────────────────────────────────────────────────────────────

export interface GitState {
  branch: string | null
  commit: string | null
  dirty: boolean
}

export function getGitState(cwd: string): GitState {
  try {
    const branch = execSync('git rev-parse --abbrev-ref HEAD', {
      cwd, encoding: 'utf8', timeout: 5000, stdio: ['pipe', 'pipe', 'ignore'],
    }).trim()

    const commit = execSync('git rev-parse HEAD', {
      cwd, encoding: 'utf8', timeout: 5000, stdio: ['pipe', 'pipe', 'ignore'],
    }).trim()

    const status = execSync('git status --porcelain', {
      cwd, encoding: 'utf8', timeout: 5000, stdio: ['pipe', 'pipe', 'ignore'],
    }).trim()

    return { branch, commit, dirty: status.length > 0 }
  } catch {
    return { branch: null, commit: null, dirty: false }
  }
}

// ── Snapshot CRUD ───────────────────────────────────────────────────────────

export function createSnapshot(
  cwd: string,
  name: string,
  options: {
    files?: string[]
    activeFile?: string
    cursor?: { line: number; column: number }
    todos?: Array<{ text: string; done: boolean }>
    metadata?: Record<string, unknown>
    notes?: string
  } = {},
): WorkspaceSnapshot {
  const store = loadSnapshots(cwd)
  const gitState = getGitState(cwd)

  const snapshot: WorkspaceSnapshot = {
    id: `snap_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    name,
    createdAt: new Date().toISOString(),
    gitBranch: gitState.branch,
    gitCommit: gitState.commit,
    gitDirty: gitState.dirty,
    files: options.files ?? [],
    activeFile: options.activeFile,
    cursor: options.cursor,
    todos: options.todos ?? [],
    metadata: options.metadata ?? {},
    notes: options.notes,
  }

  // Replace existing snapshot with same name
  const existingIdx = store.snapshots.findIndex(s => s.name === name)
  if (existingIdx >= 0) {
    store.snapshots[existingIdx] = snapshot
  } else {
    store.snapshots.push(snapshot)
  }

  saveSnapshots(cwd, store)
  return snapshot
}

export function removeSnapshot(cwd: string, idOrName: string): boolean {
  const store = loadSnapshots(cwd)
  const before = store.snapshots.length
  store.snapshots = store.snapshots.filter(
    s => s.id !== idOrName && s.name !== idOrName,
  )
  if (store.snapshots.length === before) return false
  saveSnapshots(cwd, store)
  return true
}

export function getSnapshot(cwd: string, idOrName: string): WorkspaceSnapshot | null {
  const store = loadSnapshots(cwd)
  return store.snapshots.find(s => s.id === idOrName || s.name === idOrName) ?? null
}

export function listSnapshots(cwd: string): WorkspaceSnapshot[] {
  return loadSnapshots(cwd).snapshots
}

// ── Snapshot Update ─────────────────────────────────────────────────────────

export function updateSnapshot(
  cwd: string,
  idOrName: string,
  updates: Partial<Omit<WorkspaceSnapshot, 'id' | 'createdAt'>>,
): WorkspaceSnapshot | null {
  const store = loadSnapshots(cwd)
  const snapshot = store.snapshots.find(s => s.id === idOrName || s.name === idOrName)
  if (!snapshot) return null

  Object.assign(snapshot, updates)
  saveSnapshots(cwd, store)
  return snapshot
}

export function addFileToSnapshot(
  cwd: string,
  idOrName: string,
  filePath: string,
): WorkspaceSnapshot | null {
  const store = loadSnapshots(cwd)
  const snapshot = store.snapshots.find(s => s.id === idOrName || s.name === idOrName)
  if (!snapshot) return null

  if (!snapshot.files.includes(filePath)) {
    snapshot.files.push(filePath)
  }
  saveSnapshots(cwd, store)
  return snapshot
}

export function addTodoToSnapshot(
  cwd: string,
  idOrName: string,
  todoText: string,
): WorkspaceSnapshot | null {
  const store = loadSnapshots(cwd)
  const snapshot = store.snapshots.find(s => s.id === idOrName || s.name === idOrName)
  if (!snapshot) return null

  snapshot.todos.push({ text: todoText, done: false })
  saveSnapshots(cwd, store)
  return snapshot
}

export function toggleTodoInSnapshot(
  cwd: string,
  idOrName: string,
  todoIndex: number,
): WorkspaceSnapshot | null {
  const store = loadSnapshots(cwd)
  const snapshot = store.snapshots.find(s => s.id === idOrName || s.name === idOrName)
  if (!snapshot) return null
  if (todoIndex < 0 || todoIndex >= snapshot.todos.length) return null

  snapshot.todos[todoIndex].done = !snapshot.todos[todoIndex].done
  saveSnapshots(cwd, store)
  return snapshot
}

// ── Snapshot Comparison ─────────────────────────────────────────────────────

export interface SnapshotDiff {
  filesAdded: string[]
  filesRemoved: string[]
  todosAdded: string[]
  todosCompleted: string[]
  branchChanged: boolean
  commitChanged: boolean
}

export function diffSnapshots(
  old: WorkspaceSnapshot,
  current: WorkspaceSnapshot,
): SnapshotDiff {
  const oldFiles = new Set(old.files)
  const currentFiles = new Set(current.files)

  const filesAdded = current.files.filter(f => !oldFiles.has(f))
  const filesRemoved = old.files.filter(f => !currentFiles.has(f))

  const oldTodos = new Set(old.todos.map(t => t.text))
  const currentTodoTexts = current.todos.map(t => t.text)

  const todosAdded = currentTodoTexts.filter(t => !oldTodos.has(t))
  const todosCompleted = current.todos
    .filter(t => t.done && old.todos.find(ot => ot.text === t.text && !ot.done))
    .map(t => t.text)

  return {
    filesAdded,
    filesRemoved,
    todosAdded,
    todosCompleted,
    branchChanged: old.gitBranch !== current.gitBranch,
    commitChanged: old.gitCommit !== current.gitCommit,
  }
}

// ── Formatting ──────────────────────────────────────────────────────────────

export function formatSnapshot(snapshot: WorkspaceSnapshot): string {
  const lines: string[] = [
    `Snapshot: ${snapshot.name}`,
    `  Created: ${snapshot.createdAt}`,
  ]

  if (snapshot.gitBranch) {
    lines.push(`  Git: ${snapshot.gitBranch}@${snapshot.gitCommit?.slice(0, 7) ?? '?'}`)
    if (snapshot.gitDirty) lines.push(`  ⚠ Uncommitted changes at snapshot time`)
  }

  if (snapshot.files.length > 0) {
    lines.push(`  Files (${snapshot.files.length}):`)
    for (const f of snapshot.files) {
      const active = f === snapshot.activeFile ? ' ← active' : ''
      lines.push(`    ${f}${active}`)
    }
  }

  if (snapshot.todos.length > 0) {
    const done = snapshot.todos.filter(t => t.done).length
    lines.push(`  TODOs: ${done}/${snapshot.todos.length}`)
    for (const t of snapshot.todos) {
      lines.push(`    ${t.done ? '✓' : '○'} ${t.text}`)
    }
  }

  if (snapshot.notes) {
    lines.push(`  Notes: ${snapshot.notes}`)
  }

  return lines.join('\n')
}

export function formatSnapshotList(snapshots: WorkspaceSnapshot[]): string {
  if (snapshots.length === 0) return 'No snapshots saved.'

  const lines: string[] = [`Snapshots (${snapshots.length}):`]
  for (const s of snapshots) {
    const branch = s.gitBranch ? ` [${s.gitBranch}]` : ''
    const fileCount = s.files.length > 0 ? ` ${s.files.length} files` : ''
    const todoCount = s.todos.length > 0
      ? ` ${s.todos.filter(t => t.done).length}/${s.todos.length} todos`
      : ''
    const dirty = s.gitDirty ? ' ⚠' : ''

    lines.push(`  ${s.name}${branch}${fileCount}${todoCount}${dirty}`)
    lines.push(`    id: ${s.id} | ${s.createdAt.slice(0, 10)}`)
  }

  return lines.join('\n')
}

export function formatSnapshotDiff(diff: SnapshotDiff, oldName: string, newName: string): string {
  const lines: string[] = [`Diff: ${oldName} → ${newName}`]

  if (diff.branchChanged) lines.push('  ⚠ Git branch changed')
  if (diff.commitChanged) lines.push('  → New commit')

  if (diff.filesAdded.length > 0) {
    lines.push(`  Files added (${diff.filesAdded.length}):`)
    diff.filesAdded.forEach(f => lines.push(`    + ${f}`))
  }

  if (diff.filesRemoved.length > 0) {
    lines.push(`  Files removed (${diff.filesRemoved.length}):`)
    diff.filesRemoved.forEach(f => lines.push(`    - ${f}`))
  }

  if (diff.todosAdded.length > 0) {
    lines.push(`  TODOs added:`)
    diff.todosAdded.forEach(t => lines.push(`    + ${t}`))
  }

  if (diff.todosCompleted.length > 0) {
    lines.push(`  TODOs completed:`)
    diff.todosCompleted.forEach(t => lines.push(`    ✓ ${t}`))
  }

  if (lines.length === 1) lines.push('  No changes')

  return lines.join('\n')
}
