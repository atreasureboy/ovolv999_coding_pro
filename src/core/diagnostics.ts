/**
 * Diagnostics Service
 *
 * Provides real-time code diagnostics by running language-specific linters
 * and type checkers. Results are cached and queryable by file/glob/severity.
 *
 * Supported checkers:
 *   - TypeScript: tsc --noEmit
 *   - ESLint: eslint --format json
 *   - Biome: biome check --json
 *   - Python: pyflakes / ruff
 *
 * The DiagnosticsTool exposes this to the LLM.
 */

import { execSync, type ExecSyncOptions } from 'child_process'
import { existsSync, readFileSync } from 'fs'
import { join, extname, relative, dirname } from 'path'

// ── Types ───────────────────────────────────────────────────────────────────

export type DiagnosticSeverity = 'error' | 'warning' | 'info' | 'hint'

export interface Diagnostic {
  filePath: string
  line: number
  column: number
  endLine?: number
  endColumn?: number
  severity: DiagnosticSeverity
  message: string
  code?: string | number
  source: string
}

export interface FileDiagnostics {
  filePath: string
  diagnostics: Diagnostic[]
  errorCount: number
  warningCount: number
}

export interface DiagnosticsResult {
  files: FileDiagnostics[]
  totalErrors: number
  totalWarnings: number
  totalInfos: number
  duration: number
  checker: string
}

// ── Cache ───────────────────────────────────────────────────────────────────

interface CacheEntry {
  result: DiagnosticsResult
  timestamp: number
  cwd: string
}

const cache: Map<string, CacheEntry> = new Map()
const CACHE_TTL = 30_000 // 30 seconds

export function clearCache(): void {
  cache.clear()
}

export function getCached(cwd: string, checker: string): DiagnosticsResult | null {
  const key = `${cwd}::${checker}`
  const entry = cache.get(key)
  if (!entry) return null
  if (Date.now() - entry.timestamp > CACHE_TTL) {
    cache.delete(key)
    return null
  }
  return entry.result
}

function setCached(cwd: string, checker: string, result: DiagnosticsResult): void {
  cache.set(`${cwd}::${checker}`, { result, timestamp: Date.now(), cwd })
}

// ── Checkers ────────────────────────────────────────────────────────────────

export type Checker = 'tsc' | 'eslint' | 'biome' | 'ruff' | 'auto'

interface CheckerDef {
  name: string
  detect: (cwd: string) => boolean
  run: (cwd: string) => Diagnostic[]
}

const CHECKERS: CheckerDef[] = [
  {
    name: 'tsc',
    detect: (cwd) => existsSync(join(cwd, 'tsconfig.json')),
    run: (cwd) => runTsc(cwd),
  },
  {
    name: 'eslint',
    detect: (cwd) => {
      const configs = ['.eslintrc.js', '.eslintrc.json', '.eslintrc.yml', '.eslintrc', 'eslint.config.js', 'eslint.config.mjs']
      return configs.some(f => existsSync(join(cwd, f)))
    },
    run: (cwd) => runEslint(cwd),
  },
  {
    name: 'biome',
    detect: (cwd) => existsSync(join(cwd, 'biome.json')) || existsSync(join(cwd, 'biome.jsonc')),
    run: (cwd) => runBiome(cwd),
  },
  {
    name: 'ruff',
    detect: (cwd) => {
      const pyfiles = ['pyproject.toml', 'ruff.toml', '.ruff.toml']
      return pyfiles.some(f => existsSync(join(cwd, f)))
    },
    run: (cwd) => runRuff(cwd),
  },
]

function getChecker(name: string, cwd: string): CheckerDef | null {
  if (name === 'auto') {
    return CHECKERS.find(c => c.detect(cwd)) ?? null
  }
  return CHECKERS.find(c => c.name === name) ?? null
}

// ── Runners ─────────────────────────────────────────────────────────────────

function exec(cmd: string, cwd: string, timeout = 60_000): { stdout: string; stderr: string; exitCode: number | null } {
  const opts: ExecSyncOptions = { cwd, encoding: 'utf8', timeout, stdio: ['pipe', 'pipe', 'pipe'] }
  try {
    const stdout = execSync(cmd, opts) ?? ''
    return { stdout: stdout.toString(), stderr: '', exitCode: 0 }
  } catch (err: unknown) {
    const e = err as { stdout?: string; stderr?: string; status?: number }
    return {
      stdout: (e.stdout ?? '').toString(),
      stderr: (e.stderr ?? '').toString(),
      exitCode: e.status ?? null,
    }
  }
}

function runTsc(cwd: string): Diagnostic[] {
  const { stdout, stderr } = exec('npx tsc --noEmit --pretty false', cwd)
  const output = stdout + stderr
  return parseTscOutput(output, cwd)
}

export function parseTscOutput(output: string, cwd: string): Diagnostic[] {
  const diagnostics: Diagnostic[] = []
  const lines = output.split('\n')

  // Format: file.ts(L,C): error TS1234: message
  // Or:     file.ts:L:C - error TS1234: message
  const lineRegex = /^(.+?)\((\d+),(\d+)\)\s*:\s*(error|warning|info)\s+(TS\d+):\s*(.+)$/

  for (const line of lines) {
    const m = line.match(lineRegex)
    if (m) {
      const [, file, lineStr, colStr, severity, code, message] = m
      diagnostics.push({
        filePath: relative(cwd, file),
        line: parseInt(lineStr, 10),
        column: parseInt(colStr, 10),
        severity: severity as DiagnosticSeverity,
        message: message.trim(),
        code,
        source: 'tsc',
      })
    }
  }

  return diagnostics
}

function runEslint(cwd: string): Diagnostic[] {
  const { stdout } = exec('npx eslint --format json .', cwd)
  return parseEslintJson(stdout, cwd)
}

export function parseEslintJson(json: string, _cwd: string): Diagnostic[] {
  const diagnostics: Diagnostic[] = []
  try {
    const results = JSON.parse(json) as Array<{
      filePath: string
      messages: Array<{
        line: number
        column: number
        endLine?: number
        endColumn?: number
        severity: number // 1=warning, 2=error
        message: string
        ruleId?: string
      }>
    }>
    for (const file of results) {
      for (const msg of file.messages) {
        diagnostics.push({
          filePath: file.filePath,
          line: msg.line,
          column: msg.column,
          endLine: msg.endLine,
          endColumn: msg.endColumn,
          severity: msg.severity === 2 ? 'error' : 'warning',
          message: msg.message,
          code: msg.ruleId,
          source: 'eslint',
        })
      }
    }
  } catch { /* invalid json */ }
  return diagnostics
}

function runBiome(cwd: string): Diagnostic[] {
  const { stdout } = exec('npx biome check --json 2>/dev/null || npx biome check', cwd)
  return parseBiomeOutput(stdout, cwd)
}

export function parseBiomeOutput(output: string, _cwd: string): Diagnostic[] {
  const diagnostics: Diagnostic[] = []
  try {
    const data = JSON.parse(output) as {
      diagnostics?: Array<{
        file?: string
        severity?: string
        category?: string
        description?: string
        location?: { span?: { start?: { line?: number; col?: number }; end?: { line?: number; col?: number } } }
      }>
    }
    for (const d of data.diagnostics ?? []) {
      const start = d.location?.span?.start
      const end = d.location?.span?.end
      if (!start) continue
      diagnostics.push({
        filePath: d.file ?? '<unknown>',
        line: start.line ?? 1,
        column: start.col ?? 1,
        endLine: end?.line,
        endColumn: end?.col,
        severity: (d.severity === 'error' ? 'error' : d.severity === 'warning' ? 'warning' : 'info'),
        message: d.description ?? '',
        code: d.category,
        source: 'biome',
      })
    }
  } catch { /* not JSON — might be plain text */ }
  return diagnostics
}

function runRuff(cwd: string): Diagnostic[] {
  const { stdout } = exec('ruff check --output-format json .', cwd)
  return parseRuffJson(stdout, cwd)
}

export function parseRuffJson(json: string, _cwd: string): Diagnostic[] {
  const diagnostics: Diagnostic[] = []
  try {
    const results = JSON.parse(json) as Array<{
      filename: string
      location: { row: number; column: number }
      end_location?: { row: number; column: number }
      code: string
      message: string
      url?: string
    }>
    for (const r of results) {
      diagnostics.push({
        filePath: r.filename,
        line: r.location.row,
        column: r.location.column,
        endLine: r.end_location?.row,
        endColumn: r.end_location?.column,
        severity: 'warning',
        message: r.message,
        code: r.code,
        source: 'ruff',
      })
    }
  } catch { /* invalid json */ }
  return diagnostics
}

// ── Public API ──────────────────────────────────────────────────────────────

export function runDiagnostics(cwd: string, checker: Checker = 'auto', useCache = true): DiagnosticsResult {
  const start = Date.now()
  const def = getChecker(checker, cwd)

  if (!def) {
    return {
      files: [],
      totalErrors: 0,
      totalWarnings: 0,
      totalInfos: 0,
      duration: Date.now() - start,
      checker: checker === 'auto' ? 'none-detected' : checker,
    }
  }

  if (useCache) {
    const cached = getCached(cwd, def.name)
    if (cached) return cached
  }

  const diagnostics = def.run(cwd)
  const result = aggregateDiagnostics(diagnostics, def.name, Date.now() - start)
  setCached(cwd, def.name, result)
  return result
}

export function aggregateDiagnostics(diagnostics: Diagnostic[], checker: string, duration: number): DiagnosticsResult {
  const byFile = new Map<string, Diagnostic[]>()

  for (const d of diagnostics) {
    const arr = byFile.get(d.filePath) ?? []
    arr.push(d)
    byFile.set(d.filePath, arr)
  }

  const files: FileDiagnostics[] = []
  let totalErrors = 0
  let totalWarnings = 0
  let totalInfos = 0

  for (const [filePath, diags] of byFile) {
    const errorCount = diags.filter(d => d.severity === 'error').length
    const warningCount = diags.filter(d => d.severity === 'warning').length
    const infoCount = diags.filter(d => d.severity === 'info' || d.severity === 'hint').length

    files.push({ filePath, diagnostics: diags.sort((a, b) => a.line - b.line), errorCount, warningCount })
    totalErrors += errorCount
    totalWarnings += warningCount
    totalInfos += infoCount
  }

  files.sort((a, b) => b.errorCount - a.errorCount || b.warningCount - a.warningCount)

  return { files, totalErrors, totalWarnings, totalInfos, duration, checker }
}

export function filterDiagnostics(
  result: DiagnosticsResult,
  opts: {
    filePath?: string
    severity?: DiagnosticSeverity | 'all'
    limit?: number
  } = {},
): Diagnostic[] {
  const all: Diagnostic[] = []
  for (const f of result.files) {
    if (opts.filePath && !f.filePath.includes(opts.filePath)) continue
    for (const d of f.diagnostics) {
      if (opts.severity && opts.severity !== 'all' && d.severity !== opts.severity) continue
      all.push(d)
    }
  }
  if (opts.limit) return all.slice(0, opts.limit)
  return all
}

// ── Formatting ──────────────────────────────────────────────────────────────

export function formatDiagnosticsResult(result: DiagnosticsResult, maxFiles = 20, maxDiagsPerFile = 5): string {
  if (result.files.length === 0) {
    return `✓ No diagnostics (${result.checker}, ${result.duration}ms)`
  }

  const lines: string[] = []
  lines.push(`Diagnostics (${result.checker}, ${result.duration}ms):`)
  lines.push(`  ${result.totalErrors} errors, ${result.totalWarnings} warnings, ${result.totalInfos} infos`)

  const filesToShow = result.files.slice(0, maxFiles)
  for (const f of filesToShow) {
    const severity = f.errorCount > 0 ? '✗' : '⚠'
    lines.push(`\n${severity} ${f.filePath} (${f.errorCount}E, ${f.warningCount}W)`)
    const diags = f.diagnostics.slice(0, maxDiagsPerFile)
    for (const d of diags) {
      const tag = d.severity === 'error' ? 'E' : d.severity === 'warning' ? 'W' : 'I'
      const code = d.code ? ` [${d.code}]` : ''
      lines.push(`  ${d.filePath}:${d.line}:${d.column} ${tag}${code} ${d.message}`)
    }
    if (f.diagnostics.length > maxDiagsPerFile) {
      lines.push(`  ... and ${f.diagnostics.length - maxDiagsPerFile} more`)
    }
  }

  if (result.files.length > maxFiles) {
    lines.push(`\n... and ${result.files.length - maxFiles} more files`)
  }

  return lines.join('\n')
}

// ── File-level diagnostics (single file) ────────────────────────────────────

export function getFileDiagnostics(filePath: string, cwd: string): Diagnostic[] {
  const ext = extname(filePath).toLowerCase()
  const tsExts = ['.ts', '.tsx', '.js', '.jsx', '.mts', '.cts']
  const pyExts = ['.py']

  let checker: Checker = 'auto'
  if (tsExts.includes(ext)) checker = 'tsc'
  else if (pyExts.includes(ext)) checker = 'ruff'

  const result = runDiagnostics(cwd, checker, true)
  return filterDiagnostics(result, { filePath, severity: 'all' })
}
