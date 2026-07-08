import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import {
  DEFAULT_MODES,
  getCurrentMode,
  setCurrentMode,
  getAllModes,
  cycleMode,
  resetModeCache,
  getVerbosityPrompt,
  loadCustomModes,
} from '../src/core/modes.js'
import { mkdirSync, writeFileSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

const TEST_DIR = join(tmpdir(), `ovolv999_modes_test_${Date.now()}`)

describe('Modes System', () => {
  beforeEach(() => {
    resetModeCache()
    mkdirSync(TEST_DIR, { recursive: true })
  })

  afterEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true })
    resetModeCache()
  })

  describe('DEFAULT_MODES', () => {
    it('has 6 built-in modes', () => {
      expect(DEFAULT_MODES).toHaveLength(6)
    })

    it('all modes have unique slugs', () => {
      const slugs = DEFAULT_MODES.map(m => m.slug)
      expect(new Set(slugs).size).toBe(slugs.length)
    })

    it('all modes have required fields', () => {
      for (const mode of DEFAULT_MODES) {
        expect(mode.name).toBeTruthy()
        expect(mode.slug).toBeTruthy()
        expect(mode.icon).toBeTruthy()
        expect(['minimal', 'normal', 'verbose']).toContain(mode.verbosity)
      }
    })

    it('Dr. Sharp mode has three-phase workflow', () => {
      const sharp = DEFAULT_MODES.find(m => m.slug === 'sharp')!
      expect(sharp.systemPrompt).toContain('Three-Phase Workflow')
      expect(sharp.systemPrompt).toContain('Phase 1: Deep Diagnosis')
      expect(sharp.systemPrompt).toContain('Phase 2: Action Strategy')
      expect(sharp.systemPrompt).toContain('Phase 3: Mirror Self')
    })
  })

  describe('getCurrentMode / setCurrentMode', () => {
    it('defaults to "default" mode', () => {
      const mode = getCurrentMode()
      expect(mode.slug).toBe('default')
    })

    it('can switch to another mode', () => {
      setCurrentMode('sharp')
      expect(getCurrentMode().slug).toBe('sharp')
      expect(getCurrentMode().name).toBe('Dr. Sharp')
    })

    it('throws on unknown mode', () => {
      expect(() => setCurrentMode('nonexistent')).toThrow(/Unknown mode/)
    })

    it('cycleMode rotates through modes', () => {
      expect(getCurrentMode().slug).toBe('default')
      const next = cycleMode()
      expect(next.slug).toBe('gentle') // second mode
      const next2 = cycleMode()
      expect(next2.slug).toBe('sharp') // third mode
    })

    it('cycleMode wraps around', () => {
      // Fast-forward to last mode
      setCurrentMode('super-ai')
      const next = cycleMode()
      expect(next.slug).toBe('default') // wraps to first
    })
  })

  describe('getAllModes', () => {
    it('returns defaults when no custom modes', () => {
      const modes = getAllModes()
      expect(modes.length).toBeGreaterThanOrEqual(6)
    })
  })

  describe('getVerbosityPrompt', () => {
    it('returns prompt for minimal', () => {
      const prompt = getVerbosityPrompt('minimal')
      expect(prompt).toContain('shortest')
    })

    it('returns prompt for verbose', () => {
      const prompt = getVerbosityPrompt('verbose')
      expect(prompt).toContain('detailed')
    })

    it('returns empty for normal', () => {
      expect(getVerbosityPrompt('normal')).toBe('')
    })
  })

  describe('Custom modes (frontmatter loading)', () => {
    it('loads custom mode from markdown file', () => {
      const modeFile = join(TEST_DIR, 'custom.md')
      writeFileSync(modeFile, `---
name: My Custom Mode
slug: my-custom
description: A test mode
verbosity: minimal
auto_approve_edits: true
---
You are a custom mode. Always be brief.`, 'utf8')

      const modes = getAllModes(TEST_DIR)
      const custom = modes.find(m => m.slug === 'my-custom')
      expect(custom).toBeDefined()
      expect(custom!.name).toBe('My Custom Mode')
      expect(custom!.verbosity).toBe('minimal')
      expect(custom!.autoApproveEdits).toBe(true)
      expect(custom!.systemPrompt).toContain('Always be brief')
    })

    it('derives slug from name when not provided', () => {
      writeFileSync(join(TEST_DIR, 'no-slug.md'), `---
name: Cool Mode
---
Be cool.`, 'utf8')

      const modes = getAllModes(TEST_DIR)
      const mode = modes.find(m => m.slug === 'cool-mode')
      expect(mode).toBeDefined()
    })

    it('custom mode overrides default with same slug', () => {
      writeFileSync(join(TEST_DIR, 'override.md'), `---
name: My Default
slug: default
---
Custom default prompt.`, 'utf8')

      const modes = getAllModes(TEST_DIR)
      const defaultMode = modes.find(m => m.slug === 'default')
      expect(defaultMode!.systemPrompt).toContain('Custom default')
      // Should only appear once
      expect(modes.filter(m => m.slug === 'default')).toHaveLength(1)
    })

    it('skips files without name', () => {
      writeFileSync(join(TEST_DIR, 'bad.md'), `---
verbosity: minimal
---
No name field.`, 'utf8')

      const modes = getAllModes(TEST_DIR)
      expect(modes.find(m => m.name === '')).toBeUndefined()
    })

    it('caches loaded modes (idempotent)', () => {
      writeFileSync(join(TEST_DIR, 'cached.md'), `---
name: Cached
slug: cached
---
Cached prompt.`, 'utf8')

      loadCustomModes(TEST_DIR)
      const result2 = loadCustomModes(TEST_DIR)
      expect(result2.filter(m => m.slug === 'cached')).toHaveLength(1)
    })

    it('handles empty modes directory gracefully', () => {
      const empty = join(TEST_DIR, 'empty')
      mkdirSync(empty, { recursive: true })
      const modes = getAllModes(empty)
      expect(modes).toEqual(DEFAULT_MODES)
    })
  })
})
