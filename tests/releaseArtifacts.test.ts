import { execFileSync } from 'node:child_process'
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
    expect(pkg.scripts.prepack).toContain('npm run check')
  })

  it('keeps development sources and tests out of the npm tarball', () => {
    const output = execFileSync(
      'npm',
      ['pack', '--dry-run', '--json', '--ignore-scripts'],
      { cwd: root, encoding: 'utf8' },
    )
    const [pack] = JSON.parse(output) as Array<{ files: Array<{ path: string }> }>
    const paths = pack.files.map((file) => file.path)
    expect(paths).toContain('dist/bin/ovogogogo.js')
    expect(paths).toContain('dist/package.json')
    expect(paths.some((path) => path.startsWith('tests/'))).toBe(false)
    expect(paths.some((path) => path.startsWith('src/'))).toBe(false)
  })

  it('has cross-platform CI and a guarded tag release', () => {
    const ci = readFileSync(resolve(root, '.github/workflows/ci.yml'), 'utf8')
    const release = readFileSync(resolve(root, '.github/workflows/release.yml'), 'utf8')
    expect(ci).toContain('runs-on: ubuntu-latest')
    expect(ci).toContain('macos-latest, windows-latest')
    expect(ci).toContain('node: [20, 22]')
    expect(release).toContain('Verify tag matches package version')
    expect(release).toContain('npm publish --provenance --access public')
    expect(release).toContain('secrets.NPM_TOKEN')
  })
})
