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
 * Consolidate a session's verified LongTermMemory records.
 *
 * v0.5.3 Final (task 6): the previous implementation:
 *   - read episodic events (full session including failures),
 *   - called LLM to extract knowledge,
 *   - wrote each entry with verified=false + repo='session' + a
 *     fabricated sessionRunId.
 *
 * Result: every consolidation entry was `gateRejected` because
 * verified=false semantic entries fail R1, AND the artificial
 * 'session' repo + 'session-${Date.now()}' runId violated the
 * RevisionBinding contract.
 *
 * New implementation (Option A from spec):
 *   1. Read already-VERIFIED LongTermMemory records that carry a
 *      sourceRunId from the current session (episodes alone are not
 *      trusted — they are unverified by definition).
 *   2. Group records by content similarity (exact contentKey match).
 *   3. For each group: synthesize a Candidate that cites every
 *      constituent sourceRunId.
 *   4. Run decidePromotion. Failure runs → drops. Success runs →
 *      Candidate with origin='reflection:consolidation' and a
 *      `sourceRunIds:<...>` tag listing every contributing run.
 *   5. The promoter stamps verified=true only when the run that
 *      CALLS consolidateSession is itself a completed run; the
 *      pass-through requirement is that the caller passes its
 *      own outcome + userMessage.
 *
 * If no verified LongTermMemory records are present in the
 * current session, consolidation is a no-op (NOT an error) — the
 * previous implementation always produced output regardless of
 * input, which masked broken flows.
 */
export async function consolidateSession(opts: {
  client: OpenAI
  model: string
  longTerm: LongTermMemory
  sessionRunIds: string[] // real Run IDs from this session
  outcomeForCaller?: import('../core/runtime/turnOutcome.js').TurnOutcome
  userMessage?: string
  cwd: string
  poor?: { enabled: boolean }
}): Promise<{
  sourceRecords: number
  candidates: number
  promoted: number
  promotionFailed: number
}> {
  if (opts.poor?.enabled) {
    return { sourceRecords: 0, candidates: 0, promoted: 0, promotionFailed: 0 }
  }

  const longTerm = opts.longTerm
  // Filter LongTermMemory records by this session's real Run IDs.
  // We only read verified=true semantic records — anything else
  // would have a fabrication problem (R5 already demoted it).
  const candidates: Array<{
    content: string
    tags: string[]
    confidence: number
    sourceRunIds: string[]
  }> = []

  const seen = new Map<string, number>() // contentKey → idx in candidates
  let sourceRecords = 0
  for (const runId of opts.sessionRunIds) {
    const records = longTerm.query({ kind: 'semantic', verified: true, sourceRunId: runId, limit: 50 })
    for (const r of records) {
      sourceRecords++
      // contentKey reuses the merge key shape from LongTermMemory —
      // sha256(repo|kind|content.toLowerCase().trim()).
      const key = `${r.repo || ''}|${r.kind}|${r.content.trim().toLowerCase()}`
      const existingIdx = seen.get(key)
      if (existingIdx !== undefined) {
        candidates[existingIdx].confidence = Math.max(candidates[existingIdx].confidence, r.confidence)
        candidates[existingIdx].sourceRunIds.push(runId)
      } else {
        seen.set(key, candidates.length)
        candidates.push({
          content: r.content,
          tags: [...r.tags, 'session-consolidation'],
          confidence: r.confidence,
          sourceRunIds: [runId],
        })
      }
    }
  }

  if (candidates.length === 0) {
    return { sourceRecords: 0, candidates: 0, promoted: 0, promotionFailed: 0 }
  }

  // Promote via the gate that protects memory_write. Build
  // MemoryCandidates from the synthesized entries, run the gate
  // against a dummy completion context. The caller must pass a
  // successful outcome; otherwise we only write failure entries.
  const { decidePromotion } = await import('../core/memoryCandidate.js')
  const memoryCandidates = candidates.map((c) => ({
    id: `mc_consolidate_${Math.random().toString(36).slice(2)}`,
    runId: opts.sessionRunIds[0] ?? 'unknown',
    content: c.content,
    claimedSource: 'tool_observed' as const,
    tags: c.tags,
    confidence: c.confidence,
    createdAt: new Date().toISOString(),
  }))

  const dummyOutcome = opts.outcomeForCaller ?? {
    runId: opts.sessionRunIds[0] ?? 'unknown',
    stopReason: 'error' as const,
    completion: { status: 'failed' as const, reasons: [], evidence: [], requiredNextActions: [] },
    output: '',
    changedFiles: [],
    artifacts: [],
    verification: { executed: false, passed: false, failed: [] },
    modelAttempts: [],
    durationMs: 0,
    stopped: true,
    reason: 'consolidation-default-failed',
  }

  const decision = decidePromotion({
    candidates: memoryCandidates,
    outcome: dummyOutcome,
    userMessage: opts.userMessage ?? '',
    revision: { repo: opts.cwd, dirty: false },
  })

  let promoted = 0
  let promotionFailed = 0
  for (const promo of [...decision.successPromotions, ...decision.failurePromotions]) {
    try {
      longTerm.record({ ...promo.memoryInput, sourceRunId: opts.sessionRunIds[0] ?? 'unknown' })
      promoted++
    } catch {
      promotionFailed++
    }
  }

  return { sourceRecords, candidates: candidates.length, promoted, promotionFailed }
}
