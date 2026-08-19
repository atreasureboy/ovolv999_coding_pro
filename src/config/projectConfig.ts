/**
 * Project config — loads .ovolv999.json for project-specific settings.
 *
 * Supports:
 *   {
 *     "model": "glm-4.6",
 *     "permissionMode": "default",
 *     "maxIterations": 50,
 *     "maxContextTokens": 200000,
 *     "systemPrompt": "You are a coding assistant.",
 *     "enabledModules": ["memory", "critic"],
 *     "poor": { "enabled": false },
 *     "temperature": 0
 *   }
 *
 * Looked up from cwd up to git root (first one wins).
 */

import { readFileSync, existsSync } from 'fs'
import { join, dirname } from 'path'
import { warnConfigOnce } from './diagnostics.js'
import { parseJsonc } from '../utils/jsonc.js'

import { type PermissionMode } from '../core/permissionSystem.js'

export interface ProjectConfig {
  model?: string
  permissionMode?: PermissionMode
  maxIterations?: number
  maxContextTokens?: number
  systemPrompt?: string
  enabledModules?: string[]
  poor?: { enabled: boolean }
  temperature?: number
}

const CONFIG_FILES = ['.ovolv999.json', '.ovolv999.jsonc']
const PERMISSION_MODES = new Set(['default', 'acceptEdits', 'plan', 'auto', 'bypassPermissions', 'dontAsk', 'bubble'])

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Field-level validation (hand-rolled, project convention). Invalid fields
 * are dropped WITH a one-time stderr warning — the run continues with the
 * valid subset (CI/--bg children must never die on a typo'd config).
 */
function normalizeProjectConfig(parsed: unknown, file: string): ProjectConfig | null {
  if (!isObject(parsed)) {
    warnConfigOnce({
      file, severity: 'warning',
      message: 'project config must be a JSON object — ignored',
      fix: `fix or remove "${file}"`,
    })
    return null
  }
  const out: ProjectConfig = {}
  const drop = (field: string, expected: string): void => warnConfigOnce({
    file, field, severity: 'warning',
    message: `"${field}" has an invalid value — expected ${expected}, dropped`,
    fix: `correct "${field}" in "${file}"`,
  })

  if (typeof parsed.model === 'string' && parsed.model.trim()) out.model = parsed.model
  else if (parsed.model !== undefined) drop('model', 'a non-empty string')

  if (typeof parsed.permissionMode === 'string' && PERMISSION_MODES.has(parsed.permissionMode)) {
    out.permissionMode = parsed.permissionMode as ProjectConfig['permissionMode']
  } else if (parsed.permissionMode !== undefined) drop('permissionMode', 'one of "auto" | "ask" | "deny"')

  if (typeof parsed.maxIterations === 'number' && Number.isFinite(parsed.maxIterations)) out.maxIterations = parsed.maxIterations
  else if (parsed.maxIterations !== undefined) drop('maxIterations', 'a number')

  if (typeof parsed.maxContextTokens === 'number' && Number.isFinite(parsed.maxContextTokens)) out.maxContextTokens = parsed.maxContextTokens
  else if (parsed.maxContextTokens !== undefined) drop('maxContextTokens', 'a number')

  if (typeof parsed.systemPrompt === 'string') out.systemPrompt = parsed.systemPrompt
  else if (parsed.systemPrompt !== undefined) drop('systemPrompt', 'a string')

  if (Array.isArray(parsed.enabledModules) && parsed.enabledModules.every((m) => typeof m === 'string')) {
    out.enabledModules = parsed.enabledModules
  } else if (parsed.enabledModules !== undefined) drop('enabledModules', 'an array of strings')

  if (isObject(parsed.poor) && typeof parsed.poor.enabled === 'boolean') out.poor = { enabled: parsed.poor.enabled }
  else if (parsed.poor !== undefined) drop('poor', 'an object like { "enabled": boolean }')

  if (typeof parsed.temperature === 'number' && Number.isFinite(parsed.temperature)) out.temperature = parsed.temperature
  else if (parsed.temperature !== undefined) drop('temperature', 'a number')

  return out
}

export function loadProjectConfig(cwd: string): ProjectConfig | null {
  let dir = cwd
  for (let i = 0; i < 10; i++) {
    for (const filename of CONFIG_FILES) {
      const configPath = join(dir, filename)
      if (existsSync(configPath)) {
        try {
          const content = readFileSync(configPath, 'utf-8')
          // JSONC (comments + trailing commas) — string-aware, unlike the
          // previous regex strip which corrupted "https://..." values.
          return normalizeProjectConfig(parseJsonc(content), configPath)
        } catch (err) {
          // Corrupt project config: warn once and continue — never fatal
          // (background/CI children re-enter with the same cwd).
          warnConfigOnce({
            file: configPath,
            severity: 'warning',
            message: `project config ignored — ${(err as Error).message.split('\n')[0]}`,
            fix: `fix or remove "${configPath}"`,
          })
          return null
        }
      }
    }
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return null
}
