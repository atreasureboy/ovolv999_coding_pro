import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, statSync, existsSync } from 'fs'
import { join, resolve, dirname } from 'path'
import { fileURLToPath } from 'url'

/**
 * Regression guard for the Round 29 split bug: when builtin.ts was
 * split into src/commands/cmd/group*.ts, the lazy `require()` strings
 * kept their old '../core/...' prefixes while the files had moved one
 * level deeper — every lazy-loaded module threw MODULE_NOT_FOUND at
 * dispatch time. Type imports were fixed, runtime strings were not.
 * This test resolves EVERY relative require() in src/ against the real
 * filesystem so a future move can never reintroduce the class of bug.
 */

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry)
    if (statSync(p).isDirectory()) {
      if (!entry.startsWith('.') && entry !== 'node_modules') walk(p, out)
    } else if (entry.endsWith('.ts') && !entry.endsWith('.d.ts')) {
      out.push(p)
    }
  }
  return out
}

const SRC_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', 'src')

describe('relative require() paths in src/', () => {
  it('all resolve to real files (package.json excepted — dist layout differs)', () => {
    const broken: string[] = []
    for (const file of walk(SRC_ROOT)) {
      const src = readFileSync(file, 'utf8')
      for (const m of src.matchAll(/require\((['"])((?:\.\.?\/)[^'"]+)\1\)/g)) {
        const rel = m[2] as string
        if (rel.endsWith('package.json')) continue
        const base = resolve(dirname(file), rel)
        const candidates = [
          base,
          base.replace(/\.js$/, '.ts'),
          `${base}.ts`,
          join(base, 'index.ts'),
        ]
        if (!candidates.some(existsSync)) {
          broken.push(`${file} → ${rel}`)
        }
      }
    }
    expect(broken).toEqual([])
  })
})
