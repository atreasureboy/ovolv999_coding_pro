/**
 * Enhanced Permission Rules
 *
 * Glob-based permission rules for fine-grained access control.
 * Supports allow/deny lists with glob patterns, per-tool rules,
 * and user approval flows.
 */

import { globMatch as globMatchFn } from '../utils/globMatch.js'

// ── Types ───────────────────────────────────────────────────────────────────

export type PermissionDecision = 'allow' | 'deny' | 'ask'

export interface PermissionRule {
  /** Unique rule id */
  id: string
  /** Tool name to match (glob, e.g. 'Bash', 'Read', 'Write', '*' for all) */
  tool: string
  /** Glob pattern to match against the tool's primary argument (file path, command, etc.) */
  pattern: string
  /** Decision when rule matches */
  decision: PermissionDecision
  /** Human-readable reason */
  reason?: string
  /** Priority (higher = checked first, default 0) */
  priority: number
}

export interface PermissionConfig {
  /** Default decision when no rule matches */
  defaultDecision: PermissionDecision
  /** List of rules */
  rules: PermissionRule[]
}

// ── Default Config ──────────────────────────────────────────────────────────

export const DEFAULT_PERMISSION_CONFIG: PermissionConfig = {
  defaultDecision: 'ask',
  rules: [
    // Read-only operations are safe
    { id: 'read-all', tool: 'Read', pattern: '**', decision: 'allow', reason: 'Read access', priority: 10 },
    { id: 'glob-all', tool: 'Glob', pattern: '**', decision: 'allow', reason: 'Search access', priority: 10 },
    { id: 'grep-all', tool: 'Grep', pattern: '**', decision: 'allow', reason: 'Search access', priority: 10 },

    // Safe bash commands
    { id: 'bash-safe', tool: 'Bash', pattern: '{ls,cat,pwd,echo,git status,git log,git diff,git show}*', decision: 'allow', reason: 'Safe read-only commands', priority: 5 },

    // Deny dangerous operations
    { id: 'deny-rm-rf', tool: 'Bash', pattern: 'rm -rf **', decision: 'deny', reason: 'Prevent recursive delete', priority: 100 },
    { id: 'deny-force-push', tool: 'Bash', pattern: 'git push --force**', decision: 'deny', reason: 'Prevent force push', priority: 100 },
    { id: 'deny-sudo', tool: 'Bash', pattern: 'sudo **', decision: 'deny', reason: 'Prevent privilege escalation', priority: 100 },
    { id: 'deny-chmod-777', tool: 'Bash', pattern: 'chmod 777 **', decision: 'deny', reason: 'Insecure permissions', priority: 100 },

    // Protect sensitive files from writes
    { id: 'protect-env', tool: 'Write', pattern: '**/.env*', decision: 'deny', reason: 'Protect environment files', priority: 50 },
    { id: 'protect-keys', tool: 'Write', pattern: '**/*{key,pem,p12,jks,keystore}*', decision: 'deny', reason: 'Protect key files', priority: 50 },
  ],
}

// ── Rule Evaluation ─────────────────────────────────────────────────────────

export interface PermissionResult {
  decision: PermissionDecision
  reason: string
  matchedRule: PermissionRule | null
}

export function evaluatePermission(
  toolName: string,
  primaryArg: string,
  config: PermissionConfig = DEFAULT_PERMISSION_CONFIG,
): PermissionResult {
  // Sort rules by priority (highest first)
  const sortedRules = [...config.rules].sort((a, b) => b.priority - a.priority)

  for (const rule of sortedRules) {
    if (!matchesTool(rule.tool, toolName)) continue
    if (!matchesPattern(rule.pattern, primaryArg)) continue

    return {
      decision: rule.decision,
      reason: rule.reason ?? `Rule "${rule.id}" matched`,
      matchedRule: rule,
    }
  }

  return {
    decision: config.defaultDecision,
    reason: 'No matching rule, using default',
    matchedRule: null,
  }
}

function matchesTool(ruleTool: string, toolName: string): boolean {
  if (ruleTool === '*') return true
  if (ruleTool === toolName) return true
  // Brace expansion: {Read,Write,Glob} — check before comma split
  const braceMatch = ruleTool.match(/^\{(.+)\}$/)
  if (braceMatch) {
    const tools = braceMatch[1].split(',').map(t => t.trim())
    return tools.includes(toolName)
  }
  // Comma-separated list (without braces)
  if (ruleTool.includes(',')) {
    const tools = ruleTool.split(',').map(t => t.trim())
    return tools.includes(toolName)
  }
  return false
}

function matchesPattern(pattern: string, value: string): boolean {
  return globMatchFn(pattern, value)
}

// ── Rule Management ─────────────────────────────────────────────────────────

export function addRule(
  config: PermissionConfig,
  rule: Omit<PermissionRule, 'id' | 'priority'> & { id?: string; priority?: number },
): PermissionConfig {
  const newRule: PermissionRule = {
    id: rule.id ?? `rule_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    tool: rule.tool,
    pattern: rule.pattern,
    decision: rule.decision,
    reason: rule.reason,
    priority: rule.priority ?? 0,
  }
  return {
    ...config,
    rules: [...config.rules, newRule],
  }
}

export function removeRule(config: PermissionConfig, ruleId: string): PermissionConfig {
  return {
    ...config,
    rules: config.rules.filter(r => r.id !== ruleId),
  }
}

export function updateRule(
  config: PermissionConfig,
  ruleId: string,
  updates: Partial<PermissionRule>,
): PermissionConfig {
  return {
    ...config,
    rules: config.rules.map(r =>
      r.id === ruleId ? { ...r, ...updates } : r
    ),
  }
}

export function findRule(config: PermissionConfig, ruleId: string): PermissionRule | null {
  return config.rules.find(r => r.id === ruleId) ?? null
}

// ── Session Approvals ───────────────────────────────────────────────────────

export interface SessionApproval {
  /** Tool that was approved */
  tool: string
  /** Pattern that was approved */
  pattern: string
  /** Whether approval is for this session only */
  sessionOnly: boolean
  /** Timestamp of approval */
  timestamp: string
}

export class ApprovalCache {
  private approvals: SessionApproval[] = []

  approve(tool: string, pattern: string, sessionOnly = true): void {
    this.approvals.push({
      tool,
      pattern,
      sessionOnly,
      timestamp: new Date().toISOString(),
    })
  }

  isApproved(tool: string, primaryArg: string): boolean {
    return this.approvals.some(a =>
      a.tool === tool && matchesPattern(a.pattern, primaryArg)
    )
  }

  clear(): void {
    this.approvals = []
  }

  list(): SessionApproval[] {
    return [...this.approvals]
  }
}

// ── Formatting ──────────────────────────────────────────────────────────────

const DECISION_ICONS: Record<PermissionDecision, string> = {
  allow: '✓',
  deny: '✗',
  ask: '?',
}

export function formatPermissionResult(result: PermissionResult): string {
  const icon = DECISION_ICONS[result.decision]
  const rule = result.matchedRule
    ? ` (rule: ${result.matchedRule.id})`
    : ''
  return `${icon} ${result.decision.toUpperCase()} — ${result.reason}${rule}`
}

export function formatRuleList(config: PermissionConfig): string {
  if (config.rules.length === 0) {
    return `Permission rules (0):\n  Default: ${config.defaultDecision}`
  }

  const lines: string[] = [`Permission rules (${config.rules.length}):`]
  const sorted = [...config.rules].sort((a, b) => b.priority - a.priority)

  for (const rule of sorted) {
    const icon = DECISION_ICONS[rule.decision]
    lines.push(`  ${icon} [${rule.priority}] ${rule.tool} "${rule.pattern}" → ${rule.decision}`)
    if (rule.reason) lines.push(`      ${rule.reason}`)
    lines.push(`      id: ${rule.id}`)
  }

  lines.push(`\n  Default: ${config.defaultDecision}`)

  return lines.join('\n')
}

export function formatPermissionSummary(config: PermissionConfig): string {
  const allow = config.rules.filter(r => r.decision === 'allow').length
  const deny = config.rules.filter(r => r.decision === 'deny').length
  const ask = config.rules.filter(r => r.decision === 'ask').length

  return [
    `Permission Summary:`,
    `  Total rules: ${config.rules.length}`,
    `  Allow: ${allow} | Deny: ${deny} | Ask: ${ask}`,
    `  Default: ${config.defaultDecision}`,
  ].join('\n')
}

// ── Helpers ─────────────────────────────────────────────────────────────────

export function createQuickConfig(
  defaultDecision: PermissionDecision = 'ask',
  rules: Array<{ tool: string; pattern: string; decision: PermissionDecision }> = [],
): PermissionConfig {
  return {
    defaultDecision,
    rules: rules.map((r, i) => ({
      id: `custom_${i}`,
      tool: r.tool,
      pattern: r.pattern,
      decision: r.decision,
      priority: 0,
    })),
  }
}

// ── Convenience: Primary Arg Extraction ────────────────────────────────────

/**
 * Standard tool input fields that we treat as the "primary argument" for
 * glob matching. Ordered by likelihood — first non-empty match wins.
 *
 *   Bash       → command
 *   Read/Write/Edit → file_path / path / filepath
 *   Glob/Grep  → pattern
 *   Notebook   → notebook_path
 */
const PRIMARY_ARG_FIELDS = [
  'command',
  'file_path',
  'filepath',
  'path',
  'pattern',
  'query',
  'notebook_path',
  'url',
] as const

export function extractPrimaryArg(input: Record<string, unknown>): string {
  for (const field of PRIMARY_ARG_FIELDS) {
    const value = input[field]
    if (typeof value === 'string' && value.length > 0) return value
  }
  return ''
}

/**
 * P2.1 (R9.2): one-call entry to the glob engine. Extracts the primary
 * argument from the tool input, then runs the priority-sorted default
 * rule set. The result is the FIRST matching rule's decision, or the
 * default decision if no rule matches.
 */
export function evaluateDefaultGlobRule(
  toolName: string,
  input: Record<string, unknown>,
): PermissionResult {
  const primaryArg = extractPrimaryArg(input)
  return evaluatePermission(toolName, primaryArg, DEFAULT_PERMISSION_CONFIG)
}

/**
 * Session-scoped approvals — useful when the user approves a "{Bash,git
 * status}" pattern and we want subsequent calls to skip the prompt.
 */
export const sessionApprovalCache = new ApprovalCache()
