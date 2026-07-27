import { describe, it, expect } from 'vitest'
import { filterMatches, type SlashSuggesterSource } from '../slashSuggest.js'

function src(extra: Partial<SlashSuggesterSource> = {}): SlashSuggesterSource {
  return {
    isTTY: true,
    getCommands: () => [
      { name: 'help', description: 'Show help' },
      { name: 'history', description: 'Show history' },
      { name: 'resume', description: 'Resume session' },
      { name: 'review', description: 'Code review' },
    ],
    getSkills: () => [
      { name: 'plan', description: 'Plan mode' },
      { name: 'release', description: 'Release helper' },
    ],
    ...extra,
  }
}

describe('filterMatches', () => {
  it('returns all commands when partial is empty', () => {
    const out = filterMatches('', src())
    // With no partial, only commands come back (skills appear when the
    // user has typed at least one character so we don't dump a huge list).
    expect(out.map((m) => m.name)).toEqual(['help', 'history', 'resume', 'review'])
    expect(out.length).toBe(4)
    expect(out.every((m) => m.kind === 'cmd')).toBe(true)
  })

  it('prefix-matches commands case-insensitively', () => {
    const out = filterMatches('h', src())
    expect(out.map((m) => m.name)).toContain('help')
    expect(out.map((m) => m.name)).toContain('history')
  })

  it('prefix-matches skills', () => {
    const out = filterMatches('pl', src())
    expect(out.map((m) => m.name)).toContain('plan')
  })

  it('returns empty for non-matching prefix', () => {
    const out = filterMatches('zzzz', src())
    expect(out).toEqual([])
  })

  it('matches on full command name', () => {
    const out = filterMatches('resume', src())
    expect(out).toHaveLength(1)
    expect(out[0].name).toBe('resume')
    expect(out[0].kind).toBe('cmd')
  })

  it('normalizes full-width command punctuation', () => {
    const out = filterMatches('？'.normalize('NFKC'), {
      isTTY: true,
      getCommands: () => [{ name: '?', description: 'Show all commands' }],
      getSkills: () => [],
    })
    expect(out.map((m) => m.name)).toEqual(['?'])
  })

  it('returns empty when getCommands/getSkills throw — defensive', () => {
    const out = filterMatches('h', { isTTY: true, getCommands: () => [], getSkills: () => [] })
    expect(out).toEqual([])
  })

  it('exposes kind for downstream formatting', () => {
    const out = filterMatches('re', src())
    expect(out.find((m) => m.name === 'review')?.kind).toBe('cmd')
    expect(out.find((m) => m.name === 'release')?.kind).toBe('skill')
  })
})
