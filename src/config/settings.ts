/**
 * Settings loader — reads .ovogo/settings.json from project and global dirs
 *
 * Config resolution order (later entries win):
 *   ~/.ovogo/settings.json   (global user defaults)
 *   .ovogo/settings.json     (project-specific, relative to cwd)
 *
 * Example settings.json:
 * {
 *   "hooks": {
 *     "PreToolCall": [
 *       { "matcher": "Bash", "command": "echo \"Running: $OVOGO_TOOL_INPUT\"" }
 *     ],
 *     "PostToolCall": [
 *       { "matcher": "Write,Edit", "command": "npx prettier --write \"$OVOGO_TOOL_NAME\" 2>/dev/null || true" }
 *     ],
 *     "UserPromptSubmit": [
 *       { "command": "logger -t ovogogogo \"prompt: $OVOGO_PROMPT\"" }
 *     ]
 *   }
 * }
 *
 * Hook env vars:
 *   PreToolCall:       OVOGO_TOOL_NAME, OVOGO_TOOL_INPUT (JSON)
 *   PostToolCall:      OVOGO_TOOL_NAME, OVOGO_TOOL_RESULT, OVOGO_TOOL_IS_ERROR
 *   UserPromptSubmit:  OVOGO_PROMPT
 */

import { readFileSync, existsSync, mkdirSync, writeFileSync, renameSync, unlinkSync } from 'fs'
import { randomBytes } from 'crypto'
import { resolve, join, dirname } from 'path'
import { homedir } from 'os'
import type { PermissionMode, PermissionRule } from '../core/permissionSystem.js'
import type { McpServerConfig } from '../core/mcpClient.js'
import { parseJsonSyntaxError, warnConfigOnce } from './diagnostics.js'
import type { ConfigDiagnostic } from './diagnostics.js'

const PERMISSION_MODES = new Set(['default', 'acceptEdits', 'plan', 'auto', 'bypassPermissions'])
const PERMISSION_BEHAVIORS = new Set(['allow', 'deny', 'ask'])
const PERMISSION_SOURCES = new Set(['builtin', 'user', 'project'])
const HOOK_EVENTS = ['PreToolCall', 'PostToolCall', 'UserPromptSubmit', 'OnError', 'OnComplete', 'OnContextOverflow'] as const

export interface HookEntry {
  /** Comma-separated tool names to match, or "*" / omit for all. Supports trailing "*" wildcard. */
  matcher?: string
  /** Shell command to execute. Runs with tool env vars set. */
  command: string
}

export interface HooksConfig {
  PreToolCall?: HookEntry[]
  PostToolCall?: HookEntry[]
  UserPromptSubmit?: HookEntry[]
  OnError?: HookEntry[]
  OnComplete?: HookEntry[]
  OnContextOverflow?: HookEntry[]
}

export interface PermissionsConfig {
  /** Runtime permission mode. Defaults to bypassPermissions for local personal use. */
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
  baseURL?: string
  model?: string
}

export interface OvogoSettings {
  hooks?: HooksConfig
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
  try {
    return normalizeSettings(JSON.parse(content), path)
  } catch (err: unknown) {
    const parseError = err as Error
    const loc = parseJsonSyntaxError(parseError, content)
    const locText = loc && loc.line !== undefined
      ? ` (line ${loc.line}${loc.column !== undefined ? `, column ${loc.column}` : ''})`
      : ''
    throw new Error(
      `Corrupted JSON config file at "${path}"${locText}: ${parseError.message}\n` +
      `Fix suggestion: Inspect and fix syntax in "${path}", or remove the file to reset config.`,
      { cause: parseError },
    )
  }
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

function normalizeMcpServer(value: unknown): McpServerConfig | null {
  if (!isObject(value)) return null
  if (typeof value.name !== 'string' || !value.name.trim()) return null
  if (!Array.isArray(value.command) || value.command.length === 0) return null
  if (!value.command.every((c) => typeof c === 'string')) return null
  const type = value.type === 'stdio' ? 'stdio' : 'stdio'
  const env =
    isObject(value.env)
      ? (Object.fromEntries(
          Object.entries(value.env).filter(([, v]) => typeof v === 'string'),
        ) as Record<string, string>)
      : undefined
  const cwd = typeof value.cwd === 'string' ? value.cwd : undefined
  return { name: value.name, type, command: [...value.command], env, cwd }
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
        message: 'invalid MCP server entry dropped (needs non-empty "name" and non-empty "command" array)',
        fix: `Correct or remove this entry in "${file}".`,
      })
    }
  })
  return servers.length > 0 ? { servers } : undefined
}

function normalizeProvider(value: unknown): ProviderConfig | undefined {
  if (!isObject(value)) return undefined
  const p = value
  const out: ProviderConfig = {}
  if (typeof p.provider === 'string' && p.provider.trim()) out.provider = p.provider.trim()
  if (typeof p.apiKey === 'string' && p.apiKey.trim()) out.apiKey = p.apiKey.trim()
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
  const profiles = value.profiles.filter(isObject)
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

function normalizeHookEntry(value: unknown): HookEntry | null {
  if (!isObject(value)) return null
  if (typeof value.command !== 'string' || !value.command.trim()) return null
  const matcher = typeof value.matcher === 'string' && value.matcher.trim() ? value.matcher : undefined
  return { matcher, command: value.command }
}

function normalizeHooks(value: unknown, file: string | undefined, diags: ConfigDiagnostic[]): HooksConfig | undefined {
  if (value === undefined) return undefined
  if (!isObject(value)) {
    if (file) diags.push({
      file, field: 'hooks', severity: 'warning',
      message: '"hooks" must be an object keyed by event name — dropped',
      fix: `Correct the "hooks" section in "${file}".`,
    })
    return undefined
  }
  const out: HooksConfig = {}
  let any = false
  for (const event of HOOK_EVENTS) {
    const arr = value[event]
    if (arr === undefined) continue
    if (!Array.isArray(arr)) {
      if (file) diags.push({
        file, field: `hooks.${event}`, severity: 'warning',
        message: `"hooks.${event}" must be an array — dropped`,
        fix: `Correct or remove "hooks.${event}" in "${file}".`,
      })
      continue
    }
    const valid: HookEntry[] = []
    arr.forEach((raw, i) => {
      const entry = normalizeHookEntry(raw)
      if (entry) {
        valid.push(entry)
      } else if (file) {
        diags.push({
          file, field: `hooks.${event}[${i}]`, severity: 'warning',
          message: 'invalid hook entry dropped (needs a non-empty "command" string)',
          fix: `Correct or remove this entry in "${file}".`,
        })
      }
    })
    if (valid.length > 0) {
      out[event] = valid
      any = true
    }
  }
  return any ? out : undefined
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

  const settings = normalizeSettingsFields(value, file, diags, rules)
  for (const d of diags) warnConfigOnce(d)
  return settings
}

function normalizeSettingsFields(value: Record<string, unknown>, file: string | undefined, diags: ConfigDiagnostic[], rules: PermissionRule[]): OvogoSettings {
  const rawPermissions = isObject(value.permissions) ? value.permissions : undefined
  const rawMode = rawPermissions?.mode
  return {
    hooks: normalizeHooks(value.hooks, file, diags),
    taskContext: normalizeTaskContext(value.taskContext, file, diags),
    poor: isObject(value.poor) && typeof value.poor.enabled === 'boolean'
      ? { enabled: value.poor.enabled }
      : undefined,
    mcp: normalizeMcp(value.mcp, file, diags),
    provider: normalizeProvider(value.provider),
    models: normalizeModels(value.models, file, diags),
    permissions: rawPermissions
      ? {
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
        mode: b.permissions?.mode ?? a.permissions?.mode,
        rules: [...(a.permissions?.rules ?? []), ...(b.permissions?.rules ?? [])],
      }
    : undefined

  return {
    hooks: {
      PreToolCall: [...(a.hooks?.PreToolCall ?? []), ...(b.hooks?.PreToolCall ?? [])],
      PostToolCall: [...(a.hooks?.PostToolCall ?? []), ...(b.hooks?.PostToolCall ?? [])],
      UserPromptSubmit: [...(a.hooks?.UserPromptSubmit ?? []), ...(b.hooks?.UserPromptSubmit ?? [])],
      OnError: [...(a.hooks?.OnError ?? []), ...(b.hooks?.OnError ?? [])],
      OnComplete: [...(a.hooks?.OnComplete ?? []), ...(b.hooks?.OnComplete ?? [])],
      OnContextOverflow: [...(a.hooks?.OnContextOverflow ?? []), ...(b.hooks?.OnContextOverflow ?? [])],
    },
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

  mkdirSync(dirname(projectPath), { recursive: true })
  // Unique tmp name (pid + ms + 8 random bytes) so concurrent saves
  // can't race on a fixed `.tmp` suffix. The earlier fixed tmp could
  // collide when two writers fired in the same ms: writer A's rename
  // would steal writer B's half-written tmp mid-flight, leaving B's
  // data overwritten or its tmp clobbered. With a unique suffix each
  // call gets its own tmp and only the last rename survives. We clean
  // up OUR tmp on failure — other concurrent writers' tmps are left
  // alone, mirroring the convention used by saveSession.
  const tmpPath = `${projectPath}.tmp.${process.pid}.${Date.now()}.${randomBytes(8).toString('hex')}`
  try {
    writeFileSync(tmpPath, JSON.stringify(next, null, 2) + '\n', 'utf8')
    renameSync(tmpPath, projectPath)
  } catch (err) {
    try {
      if (existsSync(tmpPath)) unlinkSync(tmpPath)
    } catch {
      /* swallow cleanup failure — the write error is the important one */
    }
    throw err
  }
  return next
}

export function loadSettings(cwd: string): OvogoSettings {
  const globalPath = join(homedir(), '.ovogo', 'settings.json')
  const projectPath = getProjectSettingsPath(cwd)

  let settings: OvogoSettings = {}
  if (existsSync(globalPath)) settings = mergeSettings(settings, tryParse(globalPath))
  if (existsSync(projectPath)) settings = mergeSettings(settings, tryParse(projectPath))
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
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, JSON.stringify(next, null, 2) + '\n', 'utf8')
}
