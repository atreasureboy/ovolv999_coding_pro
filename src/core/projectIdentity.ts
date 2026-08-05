/**
 * v0.5.3 Post-Release Integrity Hotfix §4 — ProjectIdentity.
 *
 * Resolved ONCE per run, before module boot. Every subsystem that
 * needs the canonical project root reads from the same identity:
 *
 *   - RevisionBinding — already computes canonicalRoot via
 *     `git rev-parse --show-toplevel` (or cwd fallback)
 *   - MemoryModule.bindToProject() — must take canonicalRoot,
 *     not ctx.cwd (otherwise a git-subdir launch would record
 *     memory as the subdir and never see the project's records)
 *   - SemanticMemory / EpisodicMemory
 *   - RepoStats
 *   - Session / EventLog
 *   - Per-project Memory backend (defaultMemoryPath)
 *
 * `projectKey` is a stable hash of the canonicalRoot so two
 * projects on different machines share an identical backend file
 * while two projects on the same machine use different files
 * even if their human-readable paths happen to collide.
 */
import { createHash } from 'node:crypto'
import { buildRevisionBinding, type RevisionBindingOptions } from './revisionBinding.js'
import type { RevisionBinding } from './memoryCandidate.js'

export interface ProjectIdentity {
  /** The cwd the user (or Engine) launched from. May be a subdir. */
  inputCwd: string
  /** The canonical project root (git toplevel OR absolute cwd for non-git). */
  canonicalRoot: string
  /** Stable opaque key derived from canonicalRoot — used for paths. */
  projectKey: string
  /**
   * Pre-computed RevisionBinding for this run. Sub-systems read
   * `binding.repo` (= canonicalRoot), `binding.baseCommit`,
   * `binding.dirty`, `binding.diffHash`, `binding.workspaceHash`.
   */
  binding: RevisionBinding
}

export interface ProjectIdentityOptions extends RevisionBindingOptions {
  cwd: string
}

/**
 * Resolve the project identity for a given input cwd.
 *
 * Order of operations:
 *   1. Build the RevisionBinding (which itself runs git detection
 *      and fills `binding.repo`).
 *   2. canonicalRoot = binding.repo.
 *   3. projectKey = sha256(canonicalRoot)[:16].
 */
export async function resolveProjectIdentity(opts: ProjectIdentityOptions): Promise<ProjectIdentity> {
  const { cwd, ...rest } = opts
  const binding = await buildRevisionBinding({ cwd, ...rest })
  const canonicalRoot = binding.repo
  const projectKey = createHash('sha256').update(canonicalRoot).digest('hex').slice(0, 16)
  return {
    inputCwd: cwd,
    canonicalRoot,
    projectKey,
    binding,
  }
}

/**
 * Synchronous fallback for callers that cannot await (legacy
 * boot paths). Skips git detection — canonicalRoot == inputCwd.
 * Tests that exercise the full git-aware path use the async API.
 */
export function resolveProjectIdentitySync(cwd: string): ProjectIdentity {
  const projectKey = createHash('sha256').update(cwd).digest('hex').slice(0, 16)
  return {
    inputCwd: cwd,
    canonicalRoot: cwd,
    projectKey,
    binding: {
      repo: cwd,
      dirty: false,
      workspaceHash: '',
    },
  }
}