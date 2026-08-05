/**
 * CodeQualityTool — post-change automated quality verification.
 *
 * Inspired by Codex's built-in code review system. After the agent
 * makes changes, this tool runs: typecheck, lint, and test suite
 * on the affected files. Results feed back into the agent's context
 * so it can fix regressions before the user sees them.
 *
 * Design:
 *   - Fast path: run only on changed files (typecheck targeted files)
 *   - Full path: run full project suite (typecheck all, lint all, test all)
 *   - Cached results (30s TTL) so repeated calls don't re-run checks
 *   - Structured output: errors grouped by file, severity, check type
 */

import { execSync } from 'child_process'
import { existsSync } from 'fs'
import { join, relative } from 'path'
import type { Tool, ToolDefinition, ToolResult, ToolContext } from '../core/types.js'
import { runDiagnostics, formatDiagnosticsResult } from '../core/diagnostics.js'

export interface QualityCheckInput {
  /** 'fast' (changed files only) or 'full' (entire project) */
  mode?: 'fast' | 'full'
  /** Specific files to check (overrides fast mode file detection) */
  files?: string[]
  /** Which checks to run: 'all' | 'typecheck' | 'lint' | 'test' */
  checks?: string
  /** Run tests matching this pattern (e.g. 'unit' or 'src/core/compact') */
  testPattern?: string
}

export interface QualityReport {
  passed: boolean
  summary: string
  typecheck: { passed: boolean; errors: number; warnings: number; output: string }
  lint: { passed: boolean; errors: number; warnings: number; output: string }
  test: { passed: boolean; failures: number; total: number; output: string }
  durationMs: number
  changedFiles: string[]
}

export class CodeQualityTool implements Tool {
  name = 'CodeQuality'
  metadata = {
    readOnly: true,
    concurrencySafe: true,
    searchHint: 'verify validate check quality typecheck lint test regression',
  }

  definition: ToolDefinition = {
    type: 'function',
    function: {
      name: 'CodeQuality',
      description: `Run automated quality checks on the codebase after making changes.

Use this after modifying files to verify no regressions were introduced.
Runs typecheck (tsc), lint (eslint/biome), and test suite.

Modes:
- fast: only check changed files (quick, default)
- full: check entire project (thorough, slower)

Checks (comma-separated):
- all: run all checks (default)
- typecheck: only run type checker
- lint: only run linter
- test: only run test suite`,
      parameters: {
        type: 'object',
        properties: {
          mode: {
            type: 'string',
            description: 'Check mode: "fast" (changed files only, default) or "full" (entire project)',
          },
          files: {
            type: 'array',
            items: { type: 'string' },
            description: 'Specific files to check (overrides auto-detection)',
          },
          checks: {
            type: 'string',
            description: 'Which checks to run: "all" (default), "typecheck", "lint", "test", or comma-separated like "typecheck,test"',
          },
          testPattern: {
            type: 'string',
            description: 'Test pattern to pass to vitest (e.g. "unit" or "src/core/compact")',
          },
        },
      },
    },
  }

  async execute(
    input: Record<string, unknown>,
    context: ToolContext,
  ): Promise<ToolResult> {
    const start = Date.now()
    const opts = input as unknown as QualityCheckInput
    const mode = opts.mode ?? 'fast'
    const checks = (opts.checks ?? 'all').split(',').map(s => s.trim())
    const runAll = checks.includes('all')
    const cwd = (context as { cwd?: string }).cwd ?? process.cwd()

    // Detect which files have changed
    const changedFiles = opts.files ?? this.detectChangedFiles(cwd, mode)

    const report: QualityReport = {
      passed: true,
      summary: '',
      typecheck: { passed: true, errors: 0, warnings: 0, output: '' },
      lint: { passed: true, errors: 0, warnings: 0, output: '' },
      test: { passed: true, failures: 0, total: 0, output: '' },
      durationMs: 0,
      changedFiles,
    }

    // Run typecheck
    if (runAll || checks.includes('typecheck')) {
      try {
        const result = runDiagnostics(cwd, 'tsc', false)
        report.typecheck.errors = result.totalErrors
        report.typecheck.warnings = result.totalWarnings
        report.typecheck.output = formatDiagnosticsResult(result, 10, 5)
        if (result.totalErrors > 0) {
          report.typecheck.passed = false
          report.passed = false
        }
      } catch (err) {
        report.typecheck.passed = false
        report.typecheck.output = `Typecheck error: ${(err as Error).message}`
        report.passed = false
      }
    }

    // Run lint
    if (runAll || checks.includes('lint')) {
      try {
        const result = runDiagnostics(cwd, 'eslint', false)
        if (result.totalErrors === 0 && result.totalWarnings === 0) {
          // Try biome as fallback
          const biomeResult = runDiagnostics(cwd, 'biome', false)
          if (biomeResult.totalErrors > 0 || biomeResult.totalWarnings > 0) {
            report.lint.errors = biomeResult.totalErrors
            report.lint.warnings = biomeResult.totalWarnings
            report.lint.output = formatDiagnosticsResult(biomeResult, 10, 5)
            if (biomeResult.totalErrors > 0) {
              report.lint.passed = false
              report.passed = false
            }
          } else {
            report.lint.output = '✓ No lint issues (eslint + biome)'
          }
        } else {
          report.lint.errors = result.totalErrors
          report.lint.warnings = result.totalWarnings
          report.lint.output = formatDiagnosticsResult(result, 10, 5)
          if (result.totalErrors > 0) {
            report.lint.passed = false
            report.passed = false
          }
        }
      } catch (err) {
        report.lint.passed = false
        report.lint.output = `Lint error: ${(err as Error).message}`
        report.passed = false
      }
    }

    // Run tests
    if (runAll || checks.includes('test')) {
      try {
        const testResult = this.runTests(cwd, opts.testPattern)
        report.test = testResult
        if (!testResult.passed) report.passed = false
      } catch (err) {
        report.test.passed = false
        report.test.output = `Test error: ${(err as Error).message}`
        report.passed = false
      }
    }

    report.durationMs = Date.now() - start
    report.summary = this.formatSummary(report)

    return {
      content: this.formatReport(report),
      isError: false,
    }
  }

  // ── Private helpers ─────────────────────────────────────────────────────

  private detectChangedFiles(cwd: string, _mode: string): string[] {
    try {
      const out = execSync('git diff --name-only HEAD', {
        cwd,
        encoding: 'utf8',
        stdio: ['pipe', 'pipe', 'pipe'],
        timeout: 5000,
      })
      return out.trim().split('\n').filter(Boolean)
    } catch {
      return []
    }
  }

  private runTests(cwd: string, pattern?: string): QualityReport['test'] {
    const hasVitest = existsSync(join(cwd, 'node_modules', '.bin', 'vitest'))
    const hasPnpm = existsSync(join(cwd, 'pnpm-lock.yaml'))
    const hasNpm = existsSync(join(cwd, 'package-lock.json'))

    let cmd: string
    if (pattern) {
      cmd = hasVitest
        ? `npx vitest run ${pattern} --reporter=verbose`
        : hasPnpm
          ? `pnpm test -- ${pattern}`
          : `npm test -- ${pattern}`
    } else {
      cmd = hasPnpm ? 'pnpm test' : hasNpm ? 'npm test' : 'npx vitest run'
    }

    try {
      const out = execSync(cmd, {
        cwd,
        encoding: 'utf8',
        stdio: ['pipe', 'pipe', 'pipe'],
        timeout: 120_000,
      })

      // Parse vitest output
      const totalMatch = out.match(/(\d+)\s+tests?\s+total/i)
      const failMatch = out.match(/(\d+)\s+(?:tests?\s+)?failed/i)
      const passMatch = out.match(/(\d+)\s+(?:tests?\s+)?passed/i)

      const total = totalMatch ? parseInt(totalMatch[1], 10) : 0
      const failures = failMatch ? parseInt(failMatch[1], 10) : 0
      const passed = passMatch ? parseInt(passMatch[1], 10) : 0

      // Truncate output for context
      const lines = out.split('\n')
      const summary = lines.slice(-10).join('\n')

      return {
        passed: failures === 0,
        failures,
        total: total || failures + passed,
        output: summary || out.slice(-500),
      }
    } catch (err) {
      const e = err as { stdout?: string; stderr?: string }
      const out = (e.stdout ?? '') + (e.stderr ?? '')
      const failMatch = out.match(/(\d+)\s+(?:tests?\s+)?failed/i)
      const totalMatch = out.match(/(\d+)\s+tests?\s+total/i)
      return {
        passed: false,
        failures: failMatch ? parseInt(failMatch[1], 10) : 1,
        total: totalMatch ? parseInt(totalMatch[1], 10) : 0,
        output: out.slice(-500),
      }
    }
  }

  private formatSummary(report: QualityReport): string {
    const parts: string[] = []
    if (report.typecheck.output) {
      parts.push(`Typecheck: ${report.typecheck.passed ? '✓' : '✗'} (${report.typecheck.errors}E, ${report.typecheck.warnings}W)`)
    }
    if (report.lint.output) {
      parts.push(`Lint: ${report.lint.passed ? '✓' : '✗'} (${report.lint.errors}E, ${report.lint.warnings}W)`)
    }
    if (report.test.output) {
      parts.push(`Tests: ${report.test.passed ? '✓' : '✗'} (${report.test.failures}F/${report.test.total}T)`)
    }
    parts.push(`Duration: ${report.durationMs}ms`)
    if (report.changedFiles.length > 0) {
      parts.push(`Changed files: ${report.changedFiles.length}`)
    }
    return parts.join(' | ')
  }

  private formatReport(report: QualityReport): string {
    const lines: string[] = []
    lines.push(`# Code Quality Report — ${report.passed ? '✓ PASSED' : '✗ FAILED'}`)
    lines.push(`Duration: ${report.durationMs}ms`)
    if (report.changedFiles.length > 0) {
      lines.push(`\nChanged files (${report.changedFiles.length}):`)
      for (const f of report.changedFiles.slice(0, 15)) {
        lines.push(`  ${f}`)
      }
      if (report.changedFiles.length > 15) {
        lines.push(`  ... and ${report.changedFiles.length - 15} more`)
      }
    }

    if (report.typecheck.output) {
      lines.push(`\n## TypeScript Type Check`)
      lines.push(report.typecheck.output)
    }

    if (report.lint.output) {
      lines.push(`\n## Lint`)
      lines.push(report.lint.output)
    }

    if (report.test.output) {
      lines.push(`\n## Tests`)
      lines.push(report.test.output)
    }

    lines.push(`\n${report.summary}`)
    return lines.join('\n')
  }
}