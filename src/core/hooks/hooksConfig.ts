/**
 * Hook config loader — reads hooks from ovogo settings files.
 *
 * Looks for the `hooks` block in (in priority order):
 *   - `<cwd>/.ovogo/settings.json`
 *   - `~/.ovogo/settings.json`
 *
 * Settings.json schema is the same as claude-code (subset) so users
 * can reuse their existing hooks:
 *
 *   {
 *     "hooks": {
 *       "PreToolUse": [
 *         {
 *           "matcher": "Bash",
 *           "hooks": [
 *             { "type": "command", "command": "/path/to/script.sh", "timeout": 60 }
 *           ]
 *         }
 *       ]
 *     }
 *   }
 *
 * Malformed entries are skipped silently (best-effort) — hook loading
 * must never break the runtime.
 */

import { existsSync, readFileSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import { type HookEvent, HOOK_EVENTS } from './hookProtocol.js'

export interface HookCommandConfig {
  type: 'command'
  command: string
  timeout?: number
}

export interface HookMatcherConfig {
  matcher?: string
  hooks: HookCommandConfig[]
}

export type HookMatcherMap = Partial<Record<HookEvent, HookMatcherConfig[]>>

export interface HookConfig {
  PreToolUse?: HookMatcherConfig[]
  PostToolUse?: HookMatcherConfig[]
  PostToolUseFailure?: HookMatcherConfig[]
  UserPromptSubmit?: HookMatcherConfig[]
  SessionStart?: HookMatcherConfig[]
  SessionEnd?: HookMatcherConfig[]
  Stop?: HookMatcherConfig[]
  PreCompact?: HookMatcherConfig[]
  PostCompact?: HookMatcherConfig[]
}

/**
 * Legacy (pre-unification) event names accepted as aliases. The engine
 * once shipped a parallel flat-schema hook system (config/hooks.ts) with
 * its own event names; those names still parse so existing user settings
 * keep firing after the consolidation.
 */
export const LEGACY_HOOK_EVENT_ALIASES: Readonly<Record<string, HookEvent>> = {
  PreToolCall: 'PreToolUse',
  PostToolCall: 'PostToolUse',
  OnComplete: 'Stop',
  OnContextOverflow: 'PreCompact',
}

function isValidLegacyEntry(value: unknown): value is { command: string; matcher?: string; timeout?: number } {
  if (!value || typeof value !== 'object') return false
  const obj = value as Record<string, unknown>
  if (typeof obj.command !== 'string' || obj.command.length === 0) return false
  if (obj.matcher !== undefined && typeof obj.matcher !== 'string') return false
  if (obj.timeout !== undefined && (typeof obj.timeout !== 'number' || obj.timeout <= 0)) return false
  return true
}

/**
 * Unified hook-section normalizer — the ONE parser for the "hooks" block
 * of settings.json. Accepts both schemas per event:
 *
 *   CC (canonical):   [{ "matcher": "Bash", "hooks": [{ "type": "command", "command": "...", "timeout": 60 }] }]
 *   Legacy (flat):    [{ "matcher": "Bash", "command": "..." }]
 *
 * Legacy event names (PreToolCall etc.) are mapped onto the canonical
 * Claude-Code-compatible events via LEGACY_HOOK_EVENT_ALIASES. Returns
 * null when nothing valid survives. `onIssue` (optional) receives a
 * diagnostic per dropped entry so settings loaders can surface warnings.
 */
export function normalizeHooksSection(
  hooksObj: unknown,
  onIssue?: (field: string, message: string) => void,
): HookConfig | null {
  if (!hooksObj || typeof hooksObj !== 'object') return null
  const result: HookConfig = {}
  const root = hooksObj as Record<string, unknown>
  for (const rawEvent of Object.keys(root)) {
    if (rawEvent === '__proto__' || rawEvent === 'constructor' || rawEvent === 'prototype') {
      onIssue?.(`hooks.${rawEvent}`, `suspicious key "hooks.${rawEvent}" dropped`)
      continue
    }
    const list = root[rawEvent]
    if (list === undefined) continue
    // Round 26 re-audit (D4): validate the event AFTER alias mapping — a
    // typo'd or unmapped key previously sat dead in the config with zero
    // feedback. Legacy `OnError` reports explicitly: the CC protocol has
    // no equivalent; PostToolUse is the migration path.
    const mapped = Object.hasOwn(LEGACY_HOOK_EVENT_ALIASES, rawEvent)
      ? LEGACY_HOOK_EVENT_ALIASES[rawEvent]
      : rawEvent
    const event = mapped as HookEvent
    if (!HOOK_EVENTS.includes(event)) {
      onIssue?.(
        `hooks.${rawEvent}`,
        `unknown hook event "${rawEvent}" dropped${rawEvent === 'OnError' ? ' — no CC equivalent exists; use PostToolUse' : ''}`,
      )
      continue
    }
    if (!Array.isArray(list)) {
      onIssue?.(`hooks.${rawEvent}`, `"hooks.${rawEvent}" must be an array — dropped`)
      continue
    }
    const matchers: HookMatcherConfig[] = []
    list.forEach((raw, i) => {
      if (isValidMatcher(raw)) {
        matchers.push(raw)
        return
      }
      if (isValidLegacyEntry(raw)) {
        // Wrap flat entries into the canonical matcher shape
        matchers.push({
          matcher: raw.matcher,
          hooks: [{ type: 'command', command: raw.command, ...(raw.timeout !== undefined ? { timeout: raw.timeout } : {}) }],
        })
        return
      }
      onIssue?.(
        `hooks.${rawEvent}[${i}]`,
        'invalid hook entry dropped (needs "command", or CC-schema { matcher, hooks: [{ type: "command", command }] })',
      )
    })
    if (matchers.length > 0) {
      (result as Record<string, unknown>)[event] = matchers
    }
  }
  return Object.keys(result).length > 0 ? result : null
}

function isValidCommand(value: unknown): value is HookCommandConfig {
  if (!value || typeof value !== 'object') return false
  const obj = value as Record<string, unknown>
  if (obj.type !== 'command') return false
  if (typeof obj.command !== 'string' || obj.command.length === 0) return false
  if (obj.timeout !== undefined && (typeof obj.timeout !== 'number' || obj.timeout <= 0)) return false
  return true
}

function isValidMatcher(value: unknown): value is HookMatcherConfig {
  if (!value || typeof value !== 'object') return false
  const obj = value as Record<string, unknown>
  if (obj.matcher !== undefined && typeof obj.matcher !== 'string') return false
  if (!Array.isArray(obj.hooks)) return false
  return obj.hooks.every(isValidCommand)
}

function parseHookConfig(value: unknown): HookConfig | null {
  if (!value || typeof value !== 'object') return null
  const root = value as Record<string, unknown>
  const hooks = root.hooks
  if (!hooks || typeof hooks !== 'object') return null
  return normalizeHooksSection(hooks)
}

function readJsonConfig(path: string): HookConfig | null {
  if (!existsSync(path)) return null
  try {
    const raw = readFileSync(path, 'utf8')
    const parsed = JSON.parse(raw) as unknown
    return parseHookConfig(parsed)
  } catch {
    return null
  }
}

/**
 * Merge two HookConfig objects. Second config's matchers win on conflict.
 */
function mergeConfigs(base: HookConfig, override: HookConfig): HookConfig {
  const result: HookConfig = { ...base }
  for (const event of Object.keys(override) as (keyof HookConfig)[]) {
    const overrideMatchers = override[event]
    if (!overrideMatchers) continue
    const existing = result[event] ?? []
    result[event] = [...existing, ...overrideMatchers]
  }
  return result
}

/**
 * Load hooks config from disk. Project settings override user settings.
 * Returns null if no hooks are configured anywhere.
 */
export function loadHookConfig(cwd: string, includeProject = true): HookConfig | null {
  const userConfig = readJsonConfig(join(homedir(), '.ovogo', 'settings.json'))
  const projectConfig = includeProject
    ? readJsonConfig(join(cwd, '.ovogo', 'settings.json'))
    : null
  if (!userConfig && !projectConfig) return null
  if (!userConfig) return projectConfig
  if (!projectConfig) return userConfig
  return mergeConfigs(userConfig, projectConfig)
}

/**
 * Test hook against an optional matcher string. Supported syntax (union of
 * the CC glob forms and the legacy flat-schema forms — Round 26 re-audit
 * D2: the legacy comma list / trailing-`*` prefix must keep matching or
 * migrated settings silently stop firing):
 *   - absent / "*"          → match everything
 *   - "Bash"                → exact match
 *   - "Write,Edit" / "a|b"  → alternation list (legacy comma + CC pipe)
 *   - "Bash*"               → prefix wildcard
 *   - "/regex/"             → regex form
 */
export function matcherMatches(matcher: string | undefined, candidate: string): boolean {
  if (!matcher) return true
  if (matcher === '*') return true
  if (matcher.startsWith('/') && matcher.endsWith('/')) {
    try {
      const re = new RegExp(matcher.slice(1, -1))
      return re.test(candidate)
    } catch {
      return false
    }
  }
  if (matcher.includes(',')) {
    return matcher.split(',').some((part) => matcherMatches(part.trim() || '*', candidate))
  }
  if (matcher.includes('|')) {
    return matcher.split('|').some((part) => matcherMatches(part.trim() || '*', candidate))
  }
  if (matcher.endsWith('*')) {
    return candidate.startsWith(matcher.slice(0, -1))
  }
  return matcher === candidate
}

/**
 * Return all matchers applicable for an event given the candidate
 * string (tool name for tool events, prompt for UserPromptSubmit, etc.).
 */
export function matchersForEvent(
  config: HookConfig,
  event: HookEvent,
  candidate: string,
): HookMatcherConfig[] {
  const list = config[event] ?? []
  return list.filter(m => matcherMatches(m.matcher, candidate))
}
