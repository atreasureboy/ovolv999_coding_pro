/**
 * Code Metrics Analyzer
 *
 * Analyze code files for complexity, maintainability, and quality metrics.
 * Supports TypeScript, JavaScript, Python.
 */

import { existsSync, readFileSync, statSync } from 'fs'
import { extname, basename } from 'path'

// ── Types ───────────────────────────────────────────────────────────────────

export interface FileMetrics {
  path: string
  language: string
  totalLines: number
  codeLines: number
  commentLines: number
  blankLines: number
  importedCount: number
  exportedCount: number
  functionCount: number
  classCount: number
  maxNestingDepth: number
  longestLine: number
  averageLineLength: number
  complexity: number
  maintainabilityIndex: number
  fileSizeBytes: number
  todoCount: number
  duplicateLineRatio: number
}

export interface ProjectMetrics {
  files: FileMetrics[]
  totals: {
    totalLines: number
    codeLines: number
    commentLines: number
    blankLines: number
    functions: number
    classes: number
    complexity: number
    todos: number
    fileSizeBytes: number
  }
  averages: {
    complexity: number
    maintainabilityIndex: number
    maxNestingDepth: number
    lineLength: number
    duplicateRatio: number
  }
  topComplexFiles: FileMetrics[]
  largestFiles: FileMetrics[]
  filesByLanguage: Record<string, number>
}

// ── Language Detection ──────────────────────────────────────────────────────

const EXT_TO_LANG: Record<string, string> = {
  '.ts': 'typescript',
  '.tsx': 'typescript',
  '.mts': 'typescript',
  '.cts': 'typescript',
  '.js': 'javascript',
  '.jsx': 'javascript',
  '.mjs': 'javascript',
  '.cjs': 'javascript',
  '.py': 'python',
  '.rb': 'ruby',
  '.go': 'go',
  '.rs': 'rust',
  '.java': 'java',
  '.kt': 'kotlin',
  '.swift': 'swift',
  '.c': 'c',
  '.cpp': 'cpp',
  '.h': 'c',
  '.hpp': 'cpp',
  '.cs': 'csharp',
  '.php': 'php',
  '.scala': 'scala',
  '.sh': 'bash',
  '.bash': 'bash',
  '.zsh': 'bash',
}

export function detectLanguage(filePath: string): string {
  const ext = extname(filePath).toLowerCase()
  return EXT_TO_LANG[ext] ?? 'unknown'
}

// ── Metrics Analysis ────────────────────────────────────────────────────────

export function analyzeFile(filePath: string): FileMetrics | null {
  if (!existsSync(filePath)) return null

  const content = readFileSync(filePath, 'utf8')
  const stats = statSync(filePath)
  const language = detectLanguage(filePath)
  const lines = content.split('\n')

  const totalLines = lines.length
  let codeLines = 0
  let commentLines = 0
  let blankLines = 0

  let inBlockComment = false
  const lineLengths: number[] = []

  for (const line of lines) {
    const trimmed = line.trim()
    lineLengths.push(line.length)

    if (trimmed === '') {
      blankLines++
      continue
    }

    // Check for block comment end
    if (inBlockComment) {
      commentLines++
      if (trimmed.includes('*/') || trimmed.includes('"""') && inBlockComment) {
        inBlockComment = false
      }
      continue
    }

    // Check for block comment start
    if (trimmed.startsWith('/*') || trimmed.startsWith('"""') || trimmed.startsWith("'''")) {
      commentLines++
      if (!trimmed.includes('*/') && !trimmed.endsWith('"""') && !trimmed.endsWith("'''")) {
        inBlockComment = true
      }
      continue
    }

    // Single-line comment
    if (
      trimmed.startsWith('//') ||
      trimmed.startsWith('#') ||
      trimmed.startsWith('--')
    ) {
      commentLines++
      continue
    }

    codeLines++
  }

  const longestLine = Math.max(...lineLengths, 0)
  const averageLineLength = lineLengths.length > 0
    ? Math.round(lineLengths.reduce((a, b) => a + b, 0) / lineLengths.length)
    : 0

  const functionCount = countFunctions(content, language)
  const classCount = countClasses(content, language)
  const importedCount = countImports(content, language)
  const exportedCount = countExports(content, language)
  const maxNestingDepth = calculateMaxNesting(lines, language)
  const complexity = calculateComplexity(content, lines, language)
  const todoCount = countTODOs(content)
  const duplicateLineRatio = calculateDuplicateRatio(lines)

  const maintainabilityIndex = calculateMaintainabilityIndex(
    codeLines,
    complexity,
    averageLineLength,
  )

  return {
    path: basename(filePath),
    language,
    totalLines,
    codeLines,
    commentLines,
    blankLines,
    importedCount,
    exportedCount,
    functionCount,
    classCount,
    maxNestingDepth,
    longestLine,
    averageLineLength,
    complexity,
    maintainabilityIndex,
    fileSizeBytes: stats.size,
    todoCount,
    duplicateLineRatio,
  }
}

// ── Counting Helpers ────────────────────────────────────────────────────────

function countFunctions(content: string, language: string): number {
  let count = 0
  // JS/TS: function declarations and arrow functions
  if (['typescript', 'javascript'].includes(language)) {
    const funcMatches = content.match(/\bfunction\s+\w+/g)
    if (funcMatches) count += funcMatches.length
    const arrowMatches = content.match(/\bconst\s+\w+\s*=\s*(?:async\s*)?\(/g)
    if (arrowMatches) count += arrowMatches.length
    const methodMatches = content.match(/\b(async\s+)?\w+\s*\([^)]*\)\s*[:{]/g)
    if (methodMatches) count += Math.floor(methodMatches.length / 3) // Approximate
  }
  // Python: def
  if (language === 'python') {
    const pyMatches = content.match(/^\s*def\s+\w+/gm)
    if (pyMatches) count += pyMatches.length
  }
  return count
}

function countClasses(content: string, language: string): number {
  let count = 0
  if (['typescript', 'javascript', 'java', 'csharp', 'kotlin', 'scala'].includes(language)) {
    const matches = content.match(/\bclass\s+\w+/g)
    if (matches) count = matches.length
  }
  if (language === 'python') {
    const matches = content.match(/^\s*class\s+\w+/gm)
    if (matches) count = matches.length
  }
  return count
}

function countImports(content: string, language: string): number {
  let count = 0
  if (['typescript', 'javascript'].includes(language)) {
    const matches = content.match(/^\s*import\s+.+/gm)
    if (matches) count = matches.length
  }
  if (language === 'python') {
    const matches = content.match(/^\s*(?:from\s+\S+\s+)?import\s+.+/gm)
    if (matches) count = matches.length
  }
  return count
}

function countExports(content: string, language: string): number {
  if (['typescript', 'javascript'].includes(language)) {
    const matches = content.match(/^\s*export\s+/gm)
    return matches?.length ?? 0
  }
  return 0
}

function countTODOs(content: string): number {
  const matches = content.match(/\b(TODO|FIXME|HACK|XXX|BUG)\b/gi)
  return matches?.length ?? 0
}

// ── Nesting Depth ───────────────────────────────────────────────────────────

function calculateMaxNesting(lines: string[], _language: string): number {
  let maxDepth = 0
  let currentDepth = 0

  const openChars = ['{', '(', '[']
  const closeChars = ['}', ')', ']']

  for (const line of lines) {
    const trimmed = line.trim()
    // Skip comments
    if (trimmed.startsWith('//') || trimmed.startsWith('#')) continue

    for (const char of line) {
      if (openChars.includes(char)) {
        currentDepth++
        maxDepth = Math.max(maxDepth, currentDepth)
      }
      if (closeChars.includes(char)) {
        currentDepth = Math.max(0, currentDepth - 1)
      }
    }
  }

  return maxDepth
}

// ── Cyclomatic Complexity ───────────────────────────────────────────────────

function calculateComplexity(content: string, _lines: string[], _language: string): number {
  let complexity = 1 // Base

  const patterns = [
    /\bif\b/g,
    /\belse\b/g,
    /\bfor\b/g,
    /\bwhile\b/g,
    /\bcase\b/g,
    /\bcatch\b/g,
    /\?\s/g, // ternary
    /&&/g,
    /\|\|/g,
  ]

  for (const pattern of patterns) {
    const matches = content.match(pattern)
    if (matches) complexity += matches.length
  }

  return complexity
}

// ── Maintainability Index ───────────────────────────────────────────────────

function calculateMaintainabilityIndex(
  codeLines: number,
  complexity: number,
  avgLineLength: number,
): number {
  // Simplified MI (0-100, higher is better)
  if (codeLines === 0) return 100

  const volume = Math.log2(codeLines + 1) * Math.log2(avgLineLength || 1)
  const mi = Math.max(0, Math.min(100,
    171 - 5.2 * Math.log(volume + 1) - 0.23 * complexity - 16.2 * Math.log(codeLines + 1)
  ))

  return Math.round(mi)
}

// ── Duplicate Detection ─────────────────────────────────────────────────────

function calculateDuplicateRatio(lines: string[]): number {
  const nonEmpty = lines.filter(l => l.trim().length > 0)
  if (nonEmpty.length === 0) return 0

  const seen = new Map<string, number>()
  for (const line of nonEmpty) {
    const normalized = line.trim()
    seen.set(normalized, (seen.get(normalized) ?? 0) + 1)
  }

  let duplicates = 0
  for (const count of seen.values()) {
    if (count > 1) duplicates += count - 1
  }

  return Math.round((duplicates / nonEmpty.length) * 100) / 100
}

// ── Project Metrics ─────────────────────────────────────────────────────────

export function analyzeProjectFiles(
  filePaths: string[],
  options: { maxFiles?: number } = {},
): ProjectMetrics {
  const limit = options.maxFiles ?? 100
  const files: FileMetrics[] = []

  for (const path of filePaths.slice(0, limit)) {
    const metrics = analyzeFile(path)
    if (metrics) files.push(metrics)
  }

  const totals = {
    totalLines: sum(files, f => f.totalLines),
    codeLines: sum(files, f => f.codeLines),
    commentLines: sum(files, f => f.commentLines),
    blankLines: sum(files, f => f.blankLines),
    functions: sum(files, f => f.functionCount),
    classes: sum(files, f => f.classCount),
    complexity: sum(files, f => f.complexity),
    todos: sum(files, f => f.todoCount),
    fileSizeBytes: sum(files, f => f.fileSizeBytes),
  }

  const averages = {
    complexity: avg(files, f => f.complexity),
    maintainabilityIndex: avg(files, f => f.maintainabilityIndex),
    maxNestingDepth: avg(files, f => f.maxNestingDepth),
    lineLength: avg(files, f => f.averageLineLength),
    duplicateRatio: avg(files, f => f.duplicateLineRatio),
  }

  const topComplexFiles = [...files]
    .sort((a, b) => b.complexity - a.complexity)
    .slice(0, 5)

  const largestFiles = [...files]
    .sort((a, b) => b.totalLines - a.totalLines)
    .slice(0, 5)

  const filesByLanguage: Record<string, number> = {}
  for (const f of files) {
    filesByLanguage[f.language] = (filesByLanguage[f.language] ?? 0) + 1
  }

  return {
    files,
    totals,
    averages,
    topComplexFiles,
    largestFiles,
    filesByLanguage,
  }
}

function sum<T>(arr: T[], fn: (t: T) => number): number {
  return arr.reduce((s, item) => s + fn(item), 0)
}

function avg<T>(arr: T[], fn: (t: T) => number): number {
  if (arr.length === 0) return 0
  return Math.round(sum(arr, fn) / arr.length)
}

// ── Formatting ──────────────────────────────────────────────────────────────

export function formatFileMetrics(m: FileMetrics): string {
  const lines: string[] = [
    `${m.path} (${m.language})`,
    `  Lines: ${m.totalLines} (${m.codeLines} code, ${m.commentLines} comment, ${m.blankLines} blank)`,
    `  Size: ${formatBytes(m.fileSizeBytes)}`,
    `  Functions: ${m.functionCount} | Classes: ${m.classCount}`,
    `  Complexity: ${m.complexity} | Maintainability: ${m.maintainabilityIndex}/100`,
    `  Max nesting: ${m.maxNestingDepth} | Avg line length: ${m.averageLineLength}`,
    `  TODOs: ${m.todoCount} | Duplicate ratio: ${(m.duplicateLineRatio * 100).toFixed(0)}%`,
    `  Imports: ${m.importedCount} | Exports: ${m.exportedCount}`,
  ]
  return lines.join('\n')
}

export function formatProjectMetrics(metrics: ProjectMetrics): string {
  const t = metrics.totals
  const a = metrics.averages
  const lines: string[] = [
    'Project Metrics:',
    `  Files analyzed: ${metrics.files.length}`,
    `  Total lines: ${t.totalLines.toLocaleString()} (${t.codeLines.toLocaleString()} code)`,
    `  Functions: ${t.functions} | Classes: ${t.classes}`,
    `  Complexity: ${t.complexity} (avg ${a.complexity}/file)`,
    `  Maintainability: ${a.maintainabilityIndex}/100 (avg)`,
    `  TODOs/FIXMEs: ${t.todos}`,
    `  Total size: ${formatBytes(t.fileSizeBytes)}`,
  ]

  const langs = Object.entries(metrics.filesByLanguage)
    .sort((a, b) => b[1] - a[1])
  if (langs.length > 0) {
    lines.push('  Languages:')
    for (const [lang, count] of langs) {
      lines.push(`    ${lang}: ${count} files`)
    }
  }

  if (metrics.topComplexFiles.length > 0) {
    lines.push('  Most complex files:')
    for (const f of metrics.topComplexFiles.slice(0, 3)) {
      lines.push(`    ${f.path}: complexity=${f.complexity}`)
    }
  }

  if (metrics.largestFiles.length > 0) {
    lines.push('  Largest files:')
    for (const f of metrics.largestFiles.slice(0, 3)) {
      lines.push(`    ${f.path}: ${f.totalLines} lines`)
    }
  }

  return lines.join('\n')
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`
}

// ── Health Assessment ───────────────────────────────────────────────────────

export interface HealthAssessment {
  score: number // 0-100
  grade: 'A' | 'B' | 'C' | 'D' | 'F'
  issues: Array<{ severity: 'info' | 'warning' | 'critical'; message: string }>
  recommendations: string[]
}

export function assessHealth(metrics: FileMetrics): HealthAssessment {
  let score = 100
  const issues: HealthAssessment['issues'] = []
  const recommendations: string[] = []

  // Complexity check
  if (metrics.complexity > 50) {
    score -= 20
    issues.push({ severity: 'critical', message: `High complexity: ${metrics.complexity}` })
    recommendations.push('Refactor complex logic into smaller functions')
  } else if (metrics.complexity > 20) {
    score -= 10
    issues.push({ severity: 'warning', message: `Moderate complexity: ${metrics.complexity}` })
  }

  // Nesting depth
  if (metrics.maxNestingDepth > 5) {
    score -= 15
    issues.push({ severity: 'critical', message: `Deep nesting: ${metrics.maxNestingDepth} levels` })
    recommendations.push('Flatten deeply nested code using early returns or guard clauses')
  } else if (metrics.maxNestingDepth > 3) {
    score -= 5
    issues.push({ severity: 'warning', message: `Moderate nesting: ${metrics.maxNestingDepth} levels` })
  }

  // File length
  if (metrics.totalLines > 500) {
    score -= 10
    issues.push({ severity: 'warning', message: `Long file: ${metrics.totalLines} lines` })
    recommendations.push('Consider splitting into smaller modules')
  }

  // Line length
  if (metrics.averageLineLength > 100) {
    score -= 5
    issues.push({ severity: 'warning', message: `Long lines: avg ${metrics.averageLineLength} chars` })
    recommendations.push('Keep lines under 100 characters')
  }

  // TODOs
  if (metrics.todoCount > 5) {
    score -= 10
    issues.push({ severity: 'warning', message: `${metrics.todoCount} TODOs/FIXMEs` })
    recommendations.push('Address outstanding TODOs and FIXMEs')
  }

  // Duplicates
  if (metrics.duplicateLineRatio > 0.15) {
    score -= 10
    issues.push({ severity: 'warning', message: `${(metrics.duplicateLineRatio * 100).toFixed(0)}% duplicate lines` })
    recommendations.push('Extract duplicated code into reusable functions')
  }

  // Comment ratio
  const commentRatio = metrics.totalLines > 0
    ? metrics.commentLines / metrics.totalLines
    : 0
  if (commentRatio < 0.05 && metrics.codeLines > 50) {
    score -= 5
    issues.push({ severity: 'info', message: 'Low comment ratio' })
    recommendations.push('Add documentation comments')
  }

  score = Math.max(0, Math.min(100, score))

  const grade: HealthAssessment['grade'] =
    score >= 90 ? 'A' :
    score >= 80 ? 'B' :
    score >= 70 ? 'C' :
    score >= 60 ? 'D' : 'F'

  return { score, grade, issues, recommendations }
}

export function formatHealthAssessment(assessment: HealthAssessment): string {
  const lines: string[] = [
    `Code Health: ${assessment.grade} (${assessment.score}/100)`,
  ]

  if (assessment.issues.length > 0) {
    lines.push('Issues:')
    for (const issue of assessment.issues) {
      const icon = issue.severity === 'critical' ? '✗'
        : issue.severity === 'warning' ? '⚠'
        : 'ℹ'
      lines.push(`  ${icon} ${issue.message}`)
    }
  } else {
    lines.push('  ✓ No issues found')
  }

  if (assessment.recommendations.length > 0) {
    lines.push('Recommendations:')
    for (const rec of assessment.recommendations) {
      lines.push(`  → ${rec}`)
    }
  }

  return lines.join('\n')
}
