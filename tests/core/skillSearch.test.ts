import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { searchSkills, getRecommendedSkills, getSimilarSkills, formatSearchResults, recordSkillUsage } from '../../src/core/skillSearch.js'

function writeSkill(cwd: string, name: string, body: string) {
  const skillsDir = join(cwd, '.ovogo', 'skills')
  mkdirSync(skillsDir, { recursive: true })
  writeFileSync(join(skillsDir, `${name}.md`), body)
}

describe('searchSkills (TF-IDF)', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'skillsearch-'))
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('returns empty array for empty query', () => {
    expect(searchSkills(dir, '')).toEqual([])
    expect(searchSkills(dir, '   ')).toEqual([])
  })

  it('ranks name matches highest', () => {
    writeSkill(dir, 'commit', `---
name: commit
description: make a git commit
---
Run git commit after staging.`)
    writeSkill(dir, 'review', `---
name: review
description: review code changes
---
Look at the diff.`)
    const results = searchSkills(dir, 'commit')
    expect(results.length).toBeGreaterThan(0)
    expect(results[0]?.skill.name).toBe('commit')
  })

  it('finds by description keyword', () => {
    writeSkill(dir, 'foo', `---
name: foo
description: translation between languages
---
Body.`)
    const results = searchSkills(dir, 'translation')
    expect(results.length).toBeGreaterThan(0)
    expect(results[0]?.skill.name).toBe('foo')
  })

  it('honors usage-based boost', () => {
    writeSkill(dir, 'foo', `---
name: foo
description: translation
---
Body.`)
    writeSkill(dir, 'bar', `---
name: bar
description: translation
---
Body.`)
    recordSkillUsage('foo', true)
    recordSkillUsage('foo', true)
    const results = searchSkills(dir, 'translation')
    const fooResult = results.find(r => r.skill.name === 'foo')
    const barResult = results.find(r => r.skill.name === 'bar')
    expect(fooResult).toBeDefined()
    expect(barResult).toBeDefined()
    expect(fooResult!.score).toBeGreaterThan(barResult!.score)
  })

  it('handles CJK queries via bigram fallback', () => {
    writeSkill(dir, 'foo', `---
name: foo
description: 中文翻译工具翻译文档
---
This skill translates Chinese text.`)
    const results = searchSkills(dir, '翻译')
    expect(results.length).toBeGreaterThan(0)
    expect(results[0]?.skill.name).toBe('foo')
  })
})

describe('getRecommendedSkills', () => {
  it('returns skills sorted by usage score', () => {
    const dir = mkdtempSync(join(tmpdir(), 'rec-'))
    writeSkill(dir, 'foo', `---
name: foo
description: foo
---
Body.`)
    recordSkillUsage('foo', true)
    recordSkillUsage('foo', true)
    const results = getRecommendedSkills(dir)
    expect(results.length).toBeGreaterThan(0)
    expect(results[0]?.skill.name).toBe('foo')
  })
})

describe('getSimilarSkills', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'similar-'))
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('returns empty for unknown skill', () => {
    expect(getSimilarSkills(dir, 'nonexistent')).toEqual([])
  })
})

describe('formatSearchResults', () => {
  it('renders matches', () => {
    const out = formatSearchResults([
      {
        skill: { name: 'foo', description: 'bar', prompt: 'p', source: 'builtin' },
        score: 0.42,
        matchedFields: ['name'],
      },
    ])
    expect(out).toContain('foo')
    expect(out).toContain('0.42')
  })

  it('returns empty placeholder when no matches', () => {
    expect(formatSearchResults([])).toContain('No matching skills found')
  })
})
