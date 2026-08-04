/**
 * RevisionBinding — bind every persisted memory record to a real
 * revision state. v0.5.3 Final (task 3).
 *
 * Rules:
 *   - Git repo, clean       → branch + HEAD
 *   - Git repo, dirty       → baseCommit (last clean commit) + diffHash
 *   - Non-Git directory     → absolute cwd + workspaceHash (sha256 of path + mtime bucket)
 *
 * NO fabrication. If git is not available we return a non-git
 * binding honestly; the gate still accepts code-bearing entries
 * only when there is some way to trace them back to a project.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import type { RevisionBinding } from './memoryCandidate.js'

export interface RevisionBindingOptions {
  /** Override the path — mainly for tests. */
  cwd?: string
  /** Disable git detection (always produce a non-git binding). */
  disableGit?: boolean
}

export async function buildRevisionBinding(opts: RevisionBindingOptions = {}): Promise<RevisionBinding> {
  const cwd = opts.cwd ?? process.cwd()
  const binding: RevisionBinding = { repo: cwd, dirty: false }

  if (opts.disableGit) {
    binding.workspaceHash = workspaceHash(cwd)
    return binding
  }

  if (!isGitRepo(cwd)) {
    binding.workspaceHash = workspaceHash(cwd)
    return binding
  }

  // Git repo path — try to read branch + HEAD + dirty state without
  // blocking on errors. We use execFileSync so the call is
  // synchronous and bounded.
  try {
    const branch = safeExec(cwd, 'rev-parse', '--abbrev-ref', 'HEAD').trim()
    if (branch && !branch.includes(' ')) binding.branch = branch
    const head = safeExec(cwd, 'rev-parse', 'HEAD').trim()
    if (head && /^[0-9a-f]{7,40}$/.test(head)) binding.baseCommit = head

    const statusOutput = safeExec(cwd, 'status', '--porcelain')
    if (statusOutput.trim().length > 0) {
      binding.dirty = true
      // Use a stable hash of the diff. `git diff HEAD` is too
      // expensive to materialize for big repos; we hash the
      // porcelain output instead. Stable as long as the file set +
      // hunk signatures are stable; file content-level dedup is
      // delegated to R5.
      const diff = safeExec(cwd, 'diff', '--no-color', 'HEAD')
      binding.diffHash = createHash('sha256').update(diff).digest('hex').slice(0, 16)
    }
  } catch {
    // Any git error → fall back to a non-git binding rather than
    // fabricate branch/commit strings.
    binding.workspaceHash = workspaceHash(cwd)
    delete binding.branch
    delete binding.baseCommit
    binding.dirty = true
  }

  return binding
}

function isGitRepo(cwd: string): boolean {
  try {
    return existsSync(join(cwd, '.git'))
  } catch {
    return false
  }
}

function safeExec(cwd: string, ...args: string[]): string {
  try {
    return execFileSync('git', args, {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 2_000,
    })
  } catch {
    return ''
  }
}

/**
 * Stable workspace hash. SHA-256 over the absolute path + a
 * per-minute mtime bucket; the same workspace within the same
 * minute produces the same hash. The minute resolution is
 * intentional: a long session does not change the hash while
 * files are being edited.
 */
export function workspaceHash(cwd: string): string {
  let bucketSig = 'no-stat'
  try {
    const st = statSync(cwd)
    if (st) {
      const minute = Math.floor(st.mtimeMs / 60_000)
      bucketSig = String(minute)
    }
  } catch {
    /* keep default */
  }
  return createHash('sha256').update(`${cwd}:${bucketSig}`).digest('hex').slice(0, 16)
}
