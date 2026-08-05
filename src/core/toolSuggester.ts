/**
 * ToolSuggester (v0.6.0) — context-aware tool recommendation.
 *
 * Given the current task context (user prompt, recent tool calls, current
 * phase), suggest the most relevant tools from the registry. This mirrors
 * Codex's context-aware tool selection and helps the model pick the right
 * tool faster, reducing wasted turns.
 *
 * Design:
 *   - Keyword-based scoring against each tool's name + searchHint +
 *     description keywords
 *   - Recency penalty: tools already called in the last N calls are
 *     ranked slightly lower (avoid repeating the same tool)
 *   - Phase hints: plan-mode biases read-only tools; mutation phase
 *     biases Edit/MultiEdit/Bash
 *   - Pure + deterministic → unit-testable
 */

import type { ToolDefinition } from './types.js'

// ── Types ───────────────────────────────────────────────────────────────────

export interface SuggestionContext {
  /** Free-text task description / user prompt. */
  task?: string
  /** Tool names already used recently (recency penalty). */
  recentTools?: string[]
  /** True if in plan/analysis mode (bias read-only tools). */
  planMode?: boolean
  /** Optional phase: 'explore' | 'edit' | 'verify' | 'test' | 'commit' */
  phase?: string
  limit?: number
}

export interface ToolSuggestion {
  name: string
  score: number
  reason: string
}

export interface SuggestableTool {
  name: string
  description: string
  searchHint?: string
  /** Whether the tool mutates state. */
  mutatesState?: boolean
  /** Keywords for matching (beyond name/hint). */
  keywords?: string[]
}

// ── Keyword lexicon ─────────────────────────────────────────────────────────

const PHASE_KEYWORDS: Record<string, string[]> = {
  explore: ['read', 'glob', 'grep', 'search', 'list', 'find', 'explore', 'scan', 'discover', 'structure', 'index'],
  edit: ['edit', 'write', 'multi', 'patch', 'insert', 'delete', 'replace', 'change', 'modify', 'create'],
  verify: ['test', 'check', 'verify', 'validate', 'diagnostic', 'lint', 'review', 'typecheck', 'quality'],
  commit: ['commit', 'git', 'diff', 'history', 'stage', 'push', 'branch'],
}

// ── Implementation ──────────────────────────────────────────────────────────

/** Score a single tool against the task text. */
function scoreTool(tool: SuggestableTool, task: string, phase: string | undefined): number {
  const lowerTask = task.toLowerCase()
  let score = 0
  const reasons: string[] = []

  // Exact name match.
  if (lowerTask.includes(tool.name.toLowerCase())) {
    score += 10
    reasons.push('name match')
  }

  // searchHint keyword match.
  const hintWords = (tool.searchHint ?? '').toLowerCase().split(/\s+/)
  for (const w of hintWords) {
    if (w.length > 2 && lowerTask.includes(w)) {
      score += 3
      reasons.push(`hint "${w}"`)
    }
  }

  // Description keyword match (first 50 words).
  const descWords = tool.description.toLowerCase().slice(0, 1000).split(/\s+/)
  const descSet = new Set(descWords.filter(w => w.length > 3))
  const taskWords = new Set(lowerTask.split(/\s+/).filter(w => w.length > 3))
  for (const w of taskWords) {
    if (descSet.has(w)) {
      score += 2
      if (reasons.length < 3) reasons.push(`desc "${w}"`)
    }
  }

  // Custom keywords.
  for (const kw of tool.keywords ?? []) {
    if (lowerTask.includes(kw.toLowerCase())) {
      score += 4
      reasons.push(`kw "${kw}"`)
    }
  }

  // Phase bias.
  if (phase) {
    const phaseWords = PHASE_KEYWORDS[phase] ?? []
    for (const w of phaseWords) {
      if (lowerTask.includes(w)) {
        score += 2
        break
      }
    }
  }

  return score
}

/**
 * Suggest the most relevant tools for a task context.
 * Returns suggestions sorted by score descending.
 */
export function suggestTools(tools: SuggestableTool[], ctx: SuggestionContext = {}): ToolSuggestion[] {
  const task = ctx.task ?? ''
  const limit = ctx.limit ?? 5
  const recent = new Set(ctx.recentTools ?? [])
  const phase = ctx.phase

  const scored = tools
    .map(tool => {
      let score = scoreTool(tool, task, phase)
      let reason = score > 0 ? `matched ${tool.name}` : ''

      // Recency penalty: -30% if just used.
      if (recent.has(tool.name)) {
        score = Math.floor(score * 0.7)
        reason = (reason ? reason + '; ' : '') + 'recently used'
      }

      // Plan mode: prefer read-only tools.
      if (ctx.planMode && tool.mutatesState) {
        score = Math.floor(score * 0.5)
        reason = (reason ? reason + '; ' : '') + 'plan mode demotes mutating tool'
      }

      return { tool, score, reason }
    })
    .filter(s => s.score > 0)
    .sort((a, b) => b.score - a.score)

  return scored.slice(0, limit).map(s => ({
    name: s.tool.name,
    score: s.score,
    reason: s.reason,
  }))
}

/**
 * Adapter: convert ToolDefinition[] (the runtime's registry shape) into
 * SuggestableTool[] for the suggester.
 */
export function fromDefinitions(defs: ToolDefinition[]): SuggestableTool[] {
  return defs.map(d => ({
    name: d.function.name,
    description: d.function.description,
    mutatesState: (d as { mutatesState?: boolean }).mutatesState,
  }))
}

/** Format suggestions as human-readable text for the model. */
export function formatSuggestions(suggestions: ToolSuggestion[]): string {
  if (suggestions.length === 0) return 'No tool suggestions — use core tools directly.'
  return suggestions
    .map((s, i) => `${i + 1}. ${s.name} (score ${s.score})${s.reason ? ` — ${s.reason}` : ''}`)
    .join('\n')
}
