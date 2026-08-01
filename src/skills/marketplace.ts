/**
 * Skill marketplace loader — borrowed pattern from claude-code's
 * `loadSkillsDir` / `bundledSkills`.
 *
 * Scans `~/.ovolv999/skills/marketplace/<name>/SKILL.md` directories
 * and exposes each as a Skill. Pattern:
 *
 *   ~/.ovolv999/skills/marketplace/
 *     ├── code-review/SKILL.md
 *     ├── pr-description/SKILL.md
 *     └── refactor/SKILL.md
 *
 * SKILL.md format (same as project / global skills):
 *
 *   ---
 *   name: <name>
 *   description: <one-line description>
 *   ---
 *   <prompt body>
 *
 * No marketplace UI / no install flow — just loader. Users drop SKILL.md
 * files in the marketplace dir; loader picks them up at boot.
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import type { Skill } from './loader.js'
import { parseMarketplaceSkillFile } from './marketplaceParser.js'

export function getMarketplaceSkillsDir(): string {
  return join(homedir(), '.ovolv999', 'skills', 'marketplace')
}

export function loadMarketplaceSkills(): Map<string, Skill> {
  const out = new Map<string, Skill>()
  const root = getMarketplaceSkillsDir()
  if (!existsSync(root)) return out
  let entries: string[]
  try {
    entries = readdirSync(root)
  } catch {
    return out
  }
  for (const entry of entries) {
    const skillDir = join(root, entry)
    let stat
    try { stat = statSync(skillDir) } catch { continue }
    if (!stat.isDirectory()) continue
    const skillFile = join(skillDir, 'SKILL.md')
    if (!existsSync(skillFile)) continue
    try {
      const raw = readFileSync(skillFile, 'utf8').trim()
      const skill = parseMarketplaceSkillFile(raw, entry)
      if (skill) out.set(skill.name, skill)
    } catch {
      /* skip malformed SKILL.md — best-effort */
    }
  }
  return out
}
