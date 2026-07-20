import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import {
  loadConfig, saveConfig, mergeConfig, mergeAllConfigs,
  validateConfig, updateConfig, resetConfig, formatConfig,
  DEFAULT_CONFIG, getConfigPath, type ConfigSchema,
} from '../src/core/config.js'
import {
  migrateConfig, needsMigration, MIGRATIONS, LATEST_VERSION,
  formatMigrationResult, getRawConfig, saveRawConfig,
} from '../src/core/migrations.js'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

function makeTempDir(): string {
  return mkdtempSync(join(tmpdir(), 'ovolv999-cfg-'))
}

describe('Config Schema & Validation', () => {
  let cwd: string

  beforeEach(() => { cwd = makeTempDir() })
  afterEach(() => { rmSync(cwd, { recursive: true, force: true }) })

  describe('DEFAULT_CONFIG', () => {
    it('has version 1', () => {
      expect(DEFAULT_CONFIG.version).toBeGreaterThanOrEqual(1)
    })

    it('has openai as default provider', () => {
      expect(DEFAULT_CONFIG.provider.name).toBe('openai')
    })

    it('has default permission mode', () => {
      expect(DEFAULT_CONFIG.permissions.defaultMode).toBe('default')
    })

    it('has auto-compact enabled', () => {
      expect(DEFAULT_CONFIG.behavior.autoCompact).toBe(true)
    })
  })

  describe('loadConfig', () => {
    it('returns defaults when no config file', () => {
      const config = loadConfig('project', cwd)
      expect(config.provider.name).toBe('openai')
    })

    it('loads and merges custom values', () => {
      mkdirSync(join(cwd, '.ovolv999'), { recursive: true })
      writeFileSync(
        join(cwd, '.ovolv999', 'settings.json'),
        JSON.stringify({ provider: { name: 'anthropic', model: 'claude-3' } }),
      )
      const config = loadConfig('project', cwd)
      expect(config.provider.name).toBe('anthropic')
      expect(config.provider.model).toBe('claude-3')
      // Defaults preserved
      expect(config.ui.theme).toBe('system')
    })

    it('returns defaults on invalid JSON', () => {
      mkdirSync(join(cwd, '.ovolv999'), { recursive: true })
      writeFileSync(join(cwd, '.ovolv999', 'settings.json'), 'not json')
      const config = loadConfig('project', cwd)
      expect(config.provider.name).toBe('openai')
    })
  })

  describe('saveConfig and loadConfig round-trip', () => {
    it('saves and loads config', () => {
      const custom = mergeConfig(DEFAULT_CONFIG, {
        provider: { name: 'anthropic', model: 'claude-3-sonnet' },
        ui: { ...DEFAULT_CONFIG.ui, theme: 'dark' },
      })
      saveConfig(custom, 'project', cwd)
      const loaded = loadConfig('project', cwd)
      expect(loaded.provider.name).toBe('anthropic')
      expect(loaded.provider.model).toBe('claude-3-sonnet')
      expect(loaded.ui.theme).toBe('dark')
    })
  })

  describe('mergeConfig', () => {
    it('deep merges nested objects', () => {
      const merged = mergeConfig(DEFAULT_CONFIG, {
        ui: { ...DEFAULT_CONFIG.ui, showTokens: true },
      })
      expect(merged.ui.showTokens).toBe(true)
      expect(merged.ui.theme).toBe('system') // preserved
    })
  })

  describe('validateConfig', () => {
    it('validates a correct config', () => {
      const result = validateConfig(DEFAULT_CONFIG)
      expect(result.valid).toBe(true)
    })

    it('rejects invalid theme', () => {
      const result = validateConfig({
        ...DEFAULT_CONFIG,
        ui: { ...DEFAULT_CONFIG.ui, theme: 'invalid' as any },
      })
      expect(result.valid).toBe(false)
      if (!result.valid) {
        expect(result.errors.some((e: { path: string; message: string }) => e.path === 'ui.theme')).toBe(true)
      }
    })

    it('rejects invalid temperature', () => {
      const result = validateConfig({
        ...DEFAULT_CONFIG,
        model: { ...DEFAULT_CONFIG.model, temperature: 5 },
      })
      expect(result.valid).toBe(false)
      if (!result.valid) {
        expect(result.errors.some((e: { path: string; message: string }) => e.path === 'model.temperature')).toBe(true)
      }
    })

    it('rejects invalid permission mode', () => {
      const result = validateConfig({
        ...DEFAULT_CONFIG,
        permissions: { ...DEFAULT_CONFIG.permissions, defaultMode: 'invalid' as any },
      })
      expect(result.valid).toBe(false)
    })

    it('rejects non-object', () => {
      const result = validateConfig(null)
      expect(result.valid).toBe(false)
    })

    it('rejects invalid compactThreshold', () => {
      const result = validateConfig({
        ...DEFAULT_CONFIG,
        behavior: { ...DEFAULT_CONFIG.behavior, compactThreshold: 2 },
      })
      expect(result.valid).toBe(false)
    })
  })

  describe('updateConfig', () => {
    it('updates and saves config', () => {
      const updated = updateConfig('project', {
        provider: { name: 'gemini' },
      }, cwd)
      expect(updated.provider.name).toBe('gemini')
      const loaded = loadConfig('project', cwd)
      expect(loaded.provider.name).toBe('gemini')
    })

    it('throws on invalid updates', () => {
      expect(() => updateConfig('project', {
        model: { temperature: 99 },
      }, cwd)).toThrow()
    })
  })

  describe('resetConfig', () => {
    it('resets to defaults', () => {
      updateConfig('project', { provider: { name: 'custom' } }, cwd)
      resetConfig('project', cwd)
      expect(loadConfig('project', cwd).provider.name).toBe('openai')
    })
  })

  describe('formatConfig', () => {
    it('includes key sections', () => {
      const out = formatConfig(DEFAULT_CONFIG)
      expect(out).toContain('Provider:')
      expect(out).toContain('Permissions:')
      expect(out).toContain('UI:')
      expect(out).toContain('Model:')
      expect(out).toContain('Behavior:')
    })
  })
})

describe('Config Migration System', () => {
  let cwd: string

  beforeEach(() => { cwd = makeTempDir() })
  afterEach(() => { rmSync(cwd, { recursive: true, force: true }) })

  describe('MIGRATIONS', () => {
    it('has migrations defined', () => {
      expect(MIGRATIONS.length).toBeGreaterThan(0)
    })

    it('migrations are sequential', () => {
      for (let i = 0; i < MIGRATIONS.length - 1; i++) {
        expect(MIGRATIONS[i].toVersion).toBe(MIGRATIONS[i + 1].fromVersion)
      }
    })

    it('LATEST_VERSION is highest', () => {
      for (const m of MIGRATIONS) {
        expect(LATEST_VERSION).toBeGreaterThanOrEqual(m.toVersion)
      }
    })
  })

  describe('needsMigration', () => {
    it('returns false when no config exists', () => {
      expect(needsMigration('project', cwd)).toBe(false)
    })

    it('returns true when version is old', () => {
      mkdirSync(join(cwd, '.ovolv999'), { recursive: true })
      writeFileSync(
        join(cwd, '.ovolv999', 'settings.json'),
        JSON.stringify({ version: 0 }),
      )
      expect(needsMigration('project', cwd)).toBe(true)
    })

    it('returns false when at latest version', () => {
      saveRawConfig({ version: LATEST_VERSION, provider: { name: 'openai' } }, 'project', cwd)
      expect(needsMigration('project', cwd)).toBe(false)
    })
  })

  describe('migrateConfig', () => {
    it('creates default config when none exists', () => {
      const result = migrateConfig('project', cwd)
      expect(result.migrated).toBe(false)
      expect(result.config.provider.name).toBe('openai')
    })

    it('migrates v0 to latest', () => {
      saveRawConfig({
        apiKey: 'test',
        model: 'gpt-4',
        autoApprove: true,
      }, 'project', cwd)

      const result = migrateConfig('project', cwd)
      expect(result.migrated).toBe(true)
      expect(result.fromVersion).toBe(0)
      expect(result.toVersion).toBe(LATEST_VERSION)
      expect(result.appliedMigrations.length).toBeGreaterThan(0)
    })

    it('renames apiKey to provider.apiKeyEnv', () => {
      saveRawConfig({ apiKey: 'test', version: 0 }, 'project', cwd)
      const result = migrateConfig('project', cwd)
      expect(result.config.provider.apiKeyEnv).toBeDefined()
    })

    it('renames model to provider.model', () => {
      saveRawConfig({ model: 'gpt-4', version: 0 }, 'project', cwd)
      const result = migrateConfig('project', cwd)
      expect(result.config.provider.model).toBe('gpt-4')
    })

    it('converts autoApprove to permissions.defaultMode', () => {
      saveRawConfig({ autoApprove: true, version: 0 }, 'project', cwd)
      const result = migrateConfig('project', cwd)
      expect(result.config.permissions.defaultMode).toBe('acceptEdits')
    })

    it('returns up-to-date when already latest', () => {
      saveRawConfig({ version: LATEST_VERSION, provider: { name: 'openai' } }, 'project', cwd)
      const result = migrateConfig('project', cwd)
      expect(result.migrated).toBe(false)
    })

    it('saves migrated config', () => {
      saveRawConfig({ version: 0, apiKey: 'x' }, 'project', cwd)
      migrateConfig('project', cwd)
      expect(needsMigration('project', cwd)).toBe(false)
    })
  })

  describe('formatMigrationResult', () => {
    it('shows up-to-date message', () => {
      const result = { migrated: false, fromVersion: 2, toVersion: 2, appliedMigrations: [], config: DEFAULT_CONFIG }
      const out = formatMigrationResult(result)
      expect(out).toContain('up to date')
    })

    it('shows migration details', () => {
      const result = {
        migrated: true,
        fromVersion: 0,
        toVersion: 2,
        appliedMigrations: ['First migration', 'Second migration'],
        config: DEFAULT_CONFIG,
      }
      const out = formatMigrationResult(result)
      expect(out).toContain('v0 → v2')
      expect(out).toContain('First migration')
    })
  })
})
