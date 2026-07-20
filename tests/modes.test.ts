import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import {
  DEFAULT_MODES, getAllModes, getCurrentMode, setCurrentMode,
  cycleMode, getVerbosityPrompt, resetModeCache, loadCustomModes,
  type Mode,
} from '../src/core/modes.js'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

function makeTempDir(): string {
  return mkdtempSync(join(tmpdir(), 'ovolv999-modes-'))
}

describe('Mode System', () => {
  let modesDir: string

  beforeEach(() => {
    modesDir = makeTempDir()
    resetModeCache()
  })

  afterEach(() => {
    rmSync(modesDir, { recursive: true, force: true })
    resetModeCache()
  })

  describe('DEFAULT_MODES', () => {
    it('has 6 default modes', () => {
      expect(DEFAULT_MODES).toHaveLength(6)
    })

    it('includes all expected slugs', () => {
      const slugs = DEFAULT_MODES.map(m => m.slug)
      expect(slugs).toContain('default')
      expect(slugs).toContain('gentle')
      expect(slugs).toContain('sharp')
      expect(slugs).toContain('workhorse')
      expect(slugs).toContain('token-saver')
      expect(slugs).toContain('super-ai')
    })

    it('each mode has required fields', () => {
      for (const mode of DEFAULT_MODES) {
        expect(mode.name).toBeTruthy()
        expect(mode.slug).toBeTruthy()
        expect(mode.description).toBeTruthy()
        expect(mode.icon).toBeTruthy()
        expect(mode.systemPrompt).toBeDefined()
        expect(mode.verbosity).toBeDefined()
        expect(typeof mode.autoApproveEdits).toBe('boolean')
        expect(typeof mode.memoryExtract).toBe('boolean')
      }
    })

    it('Dr. Sharp has detailed system prompt', () => {
      const sharp = DEFAULT_MODES.find(m => m.slug === 'sharp')!
      expect(sharp.systemPrompt).toContain('Diagnose')
      expect(sharp.systemPrompt).toContain('Phase')
    })

    it('workhorse auto-approves edits', () => {
      const workhorse = DEFAULT_MODES.find(m => m.slug === 'workhorse')!
      expect(workhorse.autoApproveEdits).toBe(true)
    })

    it('token-saver has minimal verbosity', () => {
      const saver = DEFAULT_MODES.find(m => m.slug === 'token-saver')!
      expect(saver.verbosity).toBe('minimal')
    })
  })

  describe('getAllModes', () => {
    it('returns defaults when no modesDir', () => {
      expect(getAllModes()).toHaveLength(6)
    })

    it('returns defaults when dir is empty', () => {
      expect(getAllModes(modesDir)).toHaveLength(6)
    })

    it('includes custom modes', () => {
      writeFileSync(join(modesDir, 'custom.md'), [
        '---',
        'name: Custom Mode',
        'slug: custom',
        'verbosity: verbose',
        '---',
        'You are a custom mode.',
      ].join('\n'))
      resetModeCache()
      const modes = getAllModes(modesDir)
      expect(modes.length).toBeGreaterThanOrEqual(7)
      expect(modes.find(m => m.slug === 'custom')).toBeDefined()
    })
  })

  describe('getCurrentMode and setCurrentMode', () => {
    it('returns default initially', () => {
      expect(getCurrentMode().slug).toBe('default')
    })

    it('switches mode', () => {
      const mode = setCurrentMode('sharp')
      expect(mode.slug).toBe('sharp')
      expect(getCurrentMode().slug).toBe('sharp')
    })

    it('throws on unknown slug', () => {
      expect(() => setCurrentMode('nope')).toThrow(/Unknown mode/)
    })
  })

  describe('cycleMode', () => {
    it('cycles to next mode', () => {
      setCurrentMode('default')
      const next = cycleMode()
      expect(next.slug).not.toBe('default')
    })

    it('wraps around', () => {
      const modes = getAllModes()
      setCurrentMode(modes[modes.length - 1].slug)
      const next = cycleMode()
      expect(next.slug).toBe(modes[0].slug)
    })
  })

  describe('getVerbosityPrompt', () => {
    it('returns empty for normal', () => {
      expect(getVerbosityPrompt('normal')).toBe('')
    })

    it('returns guidance for minimal', () => {
      const prompt = getVerbosityPrompt('minimal')
      expect(prompt).toContain('shortest')
      expect(prompt).toContain('Skip')
    })

    it('returns guidance for verbose', () => {
      const prompt = getVerbosityPrompt('verbose')
      expect(prompt).toContain('detailed')
      expect(prompt).toContain('trade-offs')
    })
  })

  describe('loadCustomModes', () => {
    it('parses frontmatter correctly', () => {
      writeFileSync(join(modesDir, 'test.md'), [
        '---',
        'name: Test Mode',
        'slug: test',
        'description: A test mode',
        'icon: 🧪',
        'verbosity: minimal',
        'auto_approve_edits: true',
        'memory_extract: false',
        '---',
        'Custom system prompt here.',
      ].join('\n'))
      resetModeCache()
      const customs = loadCustomModes(modesDir)
      expect(customs).toHaveLength(1)
      expect(customs[0].name).toBe('Test Mode')
      expect(customs[0].slug).toBe('test')
      expect(customs[0].verbosity).toBe('minimal')
      expect(customs[0].autoApproveEdits).toBe(true)
      expect(customs[0].memoryExtract).toBe(false)
      expect(customs[0].systemPrompt).toContain('Custom system prompt')
    })

    it('auto-generates slug from name', () => {
      writeFileSync(join(modesDir, 'no-slug.md'), [
        '---',
        'name: My Cool Mode',
        '---',
        'prompt',
      ].join('\n'))
      resetModeCache()
      const customs = loadCustomModes(modesDir)
      expect(customs[0].slug).toBe('my-cool-mode')
    })

    it('skips files without name', () => {
      writeFileSync(join(modesDir, 'bad.md'), '---\nverbosity: minimal\n---\nprompt')
      resetModeCache()
      expect(loadCustomModes(modesDir)).toHaveLength(0)
    })

    it('caches results', () => {
      const first = loadCustomModes(modesDir)
      const second = loadCustomModes(modesDir)
      expect(first).toBe(second) // Same reference
    })
  })

  describe('resetModeCache', () => {
    it('clears cache and resets to default', () => {
      setCurrentMode('sharp')
      resetModeCache()
      expect(getCurrentMode().slug).toBe('default')
    })
  })
})
