/**
 * Tests for src/utils/autoUpdater.ts
 *
 * Focus on pure helpers (version parsing, comparison, ignore-list,
 * cache). Network/exec-backed functions (fetchDistTags, checkForUpdates,
 * performUpdate) are exercised structurally only.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import {
  parseVersion,
  compareVersions,
  isNewerVersion,
  getCurrentVersion,
  getIgnoredVersions,
  ignoreVersion,
  isVersionIgnored,
  getCachedCheck,
  setCachedCheck,
  clearCache,
  formatVersionInfo,
  formatUpdateCheckResult,
  getIgnoredVersionsPath,
  performUpdate,
  type UpdateChannel,
} from '../src/utils/autoUpdater.js'
import { existsSync, rmSync, mkdtempSync, readFileSync, writeFileSync, mkdirSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

let testHome: string
let origHome: string | undefined

beforeAll(() => {
  testHome = mkdtempSync(join(tmpdir(), 'ovolv999-updater-'))
  origHome = process.env.HOME
  process.env.HOME = testHome
})

afterAll(() => {
  if (origHome !== undefined) process.env.HOME = origHome
  rmSync(testHome, { recursive: true, force: true })
})

beforeEach(() => {
  clearCache()
  const p = getIgnoredVersionsPath()
  if (existsSync(p)) rmSync(p, { force: true })
})

describe('autoUpdater', () => {
  describe('parseVersion', () => {
    it('parses semver', () => {
      expect(parseVersion('1.2.3')).toEqual({ major: 1, minor: 2, patch: 3 })
    })

    it('parses v-prefixed', () => {
      expect(parseVersion('v2.0.0')).toEqual({ major: 2, minor: 0, patch: 0 })
    })

    it('parses prerelease', () => {
      const r = parseVersion('1.0.0-beta.1')
      expect(r.major).toBe(1)
      expect(r.prerelease).toBe('beta.1')
    })

    it('returns zeros for garbage', () => {
      expect(parseVersion('not-a-version')).toEqual({ major: 0, minor: 0, patch: 0 })
    })
  })

  describe('compareVersions', () => {
    it('compares major', () => {
      expect(compareVersions('2.0.0', '1.0.0')).toBeGreaterThan(0)
      expect(compareVersions('1.0.0', '2.0.0')).toBeLessThan(0)
    })

    it('compares minor', () => {
      expect(compareVersions('1.2.0', '1.1.0')).toBeGreaterThan(0)
    })

    it('compares patch', () => {
      expect(compareVersions('1.0.5', '1.0.0')).toBeGreaterThan(0)
    })

    it('returns 0 for equal', () => {
      expect(compareVersions('1.2.3', '1.2.3')).toBe(0)
    })

    it('treats prerelease as lower than release', () => {
      expect(compareVersions('1.0.0', '1.0.0-beta')).toBeGreaterThan(0)
      expect(compareVersions('1.0.0-beta', '1.0.0')).toBeLessThan(0)
    })
  })

  describe('isNewerVersion', () => {
    it('true when candidate newer', () => {
      expect(isNewerVersion('1.0.0', '1.0.1')).toBe(true)
      expect(isNewerVersion('1.0.0', '2.0.0')).toBe(true)
    })

    it('false when candidate same or older', () => {
      expect(isNewerVersion('1.0.0', '1.0.0')).toBe(false)
      expect(isNewerVersion('2.0.0', '1.0.0')).toBe(false)
    })
  })

  describe('getCurrentVersion', () => {
    it('reads from package.json', () => {
      // The repo's package.json exists; version should be non-empty
      const v = getCurrentVersion()
      expect(v).toBeTruthy()
      expect(v).toMatch(/^\d+\.\d+\.\d+/)
    })
  })

  describe('ignore list', () => {
    it('starts empty', () => {
      expect(getIgnoredVersions()).toEqual([])
    })

    it('ignoreVersion adds', () => {
      ignoreVersion('9.9.9')
      expect(getIgnoredVersions()).toContain('9.9.9')
    })

    it('ignoreVersion is idempotent', () => {
      ignoreVersion('9.9.9')
      ignoreVersion('9.9.9')
      const list = getIgnoredVersions()
      expect(list.filter((v) => v === '9.9.9').length).toBe(1)
    })

    it('isVersionIgnored reflects state', () => {
      expect(isVersionIgnored('1.2.3')).toBe(false)
      ignoreVersion('1.2.3')
      expect(isVersionIgnored('1.2.3')).toBe(true)
    })
  })

  describe('cache', () => {
    it('starts null', () => {
      expect(getCachedCheck()).toBeNull()
    })

    it('setCachedCheck stores and getCachedCheck returns', () => {
      const result = {
        checked: new Date().toISOString(),
        version: {
          current: '1.0.0',
          updateAvailable: false,
          betaAvailable: false,
          isPrerelease: false,
        },
      }
      setCachedCheck(result)
      expect(getCachedCheck()).toEqual(result)
    })

    it('clearCache resets', () => {
      setCachedCheck({
        checked: new Date().toISOString(),
        version: { current: '1.0.0', updateAvailable: false, betaAvailable: false, isPrerelease: false },
      })
      clearCache()
      expect(getCachedCheck()).toBeNull()
    })
  })

  describe('formatVersionInfo', () => {
    it('formats basic info', () => {
      const out = formatVersionInfo({
        current: '1.0.0',
        updateAvailable: false,
        betaAvailable: false,
        isPrerelease: false,
      })
      expect(out).toContain('1.0.0')
    })

    it('notes prerelease', () => {
      const out = formatVersionInfo({
        current: '1.0.0-beta',
        updateAvailable: false,
        betaAvailable: false,
        isPrerelease: true,
      })
      expect(out.toLowerCase()).toContain('prerelease')
    })
  })

  describe('formatUpdateCheckResult', () => {
    it('formats a no-update result', () => {
      const out = formatUpdateCheckResult({
        checked: new Date().toISOString(),
        version: { current: '1.0.0', updateAvailable: false, betaAvailable: false, isPrerelease: false },
      })
      expect(out.length).toBeGreaterThan(0)
    })

    it('formats an error result', () => {
      const out = formatUpdateCheckResult({
        checked: new Date().toISOString(),
        version: { current: '1.0.0', updateAvailable: false, betaAvailable: false, isPrerelease: false },
        error: 'offline',
      })
      expect(out).toContain('offline')
    })
  })
})

describe('ignored-versions corruption guard', () => {
  it('preserves a corrupt list before resetting, and ignoring still works', () => {
    const path = getIgnoredVersionsPath()
    const backup = `${path}.corrupt`
    mkdirSync(join(path, '..'), { recursive: true })
    writeFileSync(path, '["9.9.9"', 'utf8')

    expect(getIgnoredVersions()).toEqual([])
    expect(readFileSync(backup, 'utf8')).toBe('["9.9.9"')

    ignoreVersion('8.8.8')
    expect(getIgnoredVersions()).toEqual(['8.8.8'])
    expect(readFileSync(backup, 'utf8')).toBe('["9.9.9"')
  })

  it('treats a non-string entry as corrupt', () => {
    const path = getIgnoredVersionsPath()
    mkdirSync(join(path, '..'), { recursive: true })
    writeFileSync(path, '["1.0.0", 42]', 'utf8')
    expect(getIgnoredVersions()).toEqual([])
    expect(existsSync(`${path}.corrupt`)).toBe(true)
  })
})

describe('performUpdate channel defense', () => {
  it('rejects a channel outside the union before any shell interpolation', () => {
    // Simulates a dishonest caller casting an arbitrary string into
    // UpdateChannel — the guard must fire before the execSync template.
    const result = performUpdate('latest && touch /tmp/pwned' as UpdateChannel)
    expect(result.success).toBe(false)
    expect(result.message).toContain('Invalid update channel')
  })
})
