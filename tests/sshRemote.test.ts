/**
 * Tests for src/core/sshRemote.ts
 *
 * SSH/rsync require network + remote hosts; we test the pure
 * helpers (argument building, profile management, formatting) and
 * structural contracts.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import {
  loadProfiles, getProfile, addProfile, removeProfile,
  buildSshArgs, testConnection,
  formatProfile, formatProfileList, formatConnectionTest, formatExecResult,
  type SshProfile,
  type SshExecResult,
  type SshConnectionTest,
} from '../src/core/sshRemote.js'
import { existsSync, rmSync, mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { homedir } from 'os'

let testHome: string
let origHome: string | undefined

beforeAll(() => {
  testHome = mkdtempSync(join(tmpdir(), 'ovolv999-ssh-'))
  origHome = process.env.HOME
  process.env.HOME = testHome
})

afterAll(() => {
  if (origHome !== undefined) process.env.HOME = origHome
  rmSync(testHome, { recursive: true, force: true })
})

beforeEach(() => {
  const dir = join(homedir(), '.ovolv999')
  if (existsSync(dir)) rmSync(dir, { recursive: true, force: true })
})

const sampleProfile: SshProfile = {
  name: 'test',
  host: 'example.com',
  user: 'deploy',
  port: 2222,
  identityFile: '/home/user/.ssh/id_rsa',
  remoteBase: '~/projects',
}

describe('sshRemote', () => {
  describe('profile management', () => {
    it('starts with empty profiles', () => {
      expect(loadProfiles()).toEqual([])
    })

    it('addProfile + getProfile round-trips', () => {
      addProfile(sampleProfile)
      const got = getProfile('test')
      expect(got).toBeDefined()
      expect(got!.host).toBe('example.com')
      expect(got!.user).toBe('deploy')
    })

    it('addProfile replaces existing', () => {
      addProfile(sampleProfile)
      addProfile({ ...sampleProfile, port: 3333 })
      const profiles = loadProfiles()
      expect(profiles.length).toBe(1)
      expect(profiles[0].port).toBe(3333)
    })

    it('removeProfile works', () => {
      addProfile(sampleProfile)
      expect(removeProfile('test')).toBe(true)
      expect(getProfile('test')).toBeUndefined()
    })

    it('removeProfile returns false for unknown', () => {
      expect(removeProfile('nope')).toBe(false)
    })
  })

  describe('buildSshArgs', () => {
    it('includes port', () => {
      const args = buildSshArgs(sampleProfile)
      expect(args).toContain('-p')
      expect(args).toContain('2222')
    })

    it('includes identity file', () => {
      const args = buildSshArgs(sampleProfile)
      expect(args).toContain('-i')
      expect(args).toContain('/home/user/.ssh/id_rsa')
    })

    it('includes BatchMode', () => {
      const args = buildSshArgs(sampleProfile)
      expect(args).toContain('BatchMode=yes')
    })

    it('includes StrictHostKeyChecking accept-new', () => {
      const args = buildSshArgs(sampleProfile)
      expect(args).toContain('StrictHostKeyChecking=accept-new')
    })

    it('builds target with user@host', () => {
      const args = buildSshArgs(sampleProfile)
      expect(args).toContain('deploy@example.com')
    })

    it('builds target without user', () => {
      const args = buildSshArgs({ name: 'x', host: 'h.com' })
      expect(args).toContain('h.com')
      expect(args).not.toContain('@')
    })

    it('includes ProxyJump', () => {
      const args = buildSshArgs({ ...sampleProfile, proxyJump: 'jump@bastion.com' })
      expect(args).toContain('-J')
      expect(args).toContain('jump@bastion.com')
    })

    it('includes remote command when provided', () => {
      const args = buildSshArgs(sampleProfile, 'ls -la')
      expect(args[args.length - 1]).toBe('ls -la')
    })
  })

  describe('testConnection (no real host)', () => {
    it('returns a result object', () => {
      const result = testConnection({ name: 'x', host: 'nonexistent.invalid', timeoutMs: 2000 })
      expect(result).toBeDefined()
      expect(result.connected).toBe(false)
      expect(typeof result.latency).toBe('number')
    })
  })

  describe('formatting', () => {
    it('formatProfile shows all fields', () => {
      const out = formatProfile(sampleProfile)
      expect(out).toContain('test')
      expect(out).toContain('example.com')
      expect(out).toContain('deploy')
      expect(out).toContain('2222')
      expect(out).toContain('id_rsa')
    })

    it('formatProfileList handles empty', () => {
      expect(formatProfileList([])).toContain('No SSH profiles')
    })

    it('formatProfileList shows profiles', () => {
      const out = formatProfileList([sampleProfile, { name: 'prod', host: 'prod.com', user: 'root' }])
      expect(out).toContain('test')
      expect(out).toContain('deploy@example.com')
      expect(out).toContain('prod')
      expect(out).toContain('root@prod.com')
    })

    it('formatConnectionTest shows success', () => {
      const test: SshConnectionTest = { connected: true, latency: 42, version: 'node v20.0.0' }
      expect(formatConnectionTest(test)).toContain('Connected')
      expect(formatConnectionTest(test)).toContain('42ms')
    })

    it('formatConnectionTest shows failure', () => {
      const test: SshConnectionTest = { connected: false, latency: 100, error: 'timeout' }
      expect(formatConnectionTest(test)).toContain('failed')
      expect(formatConnectionTest(test)).toContain('timeout')
    })

    it('formatExecResult shows exit code', () => {
      const result: SshExecResult = { exitCode: 0, stdout: 'hello', stderr: '', duration: 100 }
      const out = formatExecResult(result)
      expect(out).toContain('Exit code: 0')
      expect(out).toContain('hello')
    })

    it('formatExecResult shows stderr', () => {
      const result: SshExecResult = { exitCode: 1, stdout: '', stderr: 'error msg', duration: 50 }
      const out = formatExecResult(result)
      expect(out).toContain('error msg')
    })
  })
})
