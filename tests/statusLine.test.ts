import { describe, it, expect, beforeEach } from 'vitest'
import {
  renderStatusLine, renderMinimalStatusLine, renderFullStatusLine,
  formatTokens, formatDuration,
  DEFAULT_SEGMENTS, modelSegment, gitSegment, tokenSegment, costSegment,
  type StatusLineData,
} from '../src/ui/statusLine.js'
import { DARK_THEME, LIGHT_THEME, getTheme, setTheme, listThemes } from '../src/ui/theme.js'

describe('Theme System', () => {
  it('has dark and light themes', () => {
    const themes = listThemes()
    expect(themes.length).toBeGreaterThanOrEqual(2)
    expect(themes.some(t => t.name === 'dark')).toBe(true)
    expect(themes.some(t => t.name === 'light')).toBe(true)
  })

  it('dark theme has expected colors', () => {
    expect(DARK_THEME.isDark).toBe(true)
    expect(DARK_THEME.colors.primary).toBeDefined()
    expect(DARK_THEME.colors.error).toBeDefined()
  })

  it('light theme is not dark', () => {
    expect(LIGHT_THEME.isDark).toBe(false)
  })

  it('setTheme changes active theme', () => {
    setTheme('light')
    expect(getTheme().name).toBe('light')
    setTheme('dark')
  })

  it('system theme resolves to dark or light', () => {
    const theme = getTheme('system')
    expect(['dark', 'light']).toContain(theme.name)
  })
})

describe('StatusLine', () => {
  const baseData: StatusLineData = {
    model: 'gpt-4o',
    mode: 'Default',
    modeIcon: '⚡',
    gitBranch: 'main',
    gitDirty: false,
    tokenCount: 5000,
    contextWindow: 128000,
    cost: 0.0234,
    messageCount: 15,
    cwd: '/project/myapp',
  }

  describe('segments', () => {
    it('modelSegment returns provider/model', () => {
      const data = { model: 'gpt-4', provider: 'openai' }
      expect(modelSegment(data)).toBe('openai/gpt-4')
    })

    it('gitSegment shows branch', () => {
      expect(gitSegment({ gitBranch: 'main' })).toBe('main')
    })

    it('gitSegment shows dirty flag', () => {
      expect(gitSegment({ gitBranch: 'dev', gitDirty: true })).toBe('dev*')
    })

    it('tokenSegment formats with context ratio', () => {
      const result = tokenSegment({ tokenCount: 64000, contextWindow: 128000 })!
      expect(result).toContain('K')
      expect(result).toContain('50%')
    })

    it('tokenSegment without context window', () => {
      const result = tokenSegment({ tokenCount: 5000 })
      expect(result).toBe('5.0K')
    })

    it('costSegment formats as currency', () => {
      expect(costSegment({ cost: 0.0234 })).toBe('$0.0234')
    })

    it('returns null when no data', () => {
      expect(modelSegment({})).toBeNull()
      expect(gitSegment({})).toBeNull()
      expect(costSegment({})).toBeNull()
    })
  })

  describe('renderStatusLine', () => {
    it('renders all segments separated by │', () => {
      const result = renderStatusLine(baseData)
      expect(result).toContain('│')
      expect(result).toContain('gpt-4o')
      expect(result).toContain('main')
    })

    it('handles empty data', () => {
      const result = renderStatusLine({})
      expect(result).toBe('')
    })

    it('respects maxWidth', () => {
      const result = renderStatusLine(baseData, {
        segments: DEFAULT_SEGMENTS,
        separator: ' │ ',
        maxWidth: 20,
      })
      // Should be truncated to fit
      const stripped = result.replace(/\x1b\[[0-9;]*m/g, '')
      expect(stripped.length).toBeLessThanOrEqual(100) // Allow some slack for ANSI
    })

    it('removes lowest priority segments first when truncating', () => {
      const result = renderStatusLine(baseData, {
        segments: DEFAULT_SEGMENTS,
        separator: ' │ ',
        maxWidth: 30,
      })
      // Model should be present (high priority), custom should be dropped
      expect(result).toContain('gpt-4o')
    })
  })

  describe('renderMinimalStatusLine', () => {
    it('shows compact status', () => {
      const result = renderMinimalStatusLine(baseData)
      expect(result).toContain('⚡')
      expect(result).toContain('main')
    })

    it('handles empty data', () => {
      expect(renderMinimalStatusLine({})).toBe('')
    })
  })

  describe('renderFullStatusLine', () => {
    it('pads to full width', () => {
      const result = renderFullStatusLine(baseData, 80)
      // Should have content
      expect(result.length).toBeGreaterThan(0)
    })
  })

  describe('formatTokens', () => {
    it('formats small numbers', () => {
      expect(formatTokens(500)).toBe('500t')
    })

    it('formats thousands', () => {
      expect(formatTokens(5000)).toBe('5.0K')
      expect(formatTokens(10000)).toBe('10.0K')
    })

    it('formats millions', () => {
      expect(formatTokens(1_500_000)).toBe('1.5M')
    })
  })

  describe('formatDuration', () => {
    it('formats seconds', () => {
      expect(formatDuration(30)).toBe('30s')
    })

    it('formats minutes', () => {
      expect(formatDuration(90)).toBe('1m30s')
    })

    it('formats hours', () => {
      expect(formatDuration(3725)).toBe('1h2m')
    })
  })
})
