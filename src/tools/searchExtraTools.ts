/**
 * search_extra_tools tool — LLM-callable tool discovery.
 *
 * Lets the model discover deferred tools by name or keyword. The
 * model then calls the discovered tool directly via ordinary tool
 * invocation (no ExecuteExtraTool indirection in our runtime).
 *
 * Query forms:
 *   1. select:NAME — exact name lookup in the deferred set.
 *   2. discover:keyword — returns metadata without loading; informational.
 *   3. plain keyword — TF-IDF search across name / searchHint / description.
 */

import type { Tool, ToolDefinition, ToolResult, ToolContext } from '../core/types.js'
import { str } from '../core/strings.js'
import {
  getToolIndex,
  searchTools,
  searchToolsByExactName,
  type ToolIndexEntry,
  type ToolSearchResult,
} from '../core/toolSearch.js'
import { findTool } from './index.js'

export const SEARCH_EXTRA_TOOLS_NAME = 'search_extra_tools'

const MAX_RESULTS_DEFAULT = 5
const MAX_RESULTS_HARD_CAP = 20

export interface SearchExtraToolsOutcome {
  matches: Array<{
    name: string
    description: string
    searchHint?: string
    score: number
    parameters?: Record<string, unknown>
  }>
  query: string
  total_deferred_tools: number
}

export function createSearchExtraToolsTool(): Tool {
  return {
    name: SEARCH_EXTRA_TOOLS_NAME,
    metadata: { readOnly: true, concurrencySafe: true, searchHint: 'discover find list deferred tools by name or keyword' },
    definition: {
      type: 'function',
      function: {
        name: SEARCH_EXTRA_TOOLS_NAME,
        description: `Discover deferred tools by name or keyword.

Low priority — only use this when no core tool can accomplish the task.
Core tools (Bash, Read, Edit, Write, Glob, Grep, TodoWrite, WebFetch, WebSearch, Agent, EnterPlanMode, ExitPlanMode, AskUserQuestion, NotebookEdit, load_skill) are always available and should be used directly.

This tool is for discovering additional capabilities.

## Query forms
- "select:ToolName" — exact name lookup (fastest, preferred when you know the name)
- "discover:keyword" — returns tool metadata without forcing a call; use to understand a tool first
- "keyword keyword2" — TF-IDF search across tool name, searchHint, and description; returns top matches

Returns a list of matching deferred tools with their descriptions and JSON parameter schemas. After discovering a tool, call it directly via ordinary tool invocation.`,
        parameters: {
          type: 'object',
          properties: {
            query: {
              type: 'string',
              description: 'Query — "select:Name", "discover:keyword", or plain keywords',
            },
            max_results: {
              type: 'number',
              description: 'Maximum number of results to return (default 5, max 20)',
            },
          },
          required: ['query'],
        },
      },
    } satisfies ToolDefinition,

    execute(input: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
      const query = str(input.query)
      if (!query) {
        return Promise.resolve({ content: 'Error: query is required', isError: true })
      }
      const maxResults = Math.min(
        MAX_RESULTS_HARD_CAP,
        Math.max(1, typeof input.max_results === 'number' ? input.max_results : MAX_RESULTS_DEFAULT),
      )

      const tools = context.getRegisteredTools?.() ?? []
      const index = getToolIndex(tools)

      let matches: ToolSearchResult[]
      let mode: 'select' | 'discover' | 'keyword'

      if (query.startsWith('select:')) {
        mode = 'select'
        const name = query.slice('select:'.length).trim()
        matches = name
          ? searchToolsByExactName(name, index)
            ? [{
                name: searchToolsByExactName(name, index)!.name,
                description: searchToolsByExactName(name, index)!.description,
                searchHint: searchToolsByExactName(name, index)!.searchHint,
                score: 1.0,
              }]
            : []
          : []
      } else if (query.startsWith('discover:')) {
        mode = 'discover'
        const keyword = query.slice('discover:'.length).trim()
        matches = searchTools(keyword, index, maxResults)
      } else {
        mode = 'keyword'
        matches = searchTools(query, index, maxResults)
      }

      const matchesWithSchema = matches.map((m) => {
        const tool = findTool(tools, m.name)
        return {
          name: m.name,
          description: m.description,
          searchHint: m.searchHint,
          score: m.score,
          parameters: tool?.definition.function.parameters,
        }
      })

      if (context.markToolDiscovered) {
        for (const m of matchesWithSchema) {
          context.markToolDiscovered(m.name)
        }
      }

      const outcome: SearchExtraToolsOutcome = {
        matches: matchesWithSchema,
        query,
        total_deferred_tools: index.length,
      }

      const header = `Found ${matchesWithSchema.length} deferred tool(s) [${mode}]:`
      const lines: string[] = [header]
      for (const m of matchesWithSchema) {
        const scoreLine = `**${m.name}** (score: ${m.score.toFixed(2)})`
        const descLine = m.description ? `\n  ${m.description}` : ''
        const hintLine = m.searchHint ? `\n  hint: ${m.searchHint}` : ''
        const schemaLine = m.parameters
          ? `\n  schema: ${JSON.stringify(m.parameters).slice(0, 600)}`
          : ''
        lines.push(`${scoreLine}${descLine}${hintLine}${schemaLine}`)
      }

      if (matchesWithSchema.length === 0) {
        lines.push(
          `\nNo deferred tools matched. The deferred index has ${index.length} tool(s). ` +
            `Use a broader keyword, "select:ToolName" if you know the exact name, ` +
            `or proceed without the deferred tool.`,
        )
      } else {
        lines.push(
          `\nCall any of these directly via ordinary tool invocation (no extra wrapper).`,
        )
      }

      return Promise.resolve({
        content: `${lines.join('\n')}\n\n---\n\n${JSON.stringify(outcome, null, 2)}`,
        isError: false,
      })
    },
  }
}

export type { ToolIndexEntry }
