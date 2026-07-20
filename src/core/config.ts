/**
 * Config Schema & Validation
 *
 * Schema definition and validation for ovolv999 configuration files.
 * Supports settings.json with typed schema, defaults, and migration.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs'
import { join, resolve } from 'path'
import { homedir } from 'os'

// ── Types ───────────────────────────────────────────────────────────────────

export type ConfigScope = 'global' | 'project'

export interface ConfigSchema {
  version: number
  provider: {
    name: string
    model?: string
    baseUrl?: string
    apiKeyEnv?: string
  }
  permissions: {
    defaultMode: 'default' | 'acceptEdits' | 'bypassPermissions' | 'plan'
    rules?: Array<{
      tool: string
      pattern: string
      decision: 'allow' | 'deny' | 'ask'
    }>
  }
  ui: {
    theme: 'dark' | 'light' | 'system'
    accentColor?: string
    showTokens: boolean
    showCost: boolean
    vimMode: boolean
  }
  model: {
    temperature: number
    maxTokens?: number
    contextWindow?: number
  }
  behavior: {
    autoCompact: boolean
    compactThreshold: number
    memoryExtract: boolean
    suggestions: boolean
  }
  env: Record<string, string>
}

export type ConfigValidationResult =
  | { valid: true; config: ConfigSchema }
  | { valid: false; errors: Array<{ path: string; message: string }> }

// ── Defaults ────────────────────────────────────────────────────────────────

export const DEFAULT_CONFIG: ConfigSchema = {
  version: 1,
  provider: {
    name: 'openai',
  },
  permissions: {
    defaultMode: 'default',
  },
  ui: {
    theme: 'system',
    showTokens: false,
    showCost: false,
    vimMode: false,
  },
  model: {
    temperature: 0.7,
  },
  behavior: {
    autoCompact: true,
    compactThreshold: 0.92,
    memoryExtract: true,
    suggestions: true,
  },
  env: {},
}

// ── Paths ───────────────────────────────────────────────────────────────────

export function getConfigPath(scope: ConfigScope, cwd?: string): string {
  if (scope === 'global') {
    return join(homedir(), '.ovolv999', 'settings.json')
  }
  return join(resolve(cwd ?? process.cwd()), '.ovolv999', 'settings.json')
}

export function loadConfig(scope: ConfigScope, cwd?: string): ConfigSchema {
  const path = getConfigPath(scope, cwd)
  if (!existsSync(path)) return mergeConfig(DEFAULT_CONFIG, {})
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8'))
    return mergeConfig(DEFAULT_CONFIG, raw)
  } catch {
    return mergeConfig(DEFAULT_CONFIG, {})
  }
}

export function saveConfig(config: ConfigSchema, scope: ConfigScope, cwd?: string): void {
  const path = getConfigPath(scope, cwd)
  const dir = join(path, '..')
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  writeFileSync(path, JSON.stringify(config, null, 2), 'utf8')
}

// ── Merge ───────────────────────────────────────────────────────────────────

export function mergeConfig(base: ConfigSchema, overrides: Partial<ConfigSchema>): ConfigSchema {
  return {
    version: overrides.version ?? base.version,
    provider: { ...base.provider, ...overrides.provider },
    permissions: { ...base.permissions, ...overrides.permissions },
    ui: { ...base.ui, ...overrides.ui },
    model: { ...base.model, ...overrides.model },
    behavior: { ...base.behavior, ...overrides.behavior },
    env: { ...base.env, ...overrides.env },
  }
}

export function mergeAllConfigs(cwd?: string): ConfigSchema {
  const global = loadConfig('global')
  const project = loadConfig('project', cwd)
  return mergeConfig(global, project)
}

// ── Validation ──────────────────────────────────────────────────────────────

export function validateConfig(config: unknown): ConfigValidationResult {
  const errors: Array<{ path: string; message: string }> = []
  const c = config as Partial<ConfigSchema>

  if (typeof c !== 'object' || c === null) {
    return { valid: false, errors: [{ path: '', message: 'Config must be an object' }] }
  }

  // Provider validation
  if (c.provider) {
    if (typeof c.provider.name !== 'string') {
      errors.push({ path: 'provider.name', message: 'Must be a string' })
    }
    if (c.provider.baseUrl !== undefined && typeof c.provider.baseUrl !== 'string') {
      errors.push({ path: 'provider.baseUrl', message: 'Must be a string' })
    }
  }

  // Permissions validation
  if (c.permissions) {
    const validModes = ['default', 'acceptEdits', 'bypassPermissions', 'plan']
    if (c.permissions.defaultMode && !validModes.includes(c.permissions.defaultMode)) {
      errors.push({ path: 'permissions.defaultMode', message: `Must be one of: ${validModes.join(', ')}` })
    }
  }

  // UI validation
  if (c.ui) {
    const validThemes = ['dark', 'light', 'system']
    if (c.ui.theme && !validThemes.includes(c.ui.theme)) {
      errors.push({ path: 'ui.theme', message: `Must be one of: ${validThemes.join(', ')}` })
    }
    if (c.ui.showTokens !== undefined && typeof c.ui.showTokens !== 'boolean') {
      errors.push({ path: 'ui.showTokens', message: 'Must be a boolean' })
    }
  }

  // Model validation
  if (c.model) {
    if (c.model.temperature !== undefined) {
      if (typeof c.model.temperature !== 'number' || c.model.temperature < 0 || c.model.temperature > 2) {
        errors.push({ path: 'model.temperature', message: 'Must be a number between 0 and 2' })
      }
    }
    if (c.model.maxTokens !== undefined && (typeof c.model.maxTokens !== 'number' || c.model.maxTokens < 1)) {
      errors.push({ path: 'model.maxTokens', message: 'Must be a positive number' })
    }
  }

  // Behavior validation
  if (c.behavior) {
    if (c.behavior.compactThreshold !== undefined) {
      if (typeof c.behavior.compactThreshold !== 'number' || c.behavior.compactThreshold < 0 || c.behavior.compactThreshold > 1) {
        errors.push({ path: 'behavior.compactThreshold', message: 'Must be between 0 and 1' })
      }
    }
  }

  if (errors.length > 0) {
    return { valid: false, errors }
  }

  return { valid: true, config: mergeConfig(DEFAULT_CONFIG, c) }
}

// ── Config Updates ──────────────────────────────────────────────────────────

export function updateConfig(
  scope: ConfigScope,
  updates: Partial<ConfigSchema>,
  cwd?: string,
): ConfigSchema {
  const current = loadConfig(scope, cwd)
  const merged = mergeConfig(current, updates)
  const validation = validateConfig(merged)
  if (!validation.valid) {
    throw new Error(`Invalid config: ${validation.errors.map(e => `${e.path}: ${e.message}`).join('; ')}`)
  }
  saveConfig(merged, scope, cwd)
  return merged
}

export function resetConfig(scope: ConfigScope, cwd?: string): void {
  saveConfig(DEFAULT_CONFIG, scope, cwd)
}

// ── Formatting ──────────────────────────────────────────────────────────────

export function formatConfig(config: ConfigSchema): string {
  const lines: string[] = [
    'Configuration:',
    `  Version: ${config.version}`,
    '',
    '  Provider:',
    `    Name: ${config.provider.name}`,
  ]
  if (config.provider.model) lines.push(`    Model: ${config.provider.model}`)
  if (config.provider.baseUrl) lines.push(`    Base URL: ${config.provider.baseUrl}`)

  lines.push('', '  Permissions:')
  lines.push(`    Default Mode: ${config.permissions.defaultMode}`)

  lines.push('', '  UI:')
  lines.push(`    Theme: ${config.ui.theme}`)
  lines.push(`    Show Tokens: ${config.ui.showTokens}`)
  lines.push(`    Show Cost: ${config.ui.showCost}`)
  lines.push(`    Vim Mode: ${config.ui.vimMode}`)

  lines.push('', '  Model:')
  lines.push(`    Temperature: ${config.model.temperature}`)
  if (config.model.maxTokens) lines.push(`    Max Tokens: ${config.model.maxTokens}`)

  lines.push('', '  Behavior:')
  lines.push(`    Auto Compact: ${config.behavior.autoCompact}`)
  lines.push(`    Compact Threshold: ${config.behavior.compactThreshold}`)
  lines.push(`    Memory Extract: ${config.behavior.memoryExtract}`)
  lines.push(`    Suggestions: ${config.behavior.suggestions}`)

  if (Object.keys(config.env).length > 0) {
    lines.push('', '  Environment:')
    for (const [key, value] of Object.entries(config.env)) {
      lines.push(`    ${key}: ${value}`)
    }
  }

  return lines.join('\n')
}

export function formatValidationErrors(errors: Array<{ path: string; message: string }>): string {
  return errors.map(e => `  ${e.path || '(root)'}: ${e.message}`).join('\n')
}
