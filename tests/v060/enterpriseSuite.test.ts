/**
 * v0.6.0 enterprise test suite — covers every module added in the
 * Codex/OpenCode-inspired hardening rounds:
 *
 *   - AtomicTransaction   (multi-file atomic edits)
 *   - RetryManager        (exponential backoff + circuit breaker)
 *   - SymbolIndex         (codebase-wide symbol lookup)
 *   - CodeReview          (deterministic change review)
 *   - LazyTool            (deferred instantiation)
 *   - ProjectExplorer     (structure discovery)
 *
 * All tests are pure/unit-level (no network, no LLM). Cross-platform.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync, mkdirSync, readFileSync, existsSync } from 'fs'
import { tmpdir } from 'os'
import { join, isAbsolute } from 'path'

import { AtomicTransaction, atomicEdit } from '../../src/core/atomicTransaction.js'
import { RetryManager, CircuitBreaker, isRetryableError } from '../../src/core/retryManager.js'

import { SymbolIndex } from '../../src/core/symbolIndex.js'
import { reviewChanges, formatReviewReport, readChangesFromDisk } from '../../src/core/codeReview.js'

import { createLazyTool, type LazyTool } from '../../src/core/lazyTool.js'
import { exploreProject, formatProjectOverview } from '../../src/core/projectExplorer.js'
import { analyzeFile, semanticDiff, findReferences } from '../../src/core/codeStructure.js'

// ── Helpers ────────────────────────────────────────────────────────────────

let dir = ''
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ovolv999-v060-'))
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

function write(rel: string, content: string): string {
  // Accept both absolute and dir-relative paths.
  const full = isAbsolute(rel) ? rel : join(dir, rel)
  mkdirSync(join(full, '..'), { recursive: true })
  writeFileSync(full, content)
  return full
}

// ── AtomicTransaction ──────────────────────────────────────────────────────

describe('AtomicTransaction', () => {
  it('commits mutations atomically and persists files', async () => {
    const f1 = join(dir, 'a.txt')
    const f2 = join(dir, 'b.txt')
    const txn = new AtomicTransaction()
    await txn.mutate(f1, 'hello')
    await txn.mutate(f2, 'world')
    const res = await txn.commit()
    expect(res.ok).toBe(true)
    expect(res.mutations).toBe(2)
    expect(readFileSync(f1, 'utf8')).toBe('hello')
    expect(readFileSync(f2, 'utf8')).toBe('world')
  })

  it('rolls back all mutations on failure', async () => {
    const f1 = join(dir, 'x.txt')
    write(f1, 'original')
    const txn = new AtomicTransaction()
    await txn.mutate(f1, 'changed')
    const res = await txn.rollback()
    expect(res.rolledBack).toBe(true)
    expect(readFileSync(f1, 'utf8')).toBe('original')
  })

  it('mutateAll applies all-or-nothing', async () => {
    const f1 = join(dir, 'm1.txt')
    const f2 = join(dir, 'm2.txt')
    const txn = new AtomicTransaction()
    await txn.mutateAll([
      { filePath: f1, content: 'one' },
      { filePath: f2, content: 'two' },
    ])
    expect(readFileSync(f1, 'utf8')).toBe('one')
    expect(readFileSync(f2, 'utf8')).toBe('two')
  })

  it('rejects double commit', async () => {
    const f = join(dir, 'dc.txt')
    write(f, 'x')
    const txn = new AtomicTransaction()
    await txn.mutate(f, 'y')
    const first = await txn.commit()
    expect(first.ok).toBe(true)
    const second = await txn.commit()
    expect(second.ok).toBe(false)
  })

  it('atomicEdit helper writes + commits', async () => {
    const f = join(dir, 'ae.txt')
    const res = await atomicEdit([{ filePath: f, content: 'content' }])
    expect(res.ok).toBe(true)
    expect(readFileSync(f, 'utf8')).toBe('content')
  })

  it('abort cleans up without touching files', async () => {
    const f = join(dir, 'ab.txt')
    write(f, 'keep')
    const txn = new AtomicTransaction()
    await txn.mutate(f, 'discard')
    await txn.abort()
    expect(readFileSync(f, 'utf8')).toBe('keep')
  })
})

// ── RetryManager ───────────────────────────────────────────────────────────

describe('RetryManager', () => {
  it('succeeds on first attempt', async () => {
    const rm = new RetryManager({ maxAttempts: 3, baseDelayMs: 1 })
    const res = await rm.run(async () => 'value')
    expect(res.ok).toBe(true)
    if (res.ok) expect(res.value).toBe('value')
    expect(res.attempts).toBe(1)
  })

  it('retries transient failures then succeeds', async () => {
    const rm = new RetryManager({ maxAttempts: 4, baseDelayMs: 1, maxDelayMs: 5 })
    let calls = 0
    const res = await rm.run(async () => {
      calls++
      if (calls < 3) throw Object.assign(new Error('rate limited'), { status: 429 })
      return 'ok'
    })
    expect(res.ok).toBe(true)
    expect(calls).toBe(3)
  })

  it('gives up after max attempts on retryable errors', async () => {
    const rm = new RetryManager({ maxAttempts: 2, baseDelayMs: 1, maxDelayMs: 2 })
    let calls = 0
    const res = await rm.run(async () => {
      calls++
      throw Object.assign(new Error('timeout'), { status: 503 })
    })
    expect(res.ok).toBe(false)
    expect(calls).toBe(2)
  })

  it('does NOT retry non-retryable errors (4xx)', async () => {
    const rm = new RetryManager({ maxAttempts: 3, baseDelayMs: 1 })
    let calls = 0
    const res = await rm.run(async () => {
      calls++
      throw Object.assign(new Error('bad request'), { status: 400 })
    })
    expect(res.ok).toBe(false)
    expect(calls).toBe(1)
  })

  it('respects abort signal', async () => {
    const rm = new RetryManager({ maxAttempts: 5, baseDelayMs: 1 })
    const ac = new AbortController()
    ac.abort()
    const res = await rm.run(async () => { throw new Error('x') }, { signal: ac.signal })
    expect(res.ok).toBe(false)
  })

  it('isRetryableError classifies correctly', () => {
    expect(isRetryableError(Object.assign(new Error('x'), { status: 429 }))).toBe(true)
    expect(isRetryableError(Object.assign(new Error('x'), { status: 500 }))).toBe(true)
    expect(isRetryableError(Object.assign(new Error('x'), { status: 400 }))).toBe(false)
    expect(isRetryableError(Object.assign(new Error('ECONNRESET'), { code: 'ECONNRESET' }))).toBe(true)
    expect(isRetryableError(new Error('upstream timeout'))).toBe(true)
    expect(isRetryableError(new Error('nope'))).toBe(false)
  })

  it('circuit breaker opens after threshold and rejects fast', async () => {
    const cb = new CircuitBreaker({ failureThreshold: 2, cooldownMs: 60_000 })
    expect(cb.allowRequest()).toBe(true)
    cb.recordFailure()
    cb.recordFailure()
    expect(cb.currentState.state).toBe('open')
    expect(cb.allowRequest()).toBe(false)
    cb.recordSuccess()
    expect(cb.currentState.state).toBe('closed')
    expect(cb.allowRequest()).toBe(true)
  })
})

// ── SymbolIndex ────────────────────────────────────────────────────────────

describe('SymbolIndex', () => {
  it('indexes symbols from TS files and looks them up', async () => {
    const src = join(dir, 'src')
    mkdirSync(src, { recursive: true })
    writeFileSync(join(src, 'lib.ts'), `
export function hello() { return 1 }
export class Greeter { greet() {} }
export interface User { id: string }
const internal = 42
`)
    const idx = new SymbolIndex(dir)
    await idx.build()
    expect(idx.stats().files).toBeGreaterThan(0)

    const hello = idx.lookup('hello')
    expect(hello.length).toBe(1)
    expect(hello[0].exported).toBe(true)
    expect(hello[0].kind).toBe('function')

    const greeter = idx.lookup('Greeter')
    expect(greeter.length).toBe(1)
    expect(greeter[0].kind).toBe('class')
  })

  it('finds references across files', async () => {
    const src = join(dir, 'src2')
    mkdirSync(src, { recursive: true })
    writeFileSync(join(src, 'a.ts'), 'export const TARGET = 1\n')
    writeFileSync(join(src, 'b.ts'), "import { TARGET } from './a'\nconsole.log(TARGET)\n")
    const idx = new SymbolIndex(dir)
    await idx.build()
    const refs = idx.findReferences('TARGET')
    expect(refs.length).toBeGreaterThanOrEqual(2)
  })

  it('prefix search finds matching symbols', async () => {
    const src = join(dir, 'src3')
    mkdirSync(src, { recursive: true })
    writeFileSync(join(src, 'x.ts'), 'export function parseData() {}\nexport function parseXml() {}\n')
    const idx = new SymbolIndex(dir)
    await idx.build()
    const hits = idx.search('parse')
    expect(hits.length).toBe(2)
  })

  it('byKind filters by symbol kind', async () => {
    const src = join(dir, 'src4')
    mkdirSync(src, { recursive: true })
    writeFileSync(join(src, 'y.ts'), 'export function f() {}\nexport interface I {}\n')
    const idx = new SymbolIndex(dir)
    await idx.build()
    const fns = idx.byKind('function')
    expect(fns.some(x => x.name === 'f')).toBe(true)
    expect(fns.some(x => x.name === 'I')).toBe(false)
  })
})

// ── CodeReview ─────────────────────────────────────────────────────────────

describe('CodeReview', () => {
  it('flags hardcoded secrets as blockers', () => {
    const report = reviewChanges([{
      file: 'src/creds.ts',
      newContent: 'const API_KEY = "sk-1234567890abcdef1234567890abcdef"\n',
    }])
    expect(report.summary.blockers).toBeGreaterThan(0)
    expect(report.findings.some(f => f.rule === 'hardcoded-secret')).toBe(true)
  })

  it('flags debug statements and unsafe eval', () => {
    const report = reviewChanges([{
      file: 'src/debug.ts',
      newContent: 'console.log("hi")\neval("1+1")\n',
    }])
    expect(report.findings.some(f => f.rule === 'console-debug')).toBe(true)
    expect(report.findings.some(f => f.rule === 'eval-usage')).toBe(true)
  })

  it('clean code scores 100', () => {
    const report = reviewChanges([{
      file: 'src/clean.ts',
      newContent: 'export function add(a: number, b: number): number {\n  return a + b\n}\n',
    }])
    expect(report.score).toBe(100)
    expect(report.findings).toHaveLength(0)
  })

  it('readChangesFromDisk reads existing files', () => {
    const f = write('r.txt', 'content')
    const changes = readChangesFromDisk(dir, [{ file: 'r.txt', newContent: 'updated' }])
    expect(changes[0].oldContent).toBe('content')
    expect(changes[0].newContent).toBe('updated')
    expect(existsSync(f)).toBe(true)
  })

  it('formatReviewReport is human-readable', () => {
    const report = reviewChanges([{ file: 'a.ts', newContent: 'const X = "sk-1234567890abcdef1234567890abcdef"\n' }])
    const text = formatReviewReport(report, dir)
    expect(text).toContain('Code Review Score')
    expect(text).toContain('BLOCKERS')
  })
})

// ── LazyTool ───────────────────────────────────────────────────────────────

describe('LazyTool', () => {
  it('defers instantiation until first execute', async () => {
    let created = 0
    const tool: LazyTool = createLazyTool({
      name: 'Lazy',
      definition: {
        type: 'function',
        function: { name: 'Lazy', description: 'lazy', parameters: { type: 'object', properties: {} } },
      },
      factory: () => {
        created++
        return {
          name: 'Lazy',
          definition: { type: 'function', function: { name: 'Lazy', description: 'lazy', parameters: { type: 'object', properties: {} } } },
          execute: async () => ({ content: 'done', isError: false }),
        }
      },
    })
    expect(created).toBe(0)
    const res = await tool.execute({}, {} as never)
    expect(created).toBe(1)
    expect(res.content).toBe('done')
  })

  it('reuses the same instance after first creation', async () => {
    let created = 0
    const tool = createLazyTool({
      name: 'Lazy2',
      definition: { type: 'function', function: { name: 'Lazy2', description: 'x', parameters: { type: 'object', properties: {} } } },
      factory: () => {
        created++
        return {
          name: 'Lazy2',
          definition: { type: 'function', function: { name: 'Lazy2', description: 'x', parameters: { type: 'object', properties: {} } } },
          execute: async () => ({ content: 'ok', isError: false }),
        }
      },
    })
    await tool.execute({}, {} as never)
    await tool.execute({}, {} as never)
    expect(created).toBe(1)
  })
})


// ── ProjectExplorer ────────────────────────────────────────────────────────

describe('ProjectExplorer', () => {
  it('discovers languages and structure', () => {
    write('package.json', JSON.stringify({ name: 'test', scripts: { build: 'tsc' } }))
    write('src/index.ts', 'export const a = 1\n')
    write('src/helper.py', 'def f():\n  pass\n')
    const ov = exploreProject(dir)
    expect(ov.languages.some(l => l.name === 'TypeScript')).toBe(true)
    expect(ov.languages.some(l => l.name === 'Python')).toBe(true)
    expect(ov.packageManager).toBeTruthy()
  })

  it('detects entry points and git', () => {
    write('src/main.ts', 'console.log("hi")\n')
    mkdirSync(join(dir, '.git'), { recursive: true })
    const ov = exploreProject(dir)
    expect(ov.hasGit).toBe(true)
    expect(ov.entryPoints.length).toBeGreaterThan(0)
  })

  it('formatProjectOverview renders text', () => {
    write('README.md', '# test\n')
    const ov = exploreProject(dir)
    const text = formatProjectOverview(ov)
    expect(text).toContain('Project Overview')
  })
})

// ── CodeStructure (integration) ────────────────────────────────────────────

describe('CodeStructure integration', () => {
  it('analyzeFile extracts symbols, imports, todos', () => {
    const f = write('src/svc.ts', `
import { z } from 'zod'
// TODO: refactor
export class UserService {
  async getUser(id: string) {}
}
export interface User { id: string }
`)
    const structure = analyzeFile(f)
    expect(structure.symbols.some(s => s.name === 'UserService')).toBe(true)
    expect(structure.symbols.some(s => s.name === 'User' && s.kind === 'interface')).toBe(true)
    expect(structure.imports.some(i => i.source === 'zod')).toBe(true)
    expect(structure.todos.length).toBeGreaterThan(0)
  })

  it('semanticDiff detects symbol-level changes', () => {
    const f = join(dir, 'diff.ts')
    const oldSrc = 'export function foo() { return 1 }\nexport function bar() { return 2 }\n'
    const newSrc = 'export function foo() { return 1 }\nexport function bar() { return 3 }\nexport function baz() { return 4 }\n'
    const diffs = semanticDiff(oldSrc, newSrc, f)
    expect(diffs.some(d => d.kind === 'added' && d.symbol === 'baz')).toBe(true)
  })

  it('findReferences locates usages', () => {
    const src = join(dir, 'refsrc')
    mkdirSync(src, { recursive: true })
    writeFileSync(join(src, 'def.ts'), 'export const shared = 1\n')
    writeFileSync(join(src, 'use.ts'), 'import { shared } from "./def"\nconsole.log(shared)\n')
    const refs = findReferences('shared', src)
    expect(refs.length).toBeGreaterThanOrEqual(2)
  })
})
