/**
 * Config Migration System
 *
 * Automatically migrates configuration files when format changes.
 * Tracks schema version and applies migrations sequentially.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs'
import { join, resolve } from 'path'
import { homedir } from 'os'
import { mergeConfig, DEFAULT_CONFIG, type ConfigSchema } from './config.js'

// ── Types ───────────────────────────────────────────────────────────────────

export interface Migration {
  fromVersion: number
  toVersion: number
  description: string
  migrate: (config: Record<string, unknown>) => Record<string, unknown>
}

export interface MigrationResult {
  migrated: boolean
  fromVersion: number
  toVersion: number
  appliedMigrations: string[]
  config: ConfigSchema
}

// ── Migration Definitions ───────────────────────────────────────────────────

export const MIGRATIONS: Migration[] = [
  {
    fromVersion: 0,
    toVersion: 1,
    description: 'Initial schema: rename old fields to new structure',
    migrate: (config) => {
      const migrated: Record<string, unknown> = { ...config }

      // v0: apiKey → provider.apiKeyEnv
      if ('apiKey' in migrated && !migrated.provider) {
        migrated.provider = { name: 'openai', apiKeyEnv: 'OPENAI_API_KEY' }
        delete migrated.apiKey
      }

      // v0: model → provider.model
      if ('model' in migrated && typeof migrated.model === 'string') {
        if (!migrated.provider) migrated.provider = {}
        ;(migrated.provider as Record<string, unknown>).model = migrated.model
        delete migrated.model
      }

      // v0: autoApprove → permissions.defaultMode
      if ('autoApprove' in migrated) {
        if (!migrated.permissions) migrated.permissions = {}
        ;(migrated.permissions as Record<string, unknown>).defaultMode =
          migrated.autoApprove ? 'acceptEdits' : 'default'
        delete migrated.autoApprove
      }

      // v0: verbose → behavior.suggestions
      if ('verbose' in migrated) {
        if (!migrated.behavior) migrated.behavior = {}
        ;(migrated.behavior as Record<string, unknown>).suggestions = migrated.verbose
        delete migrated.verbose
      }

      // Set version
      migrated.version = 1

      return migrated
    },
  },
  {
    fromVersion: 1,
    toVersion: 2,
    description: 'Add behavior.compactThreshold and ui.accentColor',
    migrate: (config) => {
      const migrated = { ...config }
      if (!migrated.behavior) migrated.behavior = {}
      const behavior = migrated.behavior as Record<string, unknown>
      if (behavior.compactThreshold === undefined) {
        behavior.compactThreshold = 0.92
      }

      if (!migrated.ui) migrated.ui = {}
      const ui = migrated.ui as Record<string, unknown>
      if (ui.accentColor === undefined) {
        ui.accentColor = '#D77757'
      }

      migrated.version = 2
      return migrated
    },
  },
]

export const LATEST_VERSION = MIGRATIONS.reduce(
  (max, m) => Math.max(max, m.toVersion),
  DEFAULT_CONFIG.version,
)

// ── Migration Logic ─────────────────────────────────────────────────────────

export function getRawConfig(scope: 'global' | 'project', cwd?: string): Record<string, unknown> | null {
  const path = scope === 'global'
    ? join(homedir(), '.ovolv999', 'settings.json')
    : join(resolve(cwd ?? process.cwd()), '.ovolv999', 'settings.json')

  if (!existsSync(path)) return null
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return null
  }
}

export function saveRawConfig(
  config: Record<string, unknown>,
  scope: 'global' | 'project',
  cwd?: string,
): void {
  const path = scope === 'global'
    ? join(homedir(), '.ovolv999', 'settings.json')
    : join(resolve(cwd ?? process.cwd()), '.ovolv999', 'settings.json')

  const dir = join(path, '..')
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  writeFileSync(path, JSON.stringify(config, null, 2), 'utf8')
}

export function migrateConfig(
  scope: 'global' | 'project',
  cwd?: string,
): MigrationResult {
  const raw = getRawConfig(scope, cwd)

  if (!raw) {
    const config = mergeConfig(DEFAULT_CONFIG, {})
    saveRawConfig({ ...config, version: LATEST_VERSION }, scope, cwd)
    return {
      migrated: false,
      fromVersion: LATEST_VERSION,
      toVersion: LATEST_VERSION,
      appliedMigrations: [],
      config,
    }
  }

  const fromVersion = typeof raw.version === 'number' ? raw.version : 0
  const appliedMigrations: string[] = []
  let current = { ...raw }

  if (fromVersion >= LATEST_VERSION) {
    const config = mergeConfig(DEFAULT_CONFIG, current)
    return {
      migrated: false,
      fromVersion,
      toVersion: fromVersion,
      appliedMigrations: [],
      config,
    }
  }

  // Apply migrations sequentially
  let version = fromVersion
  while (version < LATEST_VERSION) {
    const migration = MIGRATIONS.find(m => m.fromVersion === version)
    if (!migration) break

    current = migration.migrate(current)
    appliedMigrations.push(migration.description)
    version = migration.toVersion
  }

  // Ensure version is set
  current.version = LATEST_VERSION

  // Save migrated config
  saveRawConfig(current, scope, cwd)

  const config = mergeConfig(DEFAULT_CONFIG, current)

  return {
    migrated: appliedMigrations.length > 0,
    fromVersion,
    toVersion: LATEST_VERSION,
    appliedMigrations,
    config,
  }
}

export function needsMigration(scope: 'global' | 'project', cwd?: string): boolean {
  const raw = getRawConfig(scope, cwd)
  if (!raw) return false
  const version = typeof raw.version === 'number' ? raw.version : 0
  return version < LATEST_VERSION
}

// ── Formatting ──────────────────────────────────────────────────────────────

export function formatMigrationResult(result: MigrationResult): string {
  if (!result.migrated) {
    return `Config is up to date (v${result.toVersion}).`
  }

  const lines: string[] = [
    `Config migrated: v${result.fromVersion} → v${result.toVersion}`,
    `Applied ${result.appliedMigrations.length} migration(s):`,
  ]

  for (const desc of result.appliedMigrations) {
    lines.push(`  → ${desc}`)
  }

  return lines.join('\n')
}
