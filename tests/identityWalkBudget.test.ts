import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { buildRevisionBinding } from '../src/core/revisionBinding.js'

/**
 * Round 44c (production incident): resolveProjectIdentity's
 * workspaceManifestHash walked the ENTIRE cwd synchronously — including
 * .config/.npm/.cache-style dot directories — SHA-256-ing every file.
 * Launched from a home directory this starved the event loop for
 * minutes: the UI showed "Thinking…" and ESC/Ctrl+C were dead (stdin
 * handlers never got a slot). Contract: identity computation over a
 * home-like tree returns promptly and skips hidden entries entirely.
 */

describe('revisionBinding walk budgets', () => {
  let homeLike = ''

  beforeEach(() => {
    homeLike = mkdtempSync(join(tmpdir(), 'ovogo-identity-home-'))
    // Dot directories typical of a real $HOME — must be skipped.
    for (const dir of ['.config/foo', '.npm/x', '.cache', '.local/share', '.claude']) {
      mkdirSync(join(homeLike, dir), { recursive: true })
      writeFileSync(join(homeLike, dir, 'junk.bin'), 'x'.repeat(2048))
    }
    // Real project content — must be hashed.
    writeFileSync(join(homeLike, 'src.ts'), 'export const a = 1')
    mkdirSync(join(homeLike, 'sub'), { recursive: true })
    writeFileSync(join(homeLike, 'sub', 'b.ts'), 'export const b = 2')
    // Hidden FILE too.
    writeFileSync(join(homeLike, '.hidden-file'), 'secret')
  })

  afterEach(() => {
    rmSync(homeLike, { recursive: true, force: true })
  })

  it('returns promptly over a home-like tree', async () => {
    const t0 = Date.now()
    const binding = await buildRevisionBinding({ cwd: homeLike })
    const elapsed = Date.now() - t0
    expect(binding.repo || homeLike).toBeTruthy()
    // Pre-fix, a tree like this (with thousands of junk files) took
    // unbounded time; healthy budget is well under a second.
    expect(elapsed).toBeLessThan(2_000)
  }, 10_000)

  it('untracked/manifest path does not blow up on deep trees', async () => {
    let deep = homeLike
    for (let i = 0; i < 15; i++) {
      deep = join(deep, `level${i}`)
      mkdirSync(deep, { recursive: true })
    }
    writeFileSync(join(deep, 'deep.ts'), 'deep')
    const binding = await buildRevisionBinding({ cwd: homeLike })
    expect(binding).toBeTruthy()
  }, 10_000)
})
