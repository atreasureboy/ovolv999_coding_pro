import { describe, it, expect, beforeEach } from 'vitest'
import {
  parseTscOutput,
  parseEslintJson,
  parseRuffJson,
  aggregateDiagnostics,
  filterDiagnostics,
  formatDiagnosticsResult,
  clearCache,
  type Diagnostic,
} from '../src/core/diagnostics.js'

describe('diagnostics', () => {
  beforeEach(() => {
    clearCache()
  })

  describe('parseTscOutput', () => {
    it('parses error lines', () => {
      const output = [
        'src/foo.ts(10,5): error TS2322: Type "string" is not assignable to type "number".',
        'src/bar.ts(20,10): warning TS6133: "x" is declared but never read.',
      ].join('\n')

      const diags = parseTscOutput(output, process.cwd())
      expect(diags).toHaveLength(2)
      // v0.6.0 (audit): relative() uses the platform separator
      // (src\foo.ts on win32) — compare separator-agnostic.
      expect(diags[0].filePath.replace(/\\/g, '/')).toBe('src/foo.ts')
      expect(diags[0].line).toBe(10)
      expect(diags[0].column).toBe(5)
      expect(diags[0].severity).toBe('error')
      expect(diags[0].code).toBe('TS2322')
      expect(diags[0].message).toContain('not assignable')
      expect(diags[0].source).toBe('tsc')
    })

    it('ignores non-diagnostic lines', () => {
      const output = 'some random output\nsrc/x.ts(1,1): error TS1: msg'
      const diags = parseTscOutput(output, process.cwd())
      expect(diags).toHaveLength(1)
    })

    it('handles empty output', () => {
      expect(parseTscOutput('', process.cwd())).toHaveLength(0)
    })

    it('handles multiple errors in same file', () => {
      const output = [
        'src/a.ts(1,1): error TS1: first',
        'src/a.ts(5,10): error TS2: second',
        'src/a.ts(10,3): warning TS3: third',
      ].join('\n')
      const diags = parseTscOutput(output, process.cwd())
      expect(diags).toHaveLength(3)
      // Separator-agnostic (see first test).
      expect(diags.every(d => d.filePath.replace(/\\/g, '/') === 'src/a.ts')).toBe(true)
    })
  })

  describe('parseEslintJson', () => {
    it('parses eslint JSON output', () => {
      const json = JSON.stringify([
        {
          filePath: '/project/src/a.js',
          messages: [
            { line: 5, column: 10, severity: 2, message: 'no-unused-vars', ruleId: 'no-unused-vars' },
            { line: 10, column: 3, severity: 1, message: 'indent', ruleId: 'indent' },
          ],
        },
      ])

      const diags = parseEslintJson(json, '/project')
      expect(diags).toHaveLength(2)
      expect(diags[0].severity).toBe('error')
      expect(diags[0].line).toBe(5)
      expect(diags[0].code).toBe('no-unused-vars')
      expect(diags[1].severity).toBe('warning')
    })

    it('handles empty results', () => {
      expect(parseEslintJson('[]', '/project')).toHaveLength(0)
    })

    it('handles invalid JSON', () => {
      expect(parseEslintJson('not json', '/project')).toHaveLength(0)
    })
  })

  describe('parseRuffJson', () => {
    it('parses ruff JSON output', () => {
      const json = JSON.stringify([
        {
          filename: 'src/main.py',
          location: { row: 10, column: 5 },
          end_location: { row: 10, column: 15 },
          code: 'F401',
          message: "'os' imported but unused",
          url: 'https://example.com',
        },
      ])

      const diags = parseRuffJson(json, '/project')
      expect(diags).toHaveLength(1)
      expect(diags[0].filePath).toBe('src/main.py')
      expect(diags[0].line).toBe(10)
      expect(diags[0].column).toBe(5)
      expect(diags[0].endLine).toBe(10)
      expect(diags[0].code).toBe('F401')
      expect(diags[0].source).toBe('ruff')
    })
  })

  describe('aggregateDiagnostics', () => {
    it('groups by file', () => {
      const diags: Diagnostic[] = [
        { filePath: 'a.ts', line: 1, column: 1, severity: 'error', message: 'e1', source: 'tsc' },
        { filePath: 'a.ts', line: 5, column: 1, severity: 'warning', message: 'w1', source: 'tsc' },
        { filePath: 'b.ts', line: 2, column: 1, severity: 'error', message: 'e2', source: 'tsc' },
      ]

      const result = aggregateDiagnostics(diags, 'tsc', 100)
      expect(result.files).toHaveLength(2)
      expect(result.totalErrors).toBe(2)
      expect(result.totalWarnings).toBe(1)
    })

    it('sorts files by error count', () => {
      const diags: Diagnostic[] = [
        { filePath: 'few.ts', line: 1, column: 1, severity: 'error', message: 'e', source: 'tsc' },
        { filePath: 'many.ts', line: 1, column: 1, severity: 'error', message: 'e1', source: 'tsc' },
        { filePath: 'many.ts', line: 2, column: 1, severity: 'error', message: 'e2', source: 'tsc' },
      ]

      const result = aggregateDiagnostics(diags, 'tsc', 0)
      expect(result.files[0].filePath).toBe('many.ts')
      expect(result.files[0].errorCount).toBe(2)
    })

    it('handles empty diagnostics', () => {
      const result = aggregateDiagnostics([], 'tsc', 0)
      expect(result.files).toHaveLength(0)
      expect(result.totalErrors).toBe(0)
    })
  })

  describe('filterDiagnostics', () => {
    const sampleDiags: Diagnostic[] = [
      { filePath: 'src/a.ts', line: 1, column: 1, severity: 'error', message: 'e1', source: 'tsc' },
      { filePath: 'src/a.ts', line: 5, column: 1, severity: 'warning', message: 'w1', source: 'tsc' },
      { filePath: 'src/b.ts', line: 10, column: 1, severity: 'error', message: 'e2', source: 'tsc' },
      { filePath: 'src/c.ts', line: 1, column: 1, severity: 'info', message: 'i1', source: 'tsc' },
    ]
    const result = aggregateDiagnostics(sampleDiags, 'tsc', 0)

    it('filters by file path', () => {
      const filtered = filterDiagnostics(result, { filePath: 'a.ts' })
      expect(filtered).toHaveLength(2)
      expect(filtered.every(d => d.filePath.includes('a.ts'))).toBe(true)
    })

    it('filters by severity', () => {
      const errors = filterDiagnostics(result, { severity: 'error' })
      expect(errors).toHaveLength(2)
      expect(errors.every(d => d.severity === 'error')).toBe(true)
    })

    it('applies limit', () => {
      const limited = filterDiagnostics(result, { limit: 1 })
      expect(limited).toHaveLength(1)
    })

    it('returns all when no filters', () => {
      const all = filterDiagnostics(result)
      expect(all).toHaveLength(4)
    })
  })

  describe('formatDiagnosticsResult', () => {
    it('shows clean message when no diagnostics', () => {
      const result = aggregateDiagnostics([], 'tsc', 50)
      const out = formatDiagnosticsResult(result)
      expect(out).toContain('No diagnostics')
      expect(out).toContain('tsc')
    })

    it('shows summary counts', () => {
      const diags: Diagnostic[] = [
        { filePath: 'a.ts', line: 1, column: 1, severity: 'error', message: 'e1', source: 'tsc' },
        { filePath: 'a.ts', line: 5, column: 1, severity: 'warning', message: 'w1', source: 'tsc' },
      ]
      const result = aggregateDiagnostics(diags, 'tsc', 100)
      const out = formatDiagnosticsResult(result)
      expect(out).toContain('1 errors')
      expect(out).toContain('1 warnings')
    })

    it('lists files and diagnostics', () => {
      const diags: Diagnostic[] = [
        { filePath: 'a.ts', line: 1, column: 1, severity: 'error', message: 'e1', source: 'tsc', code: 'TS1' },
      ]
      const result = aggregateDiagnostics(diags, 'tsc', 0)
      const out = formatDiagnosticsResult(result)
      expect(out).toContain('a.ts')
      expect(out).toContain('e1')
      expect(out).toContain('[TS1]')
    })

    it('truncates long lists', () => {
      const diags: Diagnostic[] = Array.from({ length: 30 }, (_, i) => ({
        filePath: `file${i}.ts`,
        line: 1,
        column: 1,
        severity: 'error' as const,
        message: `error ${i}`,
        source: 'tsc',
      }))
      const result = aggregateDiagnostics(diags, 'tsc', 0)
      const out = formatDiagnosticsResult(result, 5, 3)
      expect(out).toContain('more files')
    })
  })
})
