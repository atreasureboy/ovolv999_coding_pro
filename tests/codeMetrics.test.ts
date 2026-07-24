import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import {
  analyzeFile, analyzeProjectFiles,
  detectLanguage,
  formatFileMetrics, formatProjectMetrics, formatBytes,
  assessHealth, formatHealthAssessment,
} from '../src/core/codeMetrics.js'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

function makeTempDir(): string {
  return mkdtempSync(join(tmpdir(), 'ovolv999-metrics-'))
}

describe('Code Metrics Analyzer', () => {
  let cwd: string

  beforeEach(() => { cwd = makeTempDir() })
  afterEach(() => { rmSync(cwd, { recursive: true, force: true }) })

  describe('detectLanguage', () => {
    it('detects TypeScript', () => {
      expect(detectLanguage('foo.ts')).toBe('typescript')
      expect(detectLanguage('foo.tsx')).toBe('typescript')
    })

    it('detects JavaScript', () => {
      expect(detectLanguage('foo.js')).toBe('javascript')
      expect(detectLanguage('foo.mjs')).toBe('javascript')
    })

    it('detects Python', () => {
      expect(detectLanguage('foo.py')).toBe('python')
    })

    it('detects other languages', () => {
      expect(detectLanguage('foo.go')).toBe('go')
      expect(detectLanguage('foo.rs')).toBe('rust')
      expect(detectLanguage('foo.rb')).toBe('ruby')
    })

    it('returns unknown for unrecognized extensions', () => {
      expect(detectLanguage('foo.unknown')).toBe('unknown')
    })
  })

  describe('analyzeFile', () => {
    it('returns null for missing file', () => {
      expect(analyzeFile(join(cwd, 'nope.ts'))).toBeNull()
    })

    it('counts lines correctly', () => {
      const filePath = join(cwd, 'test.ts')
      writeFileSync(filePath, [
        'import { foo } from "bar"',
        '',
        '// This is a comment',
        'const x = 1;',
        'const y = 2; // inline',
        '',
        'function add(a, b) {',
        '  return a + b',
        '}',
      ].join('\n'))
      const m = analyzeFile(filePath)!
      expect(m.totalLines).toBe(9)
      expect(m.blankLines).toBe(2)
      expect(m.commentLines).toBeGreaterThanOrEqual(1)
      expect(m.codeLines).toBeGreaterThan(0)
    })

    it('counts functions in TypeScript', () => {
      const filePath = join(cwd, 'funcs.ts')
      writeFileSync(filePath, [
        'function foo() {}',
        'function bar() {}',
        'const baz = (x) => x',
        'const qux = async () => {}',
      ].join('\n'))
      const m = analyzeFile(filePath)!
      expect(m.functionCount).toBeGreaterThanOrEqual(4)
    })

    it('counts classes', () => {
      const filePath = join(cwd, 'classes.ts')
      writeFileSync(filePath, [
        'class Foo {}',
        'class Bar extends Foo {}',
      ].join('\n'))
      const m = analyzeFile(filePath)!
      expect(m.classCount).toBe(2)
    })

    it('counts imports and exports', () => {
      const filePath = join(cwd, 'mod.ts')
      writeFileSync(filePath, [
        'import { foo } from "./foo"',
        'import { bar } from "./bar"',
        'export const x = 1',
        'export function y() {}',
        'export default z',
      ].join('\n'))
      const m = analyzeFile(filePath)!
      expect(m.importedCount).toBe(2)
      expect(m.exportedCount).toBe(3)
    })

    it('counts TODOs', () => {
      const filePath = join(cwd, 'todos.ts')
      writeFileSync(filePath, [
        '// TODO: fix this',
        '// FIXME: broken',
        'const x = 1 // HACK: workaround',
        '// normal comment',
      ].join('\n'))
      const m = analyzeFile(filePath)!
      expect(m.todoCount).toBe(3)
    })

    it('calculates nesting depth', () => {
      const filePath = join(cwd, 'nested.ts')
      writeFileSync(filePath, [
        'function foo() {',
        '  if (true) {',
        '    if (true) {',
        '      if (true) {',
        '        console.log("deep")',
        '      }',
        '    }',
        '  }',
        '}',
      ].join('\n'))
      const m = analyzeFile(filePath)!
      expect(m.maxNestingDepth).toBeGreaterThanOrEqual(4)
    })

    it('detects file size', () => {
      const filePath = join(cwd, 'sized.ts')
      writeFileSync(filePath, 'const x = 1\n')
      const m = analyzeFile(filePath)!
      expect(m.fileSizeBytes).toBeGreaterThan(0)
    })

    it('calculates complexity', () => {
      const filePath = join(cwd, 'complex.ts')
      writeFileSync(filePath, [
        'if (a && b || c) {',
        '  for (let i = 0; i < 10; i++) {',
        '    while (x) {',
        '      switch (y) {',
        '        case 1: break',
        '      }',
        '    }',
        '  }',
        '}',
      ].join('\n'))
      const m = analyzeFile(filePath)!
      expect(m.complexity).toBeGreaterThan(5)
    })

    it('calculates duplicate ratio', () => {
      const filePath = join(cwd, 'dups.ts')
      writeFileSync(filePath, [
        'const x = 1',
        'const x = 1',
        'const x = 1',
        'const y = 2',
      ].join('\n'))
      const m = analyzeFile(filePath)!
      expect(m.duplicateLineRatio).toBeGreaterThan(0)
    })

    it('returns maintainability index', () => {
      const filePath = join(cwd, 'mi.ts')
      writeFileSync(filePath, 'const x = 1\n')
      const m = analyzeFile(filePath)!
      expect(m.maintainabilityIndex).toBeGreaterThanOrEqual(0)
      expect(m.maintainabilityIndex).toBeLessThanOrEqual(100)
    })

    it('handles Python files', () => {
      const filePath = join(cwd, 'script.py')
      writeFileSync(filePath, [
        'import os',
        '',
        'def main():',
        '    if True:',
        '        print("hello")',
        '',
        'class Foo:',
        '    pass',
      ].join('\n'))
      const m = analyzeFile(filePath)!
      expect(m.language).toBe('python')
      expect(m.functionCount).toBeGreaterThanOrEqual(1)
      expect(m.classCount).toBe(1)
    })
  })

  describe('analyzeProjectFiles', () => {
    beforeEach(() => {
      writeFileSync(join(cwd, 'a.ts'), 'const x = 1\n')
      writeFileSync(join(cwd, 'b.ts'), 'const y = 2\n')
      writeFileSync(join(cwd, 'c.js'), 'const z = 3\n')
    })

    it('analyzes multiple files', () => {
      const metrics = analyzeProjectFiles([
        join(cwd, 'a.ts'),
        join(cwd, 'b.ts'),
        join(cwd, 'c.js'),
      ])
      expect(metrics.files).toHaveLength(3)
    })

    it('calculates totals', () => {
      const metrics = analyzeProjectFiles([
        join(cwd, 'a.ts'),
        join(cwd, 'b.ts'),
      ])
      expect(metrics.totals.totalLines).toBeGreaterThan(0)
      expect(metrics.totals.codeLines).toBeGreaterThan(0)
    })

    it('groups by language', () => {
      const metrics = analyzeProjectFiles([
        join(cwd, 'a.ts'),
        join(cwd, 'b.ts'),
        join(cwd, 'c.js'),
      ])
      expect(metrics.filesByLanguage.typescript).toBe(2)
      expect(metrics.filesByLanguage.javascript).toBe(1)
    })

    it('sorts top complex files', () => {
      writeFileSync(join(cwd, 'complex.ts'), [
        'if (a && b || c) { for (let i=0;i<10;i++) { while(x) {} } }',
      ].join('\n'))
      const metrics = analyzeProjectFiles([
        join(cwd, 'a.ts'),
        join(cwd, 'complex.ts'),
      ])
      expect(metrics.topComplexFiles[0].path).toBe('complex.ts')
    })

    it('sorts largest files', () => {
      writeFileSync(join(cwd, 'big.ts'), 'x\n'.repeat(100))
      const metrics = analyzeProjectFiles([
        join(cwd, 'a.ts'),
        join(cwd, 'big.ts'),
      ])
      expect(metrics.largestFiles[0].path).toBe('big.ts')
    })

    it('respects maxFiles limit', () => {
      const metrics = analyzeProjectFiles(
        [join(cwd, 'a.ts'), join(cwd, 'b.ts'), join(cwd, 'c.js')],
        { maxFiles: 2 },
      )
      expect(metrics.files).toHaveLength(2)
    })
  })

  describe('formatBytes', () => {
    it('formats bytes', () => {
      expect(formatBytes(500)).toBe('500B')
      expect(formatBytes(1024)).toBe('1.0KB')
      expect(formatBytes(1048576)).toBe('1.0MB')
    })
  })

  describe('formatFileMetrics', () => {
    it('includes key metrics', () => {
      const filePath = join(cwd, 'test.ts')
      writeFileSync(filePath, 'const x = 1\n')
      const m = analyzeFile(filePath)!
      const out = formatFileMetrics(m)
      expect(out).toContain('test.ts')
      expect(out).toContain('Lines:')
      expect(out).toContain('Complexity:')
      expect(out).toContain('Maintainability:')
    })
  })

  describe('formatProjectMetrics', () => {
    it('includes totals and languages', () => {
      writeFileSync(join(cwd, 'a.ts'), 'const x = 1\n')
      writeFileSync(join(cwd, 'b.py'), 'x = 1\n')
      const metrics = analyzeProjectFiles([
        join(cwd, 'a.ts'),
        join(cwd, 'b.py'),
      ])
      const out = formatProjectMetrics(metrics)
      expect(out).toContain('Files analyzed')
      expect(out).toContain('Total lines')
      expect(out).toContain('typescript')
      expect(out).toContain('python')
    })
  })

  describe('assessHealth', () => {
    it('gives good score for simple file', () => {
      const filePath = join(cwd, 'simple.ts')
      writeFileSync(filePath, 'const x = 1\n')
      const m = analyzeFile(filePath)!
      const health = assessHealth(m)
      expect(health.score).toBeGreaterThanOrEqual(80)
      expect(health.grade).toMatch(/^[AB]$/)
    })

    it('penalizes high complexity', () => {
      const filePath = join(cwd, 'complex.ts')
      writeFileSync(filePath, [
        ...Array(30).fill('if (x) { if (y) { if (z) { } } }'),
      ].join('\n'))
      const m = analyzeFile(filePath)!
      const health = assessHealth(m)
      expect(health.score).toBeLessThan(100)
      expect(health.issues.some(i => i.message.includes('complexity'))).toBe(true)
    })

    it('penalizes deep nesting', () => {
      const filePath = join(cwd, 'nested.ts')
      writeFileSync(filePath, [
        'function f() {',
        ...Array(8).fill('  if (x) {').map((s, i) => '  '.repeat(i + 1) + s),
        '  }',
        '}',
      ].join('\n'))
      const m = analyzeFile(filePath)!
      const health = assessHealth(m)
      expect(health.issues.some(i => i.severity === 'critical')).toBe(true)
    })

    it('penalizes long files', () => {
      const filePath = join(cwd, 'long.ts')
      writeFileSync(filePath, 'const x = 1\n'.repeat(600))
      const m = analyzeFile(filePath)!
      const health = assessHealth(m)
      expect(health.issues.some(i => i.message.includes('Long file'))).toBe(true)
    })

    it('penalizes many TODOs', () => {
      const filePath = join(cwd, 'todos.ts')
      writeFileSync(filePath, Array(10).fill('// TODO: fix').join('\n') + '\n')
      const m = analyzeFile(filePath)!
      const health = assessHealth(m)
      expect(health.issues.some(i => i.message.includes('TODO'))).toBe(true)
    })

    it('provides recommendations', () => {
      const filePath = join(cwd, 'bad.ts')
      writeFileSync(filePath, 'if (a && b || c) { for (let i=0;i<10;i++) { while(x) { if (y) {} } } }\n'.repeat(20))
      const m = analyzeFile(filePath)!
      const health = assessHealth(m)
      expect(health.recommendations.length).toBeGreaterThan(0)
    })
  })

  describe('formatHealthAssessment', () => {
    it('shows grade and score', () => {
      const filePath = join(cwd, 'test.ts')
      writeFileSync(filePath, 'const x = 1\n')
      const m = analyzeFile(filePath)!
      const health = assessHealth(m)
      const out = formatHealthAssessment(health)
      expect(out).toContain('/100')
      expect(out).toMatch(/[A-F]/)
    })

    it('shows no issues for clean code', () => {
      const filePath = join(cwd, 'clean.ts')
      writeFileSync(filePath, 'const greeting = "hello"\n')
      const m = analyzeFile(filePath)!
      const health = assessHealth(m)
      const out = formatHealthAssessment(health)
      expect(out).toContain('No issues')
    })
  })
})
