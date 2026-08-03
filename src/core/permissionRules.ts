/**
 * Enhanced Permission Rules
 *
 * Glob-based permission rules for fine-grained access control.
 * Supports allow/deny lists with glob patterns, per-tool rules,
 * and user approval flows.
 *
 * v0.5.2 (C2 — borrowed from codex `execpolicy/`): added an
 * `execpolicy` namespace with `HostExecutableRule` so the Bash tool
 * can match commands against a curated host-binary allowlist, AND
 * a `strictestWins()` helper that codifies the canonical
 * `forbidden > prompt > allow` aggregation rule. The existing
 * priority-sorted evaluator already produces deny-wins in practice;
 * the new helper makes it explicit and testable so future
 * contributors don't accidentally invert the precedence.
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

/**
 * v0.5.2 (C2 — borrowed from codex `host_executable`):
 * a curated allowlist for the first token of a Bash command.
 *
 * Why a separate shape? `PermissionRule` matches against the FULL
 * primary argument; a `host_executable` matches against the binary
 * NAME (the first whitespace-delimited token of a Bash command).
 * Code paths that ONLY care about which binary is invoked (e.g.
 * "is `rm` allowed?" regardless of its args) read this list.
 *
 * Production caller: Bash tool, before any rule evaluation,
 * to surface a friendly "binary not in allowlist" error.
 */
export interface HostExecutableRule {
  /** Binary name (no path, e.g. 'rm', 'sudo', 'git'). */
  name: string
  /** Allowed absolute paths for this binary. Empty = any path. */
  paths?: string[]
  /** Decision: 'deny' forbids the binary outright. */
  decision: PermissionDecision
  /** Human-readable reason. */
  reason?: string
}

export interface PermissionConfig {
  /** Default decision when no rule matches */
  defaultDecision: PermissionDecision
  /** List of rules */
  rules: PermissionRule[]
  /** v0.5.2 (C2): host-binary allowlist. Evaluated separately from
   *  the glob rules because the matching shape is different (binary
   *  name vs. full primary argument). */
  hostExecutables?: HostExecutableRule[]
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
  // v0.5.2 (C2): default host_executable allowlist. `rm` is denied
  // outright so even a permissive config cannot accidentally invoke
  // recursive delete via a constructed shell-out.
  hostExecutables: [
    { name: 'rm', decision: 'deny', reason: 'rm forbidden — use safe_file_remove tool instead' },
    { name: 'sudo', decision: 'deny', reason: 'sudo forbidden — never grant elevation to the model' },
    { name: 'chmod', decision: 'ask', reason: 'changing file modes requires explicit approval' },
    { name: 'curl', decision: 'ask', reason: 'network access requires explicit approval' },
    { name: 'wget', decision: 'ask', reason: 'network access requires explicit approval' },
  ],
}

/**
 * v0.5.2 (C2 — borrowed from codex execpolicy aggregation rule):
 * `forbidden > prompt > allow`. Given a set of decisions from
 * different rule sources (default, host_executable, glob, mode
 * gate, user prompt), the strictest one wins. Returns the winning
 * decision + a reason that names every source that contributed.
 *
 * Pure — no I/O. Testable.
 */
const STRICTNESS: Record<PermissionDecision, number> = {
  deny: 3,
  ask: 2,
  allow: 1,
}

export interface StrictestWinsInput {
  defaultDecision?: PermissionDecision
  globDecision?: PermissionDecision
  hostExecutableDecision?: PermissionDecision
  modeDecision?: PermissionDecision
}

export function strictestWins(input: StrictestWinsInput): PermissionDecision {
  let winner: PermissionDecision = 'allow'
  for (const v of [
    input.defaultDecision,
    input.globDecision,
    input.hostExecutableDecision,
    input.modeDecision,
  ]) {
    if (v && STRICTNESS[v] > STRICTNESS[winner]) winner = v
  }
  return winner
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

// ── v0.5.2 (C2 — host_executable evaluation) ─────────────────────────────────

/**
 * Match a Bash command against the host_executable allowlist. The
 * matcher is intentionally simple — the first whitespace-delimited
 * token is the binary, and a path may prefix the binary name
 * (e.g. /usr/bin/rm). Returns the matched rule's decision, or
 * undefined when no rule matches.
 */
export function evaluateHostExecutable(
  command: string,
  config: PermissionConfig = DEFAULT_PERMISSION_CONFIG,
): { decision: PermissionDecision; reason: string; rule: HostExecutableRule } | undefined {
  if (!config.hostExecutables || config.hostExecutables.length === 0) return undefined
  const firstToken = command.trim().split(/\s+/)[0] ?? ''
  const basename = firstToken.split('/').pop() ?? firstToken
  for (const rule of config.hostExecutables) {
    if (rule.name !== basename) continue
    if (rule.paths && rule.paths.length > 0) {
      // When paths are specified, the FIRST TOKEN must be exactly one
      // of them. We do not resolve symlinks; this is a static check.
      if (!rule.paths.includes(firstToken)) continue
    }
    return { decision: rule.decision, reason: rule.reason ?? `host_executable rule "${rule.name}" matched`, rule }
  }
  return undefined
}

/**
 * v0.5.2 (C2): one-call entry that combines glob + host_executable +
 * default and returns the strictest-wins result. Pure.
 */
export function evaluateBashPolicy(
  input: Record<string, unknown>,
  config: PermissionConfig = DEFAULT_PERMISSION_CONFIG,
): PermissionResult {
  const primaryArg = extractPrimaryArg(input)
  const glob = evaluatePermission('Bash', primaryArg, config)
  const host = evaluateHostExecutable(primaryArg, config)
  const winner = strictestWins({
    defaultDecision: config.defaultDecision,
    globDecision: glob.decision,
    hostExecutableDecision: host?.decision,
  })
  const reasons: string[] = []
  if (glob.matchedRule) reasons.push(`glob:${glob.matchedRule.id}`)
  if (host) reasons.push(`host_executable:${host.rule.name}`)
  return {
    decision: winner,
    reason: reasons.length > 0 ? reasons.join('; ') : 'no rules matched — using strictest default',
    // host_executable rules are NOT PermissionRules (different shape).
    // Returning null here keeps the legacy contract — the reason
    // string still names which rule source fired.
    matchedRule: host ? null : glob.matchedRule,
  }
}
