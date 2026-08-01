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
import type { HookEvent } from './hookProtocol.js'

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
  const result: HookConfig = {}
  const hooksObj = hooks as Record<string, unknown>
  for (const event of Object.keys(hooksObj)) {
    const list = hooksObj[event]
    if (!Array.isArray(list)) continue
    const filtered = list.filter(isValidMatcher)
    if (filtered.length > 0) {
      (result as Record<string, unknown>)[event] = filtered
    }
  }
  return result
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
export function loadHookConfig(cwd: string): HookConfig | null {
  const userConfig = readJsonConfig(join(homedir(), '.ovogo', 'settings.json'))
  const projectConfig = readJsonConfig(join(cwd, '.ovogo', 'settings.json'))
  if (!userConfig && !projectConfig) return null
  if (!userConfig) return projectConfig
  if (!projectConfig) return userConfig
  return mergeConfigs(userConfig, projectConfig)
}

/**
 * Test hook against an optional matcher string. A hook with no matcher
 * applies to every event payload; otherwise the matcher is a glob/regex
 * against tool_name (for Pre/Post tool events) or any string field
 * (other events). Returns true when the hook should run.
 */
export function matcherMatches(matcher: string | undefined, candidate: string): boolean {
  if (!matcher) return true
  if (matcher === '*' || matcher === candidate) return true
  if (matcher.startsWith('/') && matcher.endsWith('/')) {
    try {
      const re = new RegExp(matcher.slice(1, -1))
      return re.test(candidate)
    } catch {
      return false
    }
  }
  return false
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
