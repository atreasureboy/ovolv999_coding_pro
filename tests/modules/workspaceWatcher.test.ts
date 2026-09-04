import { describe, expect, it, afterAll } from 'vitest'
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { WorkspaceWatcherModule } from '../../src/modules/workspaceWatcher.js'
import type { ModuleBootContext, ModuleIterationContext, ModuleRunContext, ModuleBootResult } from '../../src/core/module.js'
import type { EngineConfig } from '../../src/core/types.js'

function makeConfig(cwd: string): EngineConfig {
  return { cwd } as EngineConfig
}

function makeBootCtx(cwd: string): ModuleBootContext {
  return { cwd, config: makeConfig(cwd) }
}

function makeRunCtx(): ModuleRunContext {
  return {
    cwd: '/tmp',
    turnResult: { stopped: true, reason: 'stop_sequence', output: 'ok' },
    messages: [],
  }
}

async function waitForReady(module: WorkspaceWatcherModule): Promise<void> {
  const watcher = (module as unknown as { watcher: { whenReady?: () => Promise<void> } | null }).watcher
  if (watcher?.whenReady) {
    await watcher.whenReady()
  }
  // small grace period for chokidar to settle
  await new Promise((resolve) => setTimeout(resolve, 100))
}

describe('WorkspaceWatcherModule (P2.2)', () => {
  const baseDir = tmpdir()
  const dirs: string[] = []

  afterAll(() => {
    for (const d of dirs) {
      try { rmSync(d, { recursive: true, force: true }) } catch { /* ignore */ }
    }
  })

  it('boots, starts watcher, and stops on dispose', async () => {
    const dir = mkdtempSync(join(baseDir, 'ovogo-watcher-'))
    dirs.push(dir)
    const module = new WorkspaceWatcherModule()
    const result: ModuleBootResult = await module.boot(makeBootCtx(dir))
    expect(result).toBeDefined()
    // wait for chokidar's initial scan to complete
    // (WorkspaceWatcher exposes whenReady() for this — see r8 chokidar rewrite)
    await waitForReady(module)
    // After boot, no changes yet
    expect((module as unknown as { lastChanges: unknown[] }).lastChanges.length).toBe(0)
    await module.dispose?.()
  })

  it('records file changes when watched file is modified', async () => {
    const dir = mkdtempSync(join(baseDir, 'ovogo-watcher-'))
    dirs.push(dir)
    const target = join(dir, 'test.txt')
    writeFileSync(target, 'hello')

    const module = new WorkspaceWatcherModule()
    await module.boot(makeBootCtx(dir))
    await waitForReady(module)

    // Trigger a change
    writeFileSync(target, 'world')

    // Wait for chokidar to debounce + emit
    await new Promise((resolve) => setTimeout(resolve, 800))

    const lastChanges = (module as unknown as { lastChanges: Array<{ path: string }> }).lastChanges
    expect(lastChanges.length).toBeGreaterThan(0)
    expect(lastChanges.some((c) => c.path.includes('test.txt'))).toBe(true)

    await module.dispose?.()
  })

  it('injects system-reminder on iteration after change', async () => {
    const dir = mkdtempSync(join(baseDir, 'ovogo-watcher-'))
    dirs.push(dir)
    const target = join(dir, 'a.txt')
    writeFileSync(target, '1')

    const module = new WorkspaceWatcherModule()
    await module.boot(makeBootCtx(dir))
    await waitForReady(module)

    writeFileSync(target, '2')
    await new Promise((resolve) => setTimeout(resolve, 800))

    const iterCtx: ModuleIterationContext = {
      iteration: 1,
      messages: [],
      abortSignal: new AbortController().signal,
    }
    const result = await module.onIteration?.(iterCtx)
    expect(result).toBeDefined()
    expect(result?.injectMessage ?? '').toContain('workspace files changed')
    expect(result?.injectMessage ?? '').toContain('a.txt')

    // second call should not re-inject
    const second = await module.onIteration?.(iterCtx)
    expect(second?.injectMessage).toBeUndefined()

    await module.dispose?.()
  })

  it('re-arms the reminder after onComplete (per-run, not per-process)', async () => {
    const dir = mkdtempSync(join(baseDir, 'ovogo-watcher-'))
    dirs.push(dir)
    const target = join(dir, 'c.txt')
    writeFileSync(target, '1')

    const module = new WorkspaceWatcherModule()
    await module.boot(makeBootCtx(dir))
    await waitForReady(module)

    writeFileSync(target, '2')
    await new Promise((resolve) => setTimeout(resolve, 800))

    const iterCtx: ModuleIterationContext = {
      iteration: 1,
      messages: [],
      abortSignal: new AbortController().signal,
    }
    const first = await module.onIteration?.(iterCtx)
    expect(first?.injectMessage).toContain('workspace files changed')

    // Run completes: lifecycle resets, so a NEW change in a later run is
    // eligible for a fresh reminder.
    module.onComplete?.(makeRunCtx())

    writeFileSync(target, '3')
    await new Promise((resolve) => setTimeout(resolve, 800))

    const nextRun: ModuleIterationContext = { ...iterCtx, iteration: 1 }
    const reArmed = await module.onIteration?.(nextRun)
    expect(reArmed?.injectMessage).toContain('workspace files changed')

    await module.dispose?.()
  })

  it('appends workspace_change to eventLog onComplete', async () => {
    const dir = mkdtempSync(join(baseDir, 'ovogo-watcher-'))
    dirs.push(dir)
    const target = join(dir, 'b.txt')
    writeFileSync(target, 'first')

    const module = new WorkspaceWatcherModule()
    await module.boot(makeBootCtx(dir))
    await waitForReady(module)

    writeFileSync(target, 'second')
    await new Promise((resolve) => setTimeout(resolve, 800))

    const captured: Array<{ type: string; source: string; detail: Record<string, unknown> }> = []
    const fakeEventLog = {
      append: (type: string, source: string, detail: Record<string, unknown>) => {
        captured.push({ type, source, detail })
        return { id: 'evt_test', timestamp: '', type: type as never, source, detail }
      },
    }

    const ctx = makeRunCtx()
    ctx.eventLog = fakeEventLog as never
    module.onComplete?.(ctx)

    expect(captured.length).toBe(1)
    expect(captured[0]?.type).toBe('workspace_change')
    expect(captured[0]?.source).toBe('workspace_watcher')
    expect(captured[0]?.detail.changes).toBeDefined()

    await module.dispose?.()
  })

  it('skips change tracking for ignored dirs (node_modules, .git)', async () => {
    const dir = mkdtempSync(join(baseDir, 'ovogo-watcher-'))
    dirs.push(dir)
    mkdirSync(join(dir, 'node_modules'), { recursive: true })

    const module = new WorkspaceWatcherModule()
    await module.boot(makeBootCtx(dir))
    await waitForReady(module)

    writeFileSync(join(dir, 'node_modules', 'foo.ts'), 'boom')
    await new Promise((resolve) => setTimeout(resolve, 800))

    const lastChanges = (module as unknown as { lastChanges: Array<{ path: string }> }).lastChanges
    expect(lastChanges.some((c) => c.path.includes('node_modules'))).toBe(false)

    await module.dispose?.()
  })
})
