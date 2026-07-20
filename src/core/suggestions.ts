/**
 * Proactive Suggestions
 *
 * Analyzes conversation context, tool results, git state, and idle time
 * to offer helpful suggestions to the user. Non-intrusive — the UI layer
 * decides how to display them.
 *
 * Suggestion triggers:
 *   - File changes detected (git diff) → "review changes", "commit"
 *   - Tool errors in recent history → "debug this", "try alternative"
 *   - Repeated patterns → "create a skill", "refactor"
 *   - Idle after task completion → "run tests", "commit", "next task"
 *   - Large untracked files → "add to .gitignore"
 *   - Test failures → "fix tests", "show diff"
 *   - TODO/FIXME in code → "address TODOs"
 */

import { execSync } from 'child_process'
import { existsSync, readFileSync } from 'fs'
import { join, resolve, extname } from 'path'

// ── Types ───────────────────────────────────────────────────────────────────

export type SuggestionCategory =
  | 'git'
  | 'testing'
  | 'debugging'
  | 'refactoring'
  | 'workflow'
  | 'discovery'
  | 'optimization'
  | 'safety'

export interface Suggestion {
  /** Unique id for dedup */
  id: string
  /** Short label (shown as a clickable/hint) */
  label: string
  /** Longer description */
  description: string
  /** Category for icon/color */
  category: SuggestionCategory
  /** Confidence 0-1 */
  confidence: number
  /** Optional prompt to execute if accepted */
  actionPrompt?: string
  /** Optional slash command to execute */
  actionCommand?: string
}

export interface SuggestionContext {
  /** Working directory */
  cwd: string
  /** Recent tool call results (last N) */
  recentToolResults: ToolResultSummary[]
  /** Current conversation length */
  conversationLength: number
  /** Whether the last turn completed successfully */
  lastTurnCompleted: boolean
  /** Whether there are uncommitted changes */
  hasUncommittedChanges?: boolean
  /** Number of TODO/FIXME found (if scanned) */
  todoCount?: number
  /** Whether tests exist in the project */
  hasTests?: boolean
  /** Whether tests were recently run */
  testsRecentlyRun?: boolean
  /** Last test run passed? */
  lastTestPassed?: boolean
  /** Files modified since last commit */
  modifiedFiles?: string[]
  /** Idle time in seconds since last interaction */
  idleSeconds?: number
}

export interface ToolResultSummary {
  toolName: string
  isError: boolean
  /** Brief summary of the result */
  summary: string
}

export type SuggestionRule = (ctx: SuggestionContext) => Suggestion | null

// ── Git State Helper ────────────────────────────────────────────────────────

export interface GitState {
  hasGit: boolean
  modifiedCount: number
  stagedCount: number
  untrackedCount: number
  modifiedFiles: string[]
  ahead: number
  behind: number
  branch: string | null
}

export function getGitState(cwd: string): GitState {
  const state: GitState = {
    hasGit: false,
    modifiedCount: 0,
    stagedCount: 0,
    untrackedCount: 0,
    modifiedFiles: [],
    ahead: 0,
    behind: 0,
    branch: null,
  }

  try {
    const run = (cmd: string): string => {
      return execSync(cmd, { cwd, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim()
    }

    state.hasGit = true
    state.branch = run('git rev-parse --abbrev-ref HEAD')
    const status = run('git status --porcelain=v1')

    for (const line of status.split('\n').filter(Boolean)) {
      const code = line.slice(0, 2)
      const file = line.slice(3).trim()
      if (code[0] === '?' && code[1] === '?') {
        state.untrackedCount++
      } else {
        if (code[0] !== ' ' && code[0] !== '?') state.stagedCount++
        if (code[1] !== ' ' && code[1] !== '?') state.modifiedCount++
        if (code[1] !== ' ' && code[1] !== '?') state.modifiedFiles.push(file)
      }
    }

    // Ahead/behind
    try {
      const tracking = run('git rev-list --left-right --count HEAD...@{upstream} 2>/dev/null')
      const [ahead, behind] = tracking.split(/\s+/).map(Number)
      state.ahead = isNaN(ahead) ? 0 : ahead
      state.behind = isNaN(behind) ? 0 : behind
    } catch { /* no upstream */ }
  } catch {
    // not a git repo or git not available
  }

  return state
}

// ── TODO Scanner ────────────────────────────────────────────────────────────

export function scanForTODOs(cwd: string, maxFiles = 50): { count: number; files: string[] } {
  const codeExtensions = new Set([
    '.ts', '.tsx', '.js', '.jsx', '.py', '.rb', '.go', '.rs', '.java',
    '.c', '.cpp', '.h', '.hpp', '.cs', '.php', '.swift', '.kt',
  ])
  const files: string[] = []
  let count = 0

  try {
    const output = execSync(
      'git grep -l -E "TODO|FIXME|HACK|XXX|BUG" 2>/dev/null || true',
      { cwd, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], timeout: 3000 },
    ).trim()

    if (output) {
      for (const f of output.split('\n').filter(Boolean).slice(0, maxFiles)) {
        files.push(f)
        try {
          const content = readFileSync(join(cwd, f), 'utf8')
          const matches = content.match(/\b(TODO|FIXME|HACK|XXX|BUG)\b/g)
          count += matches?.length ?? 0
        } catch { /* skip */ }
      }
    }
  } catch { /* best-effort */ }

  return { count, files }
}

// ── Test Detection ──────────────────────────────────────────────────────────

export function detectTestSetup(cwd: string): { hasTests: boolean; framework: string | null } {
  const checks: Array<[string, string]> = [
    ['vitest', 'package.json'],
    ['jest', 'package.json'],
    ['pytest', 'pytest.ini'],
    ['pytest', 'pyproject.toml'],
    ['pytest', 'setup.cfg'],
    ['go test', 'go.mod'],
    ['cargo test', 'Cargo.toml'],
    ['xunit', '*.csproj'],
    ['rspec', 'Gemfile'],
  ]

  for (const [framework, marker] of checks) {
    if (marker === 'package.json') {
      const pkgPath = join(resolve(cwd), 'package.json')
      if (existsSync(pkgPath)) {
        try {
          const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'))
          if (pkg.devDependencies?.[framework] || pkg.dependencies?.[framework]) {
            return { hasTests: true, framework }
          }
        } catch { /* skip */ }
      }
    } else if (marker.includes('*')) {
      // glob markers not supported without fs.glob — skip
    } else {
      if (existsSync(join(resolve(cwd), marker))) {
        return { hasTests: true, framework }
      }
    }
  }

  // Check for test directories
  const testDirs = ['tests', 'test', '__tests__', 'spec']
  for (const dir of testDirs) {
    if (existsSync(join(resolve(cwd), dir))) {
      return { hasTests: true, framework: null }
    }
  }

  return { hasTests: false, framework: null }
}

// ── Suggestion Rules ────────────────────────────────────────────────────────

/**
 * Suggest committing changes when there are staged/unstaged files
 * after a successful turn.
 */
const ruleCommitAfterChanges: SuggestionRule = (ctx) => {
  if (!ctx.lastTurnCompleted) return null
  if (!ctx.hasUncommittedChanges) return null
  if ((ctx.modifiedFiles?.length ?? 0) === 0) return null

  const fileCount = ctx.modifiedFiles!.length
  return {
    id: 'commit-changes',
    label: 'Commit changes',
    description: `You have ${fileCount} modified file(s). Commit your work?`,
    category: 'git',
    confidence: 0.7,
    actionCommand: '/commit',
  }
}

/**
 * Suggest running tests if they exist and haven't been run recently.
 */
const ruleRunTests: SuggestionRule = (ctx) => {
  if (!ctx.hasTests) return null
  if (ctx.testsRecentlyRun) return null
  if (!ctx.lastTurnCompleted) return null

  return {
    id: 'run-tests',
    label: 'Run tests',
    description: 'Run the test suite to verify your changes?',
    category: 'testing',
    confidence: 0.6,
    actionPrompt: 'Run the test suite and report results',
  }
}

/**
 * Suggest fixing errors when tool calls failed recently.
 */
const ruleFixErrors: SuggestionRule = (ctx) => {
  const errors = ctx.recentToolResults.filter(r => r.isError)
  if (errors.length === 0) return null

  const lastError = errors[errors.length - 1]
  return {
    id: 'fix-error',
    label: 'Fix error',
    description: `Recent ${lastError.toolName} error: ${lastError.summary.slice(0, 80)}`,
    category: 'debugging',
    confidence: 0.8,
    actionPrompt: `Fix the error from ${lastError.toolName}: ${lastError.summary}`,
  }
}

/**
 * Suggest addressing TODOs when many are found.
 */
const ruleAddressTODOs: SuggestionRule = (ctx) => {
  if (!ctx.todoCount || ctx.todoCount < 3) return null

  return {
    id: 'address-todos',
    label: 'Address TODOs',
    description: `${ctx.todoCount} TODO/FIXME items found. Consider addressing some?`,
    category: 'workflow',
    confidence: 0.4,
    actionPrompt: 'Find and list all TODO/FIXME items in the codebase',
  }
}

/**
 * Suggest pushing when ahead of upstream.
 */
const rulePushAhead: SuggestionRule = (ctx) => {
  // This rule needs git state — caller provides via modifiedFiles count
  // We infer from context if possible
  if (!ctx.hasUncommittedChanges) return null
  return null // handled by commit rule
}

/**
 * Suggest creating a skill when the same pattern repeats.
 */
const ruleCreateSkill: SuggestionRule = (ctx) => {
  if (ctx.conversationLength < 20) return null

  // Check if user has been doing similar tool sequences
  const toolSequence = ctx.recentToolResults.map(r => r.toolName).join(',')
  const repeatedPatterns = ['Read,Edit,Read,Edit', 'Bash,Read,Bash,Read', 'Grep,Read,Edit,Grep,Read,Edit']
  for (const pattern of repeatedPatterns) {
    if (toolSequence.includes(pattern)) {
      return {
        id: 'create-skill',
        label: 'Create skill',
        description: 'You seem to be repeating a workflow. Create a reusable skill?',
        category: 'workflow',
        confidence: 0.3,
        actionCommand: '/skill-save',
      }
    }
  }
  return null
}

/**
 * Suggest reviewing a large diff.
 */
const ruleReviewLargeDiff: SuggestionRule = (ctx) => {
  const modCount = ctx.modifiedFiles?.length ?? 0
  if (modCount < 5) return null

  return {
    id: 'review-diff',
    label: 'Review changes',
    description: `${modCount} files modified. Review the diff before committing?`,
    category: 'safety',
    confidence: 0.6,
    actionCommand: '/diff',
  }
}

/**
 * Suggest compacting when conversation is very long.
 */
const ruleCompactLong: SuggestionRule = (ctx) => {
  if (ctx.conversationLength < 100) return null

  return {
    id: 'compact-conversation',
    label: 'Compact context',
    description: `Conversation has ${ctx.conversationLength} messages. Compact to save tokens?`,
    category: 'optimization',
    confidence: 0.75,
    actionCommand: '/compact',
  }
}

/**
 * Suggest idle-time actions.
 */
const ruleIdleAction: SuggestionRule = (ctx) => {
  if (!ctx.idleSeconds || ctx.idleSeconds < 60) return null

  const git = getGitState(ctx.cwd)
  if (git.ahead > 0 && git.modifiedCount === 0) {
    return {
      id: 'push-commits',
      label: 'Push commits',
      description: `You're ${git.ahead} commit(s) ahead of upstream. Push?`,
      category: 'git',
      confidence: 0.5,
      actionPrompt: 'Push commits to the remote',
    }
  }
  return null
}

// ── All Rules ───────────────────────────────────────────────────────────────

export const ALL_SUGGESTION_RULES: SuggestionRule[] = [
  ruleFixErrors,
  ruleCompactLong,
  ruleCommitAfterChanges,
  ruleReviewLargeDiff,
  ruleRunTests,
  ruleAddressTODOs,
  rulePushAhead,
  ruleCreateSkill,
  ruleIdleAction,
]

// ── Engine ──────────────────────────────────────────────────────────────────

/**
 * Generate suggestions based on context.
 * Returns suggestions sorted by confidence (descending).
 * Deduplicates by id.
 */
export function generateSuggestions(
  ctx: SuggestionContext,
  rules: SuggestionRule[] = ALL_SUGGESTION_RULES,
  maxResults = 5,
): Suggestion[] {
  const seen = new Set<string>()
  const results: Suggestion[] = []

  for (const rule of rules) {
    try {
      const suggestion = rule(ctx)
      if (suggestion && !seen.has(suggestion.id)) {
        seen.add(suggestion.id)
        results.push(suggestion)
      }
    } catch { /* rule failure shouldn't crash the engine */ }
  }

  results.sort((a, b) => b.confidence - a.confidence)
  return results.slice(0, maxResults)
}

/**
 * Enrich a base context with auto-detected data (git state, tests, TODOs).
 */
export function enrichContext(ctx: Partial<SuggestionContext>, cwd: string): SuggestionContext {
  const git = getGitState(cwd)
  const tests = detectTestSetup(cwd)
  const todos = scanForTODOs(cwd)

  return {
    cwd,
    recentToolResults: ctx.recentToolResults ?? [],
    conversationLength: ctx.conversationLength ?? 0,
    lastTurnCompleted: ctx.lastTurnCompleted ?? false,
    hasUncommittedChanges: ctx.hasUncommittedChanges ?? (git.modifiedCount > 0 || git.stagedCount > 0),
    todoCount: ctx.todoCount ?? todos.count,
    hasTests: ctx.hasTests ?? tests.hasTests,
    testsRecentlyRun: ctx.testsRecentlyRun ?? false,
    lastTestPassed: ctx.lastTestPassed,
    modifiedFiles: ctx.modifiedFiles ?? git.modifiedFiles,
    idleSeconds: ctx.idleSeconds,
  }
}

/**
 * Format a suggestion for display.
 */
export function formatSuggestion(s: Suggestion): string {
  const icon = CATEGORY_ICONS[s.category]
  const pct = Math.round(s.confidence * 100)
  return `${icon} ${s.label} (${pct}%) — ${s.description}`
}

export const CATEGORY_ICONS: Record<SuggestionCategory, string> = {
  git: '📝',
  testing: '🧪',
  debugging: '🐛',
  refactoring: '🔧',
  workflow: '⚡',
  discovery: '🔍',
  optimization: '⚡',
  safety: '🛡️',
}

/**
 * Format multiple suggestions as a numbered list.
 */
export function formatSuggestionList(suggestions: Suggestion[]): string {
  if (suggestions.length === 0) return ''
  return suggestions.map((s, i) => {
    return `${i + 1}. ${formatSuggestion(s)}`
  }).join('\n')
}
