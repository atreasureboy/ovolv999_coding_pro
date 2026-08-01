/**
 * Parse a marketplace SKILL.md file. Same YAML frontmatter format
 * as the project / global skills loader; isolated for testability.
 */

import type { Skill } from './loader.js'

export function parseMarketplaceSkillFile(raw: string, fallbackName: string): Skill | null {
  const trimmed = raw.trim()
  if (!trimmed) return null
  const match = trimmed.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/)
  let name = fallbackName
  let description = ''
  let body = trimmed
  if (match) {
    const fm = match[1] ?? ''
    body = (match[2] ?? '').trim()
    for (const line of fm.split('\n')) {
      const colonIdx = line.indexOf(':')
      if (colonIdx <= 0) continue
      const key = line.slice(0, colonIdx).trim()
      const value = line.slice(colonIdx + 1).trim().replace(/^["']|["']$/g, '')
      if (key === 'name') name = value || fallbackName
      else if (key === 'description') description = value
    }
  } else {
    const firstLine = trimmed.split('\n').find((l) => l.trim()) ?? ''
    description = firstLine.replace(/^#+\s*/, '').trim()
  }
  if (!body) body = trimmed
  return {
    name,
    description: description || name,
    prompt: body,
    source: 'global',
  }
}
