import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { loadMarketplaceSkills, getMarketplaceSkillsDir } from '../../src/skills/marketplace.js'
import { parseMarketplaceSkillFile } from '../../src/skills/marketplaceParser.js'

describe('parseMarketplaceSkillFile', () => {
  it('parses frontmatter name + description', () => {
    const raw = `---
name: code-review
description: Review code for quality
---
Body content here.`
    const skill = parseMarketplaceSkillFile(raw, 'fallback')
    expect(skill).not.toBeNull()
    expect(skill?.name).toBe('code-review')
    expect(skill?.description).toBe('Review code for quality')
    expect(skill?.prompt).toBe('Body content here.')
  })

  it('falls back to dir name when name missing', () => {
    const raw = `Some prompt without frontmatter`
    const skill = parseMarketplaceSkillFile(raw, 'fallback-name')
    expect(skill?.name).toBe('fallback-name')
    expect(skill?.prompt).toBe('Some prompt without frontmatter')
  })

  it('returns null for empty input', () => {
    expect(parseMarketplaceSkillFile('', 'x')).toBeNull()
    expect(parseMarketplaceSkillFile('   ', 'x')).toBeNull()
  })

  it('source is always global for marketplace', () => {
    const skill = parseMarketplaceSkillFile('---\nname: a\n---\nbody', 'a')
    expect(skill?.source).toBe('global')
  })
})

describe('loadMarketplaceSkills', () => {
  let realHome: string | undefined
  let mpDir: string
  beforeEach(() => {
    realHome = process.env.HOME
    const home = mkdtempSync(join(tmpdir(), 'mp-home-'))
    process.env.HOME = home
    mpDir = join(home, '.ovolv999', 'skills', 'marketplace')
  })
  afterEach(() => {
    process.env.HOME = realHome
    rmSync(mpDir.replace('/marketplace', ''), { recursive: true, force: true })
  })

  it('returns empty map when marketplace dir absent', () => {
    expect(loadMarketplaceSkills().size).toBe(0)
  })

  it('returns empty map for empty dir', () => {
    mkdirSync(mpDir, { recursive: true })
    expect(loadMarketplaceSkills().size).toBe(0)
  })

  it('loads SKILL.md files from subdirs', () => {
    mkdirSync(join(mpDir, 'code-review'), { recursive: true })
    writeFileSync(join(mpDir, 'code-review', 'SKILL.md'), `---
name: code-review
description: Review code
---
Run review.`)
    mkdirSync(join(mpDir, 'refactor'), { recursive: true })
    writeFileSync(join(mpDir, 'refactor', 'SKILL.md'), `---
name: refactor
description: Refactor code
---
Run refactor.`)
    const skills = loadMarketplaceSkills()
    expect(skills.size).toBe(2)
    expect(skills.has('code-review')).toBe(true)
    expect(skills.has('refactor')).toBe(true)
  })

  it('skips subdirs without SKILL.md', () => {
    mkdirSync(join(mpDir, 'broken'), { recursive: true })
    writeFileSync(join(mpDir, 'broken', 'README.md'), 'not a skill')
    const skills = loadMarketplaceSkills()
    expect(skills.size).toBe(0)
  })

  it('skips malformed SKILL.md without throwing', () => {
    mkdirSync(join(mpDir, 'corrupt'), { recursive: true })
    writeFileSync(join(mpDir, 'corrupt', 'SKILL.md'), '{ broken')
    expect(() => loadMarketplaceSkills()).not.toThrow()
  })
})

describe('getMarketplaceSkillsDir', () => {
  it('returns a path under home', () => {
    const p = getMarketplaceSkillsDir()
    expect(p).toContain('.ovolv999')
    expect(p).toContain('marketplace')
    expect(p.startsWith(homedir())).toBe(true)
  })
})
