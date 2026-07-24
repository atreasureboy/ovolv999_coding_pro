/**
 * Tests for src/ui/statusLineCustom.ts
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import {
  renderStatusLine,
  loadConfig,
  saveConfig,
  DEFAULT_SEGMENTS,
  importFromPS1,
  formatSegmentList,
  formatConfig,
  type StatusLineContext,
  type StatusSegment,
} from '../src/ui/statusLineCustom.js'
import { existsSync, rmSync, mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { homedir } from 'os'

let testHome: string
let origHome: string | undefined

beforeAll(() => {
  testHome = mkdtempSync(join(tmpdir(), 'ovolv999-sl-'))
  origHome = process.env.HOME
  process.env.HOME = testHome
})

afterAll(() => {
  if (origHome !== undefined) process.env.HOME = origHome
  rmSync(testHome, { recursive: true, force: true })
})

beforeEach(() => {
  const path = join(homedir(), '.ovolv999', 'statusline.json')
  if (existsSync(path)) rmSync(path, { force: true })
})

const baseCtx: StatusLineContext = {
  cwd: '/home/user/project',
  mode: 'plan',
  model: 'claude-sonnet-4',
  gitBranch: 'main',
  gitDirty: false,
  tokenCount: 1234,
  cost: 0.234,
  messageCount: 12,
  duration: 125_000,
}

describe('statusLineCustom', () => {
  describe('DEFAULT_SEGMENTS', () => {
    it('is a non-empty array', () => {
      expect(Array.isArray(DEFAULT_SEGMENTS)).toBe(true)
      expect(DEFAULT_SEGMENTS.length).toBeGreaterThan(0)
    })

    it('every segment has a type', () => {
      for (const s of DEFAULT_SEGMENTS) {
        expect(s.type).toBeTruthy()
      }
    })
  })

  describe('renderStatusLine — defaults', () => {
    it('renders a non-empty string with default config', () => {
      const out = renderStatusLine(baseCtx)
      expect(out.length).toBeGreaterThan(0)
    })

    it('includes the mode', () => {
      const out = renderStatusLine(baseCtx)
      expect(out).toContain('plan')
    })

    it('includes the model', () => {
      const out = renderStatusLine(baseCtx)
      expect(out).toContain('claude-sonnet-4')
    })

    it('includes git branch', () => {
      const out = renderStatusLine(baseCtx)
      expect(out).toContain('main')
    })
  })

  describe('renderStatusLine — segment types', () => {
    it('renders git dirty indicator', () => {
      const out = renderStatusLine({ ...baseCtx, gitDirty: true })
      expect(out).toMatch(/main\*/)
    })

    it('renders token count', () => {
      const out = renderStatusLine({ ...baseCtx, tokenCount: 2500 })
      expect(out).toContain('2.5k') // 2500 -> 2.5k
    })

    it('renders cost', () => {
      const out = renderStatusLine(baseCtx)
      expect(out).toContain('0.234')
    })

    it('renders duration as m+s', () => {
      const out = renderStatusLine(baseCtx) // 125_000ms = 2m5s
      expect(out).toContain('2m')
    })

    it('omits git segment when no branch', () => {
      const out = renderStatusLine({ ...baseCtx, gitBranch: undefined })
      expect(out).not.toContain('main')
    })
  })

  describe('renderStatusLine — custom config', () => {
    it('renders a single segment', () => {
      const out = renderStatusLine(baseCtx, [{ type: 'mode' }])
      expect(out).toContain('plan')
    })

    it('respects priority ordering', () => {
      const out = renderStatusLine(baseCtx, [
        { type: 'mode', priority: 1 },
        { type: 'model', priority: 10 },
      ])
      // Higher priority (model=10) should come first
      const modelIdx = out.indexOf('claude')
      const modeIdx = out.indexOf('plan')
      expect(modelIdx).toBeLessThan(modeIdx)
    })

    it('respects maxWidth on segments', () => {
      const out = renderStatusLine(baseCtx, [
        { type: 'cwd', maxWidth: 5 },
      ])
      // truncate adds '...' when maxWidth > 3
      // eslint-disable-next-line no-control-regex
      const stripped = out.replace(/\x1b\[[0-9;]*m/g, '')
      expect(stripped.length).toBeLessThanOrEqual(20) // accounting for color codes stripped
    })
  })

  describe('renderStatusLine — script mode', () => {
    it('runs a shell script with env vars', () => {
      const out = renderStatusLine(baseCtx, { script: 'echo "MODE=$STATUS_MODE MODEL=$STATUS_MODEL"' })
      expect(out).toContain('MODE=plan')
      expect(out).toContain('MODEL=claude-sonnet-4')
    })

    it('returns error marker on bad script', () => {
      const out = renderStatusLine(baseCtx, { script: 'exit 1' })
      expect(out).toMatch(/error|script/i)
    })
  })

  describe('config persistence', () => {
    it('returns null when no config saved', () => {
      expect(loadConfig()).toBeNull()
    })

    it('saves and loads a config', () => {
      const cfg: StatusSegment[] = [{ type: 'mode', priority: 100 }]
      saveConfig(cfg)
      const loaded = loadConfig()
      expect(loaded).not.toBeNull()
      expect(Array.isArray(loaded)).toBe(true)
      if (Array.isArray(loaded)) {
        expect(loaded[0].type).toBe('mode')
      }
    })

    it('saves and loads script config', () => {
      saveConfig({ script: 'echo hi', refreshMs: 1000 })
      const loaded = loadConfig()
      expect(loaded).not.toBeNull()
      expect(loaded).toHaveProperty('script')
    })
  })

  describe('importFromPS1', () => {
    it('detects cwd in PS1', () => {
      const segs = importFromPS1('\\u@\\h:\\w$')
      expect(segs.some((s) => s.type === 'cwd')).toBe(true)
    })

    it('detects git in PS1', () => {
      const segs = importFromPS1('$(__git_ps1)')
      expect(segs.some((s) => s.type === 'git')).toBe(true)
    })

    it('falls back to defaults when nothing recognized', () => {
      const segs = importFromPS1('>>>')
      expect(segs.length).toBeGreaterThan(0)
    })
  })

  describe('formatSegmentList', () => {
    it('lists segments', () => {
      const out = formatSegmentList([{ type: 'mode' }, { type: 'git', color: 'green' }])
      expect(out).toContain('mode')
      expect(out).toContain('git')
      expect(out).toContain('green')
    })

    it('handles empty list', () => {
      expect(formatSegmentList([])).toContain('No segments')
    })
  })

  describe('formatConfig', () => {
    it('formats segment config', () => {
      const out = formatConfig([{ type: 'mode' }])
      expect(out.length).toBeGreaterThan(0)
    })

    it('formats script config', () => {
      const out = formatConfig({ script: 'echo hi', refreshMs: 500 })
      expect(out).toContain('echo hi')
      expect(out).toContain('500')
    })
  })
})
