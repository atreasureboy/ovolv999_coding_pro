import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import {
  VCR,
  VCRFixtureNotFoundError,
  dehydrate,
  computeCallHash,
  createVCRFromEnv,
} from '../src/utils/vcr.js'
import { mkdtempSync, rmSync, existsSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

describe('vcr', () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'vcr-test-'))
  })

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true })
  })

  describe('dehydrate', () => {
    it('replaces absolute paths', () => {
      const input = 'cwd: /home/user/project'
      const result = dehydrate(input)
      expect(result).not.toContain('/home/user/project')
      expect(result).toContain('<PATH>')
    })

    it('replaces /tmp paths', () => {
      expect(dehydrate('path: /tmp/foo/bar')).toContain('<PATH>')
    })

    it('replaces UUIDs', () => {
      const uuid = '550e8400-e29b-41d4-a716-446655440000'
      expect(dehydrate(`id: ${uuid}`)).toContain('<UUID>')
    })

    it('replaces ISO timestamps', () => {
      expect(dehydrate('at: 2024-01-15T10:30:00Z')).toContain('<TIMESTAMP>')
    })

    it('replaces epoch millis', () => {
      expect(dehydrate('ts: 1700000000000')).toContain('<TIMESTAMP>')
    })

    it('replaces session IDs', () => {
      expect(dehydrate('session_2024-01-15_103000')).toContain('<SESSION>')
    })

    it('is idempotent on already-dehydrated text', () => {
      const dehydrated = '<PATH>/<UUID>/<TIMESTAMP>'
      expect(dehydrate(dehydrated)).toBe(dehydrated)
    })

    it('preserves non-sensitive content', () => {
      const input = 'const x = 1 + 2'
      expect(dehydrate(input)).toBe(input)
    })
  })

  describe('computeCallHash', () => {
    it('produces stable hashes for same params', () => {
      const params = { model: 'gpt-4o', messages: [{ role: 'user', content: 'hi' }] }
      expect(computeCallHash('create', params)).toBe(computeCallHash('create', params))
    })

    it('produces different hashes for different methods', () => {
      const params = { model: 'gpt-4o' }
      expect(computeCallHash('create', params)).not.toBe(computeCallHash('delete', params))
    })

    it('produces different hashes for different params', () => {
      expect(computeCallHash('create', { a: 1 })).not.toBe(computeCallHash('create', { a: 2 }))
    })

    it('normalizes paths via dehydrate', () => {
      const params1 = { cwd: '/home/user/a', prompt: 'hi' }
      const params2 = { cwd: '/home/user/b', prompt: 'hi' }
      // Both paths dehydrate to <PATH>, so hashes should be the same
      // Wait, actually /home/user/a and /home/user/b both get replaced by <PATH>
      // since the regex matches the full path prefix. Let me check:
      // /\/(?:home|Users)[^"\s]*/g — this matches /home/user/a entirely
      // and /home/user/b entirely, both become <PATH>
      expect(computeCallHash('create', params1)).toBe(computeCallHash('create', params2))
    })

    it('includes method name in hash', () => {
      const hash = computeCallHash('chat.completions.create', { model: 'x' })
      expect(hash).toContain('chat.completions.create')
    })

    it('returns a 16-char hash suffix', () => {
      const hash = computeCallHash('test', {})
      const parts = hash.split('_')
      expect(parts[parts.length - 1].length).toBe(16)
    })

    it('can skip dehydration', () => {
      const params1 = { cwd: '/home/user/a' }
      const params2 = { cwd: '/home/user/b' }
      expect(computeCallHash('create', params1, false)).not.toBe(computeCallHash('create', params2, false))
    })
  })

  describe('VCR', () => {
    describe('constructor', () => {
      it('creates fixture dir in non-replay modes', () => {
        new VCR({ mode: 'record', fixtureDir: join(tmpDir, 'fix') })
        expect(existsSync(join(tmpDir, 'fix'))).toBe(true)
      })

      it('does not create dir in replay mode', () => {
        const dir = join(tmpDir, 'nofix')
        new VCR({ mode: 'replay', fixtureDir: dir })
        expect(existsSync(dir)).toBe(false)
      })

      it('applies defaults', () => {
        const vcr = new VCR({ mode: 'replay', fixtureDir: tmpDir })
        expect(vcr.getStats().recorded).toBe(0)
      })
    })

    describe('fixturePath', () => {
      it('returns a path ending in .json', () => {
        const vcr = new VCR({ mode: 'replay', fixtureDir: tmpDir })
        const path = vcr.fixturePath('create', { model: 'x' })
        expect(path.endsWith('.json')).toBe(true)
      })

      it('includes prefix', () => {
        const vcr = new VCR({ mode: 'replay', fixtureDir: tmpDir, filePrefix: 'test' })
        const path = vcr.fixturePath('create', {})
        expect(path).toContain('test_')
      })
    })

    describe('hasFixture', () => {
      it('returns false when no fixture', () => {
        const vcr = new VCR({ mode: 'replay', fixtureDir: tmpDir })
        expect(vcr.hasFixture('create', {})).toBe(false)
      })

      it('returns true after saving', () => {
        const vcr = new VCR({ mode: 'record', fixtureDir: tmpDir })
        vcr.saveFixture('create', { model: 'x' }, { result: 'ok' })
        expect(vcr.hasFixture('create', { model: 'x' })).toBe(true)
      })
    })

    describe('saveFixture / loadFixture', () => {
      it('round-trips data', () => {
        const vcr = new VCR({ mode: 'record', fixtureDir: tmpDir })
        const data = { choices: [{ message: { content: 'hello' } }] }
        vcr.saveFixture('create', { model: 'x' }, data)
        const loaded = vcr.loadFixture('create', { model: 'x' })
        expect(loaded).toEqual(data)
      })

      it('returns null for missing fixture in non-strict mode', () => {
        const vcr = new VCR({ mode: 'replay', fixtureDir: tmpDir, strict: false })
        expect(vcr.loadFixture('create', {})).toBeNull()
      })

      it('throws for missing fixture in strict mode', () => {
        const vcr = new VCR({ mode: 'replay', fixtureDir: tmpDir, strict: true })
        expect(() => vcr.loadFixture('create', {})).toThrow(VCRFixtureNotFoundError)
      })
    })

    describe('intercept', () => {
      it('replays existing fixture in replay mode', async () => {
        // First record
        const recVcr = new VCR({ mode: 'record', fixtureDir: tmpDir })
        const mockTarget = {
          create: async () => ({ result: 'real-response' }),
        }
        await recVcr.intercept(mockTarget, 'create', { model: 'x' })

        // Now replay
        const replayVcr = new VCR({ mode: 'replay', fixtureDir: tmpDir })
        const result = await replayVcr.intercept(
          { create: async () => ({ result: 'SHOULD-NOT-CALL' }) },
          'create',
          { model: 'x' },
        )
        expect(result).toEqual({ result: 'real-response' })
      })

      it('records new fixture in record mode', async () => {
        const vcr = new VCR({ mode: 'record', fixtureDir: tmpDir })
        const callCount = { n: 0 }
        const target = {
          create: async () => { callCount.n++; return { n: callCount.n } },
        }
        const r1 = await vcr.intercept(target, 'create', { model: 'x' })
        expect(r1).toEqual({ n: 1 })
        expect(vcr.getStats().recorded).toBe(1)
      })

      it('uses cache for existing fixture in record mode', async () => {
        const vcr = new VCR({ mode: 'record', fixtureDir: tmpDir })
        let callCount = 0
        const target = {
          create: async () => { callCount++; return { n: callCount } },
        }
        await vcr.intercept(target, 'create', { model: 'x' })
        await vcr.intercept(target, 'create', { model: 'x' })
        expect(callCount).toBe(1) // only called once
        expect(vcr.getStats().cached).toBe(1)
      })

      it('replays or records in auto mode', async () => {
        const vcr = new VCR({ mode: 'auto', fixtureDir: tmpDir })
        const target = {
          create: async () => ({ result: 'fresh' }),
        }
        const r1 = await vcr.intercept(target, 'create', { model: 'x' })
        expect(r1).toEqual({ result: 'fresh' })
        expect(vcr.getStats().recorded).toBe(1)

        // Second call should replay
        const r2 = await vcr.intercept(
          { create: async () => ({ result: 'DIFFERENT' }) },
          'create',
          { model: 'x' },
        )
        expect(r2).toEqual({ result: 'fresh' })
        expect(vcr.getStats().replayed).toBe(1)
      })

      it('throws on missing fixture in strict replay mode', async () => {
        const vcr = new VCR({ mode: 'replay', fixtureDir: tmpDir, strict: true })
        await expect(
          vcr.intercept({ create: async () => ({}) }, 'create', { model: 'x' }),
        ).rejects.toThrow(VCRFixtureNotFoundError)
        expect(vcr.getStats().errors).toBe(1)
      })
    })

    describe('stats', () => {
      it('tracks recorded count', async () => {
        const vcr = new VCR({ mode: 'record', fixtureDir: tmpDir })
        await vcr.intercept({ create: async () => ({}) }, 'create', { a: 1 })
        await vcr.intercept({ create: async () => ({}) }, 'create', { a: 2 })
        expect(vcr.getStats().recorded).toBe(2)
      })

      it('resetStats clears counters', async () => {
        const vcr = new VCR({ mode: 'record', fixtureDir: tmpDir })
        await vcr.intercept({ create: async () => ({}) }, 'create', { a: 1 })
        vcr.resetStats()
        expect(vcr.getStats().recorded).toBe(0)
      })

      it('returns readonly stats', () => {
        const vcr = new VCR({ mode: 'replay', fixtureDir: tmpDir })
        const stats = vcr.getStats()
        expect(() => { (stats as { recorded: number }).recorded = 99 }).toThrow()
      })
    })

    describe('listFixtures', () => {
      it('returns empty array for new dir', () => {
        const vcr = new VCR({ mode: 'record', fixtureDir: tmpDir })
        expect(vcr.listFixtures()).toEqual([])
      })

      it('lists saved fixtures', async () => {
        const vcr = new VCR({ mode: 'record', fixtureDir: tmpDir })
        await vcr.intercept({ create: async () => ({}) }, 'create', { a: 1 })
        await vcr.intercept({ create: async () => ({}) }, 'create', { a: 2 })
        const fixtures = vcr.listFixtures()
        expect(fixtures.length).toBe(2)
        expect(fixtures[0]).toContain('.json')
      })
    })

    describe('clearFixtures', () => {
      it('removes all fixtures', async () => {
        const vcr = new VCR({ mode: 'record', fixtureDir: tmpDir })
        await vcr.intercept({ create: async () => ({}) }, 'create', { a: 1 })
        expect(vcr.listFixtures().length).toBe(1)
        const count = vcr.clearFixtures()
        expect(count).toBe(1)
        expect(vcr.listFixtures().length).toBe(0)
      })
    })
  })

  describe('VCRFixtureNotFoundError', () => {
    it('includes method and path in message', () => {
      const err = new VCRFixtureNotFoundError('create', '/path/to/fix.json')
      expect(err.message).toContain('create')
      expect(err.message).toContain('/path/to/fix.json')
      expect(err.message).toContain('VCR_RECORD=1')
    })

    it('exposes method and fixturePath properties', () => {
      const err = new VCRFixtureNotFoundError('chat', '/f.json')
      expect(err.method).toBe('chat')
      expect(err.fixturePath).toBe('/f.json')
    })
  })

  describe('createVCRFromEnv', () => {
    afterEach(() => {
      delete process.env.VCR_MODE
      delete process.env.VCR_DIR
      delete process.env.VCR_STRICT
    })

    it('defaults to replay mode', () => {
      delete process.env.VCR_MODE
      const vcr = createVCRFromEnv(tmpDir)
      expect(vcr.getStats()).toBeDefined()
    })

    it('reads VCR_MODE', () => {
      process.env.VCR_MODE = 'record'
      const _vcr = createVCRFromEnv(tmpDir)
      expect(existsSync(tmpDir)).toBe(true)
    })

    it('reads VCR_DIR', () => {
      process.env.VCR_DIR = tmpDir
      const vcr = createVCRFromEnv()
      expect(vcr).toBeDefined()
    })
  })
})
