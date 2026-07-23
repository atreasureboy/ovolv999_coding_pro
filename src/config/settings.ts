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

const PERMISSION_MODES = new Set(['default', 'acceptEdits', 'plan', 'auto', 'bypassPermissions'])
const PERMISSION_BEHAVIORS = new Set(['allow', 'deny', 'ask'])
const PERMISSION_SOURCES = new Set(['builtin', 'user', 'project'])

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
  /**
   * First-run wizard output (ovolv999 init). User-level provider
   * config written to ~/.ovogo/settings.json. resolveApiEnvironment
   * reads it (process env still wins; this beats the Claude fallback).
   */
  provider?: ProviderConfig
}

function tryParse(path: string): OvogoSettings {
  try {
    return normalizeSettings(JSON.parse(readFileSync(path, 'utf8')))
  } catch {
    return {}
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

function normalizeMcp(value: unknown): { servers: McpServerConfig[] } | undefined {
  if (!isObject(value) || !Array.isArray(value.servers)) return undefined
  const servers = value.servers
    .map(normalizeMcpServer)
    .filter((s): s is McpServerConfig => s !== null)
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

function normalizeSettings(value: unknown): OvogoSettings {
  if (!isObject(value)) return {}
  const settings = value as OvogoSettings
  const rawPermissions = isObject(value.permissions) ? value.permissions : undefined
  const rawMode = rawPermissions?.mode
  const rawRules = Array.isArray(rawPermissions?.rules) ? rawPermissions.rules : []
  const rules = rawRules
    .map(normalizePermissionRule)
    .filter((rule): rule is PermissionRule => rule !== null)

  return {
    hooks: settings.hooks,
    taskContext: settings.taskContext,
    poor: isObject(value.poor) && typeof value.poor.enabled === 'boolean'
      ? { enabled: value.poor.enabled }
      : undefined,
    mcp: normalizeMcp(value.mcp),
    provider: normalizeProvider(value.provider),
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
  return tryParse(path).provider
}

export function saveGlobalProvider(provider: ProviderConfig): void {
  const path = getGlobalSettingsPath()
  const current = existsSync(path) ? tryParse(path) : {}
  const next: OvogoSettings = { ...current, provider }
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, JSON.stringify(next, null, 2) + '\n', 'utf8')
}
