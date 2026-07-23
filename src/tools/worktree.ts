/**
 * Worktree Tools — Git Worktree isolation for parallel agent work.
 *
 * Creates isolated working copies of the repository so multiple agents
 * can work simultaneously without stepping on each other's changes.
 *
 * Workflow:
 *   1. EnterWorktree creates a new branch + worktree at .ovolv999/worktrees/<name>
 *   2. Agent works in the isolated copy (all file operations are scoped)
 *   3. ExitWorktree merges the branch back (or discards)
 *
 * Inspired by Claude Code's worktree system (src/utils/worktree.ts, 49KB).
 * Our implementation is simpler — we use git's native worktree feature
 * and track active worktrees in a JSON metadata file.
 */

import { execSync, execFileSync } from 'child_process'
import { existsSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'fs'
import { join, resolve } from 'path'
import type { Tool, ToolDefinition, ToolResult, ToolContext } from '../core/types.js'
import type { ResourceClaim } from '../core/executionRun.js'

// Git operations are exclusive — worktree create/exit must serialise with
// each other and with any `git ...` Bash command (which claims git:HEAD
// exclusive). Forces safe ordering of repo-mutating operations.
const GIT_EXCLUSIVE: ResourceClaim[] = [{ type: 'git', key: 'HEAD', access: 'exclusive' }]

// ── Types ───────────────────────────────────────────────────────────────────

export interface WorktreeInfo {
  /** Unique name for this worktree */
  name: string
  /** Absolute path to the worktree directory */
  path: string
  /** Branch name in the worktree */
  branch: string
  /** Base branch this worktree was created from */
  baseBranch: string
  /** Creation timestamp */
  createdAt: string
}

// ── Worktree Manager ────────────────────────────────────────────────────────

const WORKTREE_DIR = '.ovolv999/worktrees'
const WORKTREE_META = '.ovolv999/worktrees.json'

export class WorktreeManager {
  private active: Map<string, WorktreeInfo> = new Map()
  private cwd: string

  constructor(cwd: string) {
    this.cwd = resolve(cwd)
    this.loadMeta()
  }

  private metaPath(): string {
    return join(this.cwd, WORKTREE_META)
  }

  private worktreeBase(): string {
    return join(this.cwd, WORKTREE_DIR)
  }

  private loadMeta(): void {
    try {
      const raw = readFileSync(this.metaPath(), 'utf8')
      const list = JSON.parse(raw) as WorktreeInfo[]
      for (const wt of list) {
        this.active.set(wt.name, wt)
      }
    } catch {
      // No metadata file — start fresh
    }
  }

  private saveMeta(): void {
    try {
      mkdirSync(join(this.cwd, '.ovolv999'), { recursive: true })
      const list = [...this.active.values()]
      writeFileSync(this.metaPath(), JSON.stringify(list, null, 2), 'utf8')
    } catch {
      // Best-effort
    }
  }

  /** Check if we're inside a git repository */
  isGitRepo(): boolean {
    try {
      execSync('git rev-parse --git-dir', { cwd: this.cwd, stdio: 'pipe' })
      return true
    } catch {
      return false
    }
  }

  /** Get the current branch name */
  getCurrentBranch(): string {
    try {
      return execSync('git rev-parse --abbrev-ref HEAD', {
        cwd: this.cwd,
        encoding: 'utf8',
        stdio: 'pipe',
      }).trim()
    } catch {
      return 'main'
    }
  }

  /** Create a new worktree with an isolated branch */
  createWorktree(name: string, baseBranch?: string): WorktreeInfo {
    if (!this.isGitRepo()) {
      throw new Error('Not a git repository — worktrees require git')
    }

    if (this.active.has(name)) {
      throw new Error(`Worktree "${name}" already exists`)
    }

    // Sanitize name for branch/directory naming
    const safeName = name.replace(/[^a-zA-Z0-9_-]/g, '-')
    const branch = `wt/${safeName}`
    const base = baseBranch ?? this.getCurrentBranch()
    const wtPath = join(this.worktreeBase(), safeName)

    // Ensure base directory exists
    mkdirSync(this.worktreeBase(), { recursive: true })

    if (existsSync(wtPath)) {
      throw new Error(`Worktree path already exists: ${wtPath}. Use a different name or remove it first.`)
    }

    // Create the worktree with a new branch off the base
    try {
      execFileSync('git', [
        'worktree', 'add',
        '-b', branch,
        wtPath,
        base,
      ], { cwd: this.cwd, stdio: 'pipe' })
    } catch (err) {
      const msg = (err as Error).message
      // Clean up partial directory if git failed after creating it
      try { rmSync(wtPath, { recursive: true, force: true }) } catch { /* best-effort */ }
      throw new Error(`Failed to create worktree: ${msg}`)
    }

    const info: WorktreeInfo = {
      name,
      path: wtPath,
      branch,
      baseBranch: base,
      createdAt: new Date().toISOString(),
    }

    this.active.set(name, info)
    this.saveMeta()
    return info
  }

  /** Get info about an existing worktree */
  getWorktree(name: string): WorktreeInfo | undefined {
    return this.active.get(name)
  }

  /** List all active worktrees */
  listWorktrees(): WorktreeInfo[] {
    return [...this.active.values()]
  }

  /** Get diff stats between worktree branch and its base */
  getDiffStats(name: string): string {
    const info = this.active.get(name)
    if (!info) return ''
    try {
      return execSync(
        `git diff --stat ${info.baseBranch}..${info.branch}`,
        { cwd: this.cwd, encoding: 'utf8', stdio: 'pipe' },
      ).trim()
    } catch {
      return ''
    }
  }

  /** Remove a worktree and optionally merge its branch */
  removeWorktree(name: string, opts: { merge?: boolean; deleteBranch?: boolean } = {}): void {
    const info = this.active.get(name)
    if (!info) {
      throw new Error(`Worktree "${name}" does not exist`)
    }

    // Optionally merge the branch back to base
    if (opts.merge) {
      try {
        execFileSync('git', ['merge', info.branch, '--no-edit'], {
          cwd: this.cwd,
          stdio: 'pipe',
        })
      } catch (err) {
        throw new Error(`Merge failed for branch ${info.branch}: ${(err as Error).message}`)
      }
    }

    // Remove the worktree directory
    try {
      execFileSync('git', ['worktree', 'remove', info.path, '--force'], {
        cwd: this.cwd,
        stdio: 'pipe',
      })
    } catch {
      // Fallback: manual cleanup
      try { rmSync(info.path, { recursive: true, force: true }) } catch { /* best-effort */ }
    }

    // Optionally delete the branch
    if (opts.deleteBranch) {
      try {
        execFileSync('git', ['branch', '-D', info.branch], {
          cwd: this.cwd,
          stdio: 'pipe',
        })
      } catch { /* best-effort */ }
    }

    this.active.delete(name)
    this.saveMeta()
  }

  /** Prune stale worktrees (git worktree prune) */
  prune(): void {
    try {
      execFileSync('git', ['worktree', 'prune'], { cwd: this.cwd, stdio: 'pipe' })
    } catch { /* best-effort */ }
  }

  /** Check if a path is inside a worktree */
  isWorktreePath(path: string): boolean {
    const abs = resolve(path)
    for (const wt of this.active.values()) {
      if (abs.startsWith(wt.path)) return true
    }
    return false
  }
}

// ── Singleton per CWD ───────────────────────────────────────────────────────

const managers = new Map<string, WorktreeManager>()

export function getWorktreeManager(cwd: string): WorktreeManager {
  const abs = resolve(cwd)
  let mgr = managers.get(abs)
  if (!mgr) {
    mgr = new WorktreeManager(abs)
    managers.set(abs, mgr)
  }
  return mgr
}

/** Reset singleton — for tests only */
export function _resetWorktreeManagersForTest(): void {
  managers.clear()
}

// ── Tool Classes ────────────────────────────────────────────────────────────

export class EnterWorktreeTool implements Tool {
  name = 'EnterWorktree'
  metadata = { readOnly: false, longRunning: false, concurrencySafe: false, claims: () => GIT_EXCLUSIVE }

  definition: ToolDefinition = {
    type: 'function',
    function: {
      name: 'EnterWorktree',
      description: `Create an isolated git worktree for parallel agent work. The worktree gets its own branch and working directory at .ovolv999/worktrees/<name>, so multiple agents can work simultaneously without conflicts.

## When to Use
- Dispatching parallel work to sub-agents that modify files
- Experimenting with changes you might discard
- Isolating risky refactors from the main working tree

## When NOT to Use
- For read-only investigation (just use Read/Grep/Glob directly)
- The repo is not a git repository

After creating a worktree, file paths returned to the agent will reference the isolated directory. Use ExitWorktree to merge or discard.`,
      parameters: {
        type: 'object',
        properties: {
          name: {
            type: 'string',
            description: 'Unique name for this worktree (e.g. "fix-auth", "refactor-api")',
          },
          base_branch: {
            type: 'string',
            description: 'Branch to base the worktree on (default: current branch)',
          },
        },
        required: ['name'],
      },
    },
  }

  async execute(input: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const name = String(input.name ?? '')
    const baseBranch = input.base_branch ? String(input.base_branch) : undefined

    if (!name) {
      return { content: 'Worktree name is required', isError: true }
    }

    try {
      const mgr = getWorktreeManager(ctx.cwd)
      const info = mgr.createWorktree(name, baseBranch)
      return {
        content: `Created worktree "${name}"\nPath: ${info.path}\nBranch: ${info.branch} (based on ${info.baseBranch})`,
        isError: false,
      }
    } catch (err) {
      return { content: `Failed to create worktree: ${(err as Error).message}`, isError: true }
    }
  }
}

export class ExitWorktreeTool implements Tool {
  name = 'ExitWorktree'
  metadata = { readOnly: false, longRunning: false, concurrencySafe: false, claims: () => GIT_EXCLUSIVE }

  definition: ToolDefinition = {
    type: 'function',
    function: {
      name: 'ExitWorktree',
      description: `Exit and optionally merge a worktree back to its base branch.

## Actions
- **merge** (default): Apply changes to the base branch via git merge, then remove the worktree
- **discard**: Remove the worktree and throw away all changes

If only one worktree is active, you can omit \`name\`.`,
      parameters: {
        type: 'object',
        properties: {
          name: {
            type: 'string',
            description: 'Name of the worktree to exit',
          },
          action: {
            type: 'string',
            enum: ['merge', 'discard'],
            description: 'merge = apply changes to base branch, discard = throw away (default: merge)',
          },
          delete_branch: {
            type: 'boolean',
            description: 'Delete the branch after exit (default: true)',
          },
        },
      },
    },
  }

  async execute(input: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const name = input.name ? String(input.name) : ''
    const action = (input.action ? String(input.action) : 'merge') as 'merge' | 'discard'
    const deleteBranch = input.delete_branch !== false

    try {
      const mgr = getWorktreeManager(ctx.cwd)
      const list = mgr.listWorktrees()

      // If a name was specified, validate it exists (regardless of list size)
      if (name) {
        const info = mgr.getWorktree(name)
        if (!info) {
          return { content: `Worktree "${name}" not found.`, isError: true }
        }
        const diffStats = mgr.getDiffStats(name)
        const merge = action === 'merge'
        mgr.removeWorktree(name, { merge, deleteBranch })
        const verb = merge ? 'merged into base' : 'discarded'
        return {
          content: `Worktree "${name}" ${verb}.\n${diffStats ? `Changes:\n${diffStats}` : '(no changes)'}`,
          isError: false,
        }
      }

      // No name specified — auto-resolve
      if (list.length === 0) {
        return { content: 'No active worktrees to exit.', isError: false }
      }
      if (list.length === 1) {
        const only = list[0]
        const diffStats = mgr.getDiffStats(only.name)
        const merge = action === 'merge'
        mgr.removeWorktree(only.name, { merge, deleteBranch })
        const verb = merge ? 'merged into base' : 'discarded'
        return {
          content: `Worktree "${only.name}" ${verb}.\n${diffStats ? `Changes:\n${diffStats}` : '(no changes)'}`,
          isError: false,
        }
      }
      return {
        content: `Multiple worktrees active. Specify name:\n${list.map(w => `  ${w.name} (${w.branch})`).join('\n')}`,
        isError: false,
      }
    } catch (err) {
      return { content: `Failed to exit worktree: ${(err as Error).message}`, isError: true }
    }
  }
}

export class ListWorktreesTool implements Tool {
  name = 'ListWorktrees'
  metadata = { readOnly: true, longRunning: false, concurrencySafe: true }

  definition: ToolDefinition = {
    type: 'function',
    function: {
      name: 'ListWorktrees',
      description: 'List all active git worktrees created by EnterWorktree.',
      parameters: { type: 'object', properties: {} },
    },
  }

  async execute(_input: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const mgr = getWorktreeManager(ctx.cwd)
    const list = mgr.listWorktrees()
    if (list.length === 0) {
      return { content: 'No active worktrees.', isError: false }
    }
    const lines = list.map(w =>
      `  ${w.name.padEnd(20)} ${w.branch.padEnd(30)} ${w.path}`,
    )
    return {
      content: `Active worktrees (${list.length}):\n${lines.join('\n')}`,
      isError: false,
    }
  }
}
