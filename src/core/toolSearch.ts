/**
 * Tool search — TF-IDF indexed discovery of deferred tools.
 *
 * Built on top of core/localSearch. Only indexes tools that are
 * marked shouldDefer (or whose core membership is False and not
 * alwaysLoad). Schema is returned via searchTools so the LLM can
 * discover and call them via ordinary tool invocation.
 */

import type { Tool } from './types.js'
import {
  computeIdf,
  computeWeightedTf,
  tokenizeAndStem,
  splitHyphenatedName,
  normalizeName,
  cosineSimilarity,
  applyCjkFilter,
  buildQueryTfIdf,
  getQueryTokenSeparators,
  type WeightedTfField,
} from './localSearch.js'

const TOOL_FIELD_WEIGHT = {
  name: 3.0,
  searchHint: 2.5,
  description: 1.0,
} as const

const NAME_MATCH_MIN_LENGTH = 4
const DISPLAY_MIN_SCORE = 0.10
const SEARCH_DISCOVERY_LIMIT = 5

export interface ToolIndexEntry {
  name: string
  normalizedName: string
  description: string
  searchHint: string | undefined
  shouldDefer: boolean
  tokens: string[]
  tfVector: Map<string, number>
}

export interface ToolSearchResult {
  name: string
  description: string
  searchHint: string | undefined
  score: number
}

const CORE_TOOLS = new Set<string>([
  'Bash', 'Read', 'Write', 'Edit', 'Glob', 'Grep',
  'TodoWrite', 'WebFetch', 'WebSearch', 'Agent',
  'EnterPlanMode', 'ExitPlanMode', 'AskUserQuestion',
  'NotebookEdit', 'load_skill', 'TaskCreate', 'TaskGet',
  'TaskList', 'TaskUpdate', 'TaskStop', 'TaskPlan',
  'Worktree', 'EnterWorktree', 'ExitWorktree', 'ListWorktrees',
  'TmuxSession', 'ShellSession', 'Sleep', 'Snip',
  'Diagnostics', 'ListMcpResources', 'ReadMcpResource', 'Goal',
  'VerifyPlanExecution', 'search_extra_tools', 'ClaudeCode',
])

export function isCoreTool(name: string): boolean {
  return CORE_TOOLS.has(name)
}

export function isDeferredTool(tool: Tool): boolean {
  if (tool.metadata?.alwaysLoad === true) return false
  if (tool.metadata?.shouldDefer !== true) return false
  if (isCoreTool(tool.name)) return false
  return true
}

export interface ParsedToolName {
  parts: string[]
  full: string
  isMcp: boolean
}

export function parseToolName(name: string): ParsedToolName {
  if (name.startsWith('mcp__')) {
    const withoutPrefix = name.replace(/^mcp__/, '').toLowerCase()
    const parts = withoutPrefix.split('__').flatMap(p => p.split('_'))
    return {
      parts: parts.filter(Boolean),
      full: withoutPrefix.replace(/__/g, ' ').replace(/_/g, ' '),
      isMcp: true,
    }
  }
  const parts = name
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/_/g, ' ')
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
  return { parts, full: parts.join(' '), isMcp: false }
}

function fieldsForTool(tool: Tool): { fields: WeightedTfField[]; tokens: string[]; parsedName: ParsedToolName } {
  const description = tool.definition.function.description ?? ''
  const searchHint = tool.metadata?.searchHint ?? ''
  const parsedName = parseToolName(tool.name)

  const nameTokens = tokenizeAndStem(parsedName.parts.join(' '))
  const nameWithParts = [
    ...nameTokens,
    ...splitHyphenatedName(tool.name).map(s => s),
  ]
  const hintTokens = tokenizeAndStem(searchHint)
  const descTokens = tokenizeAndStem(description)

  const allTokens = Array.from(new Set([...nameWithParts, ...hintTokens, ...descTokens]))

  const fields: WeightedTfField[] = [
    { tokens: nameWithParts, weight: TOOL_FIELD_WEIGHT.name },
    { tokens: hintTokens, weight: TOOL_FIELD_WEIGHT.searchHint },
    { tokens: descTokens, weight: TOOL_FIELD_WEIGHT.description },
  ]

  return { fields, tokens: allTokens, parsedName }
}

export function buildToolIndex(tools: Tool[]): ToolIndexEntry[] {
  const entries: ToolIndexEntry[] = []
  for (const tool of tools) {
    if (!isDeferredTool(tool)) continue
    const { fields, tokens, parsedName } = fieldsForTool(tool)
    const tfVector = computeWeightedTf(fields)
    entries.push({
      name: tool.name,
      normalizedName: normalizeName(parsedName.full || tool.name),
      description: tool.definition.function.description ?? '',
      searchHint: tool.metadata?.searchHint,
      shouldDefer: true,
      tokens,
      tfVector,
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

let cachedIndex: ToolIndexEntry[] | null = null
let cachedKey: string | null = null

function indexKey(tools: Tool[]): string {
  return tools.map(t => t.name).sort().join(',')
}

export function getToolIndex(tools: Tool[]): ToolIndexEntry[] {
  const key = indexKey(tools)
  if (cachedIndex && cachedKey === key) return cachedIndex
  cachedIndex = buildToolIndex(tools)
  cachedKey = key
  return cachedIndex
}

export function clearToolIndexCache(): void {
  cachedIndex = null
  cachedKey = null
}

export function searchTools(
  query: string,
  index: ToolIndexEntry[],
  limit: number = SEARCH_DISCOVERY_LIMIT,
): ToolSearchResult[] {
  if (index.length === 0 || !query?.trim()) return []
  const idf = computeIdf(index)
  const { tfIdf: queryTfIdf, tokens: queryTokens } = buildQueryTfIdf(query, idf)
  if (queryTokens.length === 0) return []

  const { cjk: queryCjk, ascii: queryAscii } = getQueryTokenSeparators(queryTokens)
  const queryLower = query.toLowerCase().replace(/[-_]/g, ' ')

  const results: ToolSearchResult[] = []
  for (const entry of index) {
    let score = cosineSimilarity(queryTfIdf, entry.tfVector)
    score = applyCjkFilter(entry, queryCjk, queryAscii, score)
    if (entry.name.length >= NAME_MATCH_MIN_LENGTH && queryLower.includes(entry.normalizedName)) {
      score = Math.max(score, 0.75)
    }
    if (score >= DISPLAY_MIN_SCORE) {
      results.push({
        name: entry.name,
        description: entry.description,
        searchHint: entry.searchHint,
        score,
      })
    }
  }

  results.sort((a, b) => b.score - a.score)
  return results.slice(0, limit)
}

export function searchToolsByExactName(
  name: string,
  index: ToolIndexEntry[],
): ToolIndexEntry | undefined {
  return index.find(e => e.name === name)
}
