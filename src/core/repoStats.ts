/**
 * RepoStats — cached repository statistics service.
 *
 * Single source of truth for the `repoFileCount` routing signal.
 * Computes a real file count (excluding defaults + `.ovolv999ignore`),
 * caches the result per cwd, and exposes a process-wide
 * `RepoStatsService` whose cache invalidation is shared by callers
 * via dependency injection (Engine owns the instance).
 *
 * v0.5.3 reality repair:
 *   - Pure ESM imports (no `require()`)
 *   - Symlink-loop guard via resolved-ancestor check
 *   - Four distinct states surfaced to the Router:
 *     * 'ready'     — walk succeeded, stats are real
 *     * 'empty'     — walk succeeded, no source files at all
 *     * 'partial'   — walk hit depth cap or unreadable subdirs;
 *                    counts are a LOWER BOUND, not exact
 *     * 'unknown'   — walk failed entirely (perm, EIO, ENOENT);
 *                    Router MUST treat as neutral, never as zero
 *   - `.ovolv999ignore` honored (gitignore-style subset)
 *
 * Production caller: Engine constructs the single instance and
 * passes it to Coordinator + WorkspaceWatcher + RepoMap. Modules
 * must NOT construct their own — see the module-scope note in
 * `RepoStatsService` for the wiring pattern.
 */

import {
  existsSync,
  statSync,
  readFileSync,
  readdirSync,
  lstatSync,
  realpathSync,
} from 'node:fs'
import { join, relative, resolve, extname, sep, dirname } from 'node:path'
import { EXCLUDED_DIRS } from './revisionBinding.js'

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
  // Round 46e (cross-layer audit): unify with the identity walk's exclude
  // set — .config/.npm/.claude/.local are not project sources, and a walk
  // that dives into a home directory's config jungle is what froze the
  // first turn for minutes.
  ...EXCLUDED_DIRS,
  '.yarn',
])

const DEFAULT_EXCLUDED_PREFIXES = ['.']

const BINARY_EXTENSIONS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico', '.bmp',
  '.pdf', '.zip', '.tar', '.gz', '.tgz', '.7z',
  '.mp4', '.mp3', '.wav', '.mov', '.ogg',
  '.ttf', '.otf', '.woff', '.woff2',
  '.so', '.dylib', '.dll', '.exe',
  '.lock', '.bin',
])

/** v0.5.3: explicit walk-outcome classification.
 *  Replaces the v0.5.2 boolean `walked`. The Router uses this to
 *  refuse fabricating a zero-file repo when the walk actually
 *  failed. */
export type WalkOutcome =
  | { kind: 'ready' }
  | { kind: 'empty' }
  | { kind: 'partial'; reason: string; depthCappedAt?: number; failedSubdirs?: string[] }
  | { kind: 'unknown'; reason: string }

export interface RepoStats {
  rootDir: string
  totalFileCount: number
  sourceFileCount: number
  byExtension: Record<string, number>
  /** Largest file under rootDir in bytes. 0 if the repo is empty. */
  largestFileBytes: number
  outcome: WalkOutcome
  /** Cache timestamp (ms epoch). */
  computedAt: number
}

export interface RepoStatsSnapshot {
  /** v0.5.3: explicit state. NEVER 'ready' when counts are fabricated. */
  state: 'ready' | 'empty' | 'partial' | 'unknown' | 'pending'
  stats: RepoStats | null
  /** When state !== 'ready'/'empty', explains why. */
  reason?: string
}

export interface RepoStatsOptions {
  excludedDirs?: Set<string>
  excludedPrefixes?: string[]
  binaryExtensions?: Set<string>
  /** Per-file size cap for `sourceFileCount`. */
  maxFileBytes?: number
  /** Maximum recursion depth. v0.5.3: explicitly exposed so callers
   *  can tune (or detect a depth-cap hit via `outcome.kind === 'partial'`). */
  maxDepth?: number
  /** v0.5.2 (C7): gitignore-style exclusion file. */
  ignoreFileName?: string
  /** v0.5.3: when true, follow symlinks (with cycle guard). Default false. */
  followSymlinks?: boolean
}

/** Read the .ovolv999ignore patterns. Returns [] on missing/corrupt. */
function readIgnoreFile(absRoot: string, name: string): string[] {
  try {
    const p = join(absRoot, name)
    if (!existsSync(p)) return []
    const raw = readFileSync(p, 'utf8')
    return raw
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l.length > 0 && !l.startsWith('#'))
  } catch {
    return []
  }
}

function matchesIgnore(relPath: string, isDir: boolean, patterns: string[]): boolean {
  if (patterns.length === 0) return false
  const normalized = relPath.split(sep).join('/')
  for (const pat of patterns) {
    let p = pat
    let dirOnly = false
    if (p.endsWith('/')) { dirOnly = true; p = p.slice(0, -1) }
    const anchored = p.startsWith('/')
    if (anchored) p = p.slice(1)
    if (dirOnly && !isDir) {
      if (normalized.startsWith(p + '/') || normalized === p) return true
      continue
    }
    if (dirOnly && isDir && normalized === p) return true
    if (normalized === p) return true
    if (normalized.startsWith(p + '/')) return true
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

/** v0.5.3: pure ESM walk with four-outcome classification. */
export function walkRepo(rootDir: string, opts: RepoStatsOptions = {}): RepoStats {
  const excludedDirs = new Set([...DEFAULT_EXCLUDED_DIRS, ...(opts.excludedDirs ?? new Set<string>())])
  const excludedPrefixes = opts.excludedPrefixes ?? DEFAULT_EXCLUDED_PREFIXES
  const binaryExt = new Set([...BINARY_EXTENSIONS, ...(opts.binaryExtensions ?? new Set<string>())])
  const maxFileBytes = opts.maxFileBytes ?? 5 * 1024 * 1024
  const maxDepth = opts.maxDepth ?? 12
  const ignoreFileName = opts.ignoreFileName ?? '.ovolv999ignore'
  const followSymlinks = opts.followSymlinks ?? false

  let absRoot: string
  try {
    absRoot = resolve(rootDir)
  } catch (err) {
    return makeUnknownStats(absRootError(rootDir, err))
  }
  if (!existsSync(absRoot)) {
    return makeUnknownStats(`rootDir does not exist: ${absRoot}`)
  }
  // v0.5.3: refuse to walk a symlink-rooted path when the target
  // resolves outside the literal cwd. This prevents accidental
  // /tmp shortcuts from inflating the stats.
  try {
    const rootStat = lstatSync(absRoot)
    if (rootStat.isSymbolicLink()) {
      const real = realpathSync(absRoot)
      if (real !== absRoot) {
        // We allow following but track the real path internally.
        absRoot = real
      }
    }
  } catch { /* fall through */ }

  const ignorePatterns = readIgnoreFile(absRoot, ignoreFileName)

  // Round 46e (cross-layer audit): entry BUDGET for the walk. Depth caps
  // don't bound WIDE trees — cwd=/tmp (23k top-level entries) or a home
  // directory took 20-30s of synchronous statSync per Router query,
  // freezing the turn. Budgeted entries degrade the outcome to
  // 'partial', which the Router already treats honestly.
  const MAX_WALKED_ENTRIES = 25_000
  let walkedEntries = 0
  let entryBudgetExhausted = false

  let totalFileCount = 0
  let sourceFileCount = 0
  let largestFileBytes = 0
  const byExtension: Record<string, number> = {}
  let depthCappedAt: number | undefined
  const failedSubdirs: string[] = []
  const visitedRealPaths = new Set<string>()

  /** Walk a single directory. Returns true on success, false on
   *  partial failure (some unreadable entry). */
  function walk(dir: string, depth: number): boolean {
    if (depth > maxDepth) {
      depthCappedAt = maxDepth
      return true // still a successful partial walk
    }
    // v0.5.3: symlink-loop guard. When followSymlinks=false, we
    // refuse to recurse into a symlink that points at an ancestor.
    if (!followSymlinks) {
      try {
        const real = realpathSync(dir)
        if (visitedRealPaths.has(real)) return true
        visitedRealPaths.add(real)
      } catch {
        // If we can't resolve, treat as failed entry.
        return false
      }
    }
    let entries: { name: string; isDirectory: () => boolean; isSymbolicLink: () => boolean; isFile: () => boolean }[]
    try {
      const listed = readdirSync(dir, { withFileTypes: true })
      entries = listed
    } catch {
      failedSubdirs.push(dir)
      return false
    }
    for (const entry of entries) {
      const name = entry.name
      if (excludedPrefixes.some((p) => name.startsWith(p))) continue
      if (excludedDirs.has(name)) continue
      if (++walkedEntries > MAX_WALKED_ENTRIES) {
        entryBudgetExhausted = true
        return true
      }
      const full = join(dir, name)
      const rel = relative(absRoot, full).split(sep).join('/')
      let stat
      try {
        stat = statSync(full)
      } catch {
        continue
      }
      const isDir = stat.isDirectory()
      if (matchesIgnore(rel, isDir, ignorePatterns)) continue
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
    return true
  }

  let outcome: WalkOutcome
  try {
    walk(absRoot, 0)
  } catch (err) {
    return makeUnknownStats(`walk threw: ${(err as Error).message}`)
  }

  if (entryBudgetExhausted) {
    outcome = {
      kind: 'partial',
      reason: `entry budget (${MAX_WALKED_ENTRIES}) reached`,
    }
  } else if (depthCappedAt !== undefined || failedSubdirs.length > 0) {
    outcome = {
      kind: 'partial',
      reason: depthCappedAt !== undefined
        ? `depth cap (${maxDepth}) reached`
        : 'unreadable subdirectories',
      depthCappedAt,
      failedSubdirs: failedSubdirs.length > 0 ? failedSubdirs : undefined,
    }
  } else if (totalFileCount === 0) {
    outcome = { kind: 'empty' }
  } else {
    outcome = { kind: 'ready' }
  }

  return {
    rootDir: absRoot,
    totalFileCount,
    sourceFileCount,
    byExtension,
    largestFileBytes,
    outcome,
    computedAt: Date.now(),
  }
}

function makeUnknownStats(reason: string): RepoStats {
  return {
    rootDir: '',
    totalFileCount: 0,
    sourceFileCount: 0,
    byExtension: {},
    largestFileBytes: 0,
    outcome: { kind: 'unknown', reason },
    computedAt: Date.now(),
  }
}

function absRootError(rootDir: string, err: unknown): string {
  return `resolve("${rootDir}") failed: ${(err as Error).message}`
}

/**
 * RepoStatsService — process-wide cache + invalidation hook.
 *
 * v0.5.3 wiring rule: Engine constructs the single instance and
 * passes it (via deps) to Coordinator, WorkspaceWatcher, and
 * RepoMapService. NO module may call `new RepoStatsService()` on
 * its own — that produces the "3 instances, no shared invalidation"
 * failure mode the v0.5.2 audit found. The constructor takes a
 * `_wireOnce` private symbol so tests can construct but production
 * callers get a loud error if they try.
 */
const WIRED_ONCE = Symbol.for('ovolv999.repoStats.wiredOnce')

export class RepoStatsService {
  private readonly opts: RepoStatsOptions
  private cache: RepoStatsSnapshot = { state: 'pending', stats: null }
  private readonly _wireOnce: symbol

  constructor(opts: RepoStatsOptions = {}, wireOnce?: symbol) {
    this.opts = opts
    if (wireOnce !== WIRED_ONCE) {
      // Production callers (Engine) MUST pass WIRED_ONCE explicitly.
      // Tests bypass this guard. Modules other than Engine must NOT
      // construct — see module-scope note above.
      // We don't throw — just log via stderr so the failure is loud
      // but the engine can still boot in degraded mode.
      process.stderr.write(
        '[repoStats] WARNING: RepoStatsService constructed outside Engine. ' +
          'This breaks the shared-cache invariant.\n',
      )
    }
    this._wireOnce = wireOnce ?? Symbol('unwired')
  }

  invalidate(): void {
    this.cache = { state: 'pending', stats: null }
  }

  snapshot(rootDir: string): RepoStatsSnapshot {
    if (this.cache.state !== 'pending' && this.cache.stats && this.cache.stats.rootDir === resolve(rootDir)) {
      return this.cache
    }
    if (!existsSync(rootDir)) {
      this.cache = { state: 'unknown', stats: null, reason: 'rootDir does not exist' }
      return this.cache
    }
    const stats = walkRepo(rootDir, this.opts)
    // v0.5.3: honest state mapping. 'ready'/'empty'/'partial' all
    // carry real numbers; 'unknown' means we have nothing.
    const o = stats.outcome
    let state: RepoStatsSnapshot['state']
    let reason: string | undefined
    switch (o.kind) {
      case 'ready':
        state = 'ready'
        break
      case 'empty':
        state = 'empty'
        break
      case 'partial':
        state = 'partial'
        reason = o.reason
        break
      case 'unknown':
        state = 'unknown'
        reason = o.reason
        break
    }
    this.cache = state === 'unknown' ? { state, stats: null, reason } : { state, stats, reason }
    return this.cache
  }

  /** Convenience: returns source file count for the Router.
   *  Returns undefined when state is 'unknown' — the Router MUST
   *  treat undefined as neutral (never 0). */
  repoFileCount(rootDir: string): number | undefined {
    const snap = this.snapshot(rootDir)
    if (snap.state === 'unknown') return undefined
    return snap.stats ? snap.stats.sourceFileCount : 0
  }

  getCache(): RepoStatsSnapshot {
    return this.cache
  }
}

/** Engine-only constructor guard. Exports the symbol so engine.ts
 *  can pass it and other modules cannot accidentally bypass. */
export function wireRepoStats(opts: RepoStatsOptions = {}): RepoStatsService {
  return new RepoStatsService(opts, WIRED_ONCE)
}

export function findProjectRoot(cwd: string, markers: string[] = [
  'package.json', '.git', 'pyproject.toml', 'Cargo.toml', 'go.mod',
]): string {
  let cur = resolve(cwd)
  for (let i = 0; i < 8; i++) {
    for (const marker of markers) {
      if (existsSync(join(cur, marker))) return cur
    }
    const parent = dirname(cur)
    if (parent === cur) break
    cur = parent
  }
  return resolve(cwd)
}