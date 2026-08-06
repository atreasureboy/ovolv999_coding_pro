/**
 * Unit tests for atomicTransaction and codeStructure.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync, readFileSync, existsSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

// ── atomicTransaction ───────────────────────────────────────────────────────

import { AtomicTransaction, atomicEdit } from '../../src/core/atomicTransaction.js'

describe('AtomicTransaction', () => {
  let dir = ''

  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'txn-')) })
  afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

  it('applies mutations atomically', async () => {
    const f1 = join(dir, 'a.txt')
    const f2 = join(dir, 'b.txt')
    writeFileSync(f1, 'hello')
    writeFileSync(f2, 'world')

    const txn = new AtomicTransaction()
    await txn.mutate(f1, 'HELLO')
    await txn.mutate(f2, 'WORLD')
    const result = await txn.commit()

    expect(result.ok).toBe(true)
    expect(readFileSync(f1, 'utf8')).toBe('HELLO')
    expect(readFileSync(f2, 'utf8')).toBe('WORLD')
    expect(existsSync(`${f1}.txn.${txn.id}.bak`)).toBe(false)
  })

  it('rolls back on failure', async () => {
    const f1 = join(dir, 'a.txt')
    writeFileSync(f1, 'original')

    const txn = new AtomicTransaction()
    await txn.snapshot(f1)
    await txn.mutate(f1, 'modified')
    const result = await txn.rollback()

    expect(result.rolledBack).toBe(true)
    expect(readFileSync(f1, 'utf8')).toBe('original')
  })

  it('mutateAll applies all or none', async () => {
    const f1 = join(dir, 'a.txt')
    const f2 = join(dir, 'b.txt')
    writeFileSync(f1, 'one')
    writeFileSync(f2, 'two')

    await atomicEdit([
      { filePath: f1, content: 'ONE' },
      { filePath: f2, content: 'TWO' },
    ])

    expect(readFileSync(f1, 'utf8')).toBe('ONE')
    expect(readFileSync(f2, 'utf8')).toBe('TWO')
  })

  it('handles new file creation and rollback', async () => {
    const newFile = join(dir, 'new.txt')

    const txn = new AtomicTransaction()
    await txn.mutate(newFile, 'created')
    expect(readFileSync(newFile, 'utf8')).toBe('created')

    const result = await txn.rollback()
    expect(result.rolledBack).toBe(true)
    // File deletion on Windows may need a tick to settle
    if (existsSync(newFile)) {
      await new Promise((r) => setTimeout(r, 50))
    }
    expect(existsSync(newFile)).toBe(false)
  })

  it('rejects double commit', async () => {
    const f = join(dir, 'a.txt')
    writeFileSync(f, 'x')
    const txn = new AtomicTransaction()
    await txn.mutate(f, 'y')
    const first = await txn.commit()
    expect(first.ok).toBe(true)
    const second = await txn.commit()
    expect(second.ok).toBe(false)
  })
})

// ── codeStructure ───────────────────────────────────────────────────────────

import { extractSymbols, analyzeFile, semanticDiff, findReferences } from '../../src/core/codeStructure.js'

describe('codeStructure', () => {
  let dir = ''

  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'cs-')) })
  afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

  it('extractSymbols finds functions and classes', () => {
    const content = `
export function hello() { return 1 }
async function fetchData() {}
class UserService {
  getUser(id: string) {}
}
export interface User { id: string }
export type Role = 'admin'
    `.trim()
    const symbols = extractSymbols('/test.ts', content)
    const names = symbols.map((s) => s.name)
    expect(names).toContain('hello')
    expect(names).toContain('fetchData')
    expect(names).toContain('UserService')
    expect(names).toContain('User')
    expect(names).toContain('Role')
    expect(symbols.find((s) => s.name === 'hello')!.exported).toBe(true)
  })

  it('extractSymbols finds arrow functions', () => {
    const content = `const doThing = async (x: number) => x + 1`
    const symbols = extractSymbols('/test.ts', content)
    expect(symbols.map((s) => s.name)).toContain('doThing')
  })

  it('analyzeFile returns full structure', () => {
    const f = join(dir, 'test.ts')
    writeFileSync(f, `
import { foo } from './bar'
// TODO: refactor this
export function main() { foo() }
    `.trim())
    const structure = analyzeFile(f)
    expect(structure.language).toBe('typescript')
    expect(structure.symbols.length).toBeGreaterThan(0)
    expect(structure.imports.length).toBe(1)
    expect(structure.todos.length).toBe(1)
    expect(structure.todos[0]).toContain('TODO')
  })

  it('semanticDiff detects added and removed symbols', () => {
    const old_ = `function foo() {}`
    const new_ = `function bar() {}`
    const diffs = semanticDiff(old_, new_, '/test.ts')
    const added = diffs.filter((d) => d.kind === 'added')
    const removed = diffs.filter((d) => d.kind === 'removed')
    expect(added.some((d) => d.symbol === 'bar')).toBe(true)
    expect(removed.some((d) => d.symbol === 'foo')).toBe(true)
  })

  it('findReferences finds symbol usage', () => {
    const f1 = join(dir, 'a.ts')
    const f2 = join(dir, 'b.ts')
    writeFileSync(f1, `const myFunc = () => {}; myFunc();`)
    writeFileSync(f2, `import { myFunc } from './a'; myFunc();`)
    const refs = findReferences('myFunc', dir)
    expect(refs.length).toBeGreaterThanOrEqual(2)
  })
})
