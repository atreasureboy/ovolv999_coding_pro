/**
 * Skill Search — search and rank available skills
 *
 * Provides fuzzy search over loaded skills, ranking by relevance,
 * usage frequency, and recency.
 *
 * Phase 1.6: searchSkills now uses TF-IDF (cosine similarity over
 * weighted term vectors) on top of core/localSearch, replacing the
 * previous simple term-frequency heuristic. The SkillSearchResult
 * interface is unchanged for back-compat with consumers.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'
import { loadSkills, type Skill } from '../skills/loader.js'
import {
  computeIdf,
  computeWeightedTf,
  cosineSimilarity,
  tokenizeAndStem,
  applyCjkFilter,
  buildQueryTfIdf,
  getQueryTokenSeparators,
  normalizeName,
  splitHyphenatedName,
  type WeightedTfField,
} from './localSearch.js'

const SKILL_FIELD_WEIGHT = {
  name: 3.0,
  whenToUse: 2.0,
  description: 1.0,
  allowedTools: 0.3,
} as const

const NAME_MATCH_MIN_LENGTH = 4
const DISPLAY_MIN_SCORE = 0.10

interface SkillIndexEntry {
  skill: Skill
  normalizedName: string
  matchedFields: string[]
  tfVector: Map<string, number>
  tokens: string[]
  nameTokens: string[]
  descriptionTokens: string[]
  toolsTokens: string[]
}

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

function buildSkillIndex(skills: Map<string, Skill>): SkillIndexEntry[] {
  const entries: SkillIndexEntry[] = []
  for (const [name, skill] of skills) {
    const description = skill.description ?? ''
    const allowedTools = (skill.tools ?? []).join(' ')
    const normalizedName = normalizeName(name)
    const nameTokens = tokenizeAndStem(name)
    const nameParts = splitHyphenatedName(name).map(s => s).filter(t => t.length >= 3)
    const nameWithParts = [...nameTokens, ...nameParts]
    const descriptionTokens = tokenizeAndStem(description)
    const toolsTokens = tokenizeAndStem(allowedTools)
    const promptTokens = tokenizeAndStem(skill.prompt ?? '')
    const allTokens = Array.from(new Set([
      ...nameWithParts,
      ...descriptionTokens,
      ...toolsTokens,
      ...promptTokens,
    ]))

    const fields: WeightedTfField[] = [
      { tokens: nameWithParts, weight: SKILL_FIELD_WEIGHT.name },
      { tokens: descriptionTokens, weight: SKILL_FIELD_WEIGHT.description },
      { tokens: toolsTokens, weight: SKILL_FIELD_WEIGHT.allowedTools },
    ]

    const tfVector = computeWeightedTf(fields)
    entries.push({
      skill,
      normalizedName,
      matchedFields: [],
      tfVector,
      tokens: allTokens,
      nameTokens: nameWithParts,
      descriptionTokens,
      toolsTokens,
    })
  }

  const idf = computeIdf(entries)
  for (const entry of entries) {
    for (const [term, tf] of entry.tfVector) {
      entry.tfVector.set(term, tf * (idf.get(term) ?? 0))
    }
  }
  return entries
}

export function searchSkills(cwd: string, query: string, limit = 10): SkillSearchResult[] {
  if (!query?.trim()) return []
  const skills = loadSkills(cwd)
  const usageStats = loadUsageStats()
  const index = buildSkillIndex(skills)
  if (index.length === 0) return []

  const idf = computeIdf(index)
  const { tfIdf: queryTfIdf, tokens: queryTokens } = buildQueryTfIdf(query, idf)
  if (queryTokens.length === 0) return []
  const { cjk: queryCjk, ascii: queryAscii } = getQueryTokenSeparators(queryTokens)
  const queryLower = query.toLowerCase().replace(/[-_]/g, ' ')

  const results: SkillSearchResult[] = []
  for (const entry of index) {
    let score = cosineSimilarity(queryTfIdf, entry.tfVector)
    score = applyCjkFilter(entry, queryCjk, queryAscii, score)
    if (entry.skill.name.length >= NAME_MATCH_MIN_LENGTH && queryLower.includes(entry.normalizedName)) {
      score = Math.max(score, 0.75)
    }

    const matchedFields: string[] = []
    if (queryLower.includes(entry.normalizedName)) {
      const normalizedQuery = queryLower.trim()
      matchedFields.push(entry.normalizedName === normalizedQuery ? 'name:exact' : 'name:partial')
    }
    if (entry.descriptionTokens.some(t => queryTokens.includes(t))) matchedFields.push('description')
    if (entry.toolsTokens.some(t => queryTokens.includes(t))) matchedFields.push('tools')

    const usage = usageStats.get(entry.skill.name)
    if (usage) {
      score += Math.min(usage.useCount * 0.05, 0.20)
      score += usage.successRate * 0.10
      if (usage.useCount > 0) matchedFields.push('usage')
    }

    if (score >= DISPLAY_MIN_SCORE) {
      results.push({ skill: entry.skill, score, matchedFields })
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
