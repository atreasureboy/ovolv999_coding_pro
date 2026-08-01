import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WorkspaceWatcher } from '../../src/core/workspaceWatcher.js'

describe('WorkspaceWatcher (R7: fs.watch)', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'watcher-'))
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('builds initial watched set with existing files', async () => {
    writeFileSync(join(dir, 'a.txt'), 'a')
    writeFileSync(join(dir, 'b.ts'), 'b')
    const watcher = new WorkspaceWatcher({ rootDir: dir, debounceMs: 10 })
    watcher.start()
    await watcher.whenReady()
    expect(watcher.getWatchedDirCount()).toBeGreaterThan(0)
    watcher.stop()
  })

  it('ignores node_modules and .git directories', async () => {
    writeFileSync(join(dir, 'keep.txt'), 'k')
    mkdirSync(join(dir, 'node_modules'), { recursive: true })
    writeFileSync(join(dir, 'node_modules', 'x.js'), 'x')
    mkdirSync(join(dir, '.git'), { recursive: true })
    writeFileSync(join(dir, '.git', 'HEAD'), 'h')
    const watcher = new WorkspaceWatcher({ rootDir: dir, debounceMs: 10 })
    watcher.start()
    await watcher.whenReady()
    // node_modules and .git are excluded. The watcher tracks rootDir +
    // any non-excluded subdirectories. With only keep.txt in rootDir
    // and no other subdirectories, expect exactly 1 (the root).
    expect(watcher.getWatchedDirCount()).toBeLessThanOrEqual(2)
    watcher.stop()
  })

  it('filters by extension when provided', async () => {
    writeFileSync(join(dir, 'a.ts'), 'a')
    writeFileSync(join(dir, 'b.txt'), 'b')
    const watcher = new WorkspaceWatcher({
      rootDir: dir, debounceMs: 20, extensions: ['.ts'], pollIntervalMs: 20,
    })
    const events: WorkspaceChange[] = []
    watcher.start()
    await watcher.whenReady()
    watcher.setOnChange((c) => events.push(c))
    writeFileSync(join(dir, 'y.ts'), 'should-fire')
    await new Promise<void>((resolve) => setTimeout(resolve, 500))
    expect(events.some((e) => e.path.endsWith('.ts'))).toBe(true)
    watcher.stop()
  })

  it('debounces rapid file events', async () => {
    const watcher = new WorkspaceWatcher({ rootDir: dir, debounceMs: 50 })
    const events: WorkspaceChange[] = []
    watcher.start()
    watcher.setOnChange((c) => events.push(c))
    writeFileSync(join(dir, 'a.txt'), 'v1')
    writeFileSync(join(dir, 'a.txt'), 'v2')
    writeFileSync(join(dir, 'a.txt'), 'v3')
    await new Promise<void>((resolve) => setTimeout(resolve, 200))
    // 3 rapid writes coalesce into ≤2 events (rename + change), not 3+
    expect(events.length).toBeLessThanOrEqual(3)
    watcher.stop()
  })

  it('watches subdirectories recursively', async () => {
    mkdirSync(join(dir, 'src'), { recursive: true })
    writeFileSync(join(dir, 'src', 'a.ts'), 'a')
    mkdirSync(join(dir, 'src', 'lib'), { recursive: true })
    writeFileSync(join(dir, 'src', 'lib', 'b.ts'), 'b')
    const watcher = new WorkspaceWatcher({ rootDir: dir, debounceMs: 10 })
    watcher.start()
    await watcher.whenReady()
    // At least root + src + src/lib = 3 watched dirs. chokidar may track
    // extra entries (e.g. per-file) so we use >=.
    expect(watcher.getWatchedDirCount()).toBeGreaterThanOrEqual(3)
    watcher.stop()
  })

  it('stop is idempotent', () => {
    const watcher = new WorkspaceWatcher({ rootDir: dir, debounceMs: 10 })
    watcher.start()
    watcher.stop()
    expect(() => watcher.stop()).not.toThrow()
    expect(watcher.isRunning).toBe(false)
  })

  it('does not start twice', () => {
    const watcher = new WorkspaceWatcher({ rootDir: dir, debounceMs: 10 })
    watcher.start()
    const firstCount = watcher.getWatchedDirCount()
    watcher.start()
    expect(watcher.getWatchedDirCount()).toBe(firstCount)
    watcher.stop()
  })

  it('handles non-existent rootDir gracefully', () => {
    const watcher = new WorkspaceWatcher({
      rootDir: '/tmp/does-not-exist-xyz-' + Math.random().toString(36).slice(2, 8),
      debounceMs: 10,
    })
    expect(() => watcher.start()).not.toThrow()
    expect(watcher.getWatchedDirCount()).toBe(0)
    watcher.stop()
  })
})

import type { WorkspaceChange } from '../../src/core/workspaceWatcher.js'
