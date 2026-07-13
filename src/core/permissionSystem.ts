/**
 * Permission System — 6-mode cycling + rule engine
 *
 * Inspired by Claude Code's utils/permissions/ (26 files).
 * Adapted for ovolv999's architecture: no React, no Zod schemas,
 * pure TypeScript with 0 runtime dependencies.
 *
 * Modes:
 *   default          — ask for dangerous, allow safe
 *   acceptEdits      — auto-approve file edits, still gate Bash
 *   plan             — read-only (no writes/edits/bash)
 *   auto             — auto-approve everything except dangerous
 *   bypassPermissions — approve everything (even dangerous)
 *   dontAsk          — same as bypass, but suppresses all prompts
 *
 * Permission Rules:
 *   "Bash(npm *)"    → allow all npm commands
 *   "Bash(git *)"    → allow all git commands
 *   "Read(src/**)"   → allow reading from src/
 *   "Edit(*.ts)"     → allow editing TypeScript files
 *
 * Shift+Tab cycling:
 *   default → acceptEdits → plan → auto → bypassPermissions → default
 */

// ── Types ───────────────────────────────────────────────────────────────────

export type PermissionMode =
  | 'default'
  | 'acceptEdits'
  | 'plan'
  | 'auto'
  | 'bypassPermissions'

export type PermissionBehavior = 'allow' | 'deny' | 'ask'

export interface PermissionRule {
  toolName: string
  ruleContent: string  // e.g. "npm *", "git *", "src/**/*.ts"
  behavior: PermissionBehavior
  source: 'builtin' | 'user' | 'project'
}

export interface PermissionCheckResult {
  behavior: PermissionBehavior
  matchedRule?: PermissionRule
}

// ── Mode Cycling (Shift+Tab) ────────────────────────────────────────────────

const CYCLE_ORDER: PermissionMode[] = [
  'default',
  'acceptEdits',
  'plan',
  'auto',
  'bypassPermissions',
]

export function getNextPermissionMode(current: PermissionMode): PermissionMode {
  const idx = CYCLE_ORDER.indexOf(current)
  if (idx === -1) return 'default'
  return CYCLE_ORDER[(idx + 1) % CYCLE_ORDER.length]
}

export function permissionModeLabel(mode: PermissionMode): string {
  switch (mode) {
    case 'default':           return 'Default'
    case 'acceptEdits':       return 'Accept Edits'
    case 'plan':              return 'Plan Mode'
    case 'auto':              return 'Auto'
    case 'bypassPermissions': return 'Bypass'
  }
}

export function permissionModeSymbol(mode: PermissionMode): string {
  switch (mode) {
    case 'default':           return ''
    case 'acceptEdits':       return '>>'
    case 'plan':              return '||'
    case 'auto':              return '>>>'
    case 'bypassPermissions': return '>>>>'
  }
}

export function permissionModeDescription(mode: PermissionMode): string {
  switch (mode) {
    case 'default':           return 'Ask for dangerous commands, allow safe ones'
    case 'acceptEdits':       return 'Auto-approve file edits, still gate shell commands'
    case 'plan':              return 'Read-only analysis (no writes/edits/bash)'
    case 'auto':              return 'Auto-approve everything except dangerous commands'
    case 'bypassPermissions': return 'Approve everything (use with caution)'
  }
}

// ── Mode → behavior resolution ──────────────────────────────────────────────

/**
 * Determine the effective behavior for a tool call given the current mode.
 * This is the baseline; user rules can override.
 */
export function getModeBehavior(
  mode: PermissionMode,
  toolName: string,
  isDangerous: boolean,
): PermissionBehavior {
  // Bypass: allow everything
  if (mode === 'bypassPermissions') return 'allow'

  // Plan: deny everything except read-only tools
  if (mode === 'plan') {
    const readOnly = ['Read', 'Glob', 'Grep', 'WebFetch', 'WebSearch', 'ExitPlanMode']
    return readOnly.includes(toolName) ? 'allow' : 'deny'
  }

  // Auto: allow everything except dangerous
  if (mode === 'auto') {
    return isDangerous ? 'ask' : 'allow'
  }

  // AcceptEdits: auto-approve file operations, prompt for dangerous Bash
  // (regression: was 'deny' — silent denial confused users running one-off
  // dangerous commands; matching 'default'/'auto' with 'ask' lets the REPL
  // surface a confirmation instead of dropping the call.)
  if (mode === 'acceptEdits') {
    const editTools = ['Read', 'Write', 'Edit', 'NotebookEdit', 'Glob', 'Grep']
    if (editTools.includes(toolName)) return 'allow'
    return isDangerous ? 'ask' : 'allow'
  }

  // Default: ask for dangerous, allow known-safe
  if (isDangerous) return 'ask'
  return 'allow'
}

// ── Rule Engine ─────────────────────────────────────────────────────────────

/**
 * Check if a command matches a permission rule pattern.
 * Supports: exact match, prefix match (npm:*), wildcard match (npm *)
 */
export function matchRule(ruleContent: string, command: string): boolean {
  // Legacy prefix syntax: "npm:*"
  if (ruleContent.endsWith(':*')) {
    const prefix = ruleContent.slice(0, -2)
    return command.startsWith(prefix)
  }

  // Wildcard match: "git *" or "npm run *"
  if (ruleContent.includes('*')) {
    // Convert glob to regex: escape special chars, convert * to .*
    const regexStr = ruleContent
      .replace(/[.+?^${}()|[\]\\]/g, '\\$&')
      .replace(/\*/g, '.*')
    // If pattern ends with " .*" (space+wildcard), make the trailing part optional
    // so "git *" matches both "git commit" and bare "git"
    let finalRegex = regexStr
    const unescapedStarCount = (ruleContent.match(/\*/g) || []).length
    if (finalRegex.endsWith(' .*') && unescapedStarCount === 1) {
      finalRegex = finalRegex.slice(0, -3) + '( .*)?'
    }
    try {
      return new RegExp('^' + finalRegex + '$', 's').test(command)
    } catch {
      return false
    }
  }

  // Exact match
  return ruleContent === command
}

/**
 * Check a tool call against all permission rules.
 * Returns the first matching rule's behavior, or null if no rule matches.
 */
export function checkRules(
  rules: PermissionRule[],
  toolName: string,
  input: Record<string, unknown>,
): PermissionCheckResult | null {
  // Extract the command-like field from tool input
  const commandField = input.command as string | undefined
    ?? input.file_path as string | undefined
    ?? input.notebook_path as string | undefined
    ?? input.pattern as string | undefined
    ?? ''

  for (const rule of rules) {
    if (rule.toolName !== toolName) continue
    if (matchRule(rule.ruleContent, commandField)) {
      return { behavior: rule.behavior, matchedRule: rule }
    }
  }

  return null
}

// ── Permission Manager ──────────────────────────────────────────────────────

export class PermissionManager {
  private mode: PermissionMode = 'default'
  private rules: PermissionRule[] = []

  getMode(): PermissionMode { return this.mode }

  setMode(mode: PermissionMode): void { this.mode = mode }

  cycleMode(): PermissionMode {
    this.mode = getNextPermissionMode(this.mode)
    return this.mode
  }

  getRules(): PermissionRule[] { return [...this.rules] }

  addRule(rule: PermissionRule): void {
    if (this.rules.some((existing) =>
      existing.toolName === rule.toolName &&
      existing.ruleContent === rule.ruleContent &&
      existing.behavior === rule.behavior
    )) {
      return
    }
    this.rules.push(rule)
  }

  removeRule(index: number): void {
    this.rules.splice(index, 1)
  }

  /**
   * Full permission check: rules first (user overrides), then mode defaults.
   */
  check(
    toolName: string,
    input: Record<string, unknown>,
    isDangerous: boolean,
  ): PermissionBehavior {
    // 1. Check user rules (highest priority)
    const ruleResult = checkRules(this.rules, toolName, input)
    if (ruleResult) return ruleResult.behavior

    // 2. Fall back to mode-based behavior
    return getModeBehavior(this.mode, toolName, isDangerous)
  }

  /**
   * Format rules for display.
   */
  formatRules(): string {
    if (this.rules.length === 0) return 'No permission rules configured.'
    const lines = this.rules.map((r, i) =>
      '  [' + i + '] ' + r.behavior.toUpperCase().padEnd(5) + ' ' +
      r.toolName + '(' + r.ruleContent + ')  ' +
      '\x1b[2m(' + r.source + ')\x1b[0m'
    )
    return 'Permission rules:\n' + lines.join('\n')
  }

  /**
   * Format current mode info for display.
   */
  formatMode(): string {
    const sym = permissionModeSymbol(this.mode)
    const label = permissionModeLabel(this.mode)
    const desc = permissionModeDescription(this.mode)
    return (sym ? sym + ' ' : '') + label + ' — ' + desc
  }
}
