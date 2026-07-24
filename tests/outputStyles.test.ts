import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  BUILT_IN_STYLES,
  loadOutputStyles,
  validateStyle,
  getActiveStyle,
  setActiveStyle,
  getStyleById,
  listStyleIds,
  getDirective,
} from '../src/core/outputStyles.js'

describe('BUILT_IN_STYLES', () => {
  it('has default style', () => {
    expect(BUILT_IN_STYLES.find(s => s.id === 'default')).toBeDefined()
  })

  it('all built-ins have unique IDs', () => {
    const ids = BUILT_IN_STYLES.map(s => s.id)
    const unique = new Set(ids)
    expect(unique.size).toBe(ids.length)
  })

  it('all built-ins have required fields', () => {
    for (const s of BUILT_IN_STYLES) {
      expect(s.id).toBeTruthy()
      expect(s.name).toBeTruthy()
      expect(typeof s.directive).toBe('string')
    }
  })

  it('default style has empty directive', () => {
    const def = BUILT_IN_STYLES.find(s => s.id === 'default')!
    expect(def.directive).toBe('')
  })

  it('includes common styles', () => {
    const ids = BUILT_IN_STYLES.map(s => s.id)
    expect(ids).toContain('concise')
    expect(ids).toContain('verbose')
    expect(ids).toContain('structured')
    expect(ids).toContain('socratic')
    expect(ids).toContain('code-focused')
  })
})

describe('validateStyle', () => {
  it('validates a complete style', () => {
    const style = validateStyle({
      id: 'test', name: 'Test', description: 'desc', directive: 'be testy',
    })
    expect(style).not.toBeNull()
    expect(style!.id).toBe('test')
  })

  it('works without description', () => {
    const style = validateStyle({
      id: 'test', name: 'Test', directive: 'be testy',
    })
    expect(style).not.toBeNull()
    expect(style!.description).toBe('')
  })

  it('rejects missing id', () => {
    expect(validateStyle({ name: 'Test', directive: 'x' })).toBeNull()
  })

  it('rejects empty id', () => {
    expect(validateStyle({ id: '', name: 'Test', directive: 'x' })).toBeNull()
  })

  it('rejects missing name', () => {
    expect(validateStyle({ id: 'x', directive: 'y' })).toBeNull()
  })

  it('rejects missing directive', () => {
    expect(validateStyle({ id: 'x', name: 'X' })).toBeNull()
  })

  it('rejects non-objects', () => {
    expect(validateStyle(null)).toBeNull()
    expect(validateStyle('string')).toBeNull()
    expect(validateStyle(42)).toBeNull()
  })
})

describe('loadOutputStyles', () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'style-'))
  })

  afterEach(() => {
    try { rmSync(dir, { recursive: true, force: true }) } catch { /* best-effort */ }
  })

  it('returns defaults with no config', () => {
    const result = loadOutputStyles(dir)
    expect(result.hasConfig).toBe(false)
    expect(result.errors).toHaveLength(0)
    expect(result.active.id).toBe('default')
    expect(result.styles.length).toBeGreaterThanOrEqual(BUILT_IN_STYLES.length)
  })

  it('loads active style from config', () => {
    mkdirSync(join(dir, '.ovolv999'), { recursive: true })
    writeFileSync(
      join(dir, '.ovolv999', 'output-style.json'),
      JSON.stringify({ active: 'concise' }),
    )
    const result = loadOutputStyles(dir)
    expect(result.hasConfig).toBe(true)
    expect(result.active.id).toBe('concise')
  })

  it('loads custom styles', () => {
    mkdirSync(join(dir, '.ovolv999'), { recursive: true })
    writeFileSync(
      join(dir, '.ovolv999', 'output-style.json'),
      JSON.stringify({
        active: 'default',
        custom: [{
          id: 'custom-style',
          name: 'Custom',
          description: 'my style',
          directive: 'be custom',
        }],
      }),
    )
    const result = loadOutputStyles(dir)
    expect(result.styles.find(s => s.id === 'custom-style')).toBeDefined()
  })

  it('custom style overrides built-in with same id', () => {
    mkdirSync(join(dir, '.ovolv999'), { recursive: true })
    writeFileSync(
      join(dir, '.ovolv999', 'output-style.json'),
      JSON.stringify({
        active: 'concise',
        custom: [{
          id: 'concise',
          name: 'My Concise',
          description: 'override',
          directive: 'be brief',
        }],
      }),
    )
    const result = loadOutputStyles(dir)
    const concise = result.styles.find(s => s.id === 'concise')
    expect(concise!.name).toBe('My Concise')
    expect(concise!.directive).toBe('be brief')
  })

  it('reports errors for invalid custom styles', () => {
    mkdirSync(join(dir, '.ovolv999'), { recursive: true })
    writeFileSync(
      join(dir, '.ovolv999', 'output-style.json'),
      JSON.stringify({
        active: 'default',
        custom: [{ id: '', name: 'Bad' }],
      }),
    )
    const result = loadOutputStyles(dir)
    expect(result.errors.length).toBeGreaterThan(0)
  })

  it('falls back to default for unknown active', () => {
    mkdirSync(join(dir, '.ovolv999'), { recursive: true })
    writeFileSync(
      join(dir, '.ovolv999', 'output-style.json'),
      JSON.stringify({ active: 'nonexistent' }),
    )
    const result = loadOutputStyles(dir)
    expect(result.active.id).toBe('default')
  })

  it('handles invalid JSON', () => {
    mkdirSync(join(dir, '.ovolv999'), { recursive: true })
    writeFileSync(join(dir, '.ovolv999', 'output-style.json'), '{invalid')
    const result = loadOutputStyles(dir)
    expect(result.errors.length).toBeGreaterThan(0)
    expect(result.active.id).toBe('default')
  })
})

describe('setActiveStyle', () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'style-set-'))
  })

  afterEach(() => {
    try { rmSync(dir, { recursive: true, force: true }) } catch { /* best-effort */ }
  })

  it('sets a valid style', () => {
    const result = setActiveStyle(dir, 'concise')
    expect(result.success).toBe(true)
    expect(getActiveStyle(dir).id).toBe('concise')
  })

  it('rejects unknown style', () => {
    const result = setActiveStyle(dir, 'nonexistent')
    expect(result.success).toBe(false)
    expect(result.error).toContain('Unknown style')
  })

  it('persists to config file', () => {
    setActiveStyle(dir, 'verbose')
    const configPath = join(dir, '.ovolv999', 'output-style.json')
    const raw = readFileSync(configPath, 'utf8')
    const parsed = JSON.parse(raw)
    expect(parsed.active).toBe('verbose')
  })

  it('can set custom style after loading config', () => {
    mkdirSync(join(dir, '.ovolv999'), { recursive: true })
    writeFileSync(
      join(dir, '.ovolv999', 'output-style.json'),
      JSON.stringify({
        active: 'default',
        custom: [{ id: 'mine', name: 'Mine', directive: 'x' }],
      }),
    )
    const result = setActiveStyle(dir, 'mine')
    expect(result.success).toBe(true)
  })

  it('preserves custom styles when changing active', () => {
    mkdirSync(join(dir, '.ovolv999'), { recursive: true })
    writeFileSync(
      join(dir, '.ovolv999', 'output-style.json'),
      JSON.stringify({
        active: 'default',
        custom: [{ id: 'mine', name: 'Mine', directive: 'x' }],
      }),
    )
    setActiveStyle(dir, 'concise')
    const result = loadOutputStyles(dir)
    expect(result.styles.find(s => s.id === 'mine')).toBeDefined()
    expect(result.active.id).toBe('concise')
  })
})

describe('getActiveStyle', () => {
  it('returns default with no config', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ga-'))
    try {
      expect(getActiveStyle(dir).id).toBe('default')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('getDirective', () => {
  it('returns empty string for default', () => {
    const dir = mkdtempSync(join(tmpdir(), 'gd-'))
    try {
      expect(getDirective(dir)).toBe('')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('returns directive for concise', () => {
    const dir = mkdtempSync(join(tmpdir(), 'gd2-'))
    try {
      setActiveStyle(dir, 'concise')
      const directive = getDirective(dir)
      expect(directive).toContain('concise')
      expect(directive.length).toBeGreaterThan(10)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('getStyleById', () => {
  it('returns built-in style', () => {
    expect(getStyleById('concise')).not.toBeNull()
    expect(getStyleById('verbose')).not.toBeNull()
  })

  it('returns null for unknown', () => {
    expect(getStyleById('nonexistent')).toBeNull()
  })
})

describe('listStyleIds', () => {
  it('returns all built-in IDs', () => {
    const ids = listStyleIds()
    expect(ids).toContain('default')
    expect(ids).toContain('concise')
    expect(ids).toContain('verbose')
    expect(ids.length).toBeGreaterThanOrEqual(5)
  })
})
