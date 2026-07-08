/**
 * MemoryModule — Semantic + Episodic memory persistence.
 *
 * Implements the AgentOS memory pattern:
 *   - Source attribution: user_stated > agent_inferred > tool_observed
 *   - Active tools: memory_write (store), memory_search (find), memory_recall (episodes)
 *   - Boot injection: top-K semantic memories into system prompt
 *   - Passive tracking: episodic write on every tool call
 */

import type { Tool, ToolDefinition, ToolResult } from '../core/types.js'
import type { AgentModule, ModuleBootContext, ModuleBootResult } from '../core/module.js'
import type { SemanticMemory } from '../core/semanticMemory.js'
import type { EpisodicMemory } from '../core/episodicMemory.js'
import { getMemoryDir, buildMemorySystemSection } from '../memory/index.js'
import { str } from '../core/strings.js'

// (Source priority lives in semanticMemory.ts — single source of truth)

// ── memory_write — store knowledge with source attribution ──────────────────

function createMemoryWriteTool(semantic: SemanticMemory): Tool {
  return {
    name: 'memory_write',
    definition: {
      type: 'function',
      function: {
        name: 'memory_write',
        description: `Store a knowledge entry in long-term memory with source attribution.

Use this when you learn something reusable:
- **user_stated**: The user explicitly told you a preference/rule/constraint
- **agent_inferred**: You deduced something from observations
- **tool_observed**: A tool returned factual data worth remembering

Higher-priority sources override lower ones on conflict.`,
        parameters: {
          type: 'object',
          properties: {
            content: {
              type: 'string',
              description: 'The knowledge to remember (concise, general statement)',
            },
            tags: {
              type: 'array',
              items: { type: 'string' },
              description: 'Tags for categorization (e.g. ["convention", "api"])',
            },
            confidence: {
              type: 'number',
              description: 'Confidence level 0.0-1.0 (default: 0.7)',
            },
            source: {
              type: 'string',
              enum: ['user_stated', 'agent_inferred', 'tool_observed'],
              description: 'Knowledge source (default: agent_inferred)',
            },
          },
          required: ['content'],
        },
      },
    } satisfies ToolDefinition,

    execute(input: Record<string, unknown>): Promise<ToolResult> {
      const content = str(input.content)
      if (!content || content.length < 5) {
        return Promise.resolve({
          content: 'Error: content must be at least 5 characters',
          isError: true,
        })
      }

      const tags = Array.isArray(input.tags)
        ? (input.tags as unknown[]).filter((t): t is string => typeof t === 'string')
        : []
      const confidence = typeof input.confidence === 'number'
        ? Math.min(Math.max(input.confidence, 0), 1)
        : 0.7
      const source = str(input.source, 'agent_inferred') as 'user_stated' | 'agent_inferred' | 'tool_observed'

      const entry = semantic.write({
        content: content.slice(0, 500),
        tags,
        source,
        confidence,
        timestamp: new Date().toISOString(),
      })

      return Promise.resolve({
        content: `Stored in memory (id: ${entry.id}, source: ${source}, confidence: ${confidence})`,
        isError: false,
      })
    },
  }
}

// ── memory_search — search semantic memory by keywords/tags ─────────────────

function createMemorySearchTool(semantic: SemanticMemory): Tool {
  return {
    name: 'memory_search',
    definition: {
      type: 'function',
      function: {
        name: 'memory_search',
        description: `Search long-term memory for relevant knowledge. Returns entries sorted by confidence and recency.

Use this to recall past learnings, user preferences, or project conventions that might help with the current task.`,
        parameters: {
          type: 'object',
          properties: {
            query: {
              type: 'string',
              description: 'Keywords to search for in memory content',
            },
            tags: {
              type: 'array',
              items: { type: 'string' },
              description: 'Tags to filter by (e.g. ["convention"])',
            },
            limit: {
              type: 'number',
              description: 'Max results (default: 10)',
            },
          },
        },
      },
    } satisfies ToolDefinition,

    execute(input: Record<string, unknown>): Promise<ToolResult> {
      const query = str(input.query)
      const tags = Array.isArray(input.tags)
        ? (input.tags as unknown[]).filter((t): t is string => typeof t === 'string')
        : []
      const limit = typeof input.limit === 'number' ? Math.min(input.limit, 30) : 10

      const keywords = query ? query.split(/\s+/).filter(Boolean) : undefined
      const results = semantic.search({
        keywords,
        tags: tags.length > 0 ? tags : undefined,
        limit,
      })

      if (results.length === 0) {
        return Promise.resolve({ content: 'No matching memories found.', isError: false })
      }

      const lines = results.map((e, i) => {
        const tagStr = e.tags.length > 0 ? ` [${e.tags.join(', ')}]` : ''
        return `${i + 1}. (${e.source}) ${e.content}${tagStr} (conf: ${e.confidence})`
      })

      return Promise.resolve({
        content: `Found ${results.length} memor${results.length === 1 ? 'y' : 'ies'}:\n\n${lines.join('\n')}`,
        isError: false,
      })
    },
  }
}

// ── memory_recall — recall recent episodic events ────────────────────────────

function createMemoryRecallTool(episodic: EpisodicMemory): Tool {
  return {
    name: 'memory_recall',
    definition: {
      type: 'function',
      function: {
        name: 'memory_recall',
        description: `Recall recent actions and their outcomes from episodic memory. Shows what tools were called, with what input, and what happened. Useful for reviewing what you've already tried before repeating work.`,
        parameters: {
          type: 'object',
          properties: {
            limit: {
              type: 'number',
              description: 'Number of recent episodes to recall (default: 15, max: 50)',
            },
            tool_name: {
              type: 'string',
              description: 'Filter by specific tool name (e.g. "Bash", "Read")',
            },
          },
        },
      },
    } satisfies ToolDefinition,

    execute(input: Record<string, unknown>): Promise<ToolResult> {
      const limit = typeof input.limit === 'number' ? Math.min(input.limit, 50) : 15
      const toolName = str(input.tool_name)

      const all = toolName
        ? episodic.findByTool(toolName, limit)
        : episodic.recent(limit)

      if (all.length === 0) {
        return Promise.resolve({
          content: 'No episodic memories found. Start working to build up history.',
          isError: false,
        })
      }

      const lines = all.map((e, i) => {
        const outcome = e.outcome === 'success' ? '✓' : '✗'
        return `${i + 1}. [turn ${e.turn}] ${outcome} ${e.toolName}: ${e.inputSummary.slice(0, 80)} → ${e.resultSummary.slice(0, 100)}`
      })

      return Promise.resolve({
        content: `Recalled ${all.length} episode${all.length === 1 ? '' : 's'}:\n\n${lines.join('\n')}`,
        isError: false,
      })
    },
  }
}

// ── Relevance scoring (approximates AgentOS embedding retrieval) ─────────────

/** Extract meaningful keywords from a user message.
 *  Handles both English (whitespace-split) and CJK (Chinese/Japanese/Korean)
 *  text — CJK characters are segmented into 2-char bigrams since they
 *  have no word boundaries.
 *  Exported for testing.
 */
export function extractKeywords(text: string): string[] {
  const lower = text.toLowerCase()
  // English / Latin keywords: split on whitespace + punctuation
  const latinWords = lower
    .split(/[\s,.;:!?'"\-—–()]+/)
    .filter(w => w.length > 2)
    .filter(w => !['the', 'and', 'for', 'are', 'but', 'not', 'you', 'all', 'can', 'had', 'her', 'was', 'one', 'our', 'out', 'has', 'have', 'from', 'this', 'that', 'with', 'your', 'what', 'here', 'there', 'their', 'would'].includes(w))

  // CJK keywords: extract Chinese/Japanese/Korean character runs and
  // segment into 2-char bigrams (approximates word matching for languages
  // without whitespace word boundaries)
  const cjkBigrams: string[] = []
  const cjkRuns = lower.match(/[\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]+/g) ?? []
  for (const run of cjkRuns) {
    if (run.length === 1) {
      cjkBigrams.push(run)
    } else {
      for (let i = 0; i < run.length - 1; i++) {
        cjkBigrams.push(run.slice(i, i + 2))
      }
    }
  }

  return [...latinWords, ...cjkBigrams]
}

/** Score a memory entry against keywords — higher = more relevant */
function scoreRelevance(
  entry: { content: string; tags: string[]; confidence: number },
  keywords: string[],
): number {
  if (keywords.length === 0) return 0 // no keywords → no relevance score
  const text = (entry.content + ' ' + entry.tags.join(' ')).toLowerCase()
  let matches = 0
  for (const kw of keywords) {
    if (text.includes(kw)) matches++
  }
  // Combined score: keyword coverage ratio * confidence
  const coverage = matches / keywords.length
  return coverage * entry.confidence
}

// ── MemoryModule ────────────────────────────────────────────────────────────

export class MemoryModule implements AgentModule {
  readonly name = 'memory'

  constructor(
    private semantic: SemanticMemory,
    private episodic: EpisodicMemory,
  ) {}

  boot(ctx: ModuleBootContext): ModuleBootResult {
    // Relevance-based memory retrieval (AgentOS pattern)
    // Score entries by keyword overlap with user message, inject top-K
    const allEntries = this.semantic.readAll()
    let section = ''

    if (allEntries.length > 0 && ctx.userMessage) {
      const keywords = extractKeywords(ctx.userMessage)
      const scored = allEntries
        .map(e => ({ entry: e, score: scoreRelevance(e, keywords) }))
        .filter(x => x.score > 0) // Only inject relevant entries
        .sort((a, b) => b.score - a.score)
        .slice(0, 10) // Top-K to save context budget

      if (scored.length > 0) {
        const lines = scored.map(({ entry: e, score }) => {
          const s = score.toFixed(2)
          const tags = e.tags.length > 0 ? ` [${e.tags.join(', ')}]` : ''
          return `- (${s}) ${e.content}${tags}`
        })
        section = `## Memory — Relevant Knowledge (relevance-scored)\n\nKeywords: ${keywords.slice(0, 10).join(', ')}\n\n${lines.join('\n')}`
      }
    }

    // Fallback: if no user message or no relevant entries, use confidence-based injection
    if (!section) {
      const memoryDir = getMemoryDir(ctx.cwd)
      section = buildMemorySystemSection(memoryDir)
    }

    return {
      systemPromptSections: section ? [section] : [],
      toolContextPatch: {
        semanticMemory: this.semantic,
        episodicMemory: this.episodic,
      },
      // Module-provided tools — agent actively manages its own memory
      tools: [
        createMemoryWriteTool(this.semantic),
        createMemorySearchTool(this.semantic),
        createMemoryRecallTool(this.episodic),
      ],
    }
  }

  onToolCall(
    toolName: string,
    input: Record<string, unknown>,
    result: { content: string; isError: boolean },
    turnNumber: number,
  ): void {
    // Don't track memory tool calls themselves (avoid noise)
    if (toolName.startsWith('memory_')) return

    // Record both successes and failures (AgentOS pattern — learn from mistakes)
    this.episodic.write({
      turn: turnNumber,
      toolName,
      inputSummary: JSON.stringify(input).slice(0, 200),
      resultSummary: result.content.slice(0, 300),
      outcome: result.isError ? 'failure' as const : 'success' as const,
      timestamp: new Date().toISOString(),
    })
  }
}
