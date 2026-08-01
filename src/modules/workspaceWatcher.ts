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

const SKILL_DIRS = [
  join(homedir(), '.ovogo', 'skills'),
  join(homedir(), '.ovolv999', 'knowledge'),
]

function collectWatchRoots(cwd: string): string[] {
  const roots: string[] = [cwd]
  for (const dir of SKILL_DIRS) {
    if (existsSync(dir)) roots.push(dir)
  }
  return roots
}

export class WorkspaceWatcherModule implements AgentModule {
  readonly name = 'workspace_watcher'
  readonly criticality = 'best_effort' as const

  private watcher: WorkspaceWatcher | null = null
  private lastChanges: WorkspaceChange[] = []
  private lastChangeAt = 0
  private injectedForRun = false

  async boot(ctx: ModuleBootContext): Promise<ModuleBootResult> {
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
    if (this.lastChanges.length === 0) return
    if (ctx.eventLog) {
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
}
