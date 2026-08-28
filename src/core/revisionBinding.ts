/**
 * RevisionBinding — bind every persisted memory record to a real
 * revision state. v0.5.3 Closure (P6).
 *
 * Spec:
 *   - Git repo root / subdir / worktree: detected via
 *     `git -C <cwd> rev-parse --show-toplevel` + `--is-inside-work-tree`.
 *     The `repo` field is the canonical toplevel, NOT arbitrary cwd.
 *   - Git clean     → branch + HEAD (+ diffHash="<clean>").
 *   - Git dirty     → baseCommit + diffHash(staged+unstaged+untracked).
 *   - Non-Git       → absolute cwd + workspaceHash(manifest excluding
 *                     node_modules / .git / dist / coverage / session).
 *
 * Errors are explicit (ok / not-ok), not collapsed to "".
 */
import { execFileSync } from 'node:child_process'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { isAbsolute, join, relative, sep } from 'node:path'
import { createHash } from 'node:crypto'
import type { RevisionBinding } from './memoryCandidate.js'

export interface RevisionBindingOptions {
  cwd?: string
  /** Disable git detection (always produce a non-git binding). */
  disableGit?: boolean
  /** Test seam: pin the result of `rev-parse --show-toplevel`. */
  forceRepoRoot?: string | null
}

export type ExecResult =
  | { ok: true; stdout: string }
  | { ok: false; reason: string }

export async function buildRevisionBinding(opts: RevisionBindingOptions = {}): Promise<RevisionBinding> {
  const cwd = opts.cwd ?? process.cwd()
  const binding: RevisionBinding = { repo: cwd, dirty: false }

  if (opts.disableGit) {
    binding.workspaceHash = workspaceHash(cwd)
    binding.dirty = true
    return binding
  }

  // Step 1: ask git for the canonical toplevel.
  const toplevel: ExecResult = opts.forceRepoRoot !== undefined
    ? safeResultFrom(opts.forceRepoRoot)
    : execGit(cwd, 'rev-parse', '--show-toplevel')
  if (!toplevel.ok) {
    // Not a git repo, OR git is missing → non-git binding.
    binding.workspaceHash = workspaceHash(cwd)
    binding.dirty = true
    return binding
  }
  // After narrowing, toplevel is {ok:true, stdout:string}.
  // v0.6.0 (audit): git on Windows reports POSIX-style forward slashes
  // (`C:/path/to/repo`) while mkdtemp/join-produced cwds use backslashes.
  // Normalize to the input cwd's separator so canonicalRoot compares
  // equal to the launch path and projectKey stays stable across
  // representations of the same repo.
  const toplevelPath = normalizeGitPath(toplevel.stdout.trim(), cwd)
  if (!toplevelPath) {
    binding.workspaceHash = workspaceHash(cwd)
    binding.dirty = true
    return binding
  }
  // `repo` is the canonical root.
  binding.repo = toplevelPath

  // Step 2: confirm we're inside that work-tree (covers subdir +
  // linked worktree cases where cwd != toplevel).
  const inside = execGit(cwd, 'rev-parse', '--is-inside-work-tree')
  if (!inside.ok || inside.stdout.trim() !== 'true') {
    // In a `.git` file pointing elsewhere — fall through with
    // non-git binding rather than fabricate.
    binding.workspaceHash = workspaceHash(cwd)
    binding.dirty = true
    return binding
  }

  // Step 3: read branch / HEAD / dirty state.
  const branch = execGit(cwd, 'rev-parse', '--abbrev-ref', 'HEAD')
  if (branch.ok) {
    const trimmed = branch.stdout.trim()
    if (trimmed && !trimmed.includes(' ')) binding.branch = trimmed
  }
  const head = execGit(cwd, 'rev-parse', 'HEAD')
  if (head.ok) {
    const trimmed = head.stdout.trim()
    if (/^[0-9a-f]{7,40}$/.test(trimmed)) binding.baseCommit = trimmed
  }

  // Step 4: dirty detection — staged + unstaged + untracked.
  const dirtyHash = computeDirtyHash(cwd)
  if (dirtyHash !== null) {
    binding.dirty = true
    binding.diffHash = dirtyHash
  } else {
    binding.dirty = false
    binding.diffHash = 'clean'
  }

  return binding
}

/** v0.5.3 Closure (P6): non-fatal `git` runner. */
function execGit(cwd: string, ...args: string[]): ExecResult {
  try {
    const stdout = execFileSync('git', args, {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 2_000,
    })
    return { ok: true, stdout }
  } catch (e) {
    return { ok: false, reason: (e as Error).message ?? 'git exec failed' }
  }
}

/**
 * v0.6.0 (audit): align a git-reported path with the platform/input
 * separator style. `git rev-parse --show-toplevel` emits forward
 * slashes even on Windows (`C:/Users/...`); the input cwd (from
 * mkdtemp/join) uses backslashes there. Without normalization the
 * canonicalRoot/projectKey of the SAME repo differ by representation.
 * Only drive-letter paths are rewritten; UNC/`//server` prefixes are
 * left untouched (they must stay `//` on win32).
 */
function normalizeGitPath(p: string, cwd: string): string {
  if (process.platform !== 'win32' || !p.includes('/')) return p
  const drive = /^([A-Za-z]:)\//.exec(p)
  if (!drive) return p
  const sep = cwd.includes('\\') ? '\\' : '/'
  return drive[1] + p.slice(2).replace(/\//g, sep)
}

function safeResultFrom(v: string | null): ExecResult {
  if (v === null) return { ok: false, reason: 'forceRepoRoot=null' }
  return { ok: true, stdout: v }
}

/**
 * v0.5.3 Closure (P6): dirty hash combines three sources.
 *   git diff HEAD (unstaged)
 *   git diff --cached HEAD (staged)
 *   untracked files: path + size + content hash (capped)
 *
 * Returns null when the tree is clean.
 */
function computeDirtyHash(cwd: string): string | null {
  const unstaged = execGit(cwd, 'diff', '--binary', 'HEAD')
  const staged = execGit(cwd, 'diff', '--binary', '--cached', 'HEAD')
  // Even if exec returned an error, .stdout may carry an empty
  // string — fall through and check both stdout buffers.
  const unstagedOut = unstaged.ok ? unstaged.stdout : ''
  const stagedOut = staged.ok ? staged.stdout : ''

  const untracked = listUntracked(cwd)
  if (!unstagedOut.trim() && !stagedOut.trim() && untracked.length === 0) {
    return null
  }
  const hash = createHash('sha256')
  hash.update('UNSTAGED\0')
  hash.update(unstagedOut)
  hash.update('\nSTAGED\0')
  hash.update(stagedOut)
  hash.update('\nUNTRACKED\0')
  for (const t of untracked) {
    hash.update(`${t.path}\0${t.size}\0${t.contentHash ?? 'n/a'}\n`)
  }
  return hash.digest('hex').slice(0, 16)
}

interface UntrackedEntry {
  path: string
  size: number
  contentHash?: string
}

const UNTRACKED_HASH_LIMIT = 1_048_576 // 1 MiB

/**
 * Round 44c (fix: identity walk froze whole sessions): directories never
 * worth hashing — heavy caches, dot-config jungles, build output. The
 * pre-fix list missed .config/.npm/.claude/.local etc., so running the
 * REPL from a home directory statSync'd + SHA-256'd hundreds of
 * thousands of files SYNCHRONOUSLY on every turn start — the event loop
 * starved and ESC/Ctrl+C appeared dead.
 */
const EXCLUDED_DIRS = new Set([
  'node_modules', '.git', 'dist', 'coverage', 'session', 'tmp', '.cache',
  '.config', '.local', '.npm', '.cache', '.ovogo', '.ovolv999', '.claude',
  '.opencode', '.codex', '.cursor', '.vscode', '.nuxt', '.next',
  '__pycache__', '.venv', 'venv', '.mypy_cache', '.pytest_cache',
  'target', 'build', 'out', '.turbo', '.svelte-kit', '.gradle', '.idea',
  // Round 46e (cross-layer audit): runtime-generated dirs. 'sessions' is
  // the ovolv999 session store — it APPENDS every turn (parts.jsonl), so
  // hashing it flipped the workspace identity on every single turn and
  // made dirty detection pure noise. The others are tool/runtime outputs
  // for the same reason.
  'sessions', '.loop', '.agents', '.bg_logs', '.gtest',
])

/** Hard cap on manifest entries — walk stops here (hash marks truncation). */
const MANIFEST_MAX_ENTRIES = 5_000
/** Files that get a real content hash; beyond this, size-only entries. */
const MANIFEST_HASH_BUDGET = 1_000

/**
 * v0.5.3 Closure (P6): walk the working directory's untracked
 * files. Excludes node_modules / .git / dist / coverage / session
 * / tmp. Hashes small files inline; large files use the size
 * alone (truncated flag in the manifest entry).
 */
function listUntracked(cwd: string): UntrackedEntry[] {
  const porcelain = execGit(cwd, 'status', '--porcelain', '--untracked-files=all')
  if (!porcelain.ok) return []
  const lines = porcelain.stdout.split('\n').filter((l) => l.length >= 3)
  const EXCLUDES = EXCLUDED_DIRS
  const out: UntrackedEntry[] = []
  for (const line of lines) {
    // Porcelain v1:  XY <path> where `??` = untracked.
    if (!line.startsWith('??')) continue
    const relPath = line.slice(3).trim()
    if (!relPath) continue
    const parts = relPath.split('/')
    if (parts.some((p) => EXCLUDES.has(p))) continue
    const abs = isAbsolute(relPath) ? relPath : join(cwd, relPath)
    try {
      const st = statSync(abs)
      if (!st.isFile()) continue
      let contentHash: string | undefined
      if (st.size <= UNTRACKED_HASH_LIMIT) {
        try {
          const buf = readFileSync(abs)
          contentHash = createHash('sha256').update(buf).digest('hex').slice(0, 16)
        } catch { /* unreadable → no content hash */ }
      }
      out.push({ path: relPath, size: st.size, contentHash })
    } catch { /* stat failed; skip */ }
  }
  return out
}

/**
 * v0.5.3 Closure (P6): non-git workspace hash. We build a SMALL
 * manifest of {relative path, size, [content hash]} over the
 * directory tree excluding noise. Same content under
 * node_modules-style churn → identical hash; content changes →
 * hash changes.
 */
function workspaceManifestHash(rootDir: string): string {
  // Round 44c: shared exclude list (dot-dirs + caches) + entry cap.
  // Round 46e FIX: the old overflow path returned sha256(count:root) —
  // two DIFFERENT 6000-file trees (or one tree before/after an edit)
  // produced the SAME fingerprint, silently breaking dirty detection on
  // large workspaces. Now every walked entry is hashed; beyond the
  // content-hash budget entries degrade to size-only lines (size
  // changes still flip the hash) instead of vanishing from the
  // fingerprint entirely.
  const EXCLUDES = EXCLUDED_DIRS
  const entries: string[] = []
  try {
    walkForManifest(rootDir, rootDir, EXCLUDES, entries, '')
  } catch { /* ignore IO errors */ }
  const hash = createHash('sha256')
  for (const line of entries.sort()) {
    hash.update(line)
    hash.update('\n')
  }
  if (entries.length >= MANIFEST_MAX_ENTRIES) {
    hash.update(`truncated:${rootDir}`)
  }
  return hash.digest('hex').slice(0, 16)
}

function walkForManifest(
  rootDir: string,
  dir: string,
  excludes: Set<string>,
  out: string[],
  rel: string,
  depth: number = 0,
): void {
  // Round 44c: bounded walk — depth and total-entry budgets so a
  // pathological tree (or a forgotten EXCLUDES member) degrades to a
  // partial manifest instead of starving the event loop.
  if (depth > 12 || out.length >= MANIFEST_MAX_ENTRIES) return
  let entries: string[]
  try {
    entries = readdirSync(dir)
  } catch {
    return
  }
  for (const name of entries) {
    if (out.length >= MANIFEST_MAX_ENTRIES) return
    // Hidden entries are never project sources — skipping them is both a
    // perf fix and the semantically right identity boundary.
    if (name.startsWith('.') || excludes.has(name)) continue
    const abs = join(dir, name)
    const childRel = rel ? `${rel}/${name}` : name
    let st
    try { st = statSync(abs) } catch { continue }
    if (st.isDirectory()) {
      walkForManifest(rootDir, abs, excludes, out, childRel, depth + 1)
    } else if (st.isFile()) {
      // Round 46e: content hashing has its own budget — past it, entries
      // degrade to size-only (still hash-relevant) instead of either
      // reading unbounded bytes or being dropped from the manifest.
      let contentHash = 'skipped'
      if (out.length < MANIFEST_HASH_BUDGET && st.size <= UNTRACKED_HASH_LIMIT) {
        try {
          const buf = readFileSync(abs)
          contentHash = createHash('sha256').update(buf).digest('hex').slice(0, 16)
        } catch { /* unreadable */ }
      } else if (st.size > UNTRACKED_HASH_LIMIT) {
        contentHash = 'big'
      } else {
        contentHash = 'size-only'
      }
      out.push(`${childRel}|${st.size}|${contentHash}`)
    }
  }
}

/**
 * Non-git workspace binding: repository is the absolute cwd; the
 * identity is a content-bound manifest hash so the same workspace
 * under the same files produces the same hash, and any change
 * changes the hash.
 */
/**
 * Round 45 note: a TTL cache here was tried and REMOVED — it broke the
 * content-bound contract (a file change must flip the hash immediately;
 * revisionBindingTruth pins this). The R44c walk budgets (≤5k entries,
 * depth ≤12) already bound the worst case to ~tens of ms for realistic
 * projects, which is acceptable per call.
 */
export function workspaceHash(cwd: string): string {
  return workspaceManifestHash(cwd)
}

export { isAbsolute, relative, sep }
