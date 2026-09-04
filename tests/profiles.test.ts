import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import {
  createProfile, removeProfile, getProfile, getActiveProfile,
  setActiveProfile, listProfiles, updateProfile, cloneProfile,
  exportProfile, importProfile, getEffectiveConfig, loadProfiles,
  initializeBuiltinProfiles, BUILTIN_PROFILES,
  formatProfile, formatProfileList, formatEffectiveConfig,
} from '../src/core/profiles.js'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

function makeTempDir(): string {
  return mkdtempSync(join(tmpdir(), 'ovolv999-prof-'))
}

describe('Profile Manager', () => {
  let cwd: string

  beforeEach(() => { cwd = makeTempDir() })
  afterEach(() => { rmSync(cwd, { recursive: true, force: true }) })

  describe('createProfile', () => {
    it('creates a profile with defaults', () => {
      const p = createProfile(cwd, 'work')
      expect(p.name).toBe('work')
      expect(p.permissionLevel).toBe('normal')
      expect(p.createdAt).toBeDefined()
    })

    it('stores provider config', () => {
      const p = createProfile(cwd, 'anthropic', {
        provider: { name: 'anthropic', model: 'claude-3-sonnet' },
      })
      expect(p.provider?.name).toBe('anthropic')
      expect(p.provider?.model).toBe('claude-3-sonnet')
    })

    it('first profile becomes active automatically', () => {
      createProfile(cwd, 'first')
      expect(getActiveProfile(cwd)?.name).toBe('first')
    })

    it('subsequent profiles do not change active', () => {
      createProfile(cwd, 'first')
      createProfile(cwd, 'second')
      expect(getActiveProfile(cwd)?.name).toBe('first')
    })

    it('overwrites existing with same name', () => {
      createProfile(cwd, 'p', { description: 'old' })
      createProfile(cwd, 'p', { description: 'new' })
      expect(getProfile(cwd, 'p')?.description).toBe('new')
    })
  })

  describe('removeProfile', () => {
    it('removes a profile', () => {
      createProfile(cwd, 'a')
      expect(removeProfile(cwd, 'a')).toBe(true)
      expect(getProfile(cwd, 'a')).toBeNull()
    })

    it('switches active when removing active profile', () => {
      createProfile(cwd, 'a')
      createProfile(cwd, 'b')
      setActiveProfile(cwd, 'a')
      removeProfile(cwd, 'a')
      expect(getActiveProfile(cwd)?.name).toBe('b')
    })

    it('sets active to null when removing last profile', () => {
      createProfile(cwd, 'a')
      removeProfile(cwd, 'a')
      expect(getActiveProfile(cwd)).toBeNull()
    })

    it('returns false for missing profile', () => {
      expect(removeProfile(cwd, 'nope')).toBe(false)
    })
  })

  describe('getProfile and getActiveProfile', () => {
    it('returns null for missing profile', () => {
      expect(getProfile(cwd, 'nope')).toBeNull()
    })

    it('returns null when no active profile', () => {
      expect(getActiveProfile(cwd)).toBeNull()
    })
  })

  describe('setActiveProfile', () => {
    it('switches active profile', () => {
      createProfile(cwd, 'a')
      createProfile(cwd, 'b')
      expect(setActiveProfile(cwd, 'b')).toBe(true)
      expect(getActiveProfile(cwd)?.name).toBe('b')
    })

    it('returns false for missing profile', () => {
      expect(setActiveProfile(cwd, 'nope')).toBe(false)
    })
  })

  describe('listProfiles', () => {
    it('returns all profiles', () => {
      createProfile(cwd, 'a')
      createProfile(cwd, 'b')
      expect(listProfiles(cwd)).toHaveLength(2)
    })

    it('returns empty when none', () => {
      expect(listProfiles(cwd)).toEqual([])
    })
  })

  describe('updateProfile', () => {
    it('updates fields', () => {
      createProfile(cwd, 'p', { description: 'old' })
      const updated = updateProfile(cwd, 'p', { description: 'new' })
      expect(updated?.description).toBe('new')
    })

    it('returns null for missing', () => {
      expect(updateProfile(cwd, 'nope', {})).toBeNull()
    })
  })

  describe('cloneProfile', () => {
    it('clones a profile with new name', () => {
      createProfile(cwd, 'original', {
        provider: { name: 'openai' },
        permissionLevel: 'strict',
      })
      const cloned = cloneProfile(cwd, 'original', 'copy')
      expect(cloned).not.toBeNull()
      expect(cloned!.name).toBe('copy')
      expect(cloned!.provider?.name).toBe('openai')
      expect(cloned!.permissionLevel).toBe('strict')
    })

    it('allows overrides in clone', () => {
      createProfile(cwd, 'orig', { permissionLevel: 'strict' })
      const cloned = cloneProfile(cwd, 'orig', 'copy', { permissionLevel: 'permissive' })
      expect(cloned!.permissionLevel).toBe('permissive')
    })

    it('returns null for missing source', () => {
      expect(cloneProfile(cwd, 'nope', 'copy')).toBeNull()
    })
  })

  describe('exportProfile and importProfile', () => {
    it('exports to JSON string', () => {
      createProfile(cwd, 'p', { description: 'test' })
      const json = exportProfile(cwd, 'p')
      expect(json).not.toBeNull()
      const parsed = JSON.parse(json!)
      expect(parsed.name).toBe('p')
    })

    it('imports from JSON string', () => {
      const json = JSON.stringify({
        name: 'imported',
        provider: { name: 'anthropic' },
        permissionLevel: 'strict',
      })
      const p = importProfile(cwd, json)
      expect(p).not.toBeNull()
      expect(p!.name).toBe('imported')
      expect(p!.provider?.name).toBe('anthropic')
    })

    it('allows rename on import', () => {
      const json = JSON.stringify({ name: 'original' })
      const p = importProfile(cwd, json, 'renamed')
      expect(p!.name).toBe('renamed')
    })

    it('returns null for invalid JSON', () => {
      expect(importProfile(cwd, 'not json')).toBeNull()
    })
  })

  describe('getEffectiveConfig', () => {
    it('returns defaults when no active profile', () => {
      const config = getEffectiveConfig(cwd)
      expect(config.provider.name).toBe('openai')
      expect(config.temperature).toBe(0.7)
      expect(config.permissionLevel).toBe('normal')
    })

    it('merges active profile settings', () => {
      createProfile(cwd, 'custom', {
        provider: { name: 'anthropic', model: 'claude-3' },
        permissionLevel: 'strict',
        modelPrefs: { temperature: 0.5, maxTokens: 4096 },
        env: { ANTHROPIC_API_KEY: 'xxx' },
      })
      const config = getEffectiveConfig(cwd)
      expect(config.provider.name).toBe('anthropic')
      expect(config.provider.model).toBe('claude-3')
      expect(config.temperature).toBe(0.5)
      expect(config.maxTokens).toBe(4096)
      expect(config.env.ANTHROPIC_API_KEY).toBe('xxx')
    })
  })

  describe('initializeBuiltinProfiles', () => {
    it('creates all builtin profiles', () => {
      const profiles = initializeBuiltinProfiles(cwd)
      expect(profiles).toHaveLength(4)
      expect(profiles.map(p => p.name)).toContain('default')
      expect(profiles.map(p => p.name)).toContain('strict')
      expect(profiles.map(p => p.name)).toContain('creative')
      expect(profiles.map(p => p.name)).toContain('yolo')
    })

    it('first profile becomes active', () => {
      initializeBuiltinProfiles(cwd)
      expect(getActiveProfile(cwd)).not.toBeNull()
    })

    it('BUILTIN_PROFILES has 4 entries', () => {
      expect(BUILTIN_PROFILES).toHaveLength(4)
    })

    it('strict profile has low temperature', () => {
      const profiles = initializeBuiltinProfiles(cwd)
      const strict = profiles.find(p => p.name === 'strict')!
      expect(strict.modelPrefs?.temperature).toBeLessThan(0.5)
    })

    it('creative profile has high temperature', () => {
      const profiles = initializeBuiltinProfiles(cwd)
      const creative = profiles.find(p => p.name === 'creative')!
      expect(creative.modelPrefs?.temperature).toBeGreaterThan(0.8)
    })
  })

  describe('formatProfile', () => {
    it('includes name and description', () => {
      const p = createProfile(cwd, 'work', { description: 'Work profile' })
      const out = formatProfile(p)
      expect(out).toContain('work')
      expect(out).toContain('Work profile')
    })

    it('shows provider info', () => {
      const p = createProfile(cwd, 'p', {
        provider: { name: 'anthropic', model: 'claude-3' },
      })
      const out = formatProfile(p)
      expect(out).toContain('anthropic')
      expect(out).toContain('claude-3')
    })

    it('shows permission level', () => {
      const p = createProfile(cwd, 'p', { permissionLevel: 'strict' })
      expect(formatProfile(p)).toContain('strict')
    })

    it('shows temperature', () => {
      const p = createProfile(cwd, 'p', { modelPrefs: { temperature: 0.5 } })
      expect(formatProfile(p)).toContain('0.5')
    })
  })

  describe('formatProfileList', () => {
    it('shows empty message', () => {
      expect(formatProfileList([])).toBe('No profiles configured.')
    })

    it('marks active profile', () => {
      createProfile(cwd, 'a')
      createProfile(cwd, 'b')
      setActiveProfile(cwd, 'b')
      const out = formatProfileList(listProfiles(cwd), 'b')
      expect(out).toContain('← active')
    })
  })

  describe('formatEffectiveConfig', () => {
    it('shows provider and defaults', () => {
      const config = getEffectiveConfig(cwd)
      const out = formatEffectiveConfig(config)
      expect(out).toContain('openai')
      expect(out).toContain('0.7')
      expect(out).toContain('normal')
    })
  })
})

describe('profile store corruption guard', () => {
  let cwd: string

  beforeEach(() => { cwd = makeTempDir() })
  afterEach(() => { rmSync(cwd, { recursive: true, force: true }) })

  it('preserves a corrupt store before resetting, and CRUD still works', () => {
    const path = join(cwd, '.ovolv999', 'profiles.json')
    const backup = `${path}.corrupt`
    mkdirSync(join(cwd, '.ovolv999'), { recursive: true })
    writeFileSync(path, '{"profiles": {"work": torn', 'utf8')

    expect(loadProfiles(cwd)).toEqual({ profiles: {}, activeProfile: null })
    expect(readFileSync(backup, 'utf8')).toBe('{"profiles": {"work": torn')

    createProfile(cwd, 'after')
    expect(getProfile(cwd, 'after')).not.toBeNull()
    expect(readFileSync(backup, 'utf8')).toBe('{"profiles": {"work": torn')
  })

  it('treats a shape-violating store as corrupt', () => {
    const path = join(cwd, '.ovolv999', 'profiles.json')
    mkdirSync(join(cwd, '.ovolv999'), { recursive: true })
    // profiles as an array would make store.profiles[name] assignment blow up
    // in createProfile; activeProfile of the wrong type breaks setActive.
    writeFileSync(path, '{"profiles": [], "activeProfile": 7}', 'utf8')
    expect(loadProfiles(cwd)).toEqual({ profiles: {}, activeProfile: null })
    expect(existsSync(`${path}.corrupt`)).toBe(true)
  })
})
