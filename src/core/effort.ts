/**
 * Effort System
 *
 * Control the depth of reasoning and analysis.
 * Higher effort = more thinking, deeper analysis, slower responses.
 * Lower effort = faster, more direct answers.
 */

import type { TaskKind } from './runtime/taskIntent.js'

// ── Types ───────────────────────────────────────────────────────────────────

export type EffortLevel = 'minimal' | 'low' | 'medium' | 'high' | 'maximum'

export interface EffortConfig {
  level: EffortLevel
  thinkingTokens: number
  maxSearchResults: number
  verificationDepth: 'none' | 'quick' | 'thorough'
  explanationDetail: 'minimal' | 'normal' | 'detailed'
  multiApproach: boolean
  edgeCaseAnalysis: boolean
}

// ── Presets ─────────────────────────────────────────────────────────────────

export const EFFORT_PRESETS: Record<EffortLevel, EffortConfig> = {
  minimal: {
    level: 'minimal',
    thinkingTokens: 0,
    maxSearchResults: 3,
    verificationDepth: 'none',
    explanationDetail: 'minimal',
    multiApproach: false,
    edgeCaseAnalysis: false,
  },
  low: {
    level: 'low',
    thinkingTokens: 500,
    maxSearchResults: 5,
    verificationDepth: 'none',
    explanationDetail: 'minimal',
    multiApproach: false,
    edgeCaseAnalysis: false,
  },
  medium: {
    level: 'medium',
    thinkingTokens: 2000,
    maxSearchResults: 10,
    verificationDepth: 'quick',
    explanationDetail: 'normal',
    multiApproach: false,
    edgeCaseAnalysis: false,
  },
  high: {
    level: 'high',
    thinkingTokens: 5000,
    maxSearchResults: 20,
    verificationDepth: 'thorough',
    explanationDetail: 'detailed',
    multiApproach: true,
    edgeCaseAnalysis: true,
  },
  maximum: {
    level: 'maximum',
    thinkingTokens: 10000,
    maxSearchResults: 50,
    verificationDepth: 'thorough',
    explanationDetail: 'detailed',
    multiApproach: true,
    edgeCaseAnalysis: true,
  },
}

// ── State ───────────────────────────────────────────────────────────────────

let currentEffort: EffortLevel = 'medium'

export function getCurrentEffort(): EffortLevel {
  return currentEffort
}

export function setEffort(level: EffortLevel): EffortConfig {
  currentEffort = level
  return getEffortConfig(level)
}

export function getEffortConfig(level?: EffortLevel): EffortConfig {
  return EFFORT_PRESETS[level ?? currentEffort]
}

export function cycleEffort(): EffortLevel {
  const levels: EffortLevel[] = ['minimal', 'low', 'medium', 'high', 'maximum']
  const idx = levels.indexOf(currentEffort)
  const next = levels[(idx + 1) % levels.length]
  currentEffort = next
  return next
}

// ── Prompt Generation ───────────────────────────────────────────────────────

export function getEffortPrompt(level?: EffortLevel): string {
  const config = getEffortConfig(level ?? currentEffort)

  const parts: string[] = []

  switch (config.explanationDetail) {
    case 'minimal':
      parts.push('Be extremely concise. Only output code or the direct answer.')
      break
    case 'normal':
      parts.push('Provide clear, direct answers with necessary context.')
      break
    case 'detailed':
      parts.push('Provide thorough explanations. Include context, trade-offs, and alternatives.')
      break
  }

  if (config.multiApproach) {
    parts.push('Consider multiple approaches. Present alternatives with trade-offs.')
  }

  if (config.edgeCaseAnalysis) {
    parts.push('Analyze edge cases: null, empty, boundary values, concurrent access.')
  }

  switch (config.verificationDepth) {
    case 'none':
      break
    case 'quick':
      parts.push('Quickly verify your changes by reading the result.')
      break
    case 'thorough':
      parts.push('Thoroughly verify changes. Read results, run tests if possible.')
      break
  }

  if (config.thinkingTokens > 0) {
    parts.push(`Use up to ${config.thinkingTokens} thinking tokens for reasoning before responding.`)
  }

  return parts.join(' ')
}

// ── Formatting ──────────────────────────────────────────────────────────────

const EFFORT_ICONS: Record<EffortLevel, string> = {
  minimal: '○',
  low: '◐',
  medium: '●',
  high: '◉',
  maximum: '★',
}

export function formatEffort(level?: EffortLevel): string {
  const l = level ?? currentEffort
  const config = getEffortConfig(l)
  const icon = EFFORT_ICONS[l]
  return `${icon} ${l} (thinking: ${config.thinkingTokens}, search: ${config.maxSearchResults}, verify: ${config.verificationDepth})`
}

export function formatEffortList(): string {
  const levels: EffortLevel[] = ['minimal', 'low', 'medium', 'high', 'maximum']
  const lines: string[] = ['Effort Levels:']
  for (const level of levels) {
    const config = EFFORT_PRESETS[level]
    const icon = EFFORT_ICONS[level]
    const active = level === currentEffort ? ' ← active' : ''
    lines.push(`  ${icon} ${level.padEnd(8)} think=${config.thinkingTokens} search=${config.maxSearchResults}${active}`)
  }
  return lines.join('\n')
}

// ── Execution Profiles (v0.4.1 WS4: Golden Path Closure) ──────────────────────
//
// A profile fixes the RESOURCE DEPTH of one turn: which capability
// modules boot, the iteration cap, the output-token budget, and which
// heavyweight tools are hidden. It is a different axis from TaskKind
// (completionContract semantics — informational vs mutation): e.g. a
// mutation task can run under `deep`, an informational one under `fast`.
//
// Renamed from the v0.4.0 dead-code "ExecutionGear" — the types existed
// but were never wired. v0.4.1 wires them per-turn through
// ModuleManager.boot({only}), ToolPolicy excludedTools, and the
// coordinator's effective iteration/output limits.

export type ExecutionProfile = 'fast' | 'standard' | 'deep' | 'autonomous'

export type ProfileSource = 'override' | 'intent' | 'detected' | 'default'

export interface ExecutionProfileSpec {
  /**
   * Base capability modules booted under this profile (subset of the
   * engine's constructed module set — filtering happens per turn in
   * ModuleManager.boot({only}), the constructor list stays full).
   * `mcp` is NOT listed here: it is config-gated and appended at
   * wiring time whenever the engine constructed it, under EVERY
   * profile — a user's MCP setup is never silently dropped by a
   * profile change.
   */
  modules: string[]
  /** Per-turn iteration cap. undefined → EngineConfig.maxIterations unchanged. */
  maxIterations?: number
  /** Per-turn output-token budget. undefined → EngineConfig.maxOutputTokens unchanged. */
  maxOutputTokens?: number
  /** Tools hidden from the model AND blocked at execution under this profile. */
  excludedTools?: string[]
  description: string
}

export const EXECUTION_PROFILES: Record<ExecutionProfile, ExecutionProfileSpec> = {
  fast: {
    modules: ['memory', 'workspace'],
    maxIterations: 30,
    excludedTools: ['Agent', 'TaskPlan'],
    description: 'Lightweight turn: no Critic, no Reflection, no sub-agents, no task graph. Write access follows TaskIntent.',
  },
  standard: {
    // v0.5.3 Hotfix §11: reflection removed from default profile
    // (moved to experimental/). The standard profile now boots the
    // four production modules.
    modules: ['memory', 'critic', 'workspace', 'mcp'],
    description: 'Default: production module set, engine-configured limits.',
  },
  deep: {
    modules: ['memory', 'critic', 'workspace', 'mcp'],
    maxIterations: 300,
    maxOutputTokens: 32000,
    description: 'Complex refactors / migrations: raised iteration and output budgets.',
  },
  autonomous: {
    // Documentary: --loop entries boot through their own runLoop path;
    // this spec exists so /profile can show and validate the full set.
    modules: ['memory', 'critic', 'workspace', 'mcp'],
    description: 'Background loop autonomy (driven by the --loop entry, not per-turn resolution).',
  },
}

export function isExecutionProfile(value: string): value is ExecutionProfile {
  return value === 'fast' || value === 'standard' || value === 'deep' || value === 'autonomous'
}

export function detectExecutionProfile(taskPrompt: string, isLoop = false): ExecutionProfile {
  if (isLoop) return 'autonomous'
  const prompt = taskPrompt.toLowerCase().trim()
  if (!prompt) return 'fast'

  // Deep profile: complex refactoring, multi-module architecture, major migrations
  const isComplex = /(architect|refactor|migrat|redesign|multi-file|multiple directories|cross-module|rewrite system|end-to-end|security audit|root-cause|root cause)|(全面重构|跨模块|迁移|架构调整|架构改造|深度审计|根因分析|整体改造|公共接口|跨目录)/.test(prompt)
  if (isComplex) {
    return 'deep'
  }

  // Fast profile: pure questions, explanations, status checks
  const isQuestion = /^(what|how|why|explain|tell|where|is|can|show|list|find|search|grep|doc|status|health)\b/.test(prompt)
  const isEditAction = /(fix|edit|add|write|modify|create|delete|update|replace|implement|build|remove)/.test(prompt)

  if (isQuestion && !isEditAction) {
    return 'fast'
  }

  if (prompt.length < 30 && !isEditAction) {
    return 'fast'
  }

  return 'standard'
}

/**
 * Resolve the execution profile for ONE turn. Precedence:
 *   1. sticky override (--profile / /profile) — always wins, any source;
 *   2. TaskIntent: informational (pure Q&A) → fast, even when the regex
 *      would say otherwise (the classifier has more signal than keywords);
 *   3. detectExecutionProfile regex — responsible for `deep` escalation
 *      (and legacy `fast` detection on analysis-shaped prompts);
 *   4. standard default.
 */
export function resolveExecutionProfile(
  message: string,
  intent: { kind: TaskKind } | null | undefined,
  override?: ExecutionProfile | null,
): { profile: ExecutionProfile; source: ProfileSource } {
  if (override) return { profile: override, source: 'override' }
  const detected = detectExecutionProfile(message)
  if (detected === 'deep') return { profile: 'deep', source: 'detected' }
  if (intent?.kind === 'informational') return { profile: 'fast', source: 'intent' }
  if (detected !== 'standard') return { profile: detected, source: 'detected' }
  return { profile: 'standard', source: 'default' }
}
