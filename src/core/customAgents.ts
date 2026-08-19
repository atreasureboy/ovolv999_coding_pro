/**
 * Custom Agents — user-defined agent presets loaded from disk.
 *
 * Inspired by Claude Code's .claude/agents and opencode's markdown
 * frontmatter agents. Two discovery roots (later root does NOT override
 * project entries — project wins on name collision):
 *
 *   <cwd>/.agents/*.md          (project agents)
 *   <cwd>/.agents/*.json        (project agents, JSON manifest form)
 *   ~/.ovogo/agents/*.md|*.json (global user agents)
 *
 * Markdown form:
 *   ---
 *   name: sql-reviewer            (optional — defaults to file basename)
 *   description: Reviews SQL migrations for safety  (optional)
 *   tools: Read, Grep, Bash       (optional allowlist; comma-separated or JSON array)
 *   planMode: true                (optional — read-only agent)
 *   maxIterations: 30             (optional)
 *   ---
 *   You are a SQL migration reviewer...   ← the system prompt body
 *
 * JSON form:
 *   { "name": "...", "description": "...", "prompt": "...",
 *     "tools": ["Read", "Grep"], "planMode": false, "maxIterations": 30 }
 *
 * Invalid files are skipped silently here; /agents-style diagnostics can
 * surface the parse errors collected in CustomAgentDef.errors.
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'fs'
import { join, basename } from 'path'
import { homedir } from 'os'
import type { AgentConfig } from './agentPresets.js'

export interface CustomAgentDef {
  /** Agent name (frontmatter `name`, JSON `name`, or file basename). */
  name: string
  description?: string
  /** System prompt body. */
  prompt: string
  tools?: string[]
  planMode?: boolean
  maxIterations?: number
  /** Root the definition was loaded from. */
  source: string
  /** Parse/validation errors (definition unusable when non-empty). */
  errors: string[]
}

const MAX_AGENT_FILE_BYTES = 512 * 1024

/**
 * Parse a minimal YAML frontmatter block (flat `key: value` pairs only).
 * Returns the parsed fields and the remaining body. No external YAML
 * dependency — agent frontmatter is intentionally limited to scalars and
 * one-level lists.
 */
function parseFrontmatter(raw: string): { fields: Record<string, string>; body: string } {
  const lines = raw.split(/\r?\n/)
  if (lines[0]?.trim() !== '---') return { fields: {}, body: raw }
  const fields: Record<string, string> = {}
  let i = 1
  for (; i < lines.length; i++) {
    const line = lines[i] ?? ''
    if (line.trim() === '---') {
      i++
      break
    }
    const m = /^([A-Za-z_][A-Za-z0-9_]*)\s*:\s*(.*)$/.exec(line)
    if (m && m[1] !== undefined && m[2] !== undefined) {
      fields[m[1]] = m[2].trim().replace(/^["']|["']$/g, '')
    }
  }
  return { fields, body: lines.slice(i).join('\n') }
}

function parseToolList(value: unknown): string[] | undefined {
  if (Array.isArray(value)) {
    const tools = value.filter((t): t is string => typeof t === 'string' && t.trim().length > 0)
    return tools.length > 0 ? tools : undefined
  }
  if (typeof value === 'string' && value.trim().length > 0) {
    const tools = value.split(',').map((t) => t.trim()).filter((t) => t.length > 0)
    return tools.length > 0 ? tools : undefined
  }
  return undefined
}

function parsePositiveInt(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) return Math.floor(value)
  if (typeof value === 'string') {
    const n = parseInt(value, 10)
    if (Number.isFinite(n) && n > 0) return n
  }
  return undefined
}

function buildDef(
  name: string,
  source: string,
  prompt: string,
  opts: { description?: string; tools?: string[]; planMode?: boolean; maxIterations?: number },
  errors: string[],
): CustomAgentDef {
  return {
    name,
    prompt,
    source,
    errors,
    ...(opts.description ? { description: opts.description } : {}),
    ...(opts.tools ? { tools: opts.tools } : {}),
    ...(opts.planMode !== undefined ? { planMode: opts.planMode } : {}),
    ...(opts.maxIterations !== undefined ? { maxIterations: opts.maxIterations } : {}),
  }
}

function parseMarkdownAgent(filePath: string, raw: string): CustomAgentDef | null {
  const { fields, body } = parseFrontmatter(raw)
  const name = (fields.name ?? basename(filePath, '.md')).trim()
  const prompt = body.trim()
  const errors: string[] = []
  if (!name) errors.push('frontmatter name is empty')
  if (!prompt) errors.push('system prompt body is empty')
  return buildDef(name, filePath, prompt, {
    description: fields.description || undefined,
    tools: parseToolList(fields.tools),
    planMode: fields.planMode === 'true' ? true : fields.planMode === 'false' ? false : undefined,
    maxIterations: parsePositiveInt(fields.maxIterations),
  }, errors)
}

function parseJsonAgent(filePath: string, raw: string): CustomAgentDef | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (err) {
    return buildDef(basename(filePath, '.json'), filePath, '', {}, [`invalid JSON: ${(err as Error).message}`])
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return buildDef(basename(filePath, '.json'), filePath, '', {}, ['root must be a JSON object'])
  }
  const obj = parsed as Record<string, unknown>
  const name = typeof obj.name === 'string' && obj.name.trim() ? obj.name.trim() : basename(filePath, '.json')
  const prompt = typeof obj.prompt === 'string'
    ? obj.prompt.trim()
    : typeof obj.systemPrompt === 'string'
      ? obj.systemPrompt.trim()
      : ''
  const errors: string[] = []
  if (!prompt) errors.push('"prompt" (or "systemPrompt") must be a non-empty string')
  return buildDef(name, filePath, prompt, {
    description: typeof obj.description === 'string' && obj.description.trim() ? obj.description.trim() : undefined,
    tools: parseToolList(obj.tools),
    planMode: obj.planMode === true,
    maxIterations: parsePositiveInt(obj.maxIterations),
  }, errors)
}

function loadAgentsFromDir(dir: string): CustomAgentDef[] {
  if (!existsSync(dir)) return []
  let entries: string[]
  try {
    entries = readdirSync(dir)
  } catch {
    return []
  }
  const defs: CustomAgentDef[] = []
  for (const entry of entries.sort()) {
    const filePath = join(dir, entry)
    const isMd = entry.endsWith('.md')
    const isJson = entry.endsWith('.json')
    if (!isMd && !isJson) continue
    let raw: string
    try {
      if (statSync(filePath).size > MAX_AGENT_FILE_BYTES) continue
      raw = readFileSync(filePath, 'utf8')
    } catch {
      continue
    }
    const def = isMd ? parseMarkdownAgent(filePath, raw) : parseJsonAgent(filePath, raw)
    if (def) defs.push(def)
  }
  return defs
}

/**
 * Load all valid custom agent definitions for a project: global agents
 * first, project agents after (project wins on name collisions).
 * Definitions with parse errors are excluded — an invalid agent must
 * never silently spawn as an empty-prompt sub-agent.
 *
 * Round 41 perf fix: results are cached per (cwd) with a short TTL —
 * AgentTool's constructor calls this for EVERY engine construction
 * (each sub-agent factory call), which made each nested Agent tool
 * re-scan both directories synchronously.
 */
const agentCache = new Map<string, { at: number; defs: CustomAgentDef[] }>()
const AGENT_CACHE_TTL_MS = 5_000

export function loadCustomAgents(cwd: string): CustomAgentDef[] {
  const hit = agentCache.get(cwd)
  if (hit && Date.now() - hit.at < AGENT_CACHE_TTL_MS) return hit.defs
  const globalDefs = loadAgentsFromDir(join(homedir(), '.ovogo', 'agents'))
  const projectDefs = loadAgentsFromDir(join(cwd, '.agents'))
  const byName = new Map<string, CustomAgentDef>()
  for (const def of [...globalDefs, ...projectDefs]) {
    if (def.errors.length > 0) continue
    byName.set(def.name, def)
  }
  const defs = [...byName.values()]
  agentCache.set(cwd, { at: Date.now(), defs })
  return defs
}

/** Names of all loadable custom agents (see loadCustomAgents). */
export function customAgentNames(cwd: string): string[] {
  return loadCustomAgents(cwd).map((d) => d.name)
}

/**
 * Build an AgentConfig for a custom agent definition. The system prompt
 * gets the same working-directory + priority-rules preamble style as
 * built-in presets: the raw body is used verbatim, prefixed with the cwd
 * so the sub-agent knows where it operates.
 */
export function customAgentToConfig(def: CustomAgentDef): AgentConfig {
  const prompt = def.prompt
  return {
    identity: {
      systemPrompt: (cwd: string) => `Working directory: ${cwd}\n\n${prompt}`,
      planMode: def.planMode ?? false,
    },
    modules: {},
    ...(def.tools ? { tools: def.tools } : {}),
    ...(def.maxIterations !== undefined ? { maxIterations: def.maxIterations } : {}),
  }
}

/**
 * Look up a custom agent by name. Returns null when no valid definition
 * exists under either discovery root.
 */
export function getCustomAgent(cwd: string, name: string): CustomAgentDef | null {
  return loadCustomAgents(cwd).find((d) => d.name === name) ?? null
}
