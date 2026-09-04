/**
 * WorkspaceWatcherModule — turns the R8 chokidar-based WorkspaceWatcher
 * into a real runtime capability (P2.2 follow-up).
 *
 * Before: `src/core/workspaceWatcher.ts` was an isolated module with no
 * runtime caller. chokidar was wired into the watcher but never invoked.
 *
 * After: this module starts the watcher on boot, watches the cwd and
 * `~/.ovogo/` for changes, and:
 *   1. Invalidates the toolSearch in-memory cache so any new
 *      `search_extra_tools` query reflects the latest tool definitions.
 *   2. Records each change to the EventLog so `/trace` and the
 *      post-mortem know the workspace was mutated mid-session.
 *   3. Optionally injects a system-reminder on the next iteration
 *      (`workspace_changed`) so the LLM knows what is on disk.
 *
 * The module is best-effort — if chokidar fails to start (e.g. EPERM
 * on a directory), the engine still boots and proceeds without it.
 */

import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

import type { AgentModule, ModuleBootContext, ModuleBootResult, ModuleIterationContext, ModuleIterationResult, ModuleRunContext } from '../core/module.js'
import { WorkspaceWatcher, type WorkspaceChange } from '../core/workspaceWatcher.js'
import { clearToolIndexCache } from '../core/toolSearch.js'
import type { RepoStatsService } from '../core/repoStats.js'

const SKILL_DIRS = [
  join(homedir(), '.ovogo', 'skills'),
  join(homedir(), '.ovolv999', 'knowledge'),
]

/** Additional watch roots beyond cwd that need cache-invalidation coverage. */
function collectWatchRoots(cwd: string): string[] {
  const roots: string[] = [cwd]
  // Global skill/knowledge dirs (conditional on existence).
  for (const dir of SKILL_DIRS) {
    if (existsSync(dir)) roots.push(dir)
  }
  // Project-level skill dir — saveSkill() writes here so the
  // watcher must pick up new/removed skill files.
  const projectSkillsDir = join(cwd, '.ovogo', 'skills')
  if (existsSync(projectSkillsDir)) roots.push(projectSkillsDir)
  return roots
}

export class WorkspaceWatcherModule implements AgentModule {
  readonly name = 'workspace_watcher'
  readonly criticality = 'best_effort' as const

  private watcher: WorkspaceWatcher | null = null
  private lastChanges: WorkspaceChange[] = []
  private lastChangeAt = 0
  private injectedForRun = false
  /** v0.5.3 (P0.2): shared RepoStatsService instance. Injected
   *  during boot() via ModuleBootContext.sharedServices. The Engine
   *  is the sole constructor of the shared instance. This field is
   *  set at boot time — callers must null-guard or treat as
   *  best-effort (cache invalidation is non-critical). */
  private repoStats: RepoStatsService | null = null

  constructor(_repoStats?: RepoStatsService) {
    // v0.6.1: the Engine does not pass deps through module constructors
    // (module registration uses empty-arg factories). The shared
    // RepoStatsService is injected during boot() via sharedServices.
    // We accept the constructor arg for backward compatibility with
    // test/legacy callers but do NOT create a degraded local instance
    // — that breaks the shared-cache invariant.
    if (_repoStats) {
      this.repoStats = _repoStats
    }
  }

  async boot(ctx: ModuleBootContext): Promise<ModuleBootResult> {
    // v0.6.1: Inject the shared RepoStatsService. If the Engine
    // assembled correctly, this is the same instance the Router and
    // Coordinator use — cache invalidation reaches all consumers.
    const shared = ctx.sharedServices?.repoStats
    if (shared) {
      this.repoStats = shared
    } else if (!this.repoStats) {
      // Genuinely missing: log once at boot so the operator knows
      // file-change-triggered repo re-walks won't propagate.
      process.stderr.write(
        '[workspaceWatcher] WARNING: no RepoStatsService available; ' +
          'file change cache invalidation will not reach the Router.\n',
      )
    }

    const roots = collectWatchRoots(ctx.cwd)
    this.watcher = new WorkspaceWatcher({
      rootDir: roots[0],
      pollIntervalMs: 50,
      debounceMs: 30,
      onChange: (change) => this.recordChange(change),
    })
    this.watcher.start()

    // Also watch external roots (user skills, knowledge base). Each gets
    // its own chokidar instance since chokidar.watch() takes one root.
    for (const root of roots.slice(1)) {
      try {
        const w = new WorkspaceWatcher({
          rootDir: root,
          pollIntervalMs: 50,
          debounceMs: 30,
          onChange: (change) => this.recordChange(change),
        })
        w.start()
        this.attachedWatchers.push(w)
      } catch { /* best-effort */ }
    }

    return {}
  }

  private attachedWatchers: WorkspaceWatcher[] = []

  private recordChange(change: WorkspaceChange): void {
    this.lastChanges.push(change)
    if (this.lastChanges.length > 50) {
      this.lastChanges.splice(0, this.lastChanges.length - 50)
    }
    this.lastChangeAt = Date.now()
    // real cache invalidation: next search_extra_tools sees fresh tool defs
    clearToolIndexCache()
    // v0.5.2 (Stage 2.2): invalidate the cached repoFileCount so the
    // next Router signal collection re-walks the cwd. We use a
    // per-process singleton (RepoStatsService is constructed once
    // per Engine); the watcher can fire from many roots but the
    // service only walks the cwd on the next snapshot() call.
    this.repoStats?.invalidate()
  }

  /**
   * Called at the top of each engine loop iteration. If the workspace
   * changed since the last iteration, inject a system reminder so the
   * LLM knows the file system is different from what it last saw.
   */
  onIteration(_ctx: ModuleIterationContext): void | Promise<ModuleIterationResult | void> {
    if (this.injectedForRun) return
    if (this.lastChangeAt === 0) return
    if (this.lastChanges.length === 0) return

    const sample = this.lastChanges.slice(-5).map((c) => `${c.kind}: ${c.path}`).join(', ')
    this.injectedForRun = true
    return Promise.resolve({
      injectMessage: `[system-reminder] workspace files changed since last iteration: ${sample}. ` +
        `On-disk contents may differ from earlier context — re-read before quoting.`,
    })
  }

  onComplete(ctx: ModuleRunContext): void {
    if (ctx.eventLog && this.lastChanges.length > 0) {
      ctx.eventLog.append(
        'workspace_change',
        'workspace_watcher',
        {
          changes: this.lastChanges.slice(),
          reason: ctx.turnResult?.reason,
          at: this.lastChangeAt,
          watchedRoots: this.watcher ? 1 + this.attachedWatchers.length : 0,
        },
      )
    }
    // Per-run lifecycle: without this reset the reminder fired at most
    // once per PROCESS (injectedForRun was never cleared), and the sample
    // kept mixing in changes from earlier runs.
    this.lastChanges = []
    this.lastChangeAt = 0
    this.injectedForRun = false
  }

  async dispose(): Promise<void> {
    if (this.watcher) {
      this.watcher.stop()
      this.watcher = null
    }
    for (const w of this.attachedWatchers) {
      w.stop()
    }
    this.attachedWatchers = []
  }

  /** v0.5.3 (P0.2): test seams. */
  getRepoStats(): RepoStatsService | null {
    return this.repoStats
  }

  simulateChangeForTest(change: WorkspaceChange): void {
    this.recordChange(change)
  }
}
