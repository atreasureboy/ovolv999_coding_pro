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
import { LongTermMemory } from '../core/longTermMemory.js'

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

  /**
   * v0.5.2 (C6 — borrowed from cursor "Memories"): when reflection
   * outputs a knowledge entry, route it through LongTermMemory so
   * the R1 (verification) + R2 (source marking) + R5 (conflict
   * merge) gates apply. The reflection module's contract becomes:
   *
   *   1. LLM extracts candidate knowledge (best-effort, no trust)
   *   2. Each candidate passes through LongTermMemory.record()
   *   3. LongTermMemory stamps origin='reflection:*', enforces
   *      verification gate, merges conflicts, gates by TTL
   *
   * If LongTermMemory rejects (e.g. verification gate fails), the
   * semantic write still proceeds but is marked as
   * `unverified-audit-rejected`. This keeps the LLM-driven learning
   * loop alive while preserving the audit invariants.
   */
  private readonly longTerm = new LongTermMemory({
    // v0.5.3 (P0.3): production default. Reflection's caller (P0.4)
    // pre-validates with the CompletionContract BEFORE calling
    // record(), so the gate's R3 check is the final authority.
    allowCodeWithoutCommit: false,
  })

  constructor(
    private client: OpenAI,
    private model: string,
    private semantic: SemanticMemory,
    private config: { planMode?: boolean; poor?: { enabled: boolean } },
  ) {}

  /** Test hook: swap the LongTermMemory instance. */
  setLongTermMemory(ltm: LongTermMemory): void {
    ;(this as unknown as { longTerm: LongTermMemory }).longTerm = ltm
  }

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
    const outcome = ctx.outcome
    if (!outcome) return

    // v0.5.3 (P0.4): the run must satisfy ALL of the following for
    // any entry to be marked verified=true:
    //   - CompletionStatus === 'completed'
    //   - verification.failed is empty
    //   - completion.blockers / unresolved / remaining are empty
    //   - turnResult.reason !== 'error'
    // Any other outcome routes the entry through a SEPARATE failure
    // branch with `kind: 'failure'` and `verified=false`. The LLM is
    // never trusted to declare its own success.
    const verification = outcome.verification
    const isCompleted =
      outcome.completion.status === 'completed' &&
      (outcome.completion.reasons?.length ?? 0) === 0 &&
      verification.executed &&
      verification.passed &&
      verification.failed.length === 0 &&
      (outcome.workerReferences?.filter((w) => (w as { status?: string }).status === 'failed').length ?? 0) === 0

    // Too-short runs never yield useful insights.
    const toolCallCount = ctx.messages.filter((m) => m.role === 'tool').length
    if (toolCallCount < 3) return

    // Cancelled/interrupted/failed/max_iter runs get a different
    // treatment — see below.
    const runOutcomeKind: 'success' | 'partial' | 'blocked' | 'cancelled' | 'failed' | 'exhausted' = isCompleted
      ? 'success'
      : outcome.completion.status === 'partial'
        ? 'partial'
        : outcome.completion.status === 'blocked'
          ? 'blocked'
          : ctx.turnResult.reason === 'interrupted'
            ? 'cancelled'
            : ctx.turnResult.reason === 'max_iterations'
              ? 'exhausted'
              : 'failed'

    try {
      const conversationSummary = this.serializeForReflection(ctx.messages)
      const response = await this.client.chat.completions.create({
        model: this.model,
        messages: [
          { role: 'system', content: REFLECTION_SYSTEM_PROMPT },
          {
            role: 'user',
            content: `Analyze this agent run (outcome: ${runOutcomeKind}):\n\n${conversationSummary}`,
          },
        ],
        temperature: 0,
        max_tokens: REFLECTION_MAX_TOKENS,
      }, { timeout: 30_000 })

      const output = response.choices[0]?.message?.content ?? ''
      const parsed = parseReflection(output)
      const sourceRunId = outcome.runId ?? 'unknown'

      let auditApproved = 0
      let auditRejected = 0
      for (const entry of parsed) {
        // v0.5.3 (P0.4): success branch is GATED on runOutcomeKind.
        // Failure / partial / blocked / cancelled / exhausted runs
        // CANNOT save success experiences — they can only save
        // `kind: 'failure'` entries that the audit gate stamps
        // verified=false. This prevents the model from reinforcing
        // its own false-success narratives.
        const kind: 'semantic' | 'reflection' | 'failure' =
          runOutcomeKind === 'success' ? 'semantic' : 'failure'
        const verified = runOutcomeKind === 'success'
        // Use the unified Memory Gate. Bypass the SemanticMemory
        // adapter for failure entries — they belong in the audit
        // trail, not in the read adapter that feeds the prompt.
        if (runOutcomeKind === 'success') {
          try {
            const gateResult = this.longTerm.record({
              kind,
              content: entry.content.slice(0, 500),
              repo: 'reflection',
              origin: `reflection:${runOutcomeKind}`,
              sourceRunId,
              confidence: entry.confidence,
              verified,
              tags: [...entry.tags, `outcome:${runOutcomeKind}`],
              expiresAt: undefined,
            })
            this.semantic.write({
              content: gateResult.content,
              tags: entry.tags,
              source: 'agent_inferred',
              confidence: entry.confidence,
              timestamp: gateResult.createdAt,
            })
            auditApproved++
          } catch {
            auditRejected++
          }
        } else {
          // Failure branch: only the audit gate, never the
          // SemanticMemory adapter. This is the v0.5.3 invariant —
          // a failed run must not feed its (possibly false) lessons
          // back into the prompt.
          try {
            this.longTerm.record({
              kind: 'failure',
              content: entry.content.slice(0, 500),
              repo: 'reflection',
              origin: `reflection:${runOutcomeKind}`,
              sourceRunId,
              confidence: entry.confidence,
              verified: false,
              tags: [...entry.tags, `outcome:${runOutcomeKind}`],
              expiresAt: undefined,
            })
            auditApproved++
          } catch {
            auditRejected++
          }
        }
      }

      if (parsed.length > 0) {
        ctx.eventLog?.append('memory_write', 'reflection', {
          entries: parsed.length,
          module: 'reflection',
          auditApproved,
          auditRejected,
          sourceRunId,
          runOutcomeKind,
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
