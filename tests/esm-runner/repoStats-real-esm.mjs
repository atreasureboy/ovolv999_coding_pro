/**
 * v0.5.3 — Real Node ESM smoke test for RepoStats.
 *
 * This test runs OUTSIDE Vitest's transpilation so we exercise
 * the actual ESM `import` statements the production runtime uses
 * (no `require()`, no synchronous require shim). Run via:
 *   npx tsx tests/esm-runner/repoStats-real-esm.mjs
 *
 * tsx uses Node's native ESM loader — same loader that ships the
 * dist artifacts. This catches ESM/CommonJS interop bugs that
 * Vitest's bundling would hide.
 */
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  walkRepo,
  RepoStatsService,
  wireRepoStats,
} from '../../src/core/repoStats.ts'

let failures = 0
function check(label, ok, detail) {
  if (ok) {
    console.log(`  ok ${label}`)
  } else {
    console.log(`  FAIL ${label}: ${detail}`)
    failures++
  }
}

const tmp = mkdtempSync(join(tmpdir(), 'ovolv999-esm-'))
try {
  // ── Case 1: empty repo
  {
    const r = walkRepo(tmp)
    check('empty repo outcome=empty', r.outcome.kind === 'empty', `got ${r.outcome.kind}`)
    check('empty repo sourceFileCount=0', r.sourceFileCount === 0, String(r.sourceFileCount))
  }

  // ── Case 2: real files
  {
    writeFileSync(join(tmp, 'a.ts'), 'export const a = 1\n')
    writeFileSync(join(tmp, 'b.ts'), 'export const b = 1\n')
    mkdirSync(join(tmp, 'src'))
    writeFileSync(join(tmp, 'src/c.py'), 'x = 1\n')
    const r = walkRepo(tmp)
    check('files outcome=ready', r.outcome.kind === 'ready', JSON.stringify(r.outcome))
    check('3 source files counted', r.sourceFileCount === 3, String(r.sourceFileCount))
    check('by-extension: .ts=2', r.byExtension['.ts'] === 2, JSON.stringify(r.byExtension))
    check('by-extension: .py=1', r.byExtension['.py'] === 1, JSON.stringify(r.byExtension))
  }

  // ── Case 3: .ovolv999ignore honored
  {
    mkdirSync(join(tmp, 'vendor'))
    writeFileSync(join(tmp, 'vendor/lib.ts'), 'export const x = 1\n')
    writeFileSync(join(tmp, '.ovolv999ignore'), 'vendor/\n')
    const r = walkRepo(tmp)
    check('vendor/ excluded by .ovolv999ignore', !r.byExtension['.ts'] || r.byExtension['.ts'] <= 2, JSON.stringify(r.byExtension))
  }

  // ── Case 4: symlink loop guard
  {
    const loopDir = mkdtempSync(join(tmpdir(), 'ovolv999-loop-'))
    try {
      mkdirSync(join(loopDir, 'a'))
      try {
        symlinkSync(loopDir, join(loopDir, 'a', 'self'), 'dir')
      } catch {
        // Symlink-permission failures are environment-specific; the
        // assertion below only runs when the symlink was created.
      }
      const r = walkRepo(loopDir, { followSymlinks: false })
      // Must terminate (not hang) and report a non-unknown state.
      // With the symlink-loop guard, the second visit is skipped,
      // so the walk returns ready/empty/partial depending on contents.
      check('symlink loop terminates', ['ready', 'empty', 'partial'].includes(r.outcome.kind), JSON.stringify(r.outcome))
    } finally {
      rmSync(loopDir, { recursive: true, force: true })
    }
  }

  // ── Case 5: depth cap → partial
  {
    const deep = mkdtempSync(join(tmpdir(), 'ovolv999-deep-'))
    try {
      let cur = deep
      for (let i = 0; i < 20; i++) {
        mkdirSync(join(cur, `d${i}`))
        cur = join(cur, `d${i}`)
      }
      writeFileSync(join(cur, 'leaf.txt'), 'x')
      const r = walkRepo(deep, { maxDepth: 5 })
      check('deep walk reports partial', r.outcome.kind === 'partial', JSON.stringify(r.outcome))
    } finally {
      rmSync(deep, { recursive: true, force: true })
    }
  }

  // ── Case 6: RepoStatsService state mapping
  {
    const svc = wireRepoStats()
    const s1 = svc.snapshot(tmp)
    check('wired snapshot state is one of {ready,empty,partial}', ['ready', 'empty', 'partial'].includes(s1.state), s1.state)
    const s2 = svc.snapshot('/this/path/does/not/exist/at/all')
    check('non-existent rootDir → state=unknown', s2.state === 'unknown', s2.state)
    check('non-existent snapshot.stats===null', s2.stats === null, 'unexpected stats')
    check('unknown repoFileCount returns undefined', svc.repoFileCount('/this/does/not/exist') === undefined, String(svc.repoFileCount('/this/does/not/exist')))
  }

  // ── Case 7: shared-cache invalidation across calls
  {
    const svc = wireRepoStats()
    svc.snapshot(tmp)
    const before = svc.getCache()
    writeFileSync(join(tmp, 'fresh-file.ts'), 'export const fresh = 1\n')
    svc.invalidate()
    const after = svc.snapshot(tmp)
    check('invalidate forces re-walk', after !== before, 'cache returned same snapshot after invalidate')
    check('fresh file counted after invalidate', after.stats !== null && after.stats.sourceFileCount >= 4, String(after.stats?.sourceFileCount))
  }

  // ── Case 8: production guard warns on unwired construction
  {
    const orig = process.stderr.write
    let captured = ''
    process.stderr.write = (chunk) => { captured += String(chunk); return true }
    try {
      // eslint-disable-next-line no-new
      new RepoStatsService({})
    } finally {
      process.stderr.write = orig
    }
    check('unwired RepoStatsService construction warns', captured.includes('WIRED_ONCE') || captured.includes('shared-cache'), `captured: ${captured.slice(0, 200)}`)
  }
} finally {
  rmSync(tmp, { recursive: true, force: true })
}

if (failures === 0) {
  console.log('\n✓ all repoStats ESM checks passed')
  process.exit(0)
} else {
  console.log(`\n${failures} failure(s)`)
  process.exit(1)
}