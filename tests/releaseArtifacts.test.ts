import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const root = resolve(import.meta.dirname, '..')

describe('release artifacts', () => {
  it('publishes the product name with complete repository metadata', () => {
    const pkg = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')) as {
      name: string
      engines: { node: string }
      repository: { url: string }
      files: string[]
      scripts: { prepack: string }
    }
    expect(pkg.name).toBe('ovolv999')
    expect(pkg.engines.node).toBe('>=20')
    expect(pkg.repository.url).toContain('atreasureboy/ovolv999_coding_pro')
    expect(pkg.files).toEqual(expect.arrayContaining(['dist/bin', 'dist/src', 'dist/package.json']))
    expect(pkg.scripts.prepack).toContain('pnpm check')
  })

  it('keeps development sources out of the publish allowlist', () => {
    const pkg = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')) as {
      files: string[]
      scripts: { 'package:verify': string; prepack: string }
    }
    expect(pkg.files.some((path) => path === 'src' || path === 'tests')).toBe(false)
    expect(pkg.scripts['package:verify']).toContain('verify-package.mjs')
    expect(pkg.scripts.prepack).toContain('pnpm package:verify')
  })

  it('has cross-platform CI and a guarded tag release', () => {
    const ci = readFileSync(resolve(root, '.github/workflows/ci.yml'), 'utf8')
    const release = readFileSync(resolve(root, '.github/workflows/release.yml'), 'utf8')
    expect(ci).toContain('runs-on: ubuntu-latest')
    expect(ci).toContain('ubuntu-latest, macos-latest, windows-latest')
    expect(ci).toContain('node: [20, 22]')
    expect(release).toContain('Verify tag matches package version')
    expect(release).toContain('pnpm publish --provenance --access public')
    expect(release).toContain('secrets.NPM_TOKEN')
  })
})
