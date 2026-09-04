/**
 * Settings loader — reads .ovogo/settings.json from project and global dirs
 *
 * Config resolution order (later entries win):
 *   ~/.ovogo/settings.json   (global user defaults)
 *   .ovogo/settings.json     (project-specific, relative to cwd)
 *
 * Example settings.json (Claude-Code-compatible hook schema — legacy
 * flat entries { matcher, command } and legacy event names PreToolCall/
 * PostToolCall/OnComplete/OnContextOverflow are still accepted and
 * mapped automatically):
 * {
 *   "hooks": {
 *     "PreToolUse": [
 *       { "matcher": "Bash", "hooks": [ { "type": "command", "command": "echo \"Running: $OVOGO_TOOL_INPUT\"" } ] }
 *     ],
 *     "PostToolUse": [
 *       { "matcher": "Write,Edit", "hooks": [ { "type": "command", "command": "npx prettier --write \"$OVOGO_TOOL_NAME\" 2>/dev/null || true" } ] }
 *     ],
 *     "UserPromptSubmit": [
 *       { "hooks": [ { "type": "command", "command": "logger -t ovogogogo \"prompt: $OVOGO_PROMPT\"" } ] }
 *     ]
 *   }
 * }
 *
 * Hook input contract: the full CC-style JSON payload arrives on stdin
 * (hook_event_name, session_id, cwd, tool_name/tool_input, …). Back-compat
 * env vars are ALSO set:
 *   tool events:       OVOGO_TOOL_NAME, OVOGO_TOOL_INPUT, OVOGO_TOOL_RESULT, OVOGO_TOOL_IS_ERROR
 *   UserPromptSubmit:  OVOGO_PROMPT
 *   all events:        OVOGO_HOOK_EVENT, OVOGO_SESSION_ID
 */

import { readFileSync, existsSync } from 'fs'
import { resolve, join } from 'path'
import { homedir } from 'os'
import type { PermissionMode, PermissionProfile, PermissionRule } from '../core/permissionSystem.js'
import type { McpServerConfig } from '../core/mcpClient.js'
import { normalizeHooksSection, type HookConfig } from '../core/hooks/hooksConfig.js'
import { parseJsonSyntaxError, warnConfigOnce } from './diagnostics.js'
import type { ConfigDiagnostic } from './diagnostics.js'
import { parseJsonc } from '../utils/jsonc.js'
import { atomicWriteSync } from '../core/atomicWrite.js'

const PERMISSION_MODES = new Set(['default', 'acceptEdits', 'plan', 'auto', 'bypassPermissions', 'dontAsk', 'bubble'])
const PERMISSION_PROFILES = new Set(['safe', 'standard', 'autonomous'])
const PERMISSION_BEHAVIORS = new Set(['allow', 'deny', 'ask'])
const PERMISSION_SOURCES = new Set(['builtin', 'user', 'project'])

export interface PermissionsConfig {
  profile?: PermissionProfile
  mode?: PermissionMode
  /** Ordered allow/deny rules. Later-loaded project settings append after global settings. */
  rules?: PermissionRule[]
}

/**
 * 结构化任务上下文 — 注入系统提示词，为 agent 提供任务背景。
 * 配置在 .ovogo/settings.json 的 "taskContext" 字段。
 * 领域无关：phase/scope 均为自由字符串，不绑定任何特定业务语义。
 */
export interface TaskContext {
  /** 任务名称 */
  name?: string
  /** 当前任务阶段（自由字符串，如 "调研"、"实现"、"测试"）*/
  phase?: string
  /** 工作范围（目录、仓库、服务名等，非攻击目标）*/
  scope?: string[]
  /** 额外备注（约束、特殊要求等）*/
  notes?: string
}

export interface ProviderConfig {
  /** 'openai' | 'minimax' | 'anthropic' | any provider id (adapter selection). */
  provider?: string
  apiKey?: string
  /**
   * Round 47: environment variable holding the API key — keeps the
   * plaintext key out of settings.json (parity with models.profiles).
   */
  apiKeyEnv?: string
  baseURL?: string
  model?: string
}

export interface OvogoSettings {
  hooks?: HookConfig
  taskContext?: TaskContext
  permissions?: PermissionsConfig
  poor?: { enabled: boolean }
  mcp?: { servers: McpServerConfig[] }
  provider?: ProviderConfig
  /**
   * Phase 2 (adaptive runtime contract §四): model profiles + adaptive routing config.
   * When `profiles` has >1 entry and routing.enabled, the ModelRouter
   * selects per turn by complexity/context/budget/failure. Omit for the
   * default single-model router (no-op routing, override+health still work).
   */
  models?: { profiles: unknown[]; routing?: { enabled?: boolean; longContextThreshold?: number; failureEscalationThreshold?: number } }
}

function tryParse(path: string): OvogoSettings {
  const content = readFileSync(path, 'utf8')
  if (!content.trim()) return {}
  let parsed: unknown
  try {
    // JSONC (comments + trailing commas) — plain JSON is the fast path.
    parsed = parseJsonc(content)
  } catch (err: unknown) {
    const parseError = err as Error
    const loc = parseJsonSyntaxError(parseError, content)
    const locText = loc && loc.line !== undefined
      ? ` (line ${loc.line}${loc.column !== undefined ? `, column ${loc.column}` : ''})`
      : ''
    throw new Error(
      `Corrupted JSON config file at "${path}"${locText}: ${parseError.message}\n` +
      `Fix suggestion: Inspect and fix syntax in "${path}", or remove the file to reset config.`,
      { cause: err },
    )
  }
  return normalizeSettings(parsed, path)
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function normalizePermissionRule(value: unknown): PermissionRule | null {
  if (!isObject(value)) return null
  if (typeof value.toolName !== 'string' || !value.toolName.trim()) return null
  if (typeof value.ruleContent !== 'string' || !value.ruleContent.trim()) return null
  if (typeof value.behavior !== 'string' || !PERMISSION_BEHAVIORS.has(value.behavior)) return null
  if (typeof value.source !== 'string' || !PERMISSION_SOURCES.has(value.source)) return null

  return {
    toolName: value.toolName,
    ruleContent: value.ruleContent,
    behavior: value.behavior as PermissionRule['behavior'],
    source: value.source as PermissionRule['source'],
  }
}

function stringRecord(value: unknown): Record<string, string> | undefined {
  if (!isObject(value)) return undefined
  const entries = Object.entries(value).filter(([, v]) => typeof v === 'string')
  return entries.length > 0 ? (Object.fromEntries(entries) as Record<string, string>) : undefined
}

function normalizeMcpOAuth(value: unknown): McpServerConfig['oauth'] | undefined {
  if (!isObject(value)) return undefined
  const required = ['authorizationEndpoint', 'tokenEndpoint', 'clientId', 'redirectUri'] as const
  for (const key of required) {
    if (typeof value[key] !== 'string' || !value[key].trim()) return undefined
  }
  const oauth: NonNullable<McpServerConfig['oauth']> = {
    authorizationEndpoint: value.authorizationEndpoint as string,
    tokenEndpoint: value.tokenEndpoint as string,
    clientId: value.clientId as string,
    redirectUri: value.redirectUri as string,
  }
  if (typeof value.clientSecret === 'string' && value.clientSecret.trim()) oauth.clientSecret = value.clientSecret
  if (typeof value.scope === 'string' && value.scope.trim()) oauth.scope = value.scope
  return oauth
}

function normalizeMcpServer(value: unknown): McpServerConfig | null {
  if (!isObject(value)) return null
  if (typeof value.name !== 'string' || !value.name.trim()) return null
  const type = value.type === 'http' ? 'http' : 'stdio'
  if (type === 'http') {
    if (typeof value.url !== 'string' || !value.url.trim()) return null
    try {
      const parsed = new URL(value.url)
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null
    } catch {
      return null
    }
    return {
      name: value.name,
      type: 'http',
      url: value.url.trim(),
      headers: stringRecord(value.headers),
      oauth: normalizeMcpOAuth(value.oauth),
    }
  }
  if (!Array.isArray(value.command) || value.command.length === 0) return null
  if (!value.command.every((c) => typeof c === 'string')) return null
  return {
    name: value.name,
    type: 'stdio',
    command: [...value.command],
    env: stringRecord(value.env),
    cwd: typeof value.cwd === 'string' ? value.cwd : undefined,
  }
}

function normalizeMcp(value: unknown, file: string | undefined, diags: ConfigDiagnostic[]): { servers: McpServerConfig[] } | undefined {
  if (value === undefined) return undefined
  if (!isObject(value) || !Array.isArray(value.servers)) {
    if (file) diags.push({
      file, field: 'mcp', severity: 'warning',
      message: '"mcp.servers" must be an array — dropped',
      fix: `Correct the "mcp" section in "${file}".`,
    })
    return undefined
  }
  const servers: McpServerConfig[] = []
  value.servers.forEach((raw, i) => {
    const s = normalizeMcpServer(raw)
    if (s) {
      servers.push(s)
    } else if (file) {
      diags.push({
        file, field: `mcp.servers[${i}]`, severity: 'warning',
        message: 'invalid MCP server entry dropped (stdio needs non-empty "name" + "command" array; http needs "name" + valid "url")',
        fix: `Correct or remove this entry in "${file}".`,
      })
    }
  })
  return servers.length > 0 ? { servers } : undefined
}

function normalizeProvider(value: unknown, file?: string, diags?: ConfigDiagnostic[]): ProviderConfig | undefined {
  if (!isObject(value)) return undefined
  const p = value
  const out: ProviderConfig = {}
  if (typeof p.provider === 'string' && p.provider.trim()) out.provider = p.provider.trim()
  if (typeof p.apiKey === 'string' && p.apiKey.trim()) out.apiKey = p.apiKey.trim()
  // Round 47: apiKeyEnv — same uppercase-env-name discipline as
  // models.profiles (diagnosed in normalizeModels).
  if (typeof p.apiKeyEnv === 'string' && p.apiKeyEnv.trim()) {
    if (/^[A-Z_][A-Z0-9_]*$/.test(p.apiKeyEnv.trim())) {
      out.apiKeyEnv = p.apiKeyEnv.trim()
    } else if (file && diags) {
      diags.push({
        file,
        field: 'provider.apiKeyEnv',
        severity: 'warning',
        message: 'invalid API-key environment variable name dropped',
        fix: 'Use an uppercase environment variable name such as TOKENRHYTHM_API_KEY.',
      })
    }
  }
  if (typeof p.baseURL === 'string' && p.baseURL.trim()) out.baseURL = p.baseURL.trim()
  if (typeof p.model === 'string' && p.model.trim()) out.model = p.model.trim()
  return Object.keys(out).length > 0 ? out : undefined
}

function normalizeModels(value: unknown, file: string | undefined, diags: ConfigDiagnostic[]): { profiles: unknown[]; routing?: { enabled?: boolean; longContextThreshold?: number; failureEscalationThreshold?: number } } | undefined {
  if (value === undefined) return undefined
  if (!isObject(value) || !Array.isArray(value.profiles)) {
    if (file) diags.push({
      file, field: 'models', severity: 'warning',
      message: '"models.profiles" must be an array — dropped',
      fix: `Correct the "models" section in "${file}".`,
    })
    return undefined
  }
  const profiles = value.profiles.filter(isObject).map((profile, index) => {
    const normalized = { ...profile }
    if ('apiKey' in normalized) {
      delete normalized.apiKey
      if (file) diags.push({
        file,
        field: `models.profiles[${index}].apiKey`,
        severity: 'warning',
        message: 'literal API key dropped',
        fix: 'Store the key in an environment variable and configure apiKeyEnv instead.',
      })
    }
    if (
      normalized.apiKeyEnv !== undefined
      && (typeof normalized.apiKeyEnv !== 'string'
        || !/^[A-Z_][A-Z0-9_]*$/.test(normalized.apiKeyEnv))
    ) {
      delete normalized.apiKeyEnv
      if (file) diags.push({
        file,
        field: `models.profiles[${index}].apiKeyEnv`,
        severity: 'warning',
        message: 'invalid API-key environment variable name dropped',
        fix: 'Use an uppercase environment variable name such as OVOLV999_BUILDER_API_KEY.',
      })
    }
    if (normalized.tier !== undefined && normalized.tier !== 'top' && normalized.tier !== 'secondary') {
      delete normalized.tier
      if (file) diags.push({
        file,
        field: `models.profiles[${index}].tier`,
        severity: 'warning',
        message: 'invalid model tier dropped',
        fix: 'Set tier to "top" or "secondary".',
      })
    } else if (normalized.tier === undefined && file) {
      diags.push({
        file,
        field: `models.profiles[${index}].tier`,
        severity: 'warning',
        message: 'model tier inferred from legacy roles',
        fix: 'Add tier: "top" or tier: "secondary"; roles describe purpose, not model strength.',
      })
    }
    return normalized
  })
  const dropped = value.profiles.length - profiles.length
  if (dropped > 0 && file) diags.push({
    file, field: 'models.profiles', severity: 'warning',
    message: `${dropped} non-object profile entr${dropped === 1 ? 'y' : 'ies'} dropped`,
    fix: `Each profile must be a JSON object — see "${file}".`,
  })
  if (profiles.length === 0) return undefined
  const r = isObject(value.routing) ? value.routing : {}
  const routing: Record<string, unknown> = {}
  if (typeof r.enabled === 'boolean') routing.enabled = r.enabled
  if (typeof r.longContextThreshold === 'number') routing.longContextThreshold = r.longContextThreshold
  if (typeof r.failureEscalationThreshold === 'number') routing.failureEscalationThreshold = r.failureEscalationThreshold
  return { profiles, routing }
}

function normalizeHooks(value: unknown, file: string | undefined, diags: ConfigDiagnostic[]): HookConfig | undefined {
  if (value === undefined) return undefined
  if (!isObject(value)) {
    if (file) diags.push({
      file, field: 'hooks', severity: 'warning',
      message: '"hooks" must be an object keyed by event name — dropped',
      fix: `Correct the "hooks" section in "${file}".`,
    })
    return undefined
  }
  // Unified normalization lives in core/hooks/hooksConfig.ts — the SAME
  // parser the DefaultHookRunner uses. Before the consolidation this
  // loader only understood the legacy flat schema and silently dropped
  // Claude-Code-schema entries (matcher + nested hooks array), so hooks
  // fired or not depending on which entrypoint loaded them.
  const normalized = normalizeHooksSection(value, (field, message) => {
    if (file) diags.push({
      file, field, severity: 'warning',
      message,
      fix: `Correct or remove this entry in "${file}".`,
    })
  })
  return normalized ?? undefined
}

function normalizeTaskContext(value: unknown, file: string | undefined, diags: ConfigDiagnostic[]): TaskContext | undefined {
  if (value === undefined) return undefined
  if (!isObject(value)) {
    if (file) diags.push({
      file, field: 'taskContext', severity: 'warning',
      message: '"taskContext" must be an object — dropped',
      fix: `Correct the "taskContext" section in "${file}".`,
    })
    return undefined
  }
  const out: TaskContext = {}
  const stringField = (key: 'name' | 'phase' | 'notes'): void => {
    const v = value[key]
    if (typeof v === 'string') out[key] = v
    else if (v !== undefined && file) diags.push({
      file, field: `taskContext.${key}`, severity: 'warning',
      message: `"taskContext.${key}" must be a string — dropped`,
      fix: `Correct or remove "taskContext.${key}" in "${file}".`,
    })
  }
  stringField('name')
  stringField('phase')
  stringField('notes')
  if (Array.isArray(value.scope) && value.scope.every((s) => typeof s === 'string')) {
    out.scope = value.scope
  } else if (value.scope !== undefined && file) {
    diags.push({
      file, field: 'taskContext.scope', severity: 'warning',
      message: '"taskContext.scope" must be an array of strings — dropped',
      fix: `Correct or remove "taskContext.scope" in "${file}".`,
    })
  }
  return Object.keys(out).length > 0 ? out : undefined
}

function normalizeSettings(value: unknown, file?: string): OvogoSettings {
  if (!isObject(value)) return {}
  const diags: ConfigDiagnostic[] = []
  const rawPermissions = isObject(value.permissions) ? value.permissions : undefined
  const rawMode = rawPermissions?.mode
  const rawProfile = rawPermissions?.profile
  const rawRules = Array.isArray(rawPermissions?.rules) ? rawPermissions.rules : []
  const rules: PermissionRule[] = []
  rawRules.forEach((raw, i) => {
    const rule = normalizePermissionRule(raw)
    if (rule) {
      rules.push(rule)
    } else if (file) {
      diags.push({
        file, field: `permissions.rules[${i}]`, severity: 'warning',
        message: 'invalid permission rule dropped (needs non-empty toolName/ruleContent, behavior allow|deny|ask, source builtin|user|project)',
        fix: `Correct or remove this entry in "${file}".`,
      })
    }
  })
  const modeValid = typeof rawMode === 'string' && PERMISSION_MODES.has(rawMode)
  if (rawMode !== undefined && !modeValid && file) diags.push({
    file, field: 'permissions.mode', severity: 'warning',
    message: `"${typeof rawMode === 'string' ? rawMode : JSON.stringify(rawMode)}" is not a valid permission mode — dropped (valid: default, acceptEdits, plan, auto, bypassPermissions)`,
    fix: `Correct "permissions.mode" in "${file}".`,
  })
  const profileValid = typeof rawProfile === 'string' && PERMISSION_PROFILES.has(rawProfile)
  if (rawProfile !== undefined && !profileValid && file) diags.push({
    file, field: 'permissions.profile', severity: 'warning',
    message: `"${typeof rawProfile === 'string' ? rawProfile : JSON.stringify(rawProfile)}" is not a valid permission profile — dropped (valid: safe, standard, autonomous)`,
    fix: `Correct "permissions.profile" in "${file}".`,
  })

  const settings = normalizeSettingsFields(value, file, diags, rules)
  for (const d of diags) warnConfigOnce(d)
  return settings
}

function normalizeSettingsFields(value: Record<string, unknown>, file: string | undefined, diags: ConfigDiagnostic[], rules: PermissionRule[]): OvogoSettings {
  const rawPermissions = isObject(value.permissions) ? value.permissions : undefined
  const rawMode = rawPermissions?.mode
  const rawProfile = rawPermissions?.profile
  return {
    hooks: normalizeHooks(value.hooks, file, diags),
    taskContext: normalizeTaskContext(value.taskContext, file, diags),
    poor: isObject(value.poor) && typeof value.poor.enabled === 'boolean'
      ? { enabled: value.poor.enabled }
      : undefined,
    mcp: normalizeMcp(value.mcp, file, diags),
    provider: normalizeProvider(value.provider, file, diags),
    models: normalizeModels(value.models, file, diags),
    permissions: rawPermissions
      ? {
          profile: typeof rawProfile === 'string' && PERMISSION_PROFILES.has(rawProfile)
            ? rawProfile as PermissionProfile
            : undefined,
          mode: typeof rawMode === 'string' && PERMISSION_MODES.has(rawMode)
            ? rawMode as PermissionMode
            : undefined,
          rules,
        }
      : undefined,
  }
}

function mergeSettings(a: OvogoSettings, b: OvogoSettings): OvogoSettings {
  const mergedTaskContext = b.taskContext
    ? {
        ...(a.taskContext ?? {}),
        ...b.taskContext,
        scope: b.taskContext.scope ?? a.taskContext?.scope,
      }
    : a.taskContext

  const mergedPermissions = (a.permissions || b.permissions)
    ? {
        profile: b.permissions?.profile ?? a.permissions?.profile,
        mode: b.permissions?.mode ?? a.permissions?.mode,
        rules: [...(a.permissions?.rules ?? []), ...(b.permissions?.rules ?? [])],
      }
    : undefined

  // Hooks merge: concat per canonical event (both sides already
  // normalized to the CC schema by normalizeHooksSection).
  const mergedHooks: HookConfig = {}
  for (const key of new Set([...Object.keys(a.hooks ?? {}), ...Object.keys(b.hooks ?? {})])) {
    const event = key as keyof HookConfig
    mergedHooks[event] = [...(a.hooks?.[event] ?? []), ...(b.hooks?.[event] ?? [])]
  }
  const hasHooks = Object.keys(mergedHooks).length > 0

  return {
    ...(hasHooks ? { hooks: mergedHooks } : {}),
    taskContext: mergedTaskContext,
    permissions: mergedPermissions,
    poor: b.poor ?? a.poor,
    mcp: b.mcp ?? a.mcp,
    provider: b.provider ?? a.provider,
    models: b.models ?? a.models,
  }
}

export function getProjectSettingsPath(cwd: string): string {
  return resolve(cwd, '.ovogo', 'settings.json')
}

export function loadProjectSettings(cwd: string): OvogoSettings {
  const projectPath = getProjectSettingsPath(cwd)
  return existsSync(projectPath) ? tryParse(projectPath) : {}
}

export function saveProjectSettings(cwd: string, patch: OvogoSettings): OvogoSettings {
  const projectPath = getProjectSettingsPath(cwd)
  const current = loadProjectSettings(cwd)
  const next: OvogoSettings = {
    ...current,
    ...patch,
    hooks: patch.hooks ?? current.hooks,
    taskContext: patch.taskContext ?? current.taskContext,
    permissions: patch.permissions
      ? {
          ...(current.permissions ?? {}),
          ...patch.permissions,
          rules: patch.permissions.rules ?? current.permissions?.rules,
        }
      : current.permissions,
  }

  atomicWriteSync(projectPath, JSON.stringify(next, null, 2) + '\n')
  return next
}

function safeProjectSettings(settings: OvogoSettings): OvogoSettings {
  return {
    taskContext: settings.taskContext,
    poor: settings.poor,
  }
}

export function loadSettings(
  cwd: string,
  includeProject: boolean | 'safe' = true,
  globalPath = join(homedir(), '.ovogo', 'settings.json'),
): OvogoSettings {
  const projectPath = getProjectSettingsPath(cwd)

  let settings: OvogoSettings = {}
  if (existsSync(globalPath)) settings = mergeSettings(settings, tryParse(globalPath))
  if (includeProject && existsSync(projectPath)) {
    const projectSettings = tryParse(projectPath)
    settings = mergeSettings(settings, includeProject === 'safe' ? safeProjectSettings(projectSettings) : projectSettings)
  }
  return settings
}

/**
 * First-run wizard: load/save ONLY the user-level provider config at
 * ~/.ovogo/settings.json (so the wizard doesn't touch project settings).
 */
export function getGlobalSettingsPath(): string {
  return join(homedir(), '.ovogo', 'settings.json')
}

export function loadGlobalProvider(): ProviderConfig | undefined {
  const path = getGlobalSettingsPath()
  if (!existsSync(path)) return undefined
  try {
    return tryParse(path).provider
  } catch (err) {
    // Corrupt or unreadable global settings must never crash the CLI:
    // every entry point — even --version and --pipe — resolves the API
    // environment through this function. Degrade to defaults/env vars and
    // tell the user exactly once (stderr only — never stdout).
    warnConfigOnce({
      file: path,
      severity: 'error',
      message: `global settings unreadable — falling back to defaults/env vars (${(err as Error).message.split('\n')[0]})`,
      fix: `fix or remove "${path}", or run \`ovolv999 init\` to reconfigure`,
    })
    return undefined
  }
}

export function saveGlobalProvider(provider: ProviderConfig): void {
  const path = getGlobalSettingsPath()
  const current = existsSync(path) ? tryParse(path) : {}
  const next: OvogoSettings = { ...current, provider }
  atomicWriteSync(path, JSON.stringify(next, null, 2) + '\n')
}
