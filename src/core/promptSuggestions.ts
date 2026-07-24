/**
 * Prompt Suggestions
 *
 * Suggests 2-3 follow-up prompts to the user after each turn.
 * Unlike `suggestions.ts` (which suggests actions/commands), this module
 * generates actual natural-language prompts the user might want to send next.
 *
 * Sources:
 *   - Conversation analysis (what was just discussed)
 *   - File modifications (what needs testing/review)
 *   - Error patterns (common follow-ups)
 *   - Project context (TODOs, tests, docs)
 */

import { execSync } from 'child_process'
import { existsSync, readFileSync } from 'fs'
import { join, extname } from 'path'

// ── Types ───────────────────────────────────────────────────────────────────

export interface PromptSuggestion {
  /** The suggested prompt text */
  text: string
  /** Why this was suggested (short reason) */
  reason: string
  /** Confidence 0-1 */
  confidence: number
  /** Category for grouping */
  category: PromptCategory
}

export type PromptCategory =
  | 'testing'
  | 'review'
  | 'refactoring'
  | 'documentation'
  | 'follow-up'
  | 'next-steps'
  | 'exploration'
  | 'fixing'

export interface PromptContext {
  /** Files modified in the last turn */
  recentFiles: string[]
  /** Tools used in the last turn */
  recentTools: string[]
  /** Whether the last turn had errors */
  hadErrors: boolean
  /** The last user prompt */
  lastUserPrompt: string
  /** Last assistant response (first N chars) */
  lastAssistantSnippet: string
  /** Whether tests exist */
  hasTests: boolean
  /** Working directory */
  cwd: string
  /** Whether we're in a git repo */
  isGitRepo: boolean
}

export type PromptSuggestionRule = (ctx: PromptContext) => PromptSuggestion | null

// ── Helpers ─────────────────────────────────────────────────────────────────

export function detectLanguage(filePath: string): string {
  const ext = extname(filePath).toLowerCase()
  const map: Record<string, string> = {
    '.ts': 'TypeScript', '.tsx': 'TypeScript React',
    '.js': 'JavaScript', '.jsx': 'JavaScript React',
    '.py': 'Python', '.rb': 'Ruby', '.go': 'Go',
    '.rs': 'Rust', '.java': 'Java', '.c': 'C', '.cpp': 'C++',
    '.cs': 'C#', '.php': 'PHP', '.swift': 'Swift',
    '.kt': 'Kotlin', '.scala': 'Scala',
    '.sh': 'Shell', '.bash': 'Bash',
    '.yml': 'YAML', '.yaml': 'YAML', '.json': 'JSON',
    '.md': 'Markdown', '.html': 'HTML', '.css': 'CSS',
    '.sql': 'SQL',
  }
  return map[ext] ?? 'code'
}

export function isTestFile(filePath: string): boolean {
  const name = filePath.toLowerCase()
  return name.includes('.test.') || name.includes('.spec.')
    || name.includes('test/') || name.includes('tests/')
    || name.includes('__tests__') || name.includes('spec/')
}

// ── Suggestion Rules ────────────────────────────────────────────────────────

/**
 * Suggest running tests for recently modified code files.
 */
const ruleRunTests: PromptSuggestionRule = (ctx) => {
  if (!ctx.hasTests) return null
  const codeFiles = ctx.recentFiles.filter(f => !isTestFile(f) && !f.endsWith('.md'))
  if (codeFiles.length === 0) return null

  const firstFile = codeFiles[0].split('/').pop() ?? codeFiles[0]
  return {
    text: `Run the tests and report any failures related to ${firstFile}`,
    reason: `You modified ${codeFiles.length} code file(s) — verify tests pass`,
    confidence: 0.75,
    category: 'testing',
  }
}

/**
 * Suggest writing tests for untested code.
 */
const ruleWriteTests: PromptSuggestionRule = (ctx) => {
  const newFiles = ctx.recentFiles.filter(f => !isTestFile(f) && !f.endsWith('.md') && !f.endsWith('.json'))
  if (newFiles.length === 0) return null
  if (ctx.recentTools.includes('Write') === false) return null

  // Only suggest if no test file for this source exists
  const file = newFiles[0]
  return {
    text: `Write tests for ${file.split('/').pop()}`,
    reason: 'New file created without corresponding tests',
    confidence: 0.5,
    category: 'testing',
  }
}

/**
 * Suggest reviewing changes.
 */
const ruleReviewChanges: PromptSuggestionRule = (ctx) => {
  if (ctx.recentFiles.length < 2) return null
  return {
    text: 'Review the changes I just made and suggest improvements',
    reason: `Multiple files (${ctx.recentFiles.length}) were modified`,
    confidence: 0.6,
    category: 'review',
  }
}

/**
 * Suggest fixing errors.
 */
const ruleFixErrors: PromptSuggestionRule = (ctx) => {
  if (!ctx.hadErrors) return null
  return {
    text: 'Fix the errors from the previous attempt',
    reason: 'The last turn encountered errors',
    confidence: 0.85,
    category: 'fixing',
  }
}

/**
 * Suggest committing changes.
 */
const ruleCommit: PromptSuggestionRule = (ctx) => {
  if (ctx.recentFiles.length === 0) return null
  if (!ctx.isGitRepo) return null
  if (ctx.hadErrors) return null
  return {
    text: 'Commit these changes with a descriptive message',
    reason: 'Changes look complete — commit to save progress',
    confidence: 0.55,
    category: 'next-steps',
  }
}

/**
 * Suggest adding documentation.
 */
const ruleAddDocs: PromptSuggestionRule = (ctx) => {
  const codeFiles = ctx.recentFiles.filter(f => {
    const ext = extname(f).toLowerCase()
    return ['.ts', '.tsx', '.js', '.jsx', '.py', '.go', '.rs'].includes(ext)
  })
  if (codeFiles.length === 0) return null

  const file = codeFiles[0].split('/').pop() ?? codeFiles[0]
  return {
    text: `Add JSDoc comments to the exported functions in ${file}`,
    reason: 'Code was modified — consider documenting public API',
    confidence: 0.35,
    category: 'documentation',
  }
}

/**
 * Suggest refactoring when a file is very large or complex.
 */
const ruleRefactorLarge: PromptSuggestionRule = (ctx) => {
  for (const file of ctx.recentFiles) {
    const ext = extname(file).toLowerCase()
    if (!['.ts', '.tsx', '.js', '.jsx', '.py', '.go', '.rs', '.java', '.c', '.cpp'].includes(ext)) continue
    try {
      const fullPath = join(ctx.cwd, file)
      if (!existsSync(fullPath)) continue
      const content = readFileSync(fullPath, 'utf8')
      const lines = content.split('\n').length
      if (lines > 300) {
        const name = file.split('/').pop() ?? file
        return {
          text: `Refactor ${name} — it's ${lines} lines. Break it into smaller modules`,
          reason: `${name} is ${lines} lines (large file)`,
          confidence: 0.4,
          category: 'refactoring',
        }
      }
    } catch { /* skip */ }
  }
  return null
}

/**
 * Suggest extracting a reusable utility when patterns repeat.
 */
const ruleExtractPattern: PromptSuggestionRule = (ctx) => {
  const editCount = ctx.recentTools.filter(t => t === 'Edit').length
  if (editCount < 3) return null
  return {
    text: 'Check if any of the recent edits could be extracted into a shared helper',
    reason: `${editCount} edits made — possible duplication`,
    confidence: 0.3,
    category: 'refactoring',
  }
}

/**
 * Suggest exploring related code.
 */
const ruleExploreRelated: PromptSuggestionRule = (ctx) => {
  if (ctx.recentFiles.length === 0) return null
  const file = ctx.recentFiles[0]
  const dir = file.split('/').slice(0, -1).join('/')
  if (!dir) return null
  return {
    text: `Explore the other files in ${dir}/ and explain how they relate to ${file.split('/').pop()}`,
    reason: 'Understand the surrounding module structure',
    confidence: 0.35,
    category: 'exploration',
  }
}

/**
 * Suggest handling edge cases.
 */
const ruleEdgeCases: PromptSuggestionRule = (ctx) => {
  const codeFiles = ctx.recentFiles.filter(f => {
    const ext = extname(f).toLowerCase()
    return ['.ts', '.tsx', '.js', '.jsx', '.py'].includes(ext)
  })
  if (codeFiles.length === 0) return null

  return {
    text: `What edge cases might the code in ${codeFiles[0].split('/').pop()} not handle?`,
    reason: 'Proactively identify edge cases',
    confidence: 0.45,
    category: 'review',
  }
}

// ── Engine ──────────────────────────────────────────────────────────────────

export const ALL_PROMPT_RULES: PromptSuggestionRule[] = [
  ruleFixErrors,
  ruleRunTests,
  ruleReviewChanges,
  ruleRefactorLarge,
  ruleCommit,
  ruleWriteTests,
  ruleAddDocs,
  ruleEdgeCases,
  ruleExtractPattern,
  ruleExploreRelated,
]

/**
 * Generate prompt suggestions based on context.
 */
export function generatePromptSuggestions(
  ctx: PromptContext,
  rules: PromptSuggestionRule[] = ALL_PROMPT_RULES,
  maxResults = 3,
): PromptSuggestion[] {
  const results: PromptSuggestion[] = []

  for (const rule of rules) {
    try {
      const suggestion = rule(ctx)
      if (suggestion) results.push(suggestion)
    } catch { /* skip */ }
  }

  results.sort((a, b) => b.confidence - a.confidence)
  return results.slice(0, maxResults)
}

/**
 * Format suggestions for display.
 */
export function formatPromptSuggestions(suggestions: PromptSuggestion[]): string {
  if (suggestions.length === 0) return ''
  const lines: string[] = ['💡 Suggested next prompts:']
  for (let i = 0; i < suggestions.length; i++) {
    const s = suggestions[i]
    lines.push(`  ${i + 1}. ${s.text}`)
    lines.push(`     ${s.reason}`)
  }
  return lines.join('\n')
}

/**
 * Build context from engine state.
 */
export function buildPromptContext(
  cwd: string,
  recentFiles: string[],
  recentTools: string[],
  hadErrors: boolean,
  lastUserPrompt: string,
  lastAssistantSnippet: string,
  hasTests: boolean,
): PromptContext {
  let isGitRepo = false
  try {
    execSync('git rev-parse --is-inside-work-tree', {
      cwd, stdio: 'pipe', timeout: 2000,
    })
    isGitRepo = true
  } catch { /* not a git repo */ }

  return {
    recentFiles,
    recentTools,
    hadErrors,
    lastUserPrompt,
    lastAssistantSnippet,
    hasTests,
    cwd,
    isGitRepo,
  }
}
