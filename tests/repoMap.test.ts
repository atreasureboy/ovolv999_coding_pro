/**
 * v0.5.2 (C1 + C7 — borrowed from aider/repomap.py + cursor
 * `.cursorignore`): tests for RepoMapService and the
 * `.ovolv999ignore` integration with RepoStatsService.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

import { RepoMapService } from '../src/core/repoMap.js'
import { RepoStatsService } from '../src/core/repoStats.js'

describe('RepoMapService (C1 — borrowed from aider/repomap.py)', () => {
  let tmp: string
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'ovolv999-repomap-'))
  })
  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true })
  })

  it('builds a token-budgeted map of files by symbol density', () => {
    writeFileSync(join(tmp, 'a.ts'),
      `export function alpha() { return 1 }\n` +
      `export function beta() { return 2 }\n` +
      `export const gamma = 3\n`,
    )
    writeFileSync(join(tmp, 'b.ts'),
      `import { alpha } from './a'\nexport function use() { return alpha() }\n`,
    )
    const svc = new RepoMapService()
    const snap = svc.snapshot(tmp, 'always')
    expect(snap).not.toBeNull()
    expect(snap!.files.length).toBeGreaterThan(0)
    // The file with more symbols ranks higher
    const top = snap!.files[0]
    expect(top.symbols.length).toBeGreaterThanOrEqual(1)
    // Cache key is set
    expect(snap!.cacheKey).toBeTruthy()
  })

  it('respects maxFiles and maxTokens caps', () => {
    for (let i = 0; i < 10; i++) {
      writeFileSync(join(tmp, `f${i}.ts`),
        `export function f${i}() {}\nexport function g${i}() {}\nexport const h${i} = ${i}\n`,
      )
    }
    const svc = new RepoMapService({ maxFiles: 3, maxTokens: 50 })
    const snap = svc.snapshot(tmp, 'always')
    expect(snap!.files.length).toBeLessThanOrEqual(3)
  })

  it('renderForPrompt returns a markdown block with the top files', () => {
    writeFileSync(join(tmp, 'a.ts'), 'export function alpha() {}\nexport class Beta {}\n')
    writeFileSync(join(tmp, 'b.ts'), 'import { alpha } from "./a"\nexport const gamma = alpha()\n')
    const svc = new RepoMapService()
    const snap = svc.snapshot(tmp, 'always')
    const md = svc.renderForPrompt(snap!)
    expect(md).toContain('## Repo Map')
    expect(md).toMatch(/(a|b)\.ts/)
  })

  it('refresh mode manual returns the cached snapshot only', () => {
    writeFileSync(join(tmp, 'a.ts'), 'export function alpha() {}\n')
    const svc = new RepoMapService()
    svc.snapshot(tmp, 'always')
    // Manual mode should not rebuild and should return the cached value
    const snap = svc.snapshot(tmp, 'manual')
    expect(snap).not.toBeNull()
  })

  it('invalidate() forces a fresh snapshot', () => {
    writeFileSync(join(tmp, 'a.ts'), 'export function alpha() {}\n')
    const svc = new RepoMapService()
    const first = svc.snapshot(tmp, 'auto')
    svc.invalidate()
    const second = svc.snapshot(tmp, 'auto')
    expect(first).not.toBe(second)
  })

  it('returns null for non-existent rootDir', () => {
    const svc = new RepoMapService()
    expect(svc.snapshot('/this/does/not/exist/at/all/anywhere', 'always')).toBeNull()
  })

  it('uses shared RepoStatsService cache for the key', () => {
    writeFileSync(join(tmp, 'a.ts'), 'export function alpha() {}\n')
    const stats = new RepoStatsService()
    const svc = new RepoMapService({ repoStats: stats })
    const snap = svc.snapshot(tmp, 'auto')
    expect(snap).not.toBeNull()
    expect(stats.getCache().state).toBe('ready')
  })
})

describe('RepoStatsService with .ovolv999ignore (C7 — borrowed from cursor .cursorignore)', () => {
  let tmp: string
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'ovolv999-ignore-'))
  })
  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true })
  })

  it('excludes files matching .ovolv999ignore patterns', () => {
    writeFileSync(join(tmp, 'index.ts'), 'export const a = 1\n')
    writeFileSync(join(tmp, 'README.md'), '# Test\n')
    mkdirSync(join(tmp, 'vendor'), { recursive: true })
    writeFileSync(join(tmp, 'vendor/lib.ts'), 'export const x = 1\n')
    mkdirSync(join(tmp, 'docs/secret'), { recursive: true })
    writeFileSync(join(tmp, 'docs/secret/internal.md'), 'secret\n')
    writeFileSync(join(tmp, '.ovolv999ignore'),
      '# comment line — ignored\n' +
      'vendor/\n' +
      'docs/secret\n',
    )
    const svc = new RepoStatsService()
    const snap = svc.snapshot(tmp)
    expect(snap.state).toBe('ready')
    // vendor/ + docs/secret are excluded
    expect(snap.stats!.sourceFileCount).toBe(2) // index.ts + README.md
  })

  it('respects glob patterns in .ovolv999ignore', () => {
    mkdirSync(join(tmp, 'src'), { recursive: true })
    writeFileSync(join(tmp, 'src/a.ts'), 'export const a = 1\n')
    writeFileSync(join(tmp, 'src/b.gen.ts'), 'generated\n')
    writeFileSync(join(tmp, 'src/c.ts'), 'export const c = 1\n')
    writeFileSync(join(tmp, '.ovolv999ignore'), '*.gen.ts\n')
    const svc = new RepoStatsService()
    const snap = svc.snapshot(tmp)
    expect(snap.stats!.sourceFileCount).toBe(2) // a.ts + c.ts
  })

  it('returns unknown when rootDir is missing (override option)', () => {
    const svc = new RepoStatsService({ ignoreFileName: 'never-used.ignore' })
    expect(svc.snapshot('/this/path/does/not/exist/at/all').state).toBe('unknown')
  })

  it('a missing .ovolv999ignore behaves identically to before', () => {
    writeFileSync(join(tmp, 'a.ts'), 'export const a = 1\n')
    writeFileSync(join(tmp, 'b.ts'), 'export const b = 1\n')
    const svc = new RepoStatsService()
    const snap = svc.snapshot(tmp)
    expect(snap.stats!.sourceFileCount).toBe(2)
  })
})