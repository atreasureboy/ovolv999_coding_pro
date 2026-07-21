/**
 * ReflectionModule — post-run knowledge extraction.
 *
 * After a Run completes, analyzes the conversation to extract:
 * - Success patterns → Semantic Memory (what worked)
 * - Failure patterns → Semantic Memory (what to avoid)
 *
 * Depends on: memory module (writes to SemanticMemory).
 * This is new functionality — not extracted from existing code.
 */

import type OpenAI from 'openai'
import type { AgentModule, ModuleBootResult, ModuleRunContext } from '../core/module.js'
import type { SemanticMemory } from '../core/semanticMemory.js'
import type { EpisodicMemory } from '../core/episodicMemory.js'

const REFLECTION_SYSTEM_PROMPT = `You are a reflection engine. Analyze the completed agent run and extract reusable knowledge.

Output JSON with this structure:
{
  "knowledge": [
    {
      "content": "concise knowledge statement",
      "tags": ["relevant", "tags"],
      "confidence": 0.8,
      "source": "agent_inferred"
    }
  ]
}

Rules:
- Extract only genuinely reusable insights (not run-specific details)
- Max 3 knowledge entries per run
- Confidence 0.5-0.9 (be honest about uncertainty)
- If nothing worth remembering, return {"knowledge": []}
- Respond with JSON only, no prose`

const REFLECTION_MAX_TOKENS = 800

export class ReflectionModule implements AgentModule {
  readonly name = 'reflection'
  readonly dependencies = ['memory']

  constructor(
    private client: OpenAI,
    private model: string,
    private semantic: SemanticMemory,
    private config: { planMode?: boolean; poor?: { enabled: boolean } },
  ) {}

  boot(): ModuleBootResult {
    return {}
  }

  /**
   * P0-1 (transactional model switch): keep the captured model in
   * sync with the runtime so the post-run knowledge extraction LLM
   * call targets the user's currently-selected model rather than
   * the model that was active when this module was constructed.
   */
  onModelChanged(model: string): void {
    this.model = model
  }

  async onComplete(ctx: ModuleRunContext): Promise<void> {
    if (this.config.poor?.enabled) return
    // Skip if the run was too short to yield useful insights
    const toolCallCount = ctx.messages.filter(m => m.role === 'tool').length
    if (toolCallCount < 3) return

    // Skip if the run ended in error
    if (ctx.turnResult.reason === 'error') return

    try {
      const conversationSummary = this.serializeForReflection(ctx.messages)

      const response = await this.client.chat.completions.create({
        model: this.model,
        messages: [
          { role: 'system', content: REFLECTION_SYSTEM_PROMPT },
          {
            role: 'user',
            content: `Analyze this agent run (outcome: ${ctx.turnResult.reason}):\n\n${conversationSummary}`,
          },
        ],
        temperature: 0,
        max_tokens: REFLECTION_MAX_TOKENS,
      }, { timeout: 30_000 })

      const output = response.choices[0]?.message?.content ?? ''
      const parsed = parseReflection(output)

      for (const entry of parsed) {
        this.semantic.write({
          content: entry.content,
          tags: entry.tags,
          source: 'agent_inferred',
          confidence: entry.confidence,
          timestamp: new Date().toISOString(),
        })
      }

      if (parsed.length > 0) {
        ctx.eventLog?.append('memory_write', 'reflection', {
          entries: parsed.length,
          module: 'reflection',
        })
      }
    } catch {
      // reflection failures must never break anything
    }
  }

  private serializeForReflection(messages: { role: string; content: string | unknown[] | null; tool_calls?: unknown[] }[]): string {
    const parts: string[] = []
    for (const msg of messages.slice(-30)) {
      if (msg.role === 'user' && typeof msg.content === 'string') {
        parts.push(`[USER]: ${msg.content.slice(0, 200)}`)
      } else if (msg.role === 'assistant') {
        if (typeof msg.content === 'string' && msg.content) parts.push(`[ASSISTANT]: ${msg.content.slice(0, 200)}`)
        if (msg.tool_calls?.length) {
          const names = (msg.tool_calls as Array<{ function: { name: string } }>)
            .map(tc => tc.function.name).join(', ')
          parts.push(`[TOOLS USED]: ${names}`)
        }
      } else if (msg.role === 'tool' && typeof msg.content === 'string') {
        parts.push(`[RESULT]: ${msg.content.slice(0, 100)}`)
      }
    }
    return parts.join('\n')
  }
}

/** Parse LLM reflection output into knowledge entries (standalone, not private) */
function parseReflection(output: string): Array<{
  content: string
  tags: string[]
  confidence: number
}> {
  try {
    const parsed = JSON.parse(output) as {
      knowledge?: Array<{
        content: string
        tags?: string[]
        confidence?: number
      }>
    }
    return (parsed.knowledge ?? [])
      .filter(e => e.content && e.content.length > 10)
      .map(e => ({
        content: e.content.slice(0, 500),
        tags: e.tags ?? [],
        confidence: typeof e.confidence === 'number' ? e.confidence : 0.5,
      }))
  } catch {
    return []
  }
}

// ── Session-level consolidation (AgentOS §8 Memory 整合) ──────────────────────

/**
 * Consolidate a session's episodic events into semantic memory.
 * Called at REPL exit to close the learning loop.
 *
 * Unlike per-turn reflection (which analyzes a single run), this summarizes
 * the entire session's activity and extracts durable knowledge.
 */
export async function consolidateSession(
  client: OpenAI,
  model: string,
  episodic: EpisodicMemory,
  semantic: SemanticMemory,
  poor?: { enabled: boolean },
): Promise<{ episodes: number; knowledgeExtracted: number }> {
  if (poor?.enabled) {
    return { episodes: 0, knowledgeExtracted: 0 }
  }
  const episodes = episodic.recent(100)
  if (episodes.length < 5) {
    return { episodes: episodes.length, knowledgeExtracted: 0 }
  }

  const sessionSummary = episodes.map((e, i) => {
    const icon = e.outcome === 'success' ? '✓' : '✗'
    return `${i + 1}. ${icon} ${e.toolName}: ${e.inputSummary.slice(0, 60)} → ${e.resultSummary.slice(0, 80)}`
  }).join('\n')

  try {
    const response = await client.chat.completions.create({
      model,
      messages: [
        { role: 'system', content: REFLECTION_SYSTEM_PROMPT },
        {
          role: 'user',
          content: `Summarize this entire coding session and extract durable knowledge:\n\n${sessionSummary}`,
        },
      ],
      temperature: 0,
      max_tokens: REFLECTION_MAX_TOKENS,
    }, { timeout: 30_000 })

      const output = response.choices[0]?.message?.content ?? ''
      const parsed = parseReflection(output)

      for (const entry of parsed) {
      semantic.write({
        content: `[session] ${entry.content}`,
        tags: entry.tags,
        source: 'consolidation',
        confidence: entry.confidence,
        timestamp: new Date().toISOString(),
      })
    }

    return { episodes: episodes.length, knowledgeExtracted: parsed.length }
  } catch {
    return { episodes: episodes.length, knowledgeExtracted: 0 }
  }
}
