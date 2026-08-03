/**
 * Cursor `.mdc` rule loader — v0.5.2 (C11 — borrowed from cursor
 * `.cursor/rules/*.mdc`).
 *
 * Cursor ships two persistent-context surfaces:
 *   - Rules — explicit, user-authored `.mdc` files with YAML
 *     frontmatter + 4 activation modes (always / auto / agent /
 *     decisions) + glob scoping.
 *   - Memories — auto-extracted cross-session knowledge (covered by
 *     C6 / LongTermMemory).
 *
 * This module implements the Rules surface. The `.mdc` extension is
 * Cursor's; ovolv999 mirrors it with the same YAML frontmatter shape
 * so users can copy Cursor rules verbatim. The loader is pure
 * (read-only) and feeds the system prompt via a single
 * `renderForPrompt()` call.
 *
 * Production caller: the system-prompt builder. When `.ovolv999/rules/`
 * is present (cwd or homedir), each `.mdc` file is parsed once per
 * boot, then the active rules are rendered into the system prompt.
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join, basename } from 'node:path'
import { homedir } from 'node:os'

// ── Types ───────────────────────────────────────────────────────────────────

/**
 * Cursor activation modes:
 *   always  — always apply (highest priority)
 *   auto    — apply when glob matches
 *   agent   — apply when the active agent role matches
 *   decisions — apply when an explicit decision reference is made
 */
export type ActivationMode = 'always' | 'auto' | 'agent' | 'decisions'

export interface ParsedMdcRule {
  /** Stable id derived from filename (without extension). */
  id: string
  /** Absolute path to the source file. */
  path: string
  /** Display description (frontmatter `description`). */
  description: string
  /** Glob pattern (frontmatter `globs`). Empty = no scoping. */
  globs: string[]
  /** Activation mode. Default 'always' if unspecified. */
  activation: ActivationMode
  /** Optional agent role filter (frontmatter `agent`). */
  agentRole?: string
  /** Raw markdown body (the rule's actual instructions). */
  body: string
}

/**
 * A rule that has been evaluated against the active context (cwd,
 * agent role, etc.) and is currently in scope.
 */
export interface ActiveRule extends ParsedMdcRule {
  /** Reason this rule was activated — useful for /why and audit. */
  reason: string
}

// ── YAML frontmatter parsing ─────────────────────────────────────────────────

/**
 * Minimal YAML frontmatter parser — sufficient for the small subset
 * Cursor uses in `.mdc` files (string / array / enum fields). We
 * intentionally avoid pulling in a YAML dependency; the supported
 * syntax is `key: value` lines plus `key: [a, b, c]` for arrays.
 */
function parseFrontmatter(raw: string): { fields: Record<string, string | string[]>; body: string } {
  const fmMatch = raw.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/)
  if (!fmMatch) return { fields: {}, body: raw }
  const [, fm, body] = fmMatch
  const fields: Record<string, string | string[]> = {}
  for (const line of fm.split('\n')) {
    const m = line.match(/^([a-zA-Z_][a-zA-Z0-9_-]*):\s*(.*)$/)
    if (!m) continue
    const [, key, value] = m
    const trimmed = value.trim()
    if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
      fields[key] = trimmed.slice(1, -1).split(',').map((v) => v.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean)
    } else {
      fields[key] = trimmed.replace(/^['"]|['"]$/g, '')
    }
  }
  return { fields, body }
}

// ── Parsing a single .mdc file ───────────────────────────────────────────────

export function parseMdcRule(filePath: string): ParsedMdcRule | null {
  let raw: string
  try {
    raw = readFileSync(filePath, 'utf8')
  } catch {
    return null
  }
  const { fields, body } = parseFrontmatter(raw)
  const id = basename(filePath).replace(/\.mdc$/, '')
  const description = typeof fields.description === 'string' ? fields.description : ''
  const globs = Array.isArray(fields.globs) ? fields.globs : []
  const activationRaw = typeof fields.activation === 'string' ? fields.activation : 'always'
  const activation: ActivationMode = (
    ['always', 'auto', 'agent', 'decisions'] as const
  ).includes(activationRaw as ActivationMode)
    ? (activationRaw as ActivationMode)
    : 'always'
  const agentRole = typeof fields.agent === 'string' ? fields.agent : undefined
  return { id, path: filePath, description, globs, activation, agentRole, body: body.trim() }
}

// ── Loader ───────────────────────────────────────────────────────────────────

export interface RuleLoaderOptions {
  /** Override the default rule directory (cwd/.ovolv999/rules). */
  cwd?: string
  /** Override the user-level rule directory (~/.ovolv999/rules). */
  userDir?: string
}

const DEFAULT_CWD_RULES = (cwd: string) => join(cwd, '.ovolv999', 'rules')
const DEFAULT_USER_RULES = join(homedir(), '.ovolv999', 'rules')

export function loadRules(opts: RuleLoaderOptions = {}): ParsedMdcRule[] {
  const cwd = opts.cwd ?? process.cwd()
  const cwdDir = opts.cwd !== undefined ? join(opts.cwd, '.ovolv999', 'rules') : DEFAULT_CWD_RULES(cwd)
  const userDir = opts.userDir ?? DEFAULT_USER_RULES
  const out: ParsedMdcRule[] = []
  for (const dir of [userDir, cwdDir]) {
    if (!existsSync(dir)) continue
    let stat
    try { stat = statSync(dir) } catch { continue }
    if (!stat.isDirectory()) continue
    let entries: string[]
    try { entries = readdirSync(dir) } catch { continue }
    for (const name of entries) {
      if (!name.endsWith('.mdc')) continue
      const rule = parseMdcRule(join(dir, name))
      if (rule) out.push(rule)
    }
  }
  return out
}

// ── Activation context ──────────────────────────────────────────────────────

export interface ActivationContext {
  /** Current working directory (used for glob scoping in 'auto' mode). */
  cwd: string
  /** Current agent role (used to filter 'agent' mode rules). */
  agentRole?: string
  /**
   * Optional glob matcher (the same `globMatch` used by
   * permissionRules). When omitted, 'auto' rules with globs are
   * deactivated. Pass `globMatch` from `src/utils/globMatch.ts`.
   */
  globMatch?: (pattern: string, value: string) => boolean
}

/**
 * Apply the activation modes and return the rules that should be
 * injected into the system prompt. Order is preserved from
 * `loadRules()` (user-level first, cwd-level second).
 */
export function activateRules(rules: ParsedMdcRule[], ctx: ActivationContext): ActiveRule[] {
  const out: ActiveRule[] = []
  for (const rule of rules) {
    let active = false
    let reason = ''
    switch (rule.activation) {
      case 'always':
        active = true
        reason = 'always-on'
        break
      case 'auto':
        if (rule.globs.length === 0) {
          active = true
          reason = 'auto (no glob)'
        } else if (ctx.globMatch) {
          const matched = rule.globs.some((g) => ctx.globMatch!(g, ctx.cwd))
          if (matched) {
            active = true
            reason = `auto (matched: ${rule.globs.find((g) => ctx.globMatch!(g, ctx.cwd))})`
          }
        }
        break
      case 'agent':
        if (ctx.agentRole && rule.agentRole === ctx.agentRole) {
          active = true
          reason = `agent (role=${ctx.agentRole})`
        }
        break
      case 'decisions':
        // Decisions-mode rules require an explicit decision reference;
        // we leave them inactive here and let a higher layer opt in.
        break
    }
    if (active) out.push({ ...rule, reason })
  }
  return out
}

// ── Render for system prompt ───────────────────────────────────────────────

export function renderForPrompt(rules: ActiveRule[]): string {
  if (rules.length === 0) return ''
  const lines: string[] = ['## Active Project Rules', '']
  for (const rule of rules) {
    if (rule.description) {
      lines.push(`### ${rule.id} — ${rule.description}`)
    } else {
      lines.push(`### ${rule.id}`)
    }
    lines.push(`*activation: ${rule.reason}*`)
    lines.push('')
    lines.push(rule.body)
    lines.push('')
  }
  return lines.join('\n').trimEnd()
}