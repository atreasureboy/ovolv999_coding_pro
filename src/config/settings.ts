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

import { readFileSync, existsSync, mkdirSync, writeFileSync } from 'fs'
import { resolve, join, dirname } from 'path'
import { homedir } from 'os'
import type { PermissionMode, PermissionRule } from '../core/permissionSystem.js'

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

export interface OvogoSettings {
  hooks?: HooksConfig
  taskContext?: TaskContext
  permissions?: PermissionsConfig
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
  writeFileSync(projectPath, JSON.stringify(next, null, 2) + '\n', 'utf8')
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
