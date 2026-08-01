import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { loadHookConfig, matcherMatches, matchersForEvent } from '../../../src/core/hooks/hooksConfig.js'

describe('loadHookConfig', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'hooks-cfg-'))
    mkdirSync(join(dir, '.ovogo'), { recursive: true })
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('returns null when no settings files exist', () => {
    expect(loadHookConfig(dir)).toBeNull()
  })

  it('returns null when files exist but have no hooks block', () => {
    writeFileSync(join(dir, '.ovogo', 'settings.json'), JSON.stringify({ theme: 'dark' }))
    expect(loadHookConfig(dir)).toBeNull()
  })

  it('parses PreToolUse matchers from project settings', () => {
    writeFileSync(join(dir, '.ovogo', 'settings.json'), JSON.stringify({
      hooks: {
        PreToolUse: [
          {
            matcher: 'Bash',
            hooks: [{ type: 'command', command: '/bin/true' }],
          },
        ],
      },
    }))
    const cfg = loadHookConfig(dir)
    expect(cfg?.PreToolUse).toHaveLength(1)
    expect(cfg?.PreToolUse?.[0]?.hooks[0]?.command).toBe('/bin/true')
  })

  it('skips invalid entries silently', () => {
    writeFileSync(join(dir, '.ovogo', 'settings.json'), JSON.stringify({
      hooks: {
        PreToolUse: [
          { hooks: [{ type: 'command', command: '/bin/true' }] },
          { matcher: 123, hooks: [] },
          { matcher: 'X', hooks: [{ type: 'wrong' }] },
        ],
      },
    }))
    const cfg = loadHookConfig(dir)
    expect(cfg?.PreToolUse?.[0]?.matcher).toBeUndefined()
  })

  it('returns null on malformed JSON', () => {
    writeFileSync(join(dir, '.ovogo', 'settings.json'), '{ bad json')
    expect(loadHookConfig(dir)).toBeNull()
  })
})

describe('matcherMatches', () => {
  it('returns true when matcher is undefined (default match)', () => {
    expect(matcherMatches(undefined, 'Bash')).toBe(true)
  })

  it('returns true on exact match', () => {
    expect(matcherMatches('Bash', 'Bash')).toBe(true)
  })

  it('returns true on wildcard', () => {
    expect(matcherMatches('*', 'Anything')).toBe(true)
  })

  it('supports regex matchers wrapped in / /', () => {
    expect(matcherMatches('/^Bash$/', 'Bash')).toBe(true)
    expect(matcherMatches('/^Bash$/', 'Read')).toBe(false)
  })

  it('returns false on invalid regex', () => {
    expect(matcherMatches('/[/', 'x')).toBe(false)
  })
})

describe('matchersForEvent', () => {
  it('returns empty array when no matchers configured', () => {
    expect(matchersForEvent({}, 'PreToolUse', 'Bash')).toEqual([])
  })

  it('filters by matcher', () => {
    const cfg = {
      PreToolUse: [
        { matcher: 'Bash', hooks: [{ type: 'command' as const, command: 'a' }] },
        { matcher: 'Read', hooks: [{ type: 'command' as const, command: 'b' }] },
        { hooks: [{ type: 'command' as const, command: 'c' }] },
      ],
    }
    const result = matchersForEvent(cfg, 'PreToolUse', 'Bash')
    expect(result).toHaveLength(2)
    expect(result.map((m) => m.hooks[0]?.command)).toEqual(['a', 'c'])
  })
})

describe('file existence sanity', () => {
  it('tmp dir exists for afterEach cleanup', () => {
    expect(existsSync(tmpdir())).toBe(true)
  })
})
