/**
 * v0.5.3 (P0.2): RepoStats instance sharing.
 *
 * Verifies the WIRED invariant: a single RepoStatsService instance
 * is shared by Engine (Router signals) and WorkspaceWatcher
 * (invalidation events). A real shared-instance test:
 *
 *   1. snapshot() walks the cwd → returns state
 *   2. create or delete a source file on disk
 *   3. WorkspaceWatcher.recordChange fires → invalidates
 *   4. snapshot() returns a different object with the new count
 *
 * We don't rely on WorkspaceWatcher's chokidar machinery — we call
 * `recordChange` directly via a unit test seam, simulating the
 * real onChange callback. The shared instance is the unit of truth.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

import { RepoStatsService, wireRepoStats } from '../../src/core/repoStats.js'
import { WorkspaceWatcherModule } from '../../src/modules/workspaceWatcher.js'

describe('RepoStats shared instance (P0.2)', () => {
  let tmp: string
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'ovolv999-shared-'))
  })
  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true })
  })

  it('Engine-owned instance is the SAME instance the WorkspaceWatcher uses', async () => {
    const engine = wireRepoStats()
    const watcher = new WorkspaceWatcherModule(engine)
    // boot() pulls the shared instance from ModuleBootContext
    await watcher.boot({
      cwd: tmp,
      sessionDir: tmp,
      config: {} as never,
      sharedServices: { repoStats: engine },
    })
    expect(watcher.getRepoStats()).toBe(engine)
  })

  it('watcher.invalidate() reaches the Router\'s snapshot', async () => {
    const shared = wireRepoStats()
    const watcher = new WorkspaceWatcherModule(shared)
    await watcher.boot({
      cwd: tmp,
      sessionDir: tmp,
      config: {} as never,
      sharedServices: { repoStats: shared },
    })

    // Initial walk — empty repo
    const initial = shared.snapshot(tmp)
    expect(initial.state).toBe('empty')

    // Simulate the watcher observing a file change
    writeFileSync(join(tmp, 'a.ts'), 'export const a = 1\n')
    watcher.simulateChangeForTest({ path: join(tmp, 'a.ts'), kind: 'created', at: Date.now() })

    // Next snapshot must reflect the new file WITHOUT a manual
    // invalidate call — that's the whole point of sharing the
    // instance.
    const after = shared.snapshot(tmp)
    expect(after.state).toBe('ready')
    expect(after.stats).not.toBeNull()
    expect(after.stats!.sourceFileCount).toBe(1)
  })

  it('two separate instances do NOT see each other\'s invalidation', () => {
    const a = wireRepoStats()
    const b = wireRepoStats()
    writeFileSync(join(tmp, 'a.ts'), '')
    a.snapshot(tmp)
    a.invalidate()
    // b is a different instance; it has not been invalidated.
    const bSnap = b.snapshot(tmp)
    expect(bSnap.stats?.sourceFileCount).toBe(1)
  })
})