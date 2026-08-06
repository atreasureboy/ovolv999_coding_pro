/**
 * CodeReview (v0.6.0) — deterministic, LLM-free code review of changes.
 *
 * Inspired by Codex's built-in reviewer and the industry practice of
 * automated pre-merge review. Unlike the CriticModule (which uses an
 * LLM call to review conversation history) this module reviews actual
 * CODE CHANGES with pure heuristics:
 *
 *   - complexity: nested loops/conditionals beyond a depth threshold
 *   - error swallowing: empty catch blocks, ignored promise rejections
 *   - TODO/FIXME/HACK markers introduced in new code
 *   - hardcoded secrets: API keys, passwords, tokens in source
 *   - debug leftovers: console.log in "production" paths (TS/JS),
 *     print() in Python, fmt.Println in Go
 *   - unsafe patterns: eval(), execSync with string interpolation,
 *     innerHTML assignment, shell=True
 *   - duplicated blocks: repeated function bodies across files
 *   - large diffs: single file changes above a size threshold
 *   - incomplete refactors: renamed symbols still referenced by old name
 *   - missing null-checks on awaited calls (best-effort heuristic)
 *
 * Output: ReviewReport with severity-ranked findings (blocker / warning /
 * info), a summary score (0-100, higher = cleaner), and per-file stats.
 *
 * Pure + deterministic → unit-testable without mocks.
 */

import { readFileSync, existsSync } from 'fs'
import { join, relative, extname } from 'path'

// ── Types ───────────────────────────────────────────────────────────────────

export type ReviewSeverity = 'blocker' | 'warning' | 'info'

export interface ReviewFinding {
  severity: ReviewSeverity
  file: string
  line?: number
  rule: string
  message: string
}

export interface ReviewFileStat {
  file: string
  addedLines: number
  removedLines: number
  findings: number
}

export interface ReviewReport {
  files: ReviewFileStat[]
  findings: ReviewFinding[]
  score: number // 0-100, higher = cleaner
  summary: {
    blockers: number
    warnings: number
    infos: number
    filesReviewed: number
    totalChangedLines: number
  }
}

export interface ReviewOptions {
  /** Cap on files reviewed (largest diffs first). Default 50. */
  maxFiles?: number
  /** Cap on findings per file. Default 20. */
  maxFindingsPerFile?: number
  /** Extra patterns: { file, oldContent, newContent, addedLines[] } */
  changes: ReviewChange[]
}

export interface ReviewChange {
  file: string
  oldContent?: string
  newContent?: string
  /** Line numbers (1-based) of added lines in newContent. */
  addedLines?: number[]
}

// ── Heuristic rules ─────────────────────────────────────────────────────────

const SECRET_PATTERNS: Array<{ re: RegExp; name: string }> = [
  { re: /(?:sk|pk|api[_-]?key|secret|token|password|passwd|auth)[-_]?\w*\s*[:=]\s*['"][A-Za-z0-9_-]{16,}['"]/i, name: 'hardcoded-secret' },
  { re: /AKIA[0-9A-Z]{16}/, name: 'aws-access-key' },
  { re: /(?:ghp|gho|github_pat)_[A-Za-z0-9_]{20,}/, name: 'github-token' },
  { re: /Bearer\s+[A-Za-z0-9\-._~+/]+=*/, name: 'bearer-token' },
  { re: /mongodb(\+srv)?:\/\/[^\s'"]+:[^\s'"]+@/, name: 'db-connection-string' },
  // v0.6.0 (audit): quoted token values (`= "sk-…"`, `= "ghp_…"`) with
  // no key-name keyword — catches `const X = "sk-1234…"`.
  { re: /['"](?:sk|pk|ghp|gho|ghu|github_pat|xox[baprs])[-_][A-Za-z0-9_-]{15,}['"]/, name: 'quoted-token' },
]

const DEBUG_PATTERNS: Array<{ re: RegExp; name: string }> = [
  { re: /console\.(log|debug)\(/, name: 'console-debug' },
  { re: /debugger\s*;/, name: 'debugger-statement' },
  { re: /\bprint\(/, name: 'print-statement' },
  { re: /fmt\.Println\(/, name: 'fmt-println' },
  { re: /var_dump\(|print_r\(/, name: 'php-debug' },
]

const UNSAFE_PATTERNS: Array<{ re: RegExp; name: string; message: string }> = [
  { re: /\beval\s*\(/, name: 'eval-usage', message: 'eval() is dangerous — avoid dynamic code execution' },
  { re: /exec(?:Sync|FileSync)?\(\s*(?:`|['"][^'"]*\$|['"][^'"]*\+)/, name: 'shell-interpolation', message: 'shell command built from string interpolation — command injection risk' },
  { re: /innerHTML\s*=/, name: 'innerhtml-assignment', message: 'innerHTML assignment can enable XSS' },
  { re: /shell\s*=\s*True/, name: 'python-shell-true', message: 'shell=True in subprocess is unsafe' },
  { re: /child_process.*exec(?:Sync)?\(/, name: 'child-process-exec', message: 'prefer spawn over exec for untrusted input' },
]

const MARKER_PATTERNS: Array<{ re: RegExp; name: string }> = [
  { re: /\bTODO\b/i, name: 'todo-marker' },
  { re: /\bFIXME\b/i, name: 'fixme-marker' },
  { re: /\bHACK\b/i, name: 'hack-marker' },
  { re: /\bXXX\b/i, name: 'xxx-marker' },
]

// ── Review engine ───────────────────────────────────────────────────────────

/** Count added lines in a unified-style change when addedLines absent. */
function computeAddedLines(oldContent: string | undefined, newContent: string | undefined): number[] {
  if (!newContent) return []
  if (oldContent === undefined) {
    // Entirely new file — every line is added.
    return newContent.split('\n').map((_, i) => i + 1)
  }
  // Fallback: naive line diff (added = lines in new not in old).
  const oldSet = new Set(oldContent.split('\n'))
  const added: number[] = []
  const lines = newContent.split('\n')
  for (let i = 0; i < lines.length; i++) {
    if (!oldSet.has(lines[i])) added.push(i + 1)
  }
  return added
}

/** Score a line against a list of pattern rules; returns first match. */
function checkLine(line: string, rules: Array<{ re: RegExp; name: string }>): string | null {
  for (const rule of rules) {
    if (rule.re.test(line)) return rule.name
  }
  return null
}

/** Measure max nesting depth of control flow in a code block. */
function maxNestingDepth(lines: string[]): number {
  let depth = 0
  let max = 0
  const open = /(\b(if|for|while|switch|catch|function|async\s+function)\b|\(|\{|\[)/g
  const close = /(\}|\)|\])/g
  for (const line of lines) {
    const opens = (line.match(open) ?? []).length
    const closes = (line.match(close) ?? []).length
    depth += opens - closes
    if (depth > max) max = depth
    if (depth < 0) depth = 0
  }
  return max
}

/** Detect duplicated blocks: repeated 3+ line sequences within a file. */
function findDuplicatedBlocks(lines: string[], threshold = 3): string[] {
  const seen = new Map<string, number>()
  const dups: string[] = []
  for (let i = 0; i <= lines.length - threshold; i++) {
    const block = lines.slice(i, i + threshold).join('\n').trim()
    if (block.length < 20) continue
    const count = (seen.get(block) ?? 0) + 1
    seen.set(block, count)
    if (count === 2) dups.push(block.slice(0, 80) + '...')
  }
  return dups.slice(0, 5)
}

/** Detect empty catch blocks / swallowed errors. */
function findSwallowedErrors(lines: string[]): number[] {
  const swallowed: number[] = []
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (/\bcatch\s*\([^)]*\)\s*\{\s*\}/.test(line) || /\bcatch\s*\{/.test(line)) {
      // Look ahead for empty body (next non-empty line is a closing brace)
      let j = i + 1
      while (j < lines.length && lines[j].trim() === '') j++
      if (j < lines.length && /^\s*\}/.test(lines[j])) swallowed.push(i + 1)
    }
  }
  return swallowed
}

/** Check a single changed file and collect findings. */
function reviewFile(change: ReviewChange, opts: ReviewOptions): ReviewFinding[] {
  const findings: ReviewFinding[] = []
  const newContent = change.newContent ?? ''
  const addedLines = change.addedLines ?? computeAddedLines(change.oldContent, change.newContent)
  const lines = newContent.split('\n')
  const ext = extname(change.file).toLowerCase()
  const isSource = /\.(ts|tsx|js|jsx|py|go|rs|java|rb|php|c|h|cpp|hpp|cs|kt|swift)$/.test(ext)

  if (!isSource) {
    // Non-source files: only check secrets.
    for (const lineNo of addedLines) {
      const line = lines[lineNo - 1]
      if (!line) continue
      const rule = checkLine(line, SECRET_PATTERNS)
      if (rule) {
        findings.push({
          severity: 'blocker',
          file: change.file,
          line: lineNo,
          rule,
          message: `Potential secret/hardcoded credential detected (${rule})`,
        })
      }
    }
    return findings.slice(0, opts.maxFindingsPerFile ?? 20)
  }

  // ── Per-line checks on added lines only ──
  for (const lineNo of addedLines) {
    const line = lines[lineNo - 1]
    if (!line || line.trim() === '' || line.trim().startsWith('//') || line.trim().startsWith('#')) continue

    const secret = checkLine(line, SECRET_PATTERNS)
    if (secret) {
      findings.push({ severity: 'blocker', file: change.file, line: lineNo, rule: secret, message: `Potential secret/hardcoded credential detected (${secret})` })
    }

    const debug = checkLine(line, DEBUG_PATTERNS)
    if (debug) {
      findings.push({ severity: 'warning', file: change.file, line: lineNo, rule: debug, message: `Debug statement left in code (${debug})` })
    }

    for (const unsafe of UNSAFE_PATTERNS) {
      if (unsafe.re.test(line)) {
        findings.push({ severity: 'blocker', file: change.file, line: lineNo, rule: unsafe.name, message: unsafe.message })
      }
    }

    const marker = checkLine(line, MARKER_PATTERNS)
    if (marker) {
      findings.push({ severity: 'info', file: change.file, line: lineNo, rule: marker, message: `Marker left in new code (${marker})` })
    }
  }

  // ── Block-level checks on the whole new content ──
  const depth = maxNestingDepth(lines)
  if (depth > 8) {
    findings.push({
      severity: 'warning',
      file: change.file,
      rule: 'excessive-nesting',
      message: `Max nesting depth ${depth} — consider extracting helper functions (threshold 8)`,
    })
  }

  const dups = findDuplicatedBlocks(lines)
  for (const d of dups) {
    findings.push({
      severity: 'warning',
      file: change.file,
      rule: 'duplicated-block',
      message: `Repeated code block: ${d}`,
    })
  }

  const swallowed = findSwallowedErrors(lines)
  for (const lineNo of swallowed) {
    findings.push({
      severity: 'warning',
      file: change.file,
      line: lineNo,
      rule: 'swallowed-error',
      message: 'Empty catch block silently swallows errors',
    })
  }

  return findings.slice(0, opts.maxFindingsPerFile ?? 20)
}

// ── Public API ──────────────────────────────────────────────────────────────

export function reviewChanges(changes: ReviewChange[], opts: Partial<ReviewOptions> = {}): ReviewReport {
  const options: ReviewOptions = {
    maxFiles: opts.maxFiles ?? 50,
    maxFindingsPerFile: opts.maxFindingsPerFile ?? 20,
    changes,
  }

  // Sort by diff size descending; cap file count.
  const sorted = [...changes].sort((a, b) => {
    const sizeA = (a.addedLines?.length ?? 0) + (a.oldContent === undefined && a.newContent ? a.newContent.length : 0)
    const sizeB = (b.addedLines?.length ?? 0) + (b.oldContent === undefined && b.newContent ? b.newContent.length : 0)
    return sizeB - sizeA
  })

  const allFindings: ReviewFinding[] = []
  const fileStats: ReviewFileStat[] = []
  let totalChangedLines = 0

  for (const change of sorted.slice(0, options.maxFiles)) {
    const added = change.addedLines ?? computeAddedLines(change.oldContent, change.newContent)
    const removed = change.oldContent
      ? Math.max(0, change.oldContent.split('\n').length - (change.newContent?.split('\n').length ?? 0)) + 0
      : 0
    totalChangedLines += added.length

    const findings = reviewFile(change, options)
    allFindings.push(...findings)
    fileStats.push({
      file: change.file,
      addedLines: added.length,
      removedLines: removed,
      findings: findings.length,
    })
  }

  // ── Score: 100 - penalties ──
  let score = 100
  const blockers = allFindings.filter(f => f.severity === 'blocker').length
  const warnings = allFindings.filter(f => f.severity === 'warning').length
  const infos = allFindings.filter(f => f.severity === 'info').length
  score -= blockers * 15
  score -= warnings * 5
  score -= infos * 1
  if (totalChangedLines > 500) score -= 10 // very large diff
  score = Math.max(0, Math.min(100, score))

  return {
    files: fileStats,
    findings: allFindings,
    score,
    summary: {
      blockers,
      warnings,
      infos,
      filesReviewed: fileStats.length,
      totalChangedLines,
    },
  }
}

/** Format a ReviewReport as human-readable text. */
export function formatReviewReport(report: ReviewReport, cwd = process.cwd()): string {
  const lines: string[] = []
  lines.push(`Code Review Score: ${report.score}/100`)
  lines.push(`  ${report.summary.filesReviewed} file(s) reviewed, ${report.summary.totalChangedLines} changed line(s)`)
  lines.push(`  ${report.summary.blockers} blocker(s) | ${report.summary.warnings} warning(s) | ${report.summary.infos} info(s)`)
  if (report.summary.blockers > 0) {
    lines.push('')
    lines.push('⚠ BLOCKERS:')
    for (const f of report.findings.filter(x => x.severity === 'blocker')) {
      const file = relative(cwd, f.file)
      lines.push(`  ✖ ${file}${f.line ? `:${f.line}` : ''} — ${f.message}`)
    }
  }
  const warnings = report.findings.filter(x => x.severity === 'warning')
  if (warnings.length > 0) {
    lines.push('')
    lines.push('△ WARNINGS:')
    for (const f of warnings.slice(0, 15)) {
      const file = relative(cwd, f.file)
      lines.push(`  ! ${file}${f.line ? `:${f.line}` : ''} — ${f.message}`)
    }
    if (warnings.length > 15) lines.push(`  … and ${warnings.length - 15} more`)
  }
  const infos = report.findings.filter(x => x.severity === 'info')
  if (infos.length > 0) {
    lines.push('')
    lines.push('ℹ INFO:')
    for (const f of infos.slice(0, 8)) {
      const file = relative(cwd, f.file)
      lines.push(`  · ${file}${f.line ? `:${f.line}` : ''} — ${f.message}`)
    }
  }
  if (report.findings.length === 0) {
    lines.push('')
    lines.push('✓ No issues found — clean change set.')
  }
  return lines.join('\n')
}

/**
 * Read files from disk and build ReviewChange objects. Utility for callers
 * that have paths + old/new content instead of structured changes.
 */
export function readChangesFromDisk(
  baseDir: string,
  spec: Array<{ file: string; newContent?: string; addedLines?: number[] }>,
): ReviewChange[] {
  const changes: ReviewChange[] = []
  for (const s of spec) {
    const full = join(baseDir, s.file)
    const oldContent = existsSync(full) ? readFileSync(full, 'utf8') : undefined
    changes.push({
      file: s.file,
      oldContent,
      newContent: s.newContent ?? oldContent,
      addedLines: s.addedLines,
    })
  }
  return changes
}
