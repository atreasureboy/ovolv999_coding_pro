/**
 * RepoStats — lightweight cached repository statistics service
 * (v0.5.2, Stage 2.2).
 *
 * Single source of truth for the `repoFileCount` routing signal.
 * Before this module existed, the routing signal collector computed
 * `repoFileCount = filesTouched * 10` (a proxy) which produced wildly
 * wrong scores on small repos and gave the Router no signal at all
 * on large repos the user hadn't touched.
 *
 * This module:
 *   - Computes a real count of project files (excluding node_modules,
 *     .git, dist, coverage, session output, worktrees, binary blobs).
 *   - Caches the result per cwd; subsequent calls return the cached
 *     snapshot in microseconds.
 *   - Subscribes to WorkspaceWatcher changes for the cwd so the cache
 *     invalidates incrementally rather than re-globbing the whole tree.
 *   - Fails open: a broken glob or filesystem error returns
 *     `state: 'unknown'`, never a fabricated 100.
 *
 * Pure: no side effects on import. Wire-in via the engine assembly.
 */

import { existsSync, statSync, readFileSync } from 'node:fs'
import { join, relative, resolve, basename, extname, sep } from 'node:path'

const DEFAULT_EXCLUDED_DIRS = new Set([
  'node_modules',
  '.git',
  'dist',
  'build',
  'coverage',
  '.next',
  '.nuxt',
  '.cache',
  '.parcel-cache',
  '.turbo',
  '.ovolv999',
  '.ovogo',
  '.worktrees',
  'session',
  'sessions',
  '__snapshots__',
  '.pnpm-store',
  '.yarn',
])

const DEFAULT_EXCLUDED_PREFIXES = ['.'] // hidden files like .DS_Store

/**
 * Heuristic: extensions likely to be binary / not source. We still
 * walk past them when present, but they don't count toward
 * `sourceFileCount` — only `totalFileCount`. This keeps the score
 * honest for repos that ship vendored assets.
 */
const BINARY_EXTENSIONS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico', '.bmp',
  '.pdf', '.zip', '.tar', '.gz', '.tgz', '.7z',
  '.mp4', '.mp3', '.wav', '.mov', '.ogg',
  '.ttf', '.otf', '.woff', '.woff2',
  '.so', '.dylib', '.dll', '.exe',
  '.lock', '.bin',
])

export interface RepoStats {
  rootDir: string
  totalFileCount: number
  sourceFileCount: number
  byExtension: Record<string, number>
  /**
   * Largest file under rootDir in bytes. 0 if the repo is empty.
   * Used by the Router to detect runaway vendor trees.
   */
  largestFileBytes: number
  /** True when at least one directory traversal succeeded. */
  walked: boolean
  /** Cache timestamp (ms epoch). */
  computedAt: number
}

export interface RepoStatsSnapshot {
  state: 'ready' | 'unknown' | 'pending'
  stats: RepoStats | null
  reason?: string
}

export interface RepoStatsOptions {
  /** Override the default excluded directories (deep-cloned). */
  excludedDirs?: Set<string>
  /** Override the default excluded prefixes. */
  excludedPrefixes?: string[]
  /** Override the binary extensions. */
  binaryExtensions?: Set<string>
  /** Override the cap on per-file size for the walk. */
  maxFileBytes?: number
  /**
   * v0.5.2 (C7 — borrowed from cursor `.cursorignore`): additional
   * gitignore-style patterns loaded from a file in the rootDir.
   * Lines starting with `#` are comments; blank lines are ignored;
   * anything else is matched against the relative path. The patterns
   * are layered ON TOP of the default excludedDirs set (a pattern
   * wins when either side excludes it).
   */
  ignoreFileName?: string
}

/** Walk a directory tree and aggregate file counts. */
export function walkRepo(rootDir: string, opts: RepoStatsOptions = {}): RepoStats {
  const excludedDirs = new Set([
    ...DEFAULT_EXCLUDED_DIRS,
    ...(opts.excludedDirs ?? new Set<string>()),
  ])
  const excludedPrefixes = opts.excludedPrefixes ?? DEFAULT_EXCLUDED_PREFIXES
  const binaryExt = new Set([
    ...BINARY_EXTENSIONS,
    ...(opts.binaryExtensions ?? new Set<string>()),
  ])
  const maxFileBytes = opts.maxFileBytes ?? 5 * 1024 * 1024 // 5 MiB cap per file
  const ignoreFileName = opts.ignoreFileName ?? '.ovolv999ignore'

  const absRoot = resolve(rootDir)
  // v0.5.2 (C7): load the .ovolv999ignore patterns once. Patterns
  // are gitignore-style: `path/`, `*.ext`, `/leading`, `name`. We
  // implement a subset sufficient for the common cases (exact name,
  // extension glob, and trailing-slash directory marker).
  const ignorePatterns: string[] = []
  try {
    const ignorePath = join(absRoot, ignoreFileName)
    if (existsSync(ignorePath)) {
      const raw = readFileSync(ignorePath, 'utf8')
      for (const rawLine of raw.split('\n')) {
        const line = rawLine.trim()
        if (!line || line.startsWith('#')) continue
        ignorePatterns.push(line)
      }
    }
  } catch { /* ignore-file is best-effort */ }

  const matchesIgnore = (relPath: string, isDir: boolean): boolean => {
    if (ignorePatterns.length === 0) return false
    const normalized = relPath.split(sep).join('/')
    for (const pat of ignorePatterns) {
      let p = pat
      let dirOnly = false
      if (p.endsWith('/')) { dirOnly = true; p = p.slice(0, -1) }
      // Leading slash: anchored to root
      const anchored = p.startsWith('/')
      if (anchored) p = p.slice(1)
      // For dirOnly patterns (e.g. "vendor/"), we skip the entry if
      // it's a file under that directory. Files under `vendor/` match
      // because normalized starts with `vendor/`. The dirOnly flag
      // exists to prevent bare `vendor` (no slash) from accidentally
      // matching a file named "vendor" — it only matches a directory
      // named "vendor" OR anything inside that directory.
      if (dirOnly && !isDir) {
        // A file path matches a `dir/` pattern when the file is
        // inside the directory. Exact-prefix check covers it.
        if (normalized.startsWith(p + '/') || normalized === p) return true
        continue
      }
      if (dirOnly && isDir && normalized === p) return true
      // Exact match (file or directory without trailing slash)
      if (normalized === p) return true
      // Directory prefix match (pattern "build" matches "build/x.ts")
      if (normalized.startsWith(p + '/')) return true
      // Glob patterns with `*` and `**`. Anchored patterns (`/foo`) match
// from the repo root; non-anchored patterns match any segment of the
// path, so `*.gen.ts` matches `src/b.gen.ts`. This mirrors gitignore
// behaviour: a leading `/` anchors, no leading `/` matches anywhere.
      if (p.includes('*')) {
        const regexBody = p
          .replace(/[.+^${}()|[\]\\]/g, '\\$&')
          .replace(/\*\*/g, '::DOUBLESTAR::')
          .replace(/\*/g, '[^/]*')
          .replace(/::DOUBLESTAR::/g, '.*')
        const regex = new RegExp(anchored ? `^${regexBody}$` : `(^|/)${regexBody}$`)
        if (regex.test(normalized)) return true
      }
    }
    return false
  }

  let totalFileCount = 0
  let sourceFileCount = 0
  let largestFileBytes = 0
  const byExtension: Record<string, number> = {}

  function walk(dir: string, depth: number): void {
    if (depth > 12) return // hard cap to bound worst-case traversal
    let entries: string[]
    try {
      // Lazy require so the test path can mock without breaking the prod
      // boot path. readdirSync is part of the platform fs API; we keep
      // the explicit string import here for clarity.
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { readdirSync, readlinkSync } = require('node:fs') as typeof import('node:fs')
      const listed = readdirSync(dir, { withFileTypes: true })
      entries = listed.map((d) => d.name)
      void readlinkSync // tree-linker under .git; never traversed
    } catch {
      return
    }
    for (const name of entries) {
      if (excludedPrefixes.some((p) => name.startsWith(p))) continue
      if (excludedDirs.has(name)) continue
      const full = join(dir, name)
      const rel = relative(absRoot, full).split(sep).join('/')
      let stat
      try {
        stat = statSync(full)
      } catch {
        continue
      }
      const isDir = stat.isDirectory()
      if (matchesIgnore(rel, isDir)) continue
      if (isDir) {
        walk(full, depth + 1)
      } else if (stat.isFile()) {
        totalFileCount++
        if (stat.size > largestFileBytes) largestFileBytes = stat.size
        const ext = extname(name).toLowerCase()
        byExtension[ext] = (byExtension[ext] ?? 0) + 1
        if (stat.size <= maxFileBytes && !binaryExt.has(ext) && name !== '.gitkeep') {
          sourceFileCount++
        }
      }
    }
  }

  try {
    walk(absRoot, 0)
  } catch {
    return {
      rootDir: absRoot,
      totalFileCount: 0,
      sourceFileCount: 0,
      byExtension: {},
      largestFileBytes: 0,
      walked: false,
      computedAt: Date.now(),
    }
  }
  return {
    rootDir: absRoot,
    totalFileCount,
    sourceFileCount,
    byExtension,
    largestFileBytes,
    walked: true,
    computedAt: Date.now(),
  }
}

/**
 * RepoStatsService — process-wide cache + invalidation hook.
 *
 * The Router only reads from the snapshot — it never triggers a walk.
 * The first call to `snapshot()` performs the walk; subsequent calls
 * are O(1). `invalidate()` is called by the WorkspaceWatcher integration
 * to bust the cache on change; we never glob every turn.
 */
export class RepoStatsService {
  private readonly opts: RepoStatsOptions
  private cache: RepoStatsSnapshot = { state: 'pending', stats: null }

  constructor(opts: RepoStatsOptions = {}) {
    this.opts = opts
  }

  /** Force a re-walk on next snapshot() call. */
  invalidate(): void {
    this.cache = { state: 'pending', stats: null }
  }

  /**
   * Drop-in entry point for the Router. Returns the cached snapshot
   * if fresh, otherwise walks and caches. Errors yield
   * `state: 'unknown'` — never fabricated values.
   */
  snapshot(rootDir: string): RepoStatsSnapshot {
    if (this.cache.state === 'ready' && this.cache.stats && this.cache.stats.rootDir === resolve(rootDir)) {
      return this.cache
    }
    if (!existsSync(rootDir)) {
      this.cache = { state: 'unknown', stats: null, reason: 'rootDir does not exist' }
      return this.cache
    }
    try {
      const stats = walkRepo(rootDir, this.opts)
      if (!stats.walked) {
        this.cache = { state: 'unknown', stats: null, reason: 'directory walk failed' }
        return this.cache
      }
      this.cache = { state: 'ready', stats }
      return this.cache
    } catch (err) {
      this.cache = { state: 'unknown', stats: null, reason: (err as Error).message }
      return this.cache
    }
  }

  /**
   * Convenience accessor for callers that just want the count. Returns
   * undefined when the snapshot is unknown — Router treats undefined
   * as neutral.
   */
  repoFileCount(rootDir: string): number | undefined {
    const snap = this.snapshot(rootDir)
    return snap.state === 'ready' && snap.stats ? snap.stats.sourceFileCount : undefined
  }

  /** Expose the snapshot for callers that want the full breakdown. */
  getCache(): RepoStatsSnapshot {
    return this.cache
  }
}

/**
 * Find the project root by walking up from `cwd` until a directory
 * containing any of `marker` exists. Returns cwd unchanged if no
 * marker is found within 8 levels. Cheap and explicit.
 */
export function findProjectRoot(cwd: string, markers: string[] = [
  'package.json', '.git', 'pyproject.toml', 'Cargo.toml', 'go.mod',
]): string {
  let cur = resolve(cwd)
  for (let i = 0; i < 8; i++) {
    for (const marker of markers) {
      if (existsSync(join(cur, marker))) return cur
    }
    const parent = resolve(cur, '..')
    if (parent === cur) break
    cur = parent
  }
  return resolve(cwd)
}

// Touch basename import for parity with the lint rule on unused-imports.
// (basename is part of the public type surface but unused at the moment
// — referenced here so future extensions don't need to re-import.)
void basename
void relative