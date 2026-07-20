/**
 * Skill Search — search and rank available skills
 *
 * Provides fuzzy search over loaded skills, ranking by relevance,
 * usage frequency, and recency.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'
import { loadSkills, type Skill } from '../skills/loader.js'

// ── Types ───────────────────────────────────────────────────────────────────

export interface SkillSearchResult {
  skill: Skill
  score: number
  matchedFields: string[]
}

export interface SkillUsageStats {
  skillName: string
  useCount: number
  lastUsed: string
  successRate: number
}

// ── Usage Tracking ──────────────────────────────────────────────────────────

export function getUsageStatsPath(): string {
  return join(homedir(), '.ovolv999', 'skill-usage.json')
}

export function loadUsageStats(): Map<string, SkillUsageStats> {
  const path = getUsageStatsPath()
  if (!existsSync(path)) return new Map()
  try {
    const data = JSON.parse(readFileSync(path, 'utf8')) as SkillUsageStats[]
    return new Map(data.map(s => [s.skillName, s]))
  } catch {
    return new Map()
  }
}

export function saveUsageStats(stats: Map<string, SkillUsageStats>): void {
  const path = getUsageStatsPath()
  const dir = join(path, '..')
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  writeFileSync(path, JSON.stringify(Array.from(stats.values()), null, 2))
}

export function recordSkillUsage(name: string, success: boolean): void {
  const stats = loadUsageStats()
  const existing = stats.get(name) ?? {
    skillName: name,
    useCount: 0,
    lastUsed: new Date().toISOString(),
    successRate: 1,
  }

  const oldTotal = existing.useCount
  const oldSuccessRate = existing.successRate
  const newTotal = oldTotal + 1
  const newSuccess = success ? 1 : 0

  existing.useCount = newTotal
  existing.lastUsed = new Date().toISOString()
  existing.successRate = (oldSuccessRate * oldTotal + newSuccess) / newTotal

  stats.set(name, existing)
  saveUsageStats(stats)
}

// ── Search ──────────────────────────────────────────────────────────────────

export function searchSkills(cwd: string, query: string, limit = 10): SkillSearchResult[] {
  const skills = loadSkills(cwd)
  const usageStats = loadUsageStats()
  const results: SkillSearchResult[] = []

  const queryLower = query.toLowerCase()
  const queryTerms = queryLower.split(/\s+/).filter(Boolean)

  for (const [name, skill] of skills) {
    const matchedFields: string[] = []
    let score = 0

    // Exact name match
    if (name.toLowerCase() === queryLower) {
      score += 100
      matchedFields.push('name:exact')
    } else if (name.toLowerCase().includes(queryLower)) {
      score += 50
      matchedFields.push('name:partial')
    }

    // Description match
    const descLower = (skill.description ?? '').toLowerCase()
    if (descLower.includes(queryLower)) {
      score += 30
      matchedFields.push('description')
    }

    // Term matches in description
    for (const term of queryTerms) {
      if (descLower.includes(term)) {
        score += 10
        if (!matchedFields.includes('description:terms')) {
          matchedFields.push('description:terms')
        }
      }
    }

    // Prompt content match
    const promptLower = (skill.prompt ?? '').toLowerCase()
    for (const term of queryTerms) {
      if (promptLower.includes(term)) {
        score += 5
        if (!matchedFields.includes('prompt')) {
          matchedFields.push('prompt')
        }
      }
    }

    // Tag matches (if skill has tags via tools array)
    const tags = skill.tools ?? []
    for (const tag of tags) {
      if (tag.toLowerCase().includes(queryLower)) {
        score += 20
        matchedFields.push('tag')
      }
    }

    // Boost by usage
    const usage = usageStats.get(name)
    if (usage) {
      score += Math.min(usage.useCount * 2, 20)
      // Boost by success rate
      score += Math.round(usage.successRate * 10)
    }

    if (score > 0) {
      results.push({ skill, score, matchedFields })
    }
  }

  return results
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
}

export function getRecommendedSkills(cwd: string, limit = 5): SkillSearchResult[] {
  const skills = loadSkills(cwd)
  const usageStats = loadUsageStats()
  const results: SkillSearchResult[] = []

  for (const [name, skill] of skills) {
    const usage = usageStats.get(name)
    let score = 0

    if (usage) {
      score = usage.useCount * usage.successRate
    }

    results.push({ skill, score, matchedFields: [] })
  }

  return results
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
}

export function getSimilarSkills(cwd: string, skillName: string, limit = 5): SkillSearchResult[] {
  const skills = loadSkills(cwd)
  const target = skills.get(skillName)
  if (!target) return []

  const targetDesc = (target.description ?? '').toLowerCase()
  const targetTerms = new Set(targetDesc.split(/\s+/).filter(w => w.length > 3))

  const results: SkillSearchResult[] = []
  for (const [name, skill] of skills) {
    if (name === skillName) continue

    const desc = (skill.description ?? '').toLowerCase()
    const descTerms = new Set(desc.split(/\s+/).filter(w => w.length > 3))

    // Jaccard similarity
    const intersection = new Set([...targetTerms].filter(t => descTerms.has(t)))
    const union = new Set([...targetTerms, ...descTerms])
    const similarity = union.size > 0 ? intersection.size / union.size : 0

    if (similarity > 0) {
      results.push({
        skill,
        score: Math.round(similarity * 100),
        matchedFields: ['similarity'],
      })
    }
  }

  return results
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
}

// ── Formatting ──────────────────────────────────────────────────────────────

export function formatSearchResults(results: SkillSearchResult[]): string {
  if (results.length === 0) return 'No matching skills found.'
  const lines: string[] = [`Found ${results.length} skill(s):`]
  for (const { skill, score, matchedFields } of results) {
    const fields = matchedFields.length > 0 ? ` [${matchedFields.join(', ')}]` : ''
    const desc = skill.description ? ` — ${skill.description.slice(0, 60)}` : ''
    lines.push(`  ${skill.name}${desc}${fields} (score: ${score})`)
  }
  return lines.join('\n')
}

export function formatRecommendations(results: SkillSearchResult[]): string {
  if (results.length === 0) return 'No skills available.'
  const lines: string[] = [`Recommended skills:`]
  for (const { skill, score } of results) {
    if (score === 0) continue
    const desc = skill.description ? ` — ${skill.description.slice(0, 60)}` : ''
    lines.push(`  ${skill.name}${desc} (uses: ${score})`)
  }
  return lines.join('\n')
}
