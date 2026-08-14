/**
 * Tests for src/core/sandbox.ts
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import {
  DEFAULT_CONFIG, loadConfig, saveConfig, updateConfig,
  detectBackend, generateMacOSProfile, generateBubblewrapArgs,
  compileProfile, getCachedProfile, invalidateProfileCache,
  wrapCommand, validateConfig,
  formatConfig, formatProfile,
  type SandboxConfig,
} from '../src/core/sandbox.js'
import { existsSync, rmSync, mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { homedir } from 'os'

let testHome: string
let origHome: string | undefined

beforeAll(() => {
  testHome = mkdtempSync(join(tmpdir(), 'ovolv999-sandbox-'))
  origHome = process.env.HOME
  process.env.HOME = testHome
})

afterAll(() => {
  if (origHome !== undefined) process.env.HOME = origHome
  rmSync(testHome, { recursive: true, force: true })
})

beforeEach(() => {
  invalidateProfileCache()
  const dir = join(homedir(), '.ovolv999')
  if (existsSync(dir)) rmSync(dir, { recursive: true, force: true })
})

describe('sandbox', () => {
  describe('DEFAULT_CONFIG', () => {
    it('is disabled by default', () => {
      expect(DEFAULT_CONFIG.enabled).toBe(false)
    })
    it('defaults to standard level', () => {
      expect(DEFAULT_CONFIG.level).toBe('standard')
    })
  })

  describe('loadConfig / saveConfig', () => {
    it('returns defaults when no config', () => {
      const cfg = loadConfig()
      expect(cfg.enabled).toBe(false)
      expect(cfg.level).toBe('standard')
    })

    it('saves and loads config', () => {
      saveConfig({ ...DEFAULT_CONFIG, enabled: true, level: 'strict' })
      const cfg = loadConfig()
      expect(cfg.enabled).toBe(true)
      expect(cfg.level).toBe('strict')
    })

    it('updateConfig merges', () => {
      saveConfig({ ...DEFAULT_CONFIG, enabled: false })
      const updated = updateConfig({ enabled: true })
      expect(updated.enabled).toBe(true)
    })
  })

  describe('detectBackend', () => {
    it('returns a valid backend', () => {
      const backend = detectBackend()
      expect(['none', 'macos-seatbelt', 'linux-bubblewrap']).toContain(backend)
    })
  })

  describe('generateMacOSProfile', () => {
    it('includes version header + standard deny-default base', () => {
      const profile = generateMacOSProfile(DEFAULT_CONFIG, '/tmp/project')
      expect(profile).toContain('(version 1)')
      // Round 26 (L7): the nonstandard (allow default-services) /
      // (deny default-disallowed) directives are gone — modern
      // sandbox-exec rejects them, breaking the whole sandbox.
      expect(profile).toContain('(deny default)')
      expect(profile).not.toContain('default-services')
      expect(profile).not.toContain('default-disallowed')
    })

    it('includes writable paths', () => {
      const cfg: SandboxConfig = {
        ...DEFAULT_CONFIG,
        enabled: true,
        writablePaths: ['/custom/path'],
      }
      const profile = generateMacOSProfile(cfg, '/tmp/project')
      expect(profile).toContain('/custom/path')
      expect(profile).toContain('/tmp/project')
    })

    it('includes denied paths', () => {
      const cfg: SandboxConfig = {
        ...DEFAULT_CONFIG,
        enabled: true,
        deniedPaths: ['/secret'],
      }
      const profile = generateMacOSProfile(cfg, '/tmp/project')
      expect(profile).toContain('/secret')
      expect(profile).toContain('(deny file-read*')
    })

    it('denies network in strict mode', () => {
      const cfg: SandboxConfig = {
        ...DEFAULT_CONFIG,
        enabled: true,
        level: 'strict',
        allowNetwork: false,
      }
      const profile = generateMacOSProfile(cfg, '/tmp/project')
      expect(profile).toContain('(deny network*)')
    })

    it('restricts process-exec in strict mode', () => {
      const cfg: SandboxConfig = {
        ...DEFAULT_CONFIG,
        enabled: true,
        level: 'strict',
        allowNetwork: false,
      }
      const profile = generateMacOSProfile(cfg, '/tmp/project')
      expect(profile).toContain('process-exec')
    })
  })

  describe('generateBubblewrapArgs', () => {
    it('starts with bwrap', () => {
      const args = generateBubblewrapArgs(DEFAULT_CONFIG, '/tmp/project')
      expect(args[0]).toBe('bwrap')
    })

    it('includes --die-with-parent', () => {
      const args = generateBubblewrapArgs(DEFAULT_CONFIG, '/tmp/project')
      expect(args).toContain('--die-with-parent')
    })

    it('includes --unshare-net when network denied', () => {
      const cfg: SandboxConfig = { ...DEFAULT_CONFIG, allowNetwork: false }
      const args = generateBubblewrapArgs(cfg, '/tmp/project')
      expect(args).toContain('--unshare-net')
    })

    it('includes writable paths as --bind', () => {
      const args = generateBubblewrapArgs(DEFAULT_CONFIG, '/tmp/project')
      const bindIdx = args.indexOf('--bind')
      expect(bindIdx).toBeGreaterThan(-1)
    })
  })

  describe('compileProfile', () => {
    it('returns passthrough when disabled', () => {
      const profile = compileProfile('/tmp', { ...DEFAULT_CONFIG, enabled: false })
      expect(profile.prefix).toBe('')
      expect(profile.backend).toBe('none')
    })

    it('returns passthrough for permissive level', () => {
      const profile = compileProfile('/tmp', {
        ...DEFAULT_CONFIG, enabled: true, level: 'permissive',
      })
      expect(profile.prefix).toBe('')
    })

    it('compiles a profile when enabled with detected backend', () => {
      const profile = compileProfile('/tmp', {
        ...DEFAULT_CONFIG, enabled: true, level: 'standard',
      })
      // If a backend was detected, prefix is non-empty; otherwise passthrough
      if (profile.backend !== 'none') {
        expect(profile.prefix.length).toBeGreaterThan(0)
      }
    })
  })

  describe('getCachedProfile / invalidateProfileCache', () => {
    it('caches the profile', () => {
      const p1 = getCachedProfile('/tmp')
      const p2 = getCachedProfile('/tmp')
      expect(p1).toBe(p2) // same reference
    })

    it('invalidates on demand', () => {
      const p1 = getCachedProfile('/tmp')
      invalidateProfileCache()
      const p2 = getCachedProfile('/tmp')
      expect(p1).not.toBe(p2) // different reference
    })
  })

  describe('wrapCommand', () => {
    it('returns command unchanged when disabled', () => {
      const wrapped = wrapCommand('ls -la', '/tmp', { ...DEFAULT_CONFIG, enabled: false })
      expect(wrapped).toBe('ls -la')
    })

    it('returns command unchanged for permissive', () => {
      const wrapped = wrapCommand('ls -la', '/tmp', {
        ...DEFAULT_CONFIG, enabled: true, level: 'permissive',
      })
      expect(wrapped).toBe('ls -la')
    })
  })

  describe('validateConfig', () => {
    it('validates default config', () => {
      const result = validateConfig(DEFAULT_CONFIG)
      expect(result.valid).toBe(true)
    })

    it('flags invalid level', () => {
      const result = validateConfig({ ...DEFAULT_CONFIG, level: 'bogus' as never })
      expect(result.valid).toBe(false)
    })

    it('warns on strict + network', () => {
      const result = validateConfig({
        ...DEFAULT_CONFIG, level: 'strict', allowNetwork: true,
      })
      expect(result.valid).toBe(false)
    })

    it('flags relative denied paths', () => {
      const result = validateConfig({
        ...DEFAULT_CONFIG, deniedPaths: ['relative/path'],
      })
      expect(result.valid).toBe(false)
    })

    it('flags relative writable paths', () => {
      const result = validateConfig({
        ...DEFAULT_CONFIG, writablePaths: ['not/absolute'],
      })
      expect(result.valid).toBe(false)
    })
  })

  describe('formatConfig', () => {
    it('formats enabled config', () => {
      const out = formatConfig({ ...DEFAULT_CONFIG, enabled: true })
      expect(out).toContain('Sandbox Configuration')
      expect(out).toContain('Enabled: ✓')
    })

    it('formats disabled config', () => {
      const out = formatConfig(DEFAULT_CONFIG)
      expect(out).toContain('Enabled: ✗')
    })

    it('includes custom paths', () => {
      const out = formatConfig({
        ...DEFAULT_CONFIG,
        writablePaths: ['/w'], readOnlyPaths: ['/r'], deniedPaths: ['/d'],
      })
      expect(out).toContain('/w')
      expect(out).toContain('/r')
      expect(out).toContain('/d')
    })
  })

  describe('formatProfile', () => {
    it('formats a passthrough profile', () => {
      const out = formatProfile({ backend: 'none', level: 'permissive', prefix: '' })
      expect(out).toContain('passthrough')
    })

    it('formats an active profile', () => {
      const out = formatProfile({
        backend: 'macos-seatbelt',
        level: 'strict',
        prefix: 'sandbox-exec -f /path ',
        profilePath: '/path/to/profile.sb',
      })
      expect(out).toContain('macos-seatbelt')
      expect(out).toContain('strict')
      expect(out).toContain('/path/to/profile.sb')
    })
  })
})
