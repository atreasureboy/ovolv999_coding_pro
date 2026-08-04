/**
 * MemoryModule — Semantic + Episodic memory persistence.
 *
 * Implements the AgentOS memory pattern:
 *   - Source attribution: user_stated > agent_inferred > tool_observed
 *   - Active tools: memory_write (store), memory_search (find), memory_recall (episodes)
 *   - Boot injection: top-K semantic memories into system prompt
 *   - Passive tracking: episodic write on every tool call
 */

import type { Tool, ToolDefinition, ToolContext, ToolResult } from '../core/types.js'
import type { AgentModule, ModuleBootContext, ModuleBootResult, ModuleRunContext } from '../core/module.js'
import type { SemanticMemory } from '../core/semanticMemory.js'
import type { EpisodicMemory } from '../core/episodicMemory.js'
import { getMemoryDir, buildMemorySystemSection } from '../memory/index.js'
import { str } from '../core/strings.js'
import { LongTermMemory, defaultMemoryPath } from '../core/longTermMemory.js'
import {
  decidePromotion,
  makeCandidateId,
  type MemoryCandidate,
  type RevisionBinding,
} from '../core/memoryCandidate.js'
import { buildRevisionBinding } from '../core/revisionBinding.js'
import type { RunScopedRuntimeContextStore } from '../core/runtime/runScopedContext.js'

// (Source priority lives in semanticMemory.ts — single source of truth)

// ── memory_write — store knowledge with source attribution ──────────────────

function createMemoryWriteTool(semantic: SemanticMemory, ctxProvider: () => MemoryToolContext, candidateSink: (c: MemoryCandidate) => boolean): Tool {
  return {
    name: 'memory_write',
    metadata: { mutatesState: true, concurrencySafe: false },
    definition: {
      type: 'function',
      function: {
        name: 'memory_write',
        description: `Store a knowledge entry via the Candidate → Promotion lifecycle.

v0.5.3 Final (task 2): this tool DOES NOT persist anything yet.
It creates a MemoryCandidate on the current run's RunScopedRuntimeContext.
After the run finishes, the MemoryPromoter promotes the candidate
based on the CompletionContract verdict and the user-source
verification (for source='user_stated'). If the run failed, the
candidate is recorded under kind='failure' — those entries do NOT
enter the success-memory read pool.

- **user_stated**: You MUST provide \`source_quote\` — a contiguous
  substring of the user's original message. The engine verifies the
  quote is real; without a verified quote the entry is demoted to
  agent_inferred, or dropped entirely on failure runs.
- **agent_inferred**: You deduced something from observations.
- **tool_observed**: A tool returned factual data worth remembering.`,
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
            source_quote: {
              type: 'string',
              description: 'REQUIRED when source="user_stated": a contiguous substring of the user\'s original message that proves the user said this. The engine verifies before promoting.',
            },
          },
          required: ['content'],
        },
      },
    } satisfies ToolDefinition,

    execute(input: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
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
      const claimedSource = str(input.source, 'agent_inferred') as 'user_stated' | 'agent_inferred' | 'tool_observed'
      const sourceQuote = str(input.source_quote) || undefined

      // v0.5.3 P0-1 (kept): read runId from ToolContext so the
      // candidate is bound to the just-minted runId.
      const ctx = (context as unknown as { memoryToolContext?: MemoryToolContext })
        .memoryToolContext ?? ctxProvider()
      const runId = str(ctx.sourceRunId) || str(input.sourceRunId) || 'unknown'

      // user_stated ALWAYS requires a source_quote — even before
      // promotion. The quote-verifier runs at promotion time, but
      // the tool itself refuses to enqueue a user_stated candidate
      // without one, so the model sees the missing-input error
      // immediately (rather than a silent demotion later).
      if (claimedSource === 'user_stated' && !sourceQuote) {
        return Promise.resolve({
          content: 'Error: source="user_stated" requires a non-empty `source_quote` proving the user actually said this.',
          isError: true,
        })
      }

      const candidate: MemoryCandidate = {
        id: makeCandidateId(),
        runId,
        content: content.slice(0, 500),
        claimedSource,
        sourceQuote,
        tags,
        confidence,
        createdAt: new Date().toISOString(),
      }

      const accepted = candidateSink(candidate)
      // candidateSink returns false only when no per-run context is
      // available (a test path that bypassed Engine). In production
      // it always returns true.
      if (!accepted) {
        return Promise.resolve({
          content: `Memory candidate could not be enqueued (no per-run context). This path is unsupported.`,
          isError: true,
        })
      }

      return Promise.resolve({
        content: `MemoryCandidate enqueued (id: ${candidate.id}, source: ${claimedSource}, runId: ${runId}). Promotion to long-term memory happens after the run completes — based on CompletionContract, not on this call.`,
        isError: false,
      })
    },
  }
}

/** Subset of ToolContext fields the memory module reads. Documented
 *  in src/core/types.ts ToolContextShape. The engine populates these
 *  each turn so memory_write never sees the `unknown` defaults. */
export interface MemoryToolContext {
  repo?: string
  branch?: string
  commit?: string
  sourceRunId?: string
  /** Engine-published: whether the current run's verification passed.
   *  When true, code-bound R1 verification is satisfied. */
  verified?: boolean
}

// ── memory_search — search semantic memory by keywords/tags ─────────────────

function createMemorySearchTool(semantic: SemanticMemory): Tool {
  return {
    name: 'memory_search',
    metadata: { readOnly: true, concurrencySafe: true },
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
    metadata: { readOnly: true, concurrencySafe: true },
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

  /**
   * v0.5.3 P0-1: live publication of the per-turn memory
   * provenance fields. The Coordinator writes to this on every
   * turn with (repo, sourceRunId, verified) just after the runId
   * is minted. The memory_write tool's ctxProvider reads from
   * this field on every invocation so writes always carry the
   * engine-resolved provenance — never hidden input defaults.
   */
  private currentMemoryContext: MemoryToolContext = {}

  /** Coordinator hook: update the per-turn memory provenance. */
  publishMemoryContext(ctx: MemoryToolContext): void {
    this.currentMemoryContext = ctx
  }

  getMemoryContext(): MemoryToolContext {
    return this.currentMemoryContext
  }

  /**
   * v0.5.3 Final (task 2): per-runId Candidate sink. The
   * Coordinator publishes a sink closure for the current runId;
   * memory_write pushes candidates into it. Drop on close.
   */
  private readonly candidateSinks = new Map<string, (c: MemoryCandidate) => void>()

  publishCandidateSink(runId: string, sink: (c: MemoryCandidate) => void): void {
    this.candidateSinks.set(runId, sink)
  }

  closeCandidateSink(runId: string): void {
    this.candidateSinks.delete(runId)
  }

  /**
   * v0.5.3 Final (P0 issue): per-project LongTermMemory. The
   * previous instance shared `~/.ovogo/projects/default/memory/
   * longterm.jsonl` across all repos — A's memory bled into B's
   * prompt. We now re-bind the instance to a path derived from
   * the cwd at boot-time and every query carries the cwd-derived
   * repo string.
   */
  private longTerm: LongTermMemory = new LongTermMemory({
    // v0.5.3 Final: no allowCodeWithoutCommit or allowUnverified
    // shortcuts. Promotion to kind='semantic' requires the
    // RevisionBinding produced by the engine (binding.repo +
    // binding.baseCommit when present), which satisfies R3 by
    // contract.
  })
  private projectRepo: string = ''

  /**
   * v0.5.3 Final (P0 issue): wire the per-project LongTermMemory
   * instance. Engine calls this once it has the resolved cwd; boot
   * re-derives any query filter from the same cwd.
   */
  bindToProject(cwd: string): void {
    this.projectRepo = cwd
  }

  /** Repo filter — used by every read query below. */
  private repoFilter(): string {
    return this.projectRepo
  }

  /** Override the per-process LongTermMemory instance (tests). */
  setLongTermMemory(ltm: LongTermMemory): void {
    this.longTerm = ltm
  }

  getLongTermMemoryPath(): string {
    return defaultMemoryPath('default')
  }

  boot(ctx: ModuleBootContext): ModuleBootResult {
    // v0.5.3 Final (task 5): memory retrieval reads LongTermMemory
    // directly. SemanticMemory is kept for back-compat reads only
    // (until migration; see migrateSemanticToLongTerm below).
    let section = ''
    // v0.5.3 Final (P0 issue): bind to the boot's cwd so every read
    // and write below scopes to this project.
    this.bindToProject(ctx.cwd)
    try {
      const ltmRecords = this.longTerm.query({
        kind: 'semantic',
        verified: true,
        // v0.5.3 Final (P0 issue): repo filter is MANDATORY. Without
        // it, A's memory bleeds into B's prompt.
        repo: this.repoFilter(),
        limit: 10,
      })
      if (ltmRecords.length > 0 && ctx.userMessage) {
        const keywords = extractKeywords(ctx.userMessage)
        const scored = ltmRecords
          .map((r: { content: string; tags: string[]; confidence: number }) => ({
            entry: { content: r.content, tags: r.tags, confidence: r.confidence },
            score: scoreRelevance({ content: r.content, tags: r.tags, confidence: r.confidence }, keywords),
          }))
          .filter((x: { score: number }) => x.score > 0)
          .sort((a: { score: number }, b: { score: number }) => b.score - a.score)
          .slice(0, 10)
        if (scored.length > 0) {
          const lines = scored.map(({ entry: e, score }: { entry: { content: string; tags: string[]; confidence: number }; score: number }) => {
            const s = score.toFixed(2)
            const tags = e.tags.length > 0 ? ` [${e.tags.join(', ')}]` : ''
            return `- (${s}) ${e.content}${tags}`
          })
          section = `## Memory — Relevant Knowledge (LongTermMemory top-K)\n\nKeywords: ${keywords.slice(0, 10).join(', ')}\n\n${lines.join('\n')}`
        }
      }
    } catch { /* if LongTermMemory read fails, fall back silently — never block boot */ }

    // Fallback: build the legacy semantic section only if LongTermMemory yielded nothing
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
      tools: [
        // v0.5.3 Final (task 2): tool pushes Candidate into the
        // per-run sink, NOT to LongTermMemory.
        createMemoryWriteTool(
          this.semantic,
          () => this.currentMemoryContext,
          (cand: MemoryCandidate) => {
            const sink = this.candidateSinks.get(cand.runId)
            if (!sink) return false
            sink(cand)
            return true
          },
        ),
        // v0.5.3 Final (task 5): memory_search queries LongTermMemory
        // directly — semantic mirror removed from production reads.
        createMemorySearchToolLTM(this.longTerm, () => this.repoFilter()),
        createMemoryRecallTool(this.episodic),
      ],
    }
  }

  /**
   * v0.5.3 Final (task 2): promote this run's MemoryCandidates.
   * Called from the Coordinator right after evaluateCompletion().
   * Reads candidates from the per-run RunScopedRuntimeContext and
   * promotes each one based on the completion verdict.
   *
   * Also closes the per-run candidate sink so a re-run does not
   * inherit closures from the previous run.
   */
  async onComplete(ctx: ModuleRunContext): Promise<void> {
    // Close the sink even if we do not have a runContext.
    if (ctx.outcome?.runId) {
      // Close at the end — no further candidates will land.
      this.closeCandidateSink(ctx.outcome.runId)
    }
    if (!ctx.outcome || !ctx.cwd) return

    const runContext = (ctx as unknown as { runContext?: { memoryCandidates?: MemoryCandidate[]; userMessage?: string } }).runContext
    const candidates = runContext?.memoryCandidates ?? []
    const userMessage = runContext?.userMessage ?? ''

    if (candidates.length === 0) return

    // v0.5.3 Final (task 3): build a real RevisionBinding from the
    // workspace. Non-git fallback returns workspaceHash, never a
    // fabricated commit.
    const binding: RevisionBinding = await buildRevisionBinding({ cwd: ctx.cwd })

    const decision = decidePromotion({
      candidates,
      outcome: ctx.outcome,
      userMessage,
      revision: binding,
    })

    for (const promo of [...decision.successPromotions, ...decision.failurePromotions]) {
      try {
        this.longTerm.record(promo.memoryInput)
      } catch {
        // If a single record is rejected (e.g. commit-binding still
        // missing for an unexpected content shape), drop and
        // continue — we do not let one bad candidate break the run.
      }
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

// ── LongTermMemory-backed search (replaces the semantic mirror) ──────────
function createMemorySearchToolLTM(ltm: LongTermMemory, getRepo: () => string): Tool {
  return {
    name: 'memory_search',
    metadata: { readOnly: true, concurrencySafe: true },
    definition: {
      type: 'function',
      function: {
        name: 'memory_search',
        description: 'Search long-term memory by keywords/tags. Returns verified entries sorted by confidence and recency.',
        parameters: {
          type: 'object',
          properties: {
            query: { type: 'string', description: 'Keywords to search for in memory content' },
            tags: { type: 'array', items: { type: 'string' }, description: 'Tags to filter by' },
            limit: { type: 'number', description: 'Max results (default: 10)' },
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
      const records = ltm.query({
        kind: 'semantic',
        verified: true,
        // v0.5.3 Final (P0 issue): per-project isolation. A's memory
        // does NOT leak into B's prompt / search results.
        repo: getRepo(),
        fullText: query || undefined,
        tag: tags[0],
        limit,
      })
      if (records.length === 0) {
        return Promise.resolve({ content: 'No matching memories found.', isError: false })
      }
      const lines = records.map((r, i) => {
        const tagStr = r.tags.length > 0 ? ` [${r.tags.join(', ')}]` : ''
        return `${i + 1}. (${r.kind}) ${r.content}${tagStr} (conf: ${r.confidence})`
      })
      return Promise.resolve({
        content: `Found ${records.length} memor${records.length === 1 ? 'y' : 'ies'}:\n\n${lines.join('\n')}`,
        isError: false,
      })
    },
  }
}

// (RevisionBinding comes from src/core/revisionBinding.ts — the
// stub above was deleted; the real implementation lives in that
// module. Keeping this comment as a breadcrumb so future readers
// understand why neither `workspaceHash` nor `buildRevisionBinding`
// are defined here.)
