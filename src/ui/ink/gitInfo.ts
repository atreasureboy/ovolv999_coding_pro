/**
 * Git info — cached git branch detection for StatusBar.
 *
 * Runs `git rev-parse --abbrev-ref HEAD` once and caches the result.
 * Refreshed on demand (e.g. after turn execution).
 */

import { execSync } from 'child_process'

let cachedBranch: string | null | undefined

export function getGitBranch(cwd: string): string | null {
  if (cachedBranch !== undefined) return cachedBranch
  try {
    const branch = execSync('git rev-parse --abbrev-ref HEAD', {
      cwd,
      timeout: 2000,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim()
    cachedBranch = branch || null
  } catch {
    cachedBranch = null
  }
  return cachedBranch
}

/** Force re-detection (call after git operations). */
export function refreshGitBranch(): void {
  cachedBranch = undefined
}
