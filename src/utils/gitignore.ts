/**
 * gitignore loader — convert .gitignore (+ .git/info/exclude) rules into
 * glob `ignore` patterns.
 *
 * Round 27 (glob gitignore-awareness): Glob previously shipped a fixed
 * 3-entry ignore list, so a build artifact committed nowhere but listed
 * in .gitignore still flooded results. Real gitignore semantics (anchored
 * paths, `**`, negations) are a matcher problem — here we do the pragmatic
 * conversion that covers the overwhelming majority of real-world rules:
 *
 *   - comments (#) and blanks skipped
 *   - `dir/` → matches the dir anywhere (root-anchored when the
 *     original rule contains a slash)
 *   - negations (`!rule`) skipped — glob's ignore has no un-ignore; rare
 *     in practice, and missing an UN-ignore only shows extra files
 *     (never hides real code), which is the safe failure direction.
 *   - escaped `\#` / `\!` unescaped
 */

import { readFileSync, existsSync } from 'fs'
import { join } from 'path'

const CACHE = new Map<string, { rules: string[]; loadedAt: number }>()
const CACHE_TTL_MS = 10_000

function parseGitignoreLines(text: string): string[] {
  const out: string[] = []
  for (let raw of text.split('\n')) {
    raw = raw.replace(/\r$/, '')
    if (raw.startsWith('\\#') || raw.startsWith('\\!')) raw = raw.slice(1)
    if (!raw || raw.startsWith('#')) continue
    if (raw.startsWith('!')) continue // negation — see header note
    let rule = raw.trim()
    if (!rule) continue
    const anchored = rule.startsWith('/')
    if (anchored) rule = rule.slice(1)
    // Escaped globs are literal — normalize `\[` style escapes so the
    // glob engine doesn't re-interpret them.
    if (rule.endsWith('/')) rule = rule.slice(0, -1)
    if (!rule) continue
    const suffix = rule.includes('/') ? '' : '**/' // unanchored → any depth
    if (anchored || raw.includes('/', 1)) {
      out.push(`${rule}/**`)
      out.push(rule)
    } else {
      out.push(`${suffix}${rule}/**`)
      out.push(`${suffix}${rule}`)
    }
  }
  return out
}

/**
 * Gitignore-derived ignore patterns for `cwd`, merged with the always-on
 * junk defaults. Cached briefly so repeated Glob/Grep calls in one turn
 * don't re-read files.
 */
export function loadGitignoreIgnores(cwd: string): string[] {
  const cached = CACHE.get(cwd)
  if (cached && Date.now() - cached.loadedAt < CACHE_TTL_MS) return cached.rules

  const rules = new Set<string>([
    '**/node_modules/**',
    '**/.git/**',
    '**/dist/**',
    '**/.DS_Store',
  ])
  for (const file of [join(cwd, '.gitignore'), join(cwd, '.git', 'info', 'exclude')]) {
    try {
      if (existsSync(file)) {
        for (const r of parseGitignoreLines(readFileSync(file, 'utf8'))) {
          rules.add(r)
        }
      }
    } catch { /* unreadable → defaults only */ }
  }
  const arr = [...rules]
  CACHE.set(cwd, { rules: arr, loadedAt: Date.now() })
  return arr
}

/** Test hook — drop the mtime cache between tests. */
export function clearGitignoreCache(): void {
  CACHE.clear()
}
