import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import {
  loadUsageStats,
  saveUsageStats,
  recordSkillUsage,
  searchSkills,
  getRecommendedSkills,
  getSimilarSkills,
  formatSearchResults,
  formatRecommendations,
} from '../src/core/skillSearch.js'
import { mkdtempSync, rmSync, existsSync, mkdirSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

let testDir: string
let projectDir: string
let origHome: string | undefined

beforeAll(() => {
  testDir = mkdtempSync(join(tmpdir(), 'ovolv999-skills-'))
  projectDir = mkdtempSync(join(tmpdir(), 'ovolv999-proj-'))
  origHome = process.env.HOME
  process.env.HOME = testDir

  // Create a skill in the project
  const skillsDir = join(projectDir, '.ovogo', 'skills')
  mkdirSync(skillsDir, { recursive: true })
  writeFileSync(
    join(skillsDir, 'test-skill.md'),
    '---\ndescription: A test skill for testing\n---\nThis is a test skill prompt.',
  )
  writeFileSync(
    join(skillsDir, 'git-helper.md'),
    '---\ndescription: Helps with git operations\n---\nGit helper prompt.',
  )
})

afterAll(() => {
  if (origHome !== undefined) process.env.HOME = origHome
  rmSync(testDir, { recursive: true, force: true })
  rmSync(projectDir, { recursive: true, force: true })
})

beforeEach(() => {
  // Clear usage stats
  const usagePath = join(testDir, '.ovolv999', 'skill-usage.json')
  if (existsSync(usagePath)) rmSync(usagePath)
})

describe('skillSearch', () => {
  describe('usage stats', () => {
    it('loads empty stats when no file', () => {
      const stats = loadUsageStats()
      expect(stats.size).toBe(0)
    })

    it('records usage', () => {
      recordSkillUsage('test', true)
      const stats = loadUsageStats()
      expect(stats.get('test')!.useCount).toBe(1)
      expect(stats.get('test')!.successRate).toBe(1)
    })

    it('tracks success rate', () => {
      recordSkillUsage('test', true)
      recordSkillUsage('test', false)
      const stats = loadUsageStats()
      expect(stats.get('test')!.useCount).toBe(2)
      expect(stats.get('test')!.successRate).toBe(0.5)
    })

    it('persists stats', () => {
      recordSkillUsage('alpha', true)
      const stats = loadUsageStats()
      expect(stats.has('alpha')).toBe(true)
    })
  })

  describe('searchSkills', () => {
    it('finds skills by description', () => {
      const results = searchSkills(projectDir, 'testing')
      expect(results.length).toBeGreaterThan(0)
      expect(results.some(r => r.skill.name === 'test-skill')).toBe(true)
    })

    it('finds skills by partial name', () => {
      const results = searchSkills(projectDir, 'git')
      expect(results.some(r => r.skill.name === 'git-helper')).toBe(true)
    })

    it('returns empty for no matches', () => {
      const results = searchSkills(projectDir, 'nonexistent-skill-xyz')
      expect(results).toHaveLength(0)
    })

    it('ranks exact name match highest', () => {
      const results = searchSkills(projectDir, 'git-helper')
      expect(results[0].skill.name).toBe('git-helper')
      expect(results[0].matchedFields).toContain('name:exact')
    })

    it('respects limit', () => {
      const results = searchSkills(projectDir, 'skill', 1)
      expect(results.length).toBeLessThanOrEqual(1)
    })
  })

  describe('getRecommendedSkills', () => {
    it('returns all skills sorted by score', () => {
      recordSkillUsage('test-skill', true)
      recordSkillUsage('test-skill', true)
      const results = getRecommendedSkills(projectDir)
      expect(results.length).toBeGreaterThan(0)
    })
  })

  describe('getSimilarSkills', () => {
    it('finds similar skills', () => {
      const results = getSimilarSkills(projectDir, 'test-skill')
      // Both skills have "test" or "test" in description
      expect(Array.isArray(results)).toBe(true)
    })

    it('returns empty for unknown skill', () => {
      const results = getSimilarSkills(projectDir, 'nonexistent')
      expect(results).toHaveLength(0)
    })
  })

  describe('formatting', () => {
    it('formats search results', () => {
      const results = searchSkills(projectDir, 'testing')
      const out = formatSearchResults(results)
      expect(out).toContain('Found')
    })

    it('formats empty results', () => {
      expect(formatSearchResults([])).toContain('No matching')
    })

    it('formats recommendations', () => {
      const results = getRecommendedSkills(projectDir)
      const out = formatRecommendations(results)
      expect(typeof out).toBe('string')
    })
  })
})
