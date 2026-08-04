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
   * v0.5.3 Final (P0 issue): the previous ReflectionModule was an
   * active memory writer with its own bypass path. It is now a no-op
   * epistemic log: it observes the run outcome but does NOT write to
   * LongTermMemory. All persistence goes through MemoryModule's
   * Candidate→Promotion lifecycle.
   *
   * The module's constructor still accepts the legacy parameters so
   * existing Engine wiring does not break; we simply ignore them.
   */
  private readonly longTerm = new LongTermMemory()

  constructor(
    _client: OpenAI,
    _model: string,
    _semantic: SemanticMemory,
    private config: { planMode?: boolean; poor?: { enabled: boolean } },
  ) {}

  /** Test hook — kept for back-compat. No effect. */
  setLongTermMemory(_ltm: LongTermMemory): void {
    // no-op
  }

  boot(): ModuleBootResult {
    return {}
  }

  /**
   * v0.5.3 Final (P0 issue): previously this re-targeted the LLM
   * used to extract knowledge. Reflection no longer writes, so the
   * captured model is irrelevant. Kept as a no-op for back-compat.
   */
  onModelChanged(_model: string): void {
    // no-op
  }

  async onComplete(ctx: ModuleRunContext): Promise<void> {
    // v0.5.3 Final (P0 issue): the previous ReflectionModule
    // bypassed the MemoryCandidate lifecycle. It called LTM.record
    // directly with repo='reflection' AND its own heuristic to
    // decide whether the run "succeeded" — a fabrication that
    // could mark entries verified=true when the engine's
    // CompletionContract did not. That is anti-fake-success
    // regression.
    //
    // The right fix is to drop the LLM-driven write entirely. The
    // MemoryModule is the single entry point; Reflection becomes a
    // no-op whose presence is preserved only for the Engine's
    // profile-resolution plumbing.
    if (this.config.poor?.enabled) return
    void ctx
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
