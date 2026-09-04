/**
 * WorkspaceWatcher — R8: uses chokidar instead of self-implemented fs.watch polling.
 *
 * Chokidar provides:
 *   - Cross-platform recursive watching (FSEvents on macOS, inotify on Linux,
 *     ReadDirectoryChangesW on Windows)
 *   - Built-in debouncing (awaitWriteFinish)
 *   - add() / unwatch() for dynamic directory tree changes
 *
 * Public API preserved so callers don't change:
 *   - start() / stop() / isRunning
 *   - setOnChange(handler)
 *   - getWatchedDirCount() (test-only)
 *
 * R7-roadmap note: previous R7 fs.watch polling implementation has been
 * fully replaced. Chokidar is the de-facto standard for Node filesystem
 * watching; reusing it removes ~200 lines of custom code per project
 * principle "不重复造轮子".
 */

import chokidar, { type FSWatcher } from 'chokidar'
import { relative } from 'node:path'

export interface WorkspaceChange {
  path: string
  kind: 'modified' | 'created' | 'deleted'
  at: number
}

export interface WorkspaceWatcherOptions {
  rootDir: string
  /** File extensions to watch (default: all). */
  extensions?: string[]
  /** Directories to ignore (default: node_modules, .git, dist, .ovolv999, .ovogo). */
  ignoreDirs?: string[]
  /** onChange callback — fires once per coalesced event. */
  onChange?: (change: WorkspaceChange) => void
  /** Debounce window in ms (default 100). */
  debounceMs?: number
  /** Polling fallback interval in ms (default 50, used when chokidar falls back to polling). */
  pollIntervalMs?: number
}

const DEFAULT_IGNORE_DIRS = ['node_modules', '.git', 'dist', '.ovolv999', '.ovogo']

export class WorkspaceWatcher {
  private readonly rootDir: string
  private readonly extensions: Set<string> | null
  private readonly ignoreDirs: string[]
  private readonly debounceMs: number
  private readonly pollIntervalMs: number
  private watcher: FSWatcher | null = null
  private running = false
  private readonly debouncedEvents = new Map<string, WorkspaceChange>()
  private debounceTimer: NodeJS.Timeout | null = null
  private onChange?: (change: WorkspaceChange) => void

  constructor(options: WorkspaceWatcherOptions) {
    this.rootDir = options.rootDir
    this.extensions = options.extensions ? new Set(options.extensions) : null
    this.ignoreDirs = options.ignoreDirs ?? DEFAULT_IGNORE_DIRS
    this.debounceMs = options.debounceMs ?? 100
    this.pollIntervalMs = options.pollIntervalMs ?? 50
    this.onChange = options.onChange
  }

  get isRunning(): boolean {
    return this.running
  }

  setOnChange(handler: ((change: WorkspaceChange) => void) | undefined): void {
    this.onChange = handler
  }

  start(): void {
    if (this.running) return
    this.running = true
    this.watcher = chokidar.watch(this.rootDir, {
      ignored: (path: string) => this.shouldIgnore(path),
      ignoreInitial: true,
      persistent: true,
      awaitWriteFinish: false,
      atomic: true,
      interval: this.pollIntervalMs,
      binaryInterval: this.pollIntervalMs,
    })
    this.watcher.on('add', (path) => this.queueChange(this.toRel(path), 'created'))
    this.watcher.on('change', (path) => this.queueChange(this.toRel(path), 'modified'))
    this.watcher.on('unlink', (path) => this.queueChange(this.toRel(path), 'deleted'))
  }

  /**
   * Wait until chokidar's "ready" event fires (initial scan complete).
   * Tests should await this before checking getWatchedDirCount.
   */
  whenReady(): Promise<void> {
    return new Promise<void>((resolve) => {
      if (!this.watcher) {
        resolve()
        return
      }
      this.watcher.once('ready', () => resolve())
      this.watcher.once('error', () => resolve())
    })
  }

  stop(): void {
    if (!this.running) return
    this.running = false
    if (this.watcher) {
      void this.watcher.close().catch(() => { /* best-effort: an in-flight watch error must not crash shutdown */ })
      this.watcher = null
    }
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer)
      this.debounceTimer = null
    }
    this.debouncedEvents.clear()
  }

  getWatchedDirCount(): number {
    if (!this.watcher) return 0
    const watched = this.watcher.getWatched()
    if (Array.isArray(watched)) return watched.length
    return Object.keys(watched).length
  }

  private shouldIgnore(path: string): boolean {
    const base = path.split('/').pop() ?? ''
    if (this.ignoreDirs.includes(base)) return true
    if (base.startsWith('.') && base.length > 1 && !this.isExplicitExtension(base)) return true
    return false
  }

  private isExplicitExtension(name: string): boolean {
    return !!this.extensions && name.startsWith('.') && this.extensions.has(name)
  }

  private toRel(absoluteOrRelative: string): string {
    return relative(this.rootDir, absoluteOrRelative) || absoluteOrRelative
  }

  private queueChange(relPath: string, kind: 'modified' | 'created' | 'deleted'): void {
    if (this.extensions && !this.extensionMatches(relPath)) return
    this.debouncedEvents.set(relPath, { path: relPath, kind, at: Date.now() })
    this.scheduleFlush()
  }

  private extensionMatches(path: string): boolean {
    if (!this.extensions) return true
    const idx = path.lastIndexOf('.')
    const ext = idx < 0 ? '' : path.slice(idx)
    return this.extensions.has(ext)
  }

  private scheduleFlush(): void {
    if (this.debounceTimer) clearTimeout(this.debounceTimer)
    this.debounceTimer = setTimeout(() => {
      const events = Array.from(this.debouncedEvents.values())
      this.debouncedEvents.clear()
      this.debounceTimer = null
      const handler = this.onChange
      if (!handler) return
      for (const ev of events) {
        try { handler(ev) } catch { /* noop */ }
      }
    }, this.debounceMs)
  }
}
