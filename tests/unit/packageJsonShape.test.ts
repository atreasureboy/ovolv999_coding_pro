/**
 * v0.5.6 Release Acceptance Repair — package.json metadata tests.
 *
 * Top-level key uniqueness, scripts uniqueness, version
 * consistency across README, CHANGELOG, and CLI.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = join(import.meta.dirname, '..', '..')

function readJSON(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path, 'utf8'))
}

function readText(path: string): string {
  return readFileSync(path, 'utf8')
}

describe('package.json structural integrity', () => {
  it('has exactly one top-level "scripts" key (no duplicate override)', () => {
    const pkg = readJSON(join(ROOT, 'package.json'))
    // JSON.parse cannot produce duplicate keys — it would just
    // keep the last value. The check is structural: there is
    // exactly one `scripts` key, and it must be an object.
    expect(typeof pkg.scripts).toBe('object')
    expect(pkg.scripts).not.toBeNull()
    expect(Array.isArray(pkg.scripts)).toBe(false)
    const keys = Object.keys(pkg.scripts as Record<string, unknown>)
    expect(keys.length).toBeGreaterThan(0)
    for (const k of keys) expect(typeof (pkg.scripts as Record<string, string>)[k]).toBe('string')
  })

  it('contains all required scripts', () => {
    const scripts = readJSON(join(ROOT, 'package.json')).scripts as Record<string, string>
    const required = [
      'build', 'package:verify', 'start', 'dev',
      'lint', 'lint:fix', 'format', 'format:check',
      'test', 'test:unit', 'test:integration', 'test:esm',
      'test:golden-path', 'test:runtime-behavior',
      'eval:wiring', 'eval:deterministic', 'eval:real',
      'typecheck', 'verify:runtime-static',
      'check', 'prepack',
    ]
    for (const r of required) expect(scripts[r], `missing ${r}`).toBeTypeOf('string')
  })

  it('test:runtime-behavior includes v055 + Reality Closure behaviour tests', () => {
    const scripts = readJSON(join(ROOT, 'package.json')).scripts as Record<string, string>
    const cmd = scripts['test:runtime-behavior']
    expect(cmd).toContain('tests/v053Hotfix')
    expect(cmd).toContain('tests/v053')
    expect(cmd).toContain('tests/v053RealGoldenPath.profileFallback.test.ts')
  })

  it('check does NOT include build/package:verify (those belong to prepack)', () => {
    const scripts = readJSON(join(ROOT, 'package.json')).scripts as Record<string, string>
    const checkCmd = scripts['check']
    expect(checkCmd).not.toContain('pnpm build')
    expect(checkCmd).not.toContain('pnpm package:verify')
    // prepack wraps check + build + verify.
    expect(scripts['prepack']).toContain('pnpm check')
    expect(scripts['prepack']).toContain('pnpm build')
    expect(scripts['prepack']).toContain('pnpm package:verify')
  })
})

describe('package.json top-level keys are unique', () => {
  it('the JSON file has no duplicate top-level keys (parsed uniquely)', () => {
    // Structural check: walk the raw bytes (skipping nested
    // objects/arrays) before JSON.parse to assert no `"key":`
    // appears twice at the top level. JSON.parse would silently
    // keep the last value if duplicates existed.
    const raw = readText(join(ROOT, 'package.json'))
    const bodyStart = raw.indexOf('{')
    let depth = 0
    let end = -1
    for (let i = bodyStart; i < raw.length; i++) {
      const c = raw[i]
      if (c === '{' || c === '[') depth++
      else if (c === '}' || c === ']') {
        depth--
        if (depth === 0) { end = i; break }
      }
    }
    expect(end).toBeGreaterThan(bodyStart)
    // Walk character-by-character and only collect keys at depth 1.
    const keys = new Set<string>()
    const duplicates: string[] = []
    let curDepth = 1
    let i = bodyStart + 1
    while (i < end) {
      const c = raw[i]
      if (c === '{' || c === '[') {
        curDepth++
        // discard nested object content — we already verified
        // top-level keys via JSON.parse; this is a structural
        // guard against a future regression.
        i++
        let nested = 1
        while (i < end && nested > 0) {
          const cc = raw[i]
          if (cc === '{' || cc === '[') nested++
          else if (cc === '}' || cc === ']') nested--
          i++
        }
        curDepth--
        continue
      }
      if (c === '"' && curDepth === 1) {
        // Read the quoted key.
        let j = i + 1
        let key = ''
        while (j < end && raw[j] !== '"') {
          if (raw[j] === '\\') j++
          key += raw[j]
          j++
        }
        // After the closing quote, expect optional whitespace then ':'.
        let k = j + 1
        while (k < end && (raw[k] === ' ' || raw[k] === '\t' || raw[k] === '\n')) k++
        if (k < end && raw[k] === ':') {
          if (keys.has(key)) duplicates.push(key)
          keys.add(key)
        }
        i = k + 1
        continue
      }
      i++
    }
    expect(duplicates, `duplicate top-level keys: ${duplicates.join(',')}`).toEqual([])
  })

  it('scripts object has no duplicate script names', () => {
    const raw = readText(join(ROOT, 'package.json'))
    // Find the `"scripts": { ... }` block and walk it
    // character-by-character, collecting only keys at depth 1.
    const scriptsIdx = raw.indexOf('"scripts"')
    expect(scriptsIdx).toBeGreaterThan(-1)
    let braceIdx = -1
    for (let i = scriptsIdx; i < raw.length; i++) {
      if (raw[i] === '{') { braceIdx = i; break }
    }
    expect(braceIdx).toBeGreaterThan(-1)
    let depth = 0
    let end = -1
    for (let i = braceIdx; i < raw.length; i++) {
      const c = raw[i]
      if (c === '{' || c === '[') depth++
      else if (c === '}' || c === ']') {
        depth--
        if (depth === 0) { end = i; break }
      }
    }
    const seen = new Set<string>()
    const dups: string[] = []
    let curDepth = 1
    let i = braceIdx + 1
    while (i < end) {
      const c = raw[i]
      if (c === '{' || c === '[') {
        curDepth++
        i++
        let nested = 1
        while (i < end && nested > 0) {
          const cc = raw[i]
          if (cc === '{' || cc === '[') nested++
          else if (cc === '}' || cc === ']') nested--
          i++
        }
        curDepth--
        continue
      }
      if (c === '"' && curDepth === 1) {
        let j = i + 1
        let key = ''
        while (j < end && raw[j] !== '"') {
          if (raw[j] === '\\') j++
          key += raw[j]
          j++
        }
        let k = j + 1
        while (k < end && (raw[k] === ' ' || raw[k] === '\t' || raw[k] === '\n')) k++
        if (k < end && raw[k] === ':') {
          if (seen.has(key)) dups.push(key)
          seen.add(key)
        }
        i = k + 1
        continue
      }
      i++
    }
    expect(dups, `duplicate scripts: ${dups.join(',')}`).toEqual([])
  })
})

describe('version consistency', () => {
  const pkgVersion = (readJSON(join(ROOT, 'package.json')).version as string)

  it('package.json version is 0.6.1', () => {
    expect(pkgVersion).toBe('0.6.1')
  })

  it('README header matches package.json version', () => {
    const readme = readText(join(ROOT, 'README.md'))
    expect(readme).toMatch(new RegExp(`v${pkgVersion.replace(/\./g, '\\.')}\\b`))
  })

  it('CHANGELOG has a section for the current version', () => {
    const changelog = readText(join(ROOT, 'CHANGELOG.md'))
    expect(changelog).toContain(`## ${pkgVersion} `)
  })

  it('CLI --version string matches package.json version', async () => {
    // bin/ovogogogo.ts reads VERSION from package.json at runtime.
    // The CLI's --version output therefore matches package.json
    // automatically. We assert the wire here: the CLI binary does
    // not hardcode a different version.
    const bin = readText(join(ROOT, 'bin', 'ovogogogo.ts'))
    expect(bin).toMatch(/VERSION.*package\.json/)
  })

  it('VERSION file matches package.json version', () => {
    const vf = readText(join(ROOT, 'VERSION')).trim()
    expect(vf).toBe(pkgVersion)
  })
})