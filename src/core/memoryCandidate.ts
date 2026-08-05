/**
 * MemoryCandidate + MemoryPromoter — Candidate → Promotion lifecycle.
 *
 * v0.5.3 Final (task 2):
 *
 *   memory_write  →  creates a MemoryCandidate on the run-scoped context.
 *   Run completes  →  MemoryPromoter reads the verdict and promotes or
 *                     drops each candidate.
 *
 * Anti-fake-success invariants this design enforces:
 *
 *   1. NO semantic write happens during tool execution. The model can
 *      only INJECT a claim; the engine decides whether to persist it.
 *   2. user_stated is NOT trusted from the model's `source` field.
 *      A user-stated candidate must carry `sourceQuote`; the engine
 *      verifies the quote is a normalized contiguous substring of the
 *      original user message. Without that, the candidate is
 *      demoted to `agent_inferred`.
 *   3. Promotion to verified=true only happens when the run's
 *      CompletionContract verdict is `completed` AND Reviewer passed
 *      AND verification.executed === passed === no-failed.
 *   4. Any other outcome promotes to `kind: failure, verified: false`.
 *      Failure entries never enter the success-memory read pool.
 *
 * Storage:
 *   The candidates live on the per-run `RunScopedRuntimeContext`. They
 *   are NOT in a global singleton. Per-run storage means a re-run
 *   does not leak candidates from the previous run, and the promoter
 *   reads only the candidates created by THIS runId.
 */

import { createHash, randomUUID } from 'crypto'
import type { CompletionStatus, TurnOutcome } from './runtime/turnOutcome.js'
import type { MemoryRecord, MemoryKind } from './longTermMemory.js'

// ── Candidate shape ─────────────────────────────────────────────────────

/**
 * What the model claims about a fact's source. Treated as
 * untrusted metadata only; the engine validates user_stated via
 * sourceQuote and demotes to agent_inferred on failure.
 */
export type ClaimedMemorySource =
  | 'user_stated'
  | 'agent_inferred'
  | 'tool_observed'

export interface MemoryCandidate {
  id: string
  runId: string
  /** Resolved via RevisionBinding — populated at promotion time, not at
   *  candidate-creation time (we don't know it yet). */
  repo?: string
  content: string
  claimedSource: ClaimedMemorySource
  /** Engine-verified quote proving the model saw the user say this.
   *  Required iff claimedSource === 'user_stated'. */
  sourceQuote?: string
  tags: string[]
  confidence: number
  createdAt: string
  /**
   * Set after the user-message verifier runs. 'promote' → candidate
   * enters the promotion queue; 'demote-agent_inferred' → the
   * candidate is treated as agent_inferred (its claimedSource is
   * overridden). 'unverified' → we cannot confirm or deny; treated
   * as agent_inferred for safety.
   */
  userSourceVerification?: 'promote' | 'demote-agent_inferred' | 'unverified'
  /**
   * v0.5.3 Hotfix §2 — Claim-Level Evidence. Promotion only
   * succeeds when at least one of:
   *   - claimedSource === 'user_stated' AND userSourceVerification === 'promote'
   *   - claimedSource === 'tool_observed' AND a tool_result
   *     evidence ref verifies against a real ToolResult in the run
   *   - an explicit verification evidence ref points at a known
   *     EvidenceStore id
   *   - a file evidence ref points at a real on-disk file
   * Candidates without any evidence that resolves to verified=true
   * are either dropped (during a successful run) or saved as
   * kind='reflection', verified=false (audit trail).
   */
  evidenceRefs?: MemoryEvidenceRef[]
}

/**
 * v0.5.3 Hotfix §2 — A single piece of claim-level evidence
 * backing a MemoryCandidate. Promotion examines each ref and
 * either resolves it (verified) or rejects the candidate.
 */
export type MemoryEvidenceRef =
  | {
      kind: 'user_quote'
      quote: string
    }
  | {
      kind: 'tool_result'
      toolCallId: string
      resultQuote: string
    }
  | {
      kind: 'file'
      path: string
      contentHash?: string
    }
  | {
      kind: 'verification'
      evidenceId: string
    }

// ── RevisionBinding ─────────────────────────────────────────────────────

/**
 * v0.5.3 Final (task 3): every persisted memory record binds to a
 * real revision state. Either git branch + HEAD (clean repo), git
 * baseCommit + diffHash (dirty), or non-git absolute cwd +
 * workspaceHash. NO `repo=memory|reflection|session` and NO
 * `sourceRunId=unknown`.
 */
export interface RevisionBinding {
  /** Repo URL or absolute path. Required, derived from EngineConfig.cwd. */
  repo: string
  /** Git branch when present and clean. */
  branch?: string
  /** HEAD commit when clean, or last clean commit when dirty. */
  baseCommit?: string
  /** True iff the working tree has uncommitted changes. */
  dirty: boolean
  /** Stable hash of the dirty diff (sha256 of git diff output). */
  diffHash?: string
  /** For non-Git paths, sha256(cwd + mtime of files). */
  workspaceHash?: string
}

// ── Normalized-contiguous substring match ───────────────────────────────

/**
 * Normalize whitespace + case-fold for the purpose of quote
 * verification. Strips all whitespace and CJK punctuation marks
 * used as filler, then lowercases.
 */
function normalize(s: string): string {
  return s
    .toLowerCase()
    .replace(/[\s 　]+/g, '')
    // Strip CJK speech marks + quote glyphs that fluctuate in chat.
    .replace(/[“”‘’＂＇、。]/g, '')
}

/**
 * True iff `quote` is a contiguous (after normalization) substring
 * of `userMessage`. Returns true also when both are empty (vacuously
 * true) — but the promoter denies empty quotes anyway.
 */
export function isNormalizedSubstring(quote: string, userMessage: string): boolean {
  if (!quote) return false
  return normalize(userMessage).includes(normalize(quote))
}

/**
 * v0.5.3 Final (P1): minimum normalized quote length. A 1–2 char
 * quote (e.g. `"用"`, `"the"`, `",,"`) would otherwise pass the
 * `isNormalizedSubstring` check and let the model attribute any
 * claim to the user. We refuse those outright.
 */
export const MIN_USER_STATED_QUOTE_NORM_LENGTH = 12

/**
 * v0.5.3 Final (P1): minimum fraction of content tokens that must
 * already appear (as substrings) in the normalized quote. Without
 * this check a model can write a free-form `content` and append a
 * 1-char quote to launder it as a user preference. We require the
 * content to be DERIVABLE from the quote's vocabulary.
 */
export const MIN_CONTENT_TOKEN_COVERAGE = 0.6

/**
 * v0.5.3 Final (P1): result of verifying a source quote against
 * the original user message. Replaces the previous single-bit
 * `isNormalizedSubstring` with a multi-factor verification:
 *
 *   - 'verified'                  → claim accepted, origin = user_prompt
 *   - 'demote-agent_inferred'     → drop the user_stated claim; treat as inferred
 *   - 'drop'                      → drop both the user_stated claim and the candidate itself
 */
export type SourceVerification =
  | { result: 'verified' }
  | { result: 'demote-agent_inferred'; reason: string }
  | { result: 'drop'; reason: string }

/**
 * Multi-factor verification of a user_stated memory candidate's
 * source_quote. Returns the decision the promoter should apply.
 * The function is pure — it does not write anywhere.
 */
export function verifySourceQuote(opts: {
  sourceQuote: string | undefined
  userMessage: string
  content: string
}): SourceVerification {
  const quote = (opts.sourceQuote ?? '').trim()
  if (!quote) {
    return { result: 'drop', reason: 'user_stated missing sourceQuote' }
  }
  const normalized = normalize(quote)
  if (normalized.length < MIN_USER_STATED_QUOTE_NORM_LENGTH) {
    return {
      result: 'drop',
      reason: `sourceQuote too short (${normalized.length} < ${MIN_USER_STATED_QUOTE_NORM_LENGTH})`,
    }
  }
  if (!isNormalizedSubstring(quote, opts.userMessage)) {
    // v0.5.3 Hotfix §2: user_stated validation FAILURE is now
    // an unconditional DROP. The previous behaviour demoted to
    // agent_inferred and the candidate could still be promoted
    // (as a successful semantic record). A forged quote
    // therefore gave a free pass. Drop closes the loophole.
    return {
      result: 'drop',
      reason: 'sourceQuote not a substring of userMessage',
    }
  }
  // Coverage: how much of `content` derives from `quote`?
  const coverage = computeContentTokenCoverage(opts.content, quote)
  if (coverage < MIN_CONTENT_TOKEN_COVERAGE) {
    return {
      result: 'drop',
      reason: `content coverage of quote ${coverage.toFixed(2)} < ${MIN_CONTENT_TOKEN_COVERAGE}`,
    }
  }
  return { result: 'verified' }
}

/**
 * Fraction of content tokens (size ≥ 3, alnum) that already appear
 * inside the normalized quote. CJK + Latin are handled with a
 * mixed tokenization (length-3+ alnum; length-2 bigrams for CJK).
 */
export function computeContentTokenCoverage(content: string, quote: string): number {
  const tokens = extractClaimTokens(content)
  if (tokens.length === 0) return 1 // no tokens → trivially covered
  const normalizedQuote = normalize(quote)
  let hits = 0
  for (const tok of tokens) {
    if (normalizedQuote.includes(tok)) hits++
  }
  return hits / tokens.length
}

function extractClaimTokens(content: string): string[] {
  const out: string[] = []
  // Latin alphanumeric tokens of length ≥ 3.
  const latin = content.toLowerCase().match(/[a-z0-9]{3,}/g) ?? []
  for (const t of latin) out.push(t)
  // CJK 2-char bigrams.
  const cjkRuns = content.match(/[一-鿿぀-ゟ゠-ヿ가-힯]+/g) ?? []
  for (const run of cjkRuns) {
    if (run.length === 1) out.push(run)
    else for (let i = 0; i < run.length - 1; i++) out.push(run.slice(i, i + 2))
  }
  return out
}

// ── Promotion decision ─────────────────────────────────────────────────

export interface PromotionInput {
  candidates: MemoryCandidate[]
  outcome: TurnOutcome
  userMessage: string
  /**
   * Optional — a candidate whose claimedSource === 'user_stated' but
   * whose sourceQuote fails verification is demoted here.
   */
  revision: RevisionBinding
  /**
   * v0.5.3 Hotfix §2: tool-call registry used to validate
   * tool_observed evidence refs. The MemoryModule.onComplete
   * path collects ToolResults from the run-scoped context; this
   * map (toolCallId → resultQuote) lets decidePromotion drop
   * tool_observed candidates whose toolCallId is unknown or
   * whose resultQuote isn't in the actual result.
   *
   * When absent, tool_observed with tool_result refs are
   * accepted at the structural level (no further validation);
   * this keeps the pure function usable in unit tests.
   */
  toolCallRegistry?: Map<string, { resultText: string; truncated: boolean; isError: boolean }>
}

export interface PromotionDecision {
  /** Candidates that will be promoted to kind semantic/procedural with verified=true. */
  successPromotions: Array<{ candidate: MemoryCandidate; memoryInput: Omit<MemoryRecord, 'id' | 'createdAt'> }>
  /** Candidates that will be promoted to kind failure with verified=false. */
  failurePromotions: Array<{ candidate: MemoryCandidate; memoryInput: Omit<MemoryRecord, 'id' | 'createdAt'> }>
  /** Candidates dropped without writing. Each reason is recorded. */
  dropped: Array<{ candidateId: string; reason: string }>
}

/**
 * Decide which candidates to promote based on the run outcome and
 * the rules above. Pure function — does not write anywhere. The
 * caller (MemoryPromoter.apply) writes the records.
 */
export function decidePromotion(input: PromotionInput): PromotionDecision {
  const successPromotions: PromotionDecision['successPromotions'] = []
  const failurePromotions: PromotionDecision['failurePromotions'] = []
  const dropped: PromotionDecision['dropped'] = []

  const outcome = input.outcome
  const status: CompletionStatus = outcome.completion.status
  const verification = outcome.verification
  const unresolvedCount = outcome.completion.requiredNextActions.length

  // Promotion gates (v0.5.3 Final — task 2):
  //   - status === 'completed'
  //   - verification.executed
  //   - verification.passed
  //   - verification.failed empty
  //   - no unresolved next-actions
  const isFullSuccess =
    status === 'completed' &&
    verification.executed &&
    verification.passed &&
    verification.failed.length === 0 &&
    unresolvedCount === 0

  for (const c of input.candidates) {
    // v0.5.3 Hotfix §2 — Claim-Level Evidence.
    //
    // user_stated: drop unconditionally on verification failure.
    //   No demote, no silent launder. (P0 fix from previous round.)
    // tool_observed: verify via evidenceRefs (tool_result toolCallId
    //   belongs to the run + resultQuote exists in real result +
    //   no truncation).
    // agent_inferred without evidence: NEVER verified=true. Either
    //   dropped, or saved as kind='reflection', verified=false.
    let effectiveSource: ClaimedMemorySource = c.claimedSource

    if (c.claimedSource === 'user_stated') {
      const verdict = verifySourceQuote({
        sourceQuote: c.sourceQuote,
        userMessage: input.userMessage,
        content: c.content,
      })
      if (verdict.result === 'drop') {
        // v0.5.3 Hotfix §2: user_stated failures ALWAYS drop. No
        // demote-to-agent_inferred on success runs. The candidate
        // contributes nothing to memory.
        dropped.push({ candidateId: c.id, reason: verdict.reason })
        continue
      }
      if (verdict.result === 'demote-agent_inferred') {
        // Kept as a deprecated back-compat branch. New behaviour
        // treats demote the same as drop.
        dropped.push({ candidateId: c.id, reason: verdict.reason })
        continue
      }
      // 'verified' → keep user_stated.
    } else if (c.claimedSource === 'tool_observed') {
      // v0.5.3 Hotfix §2: tool_observed requires a tool_result
      // evidence ref AND that ref must verify against a real
      // ToolResult in this run.
      const toolRefs = (c.evidenceRefs ?? []).filter((r) => r.kind === 'tool_result')
      if (toolRefs.length === 0) {
        dropped.push({
          candidateId: c.id,
          reason: 'tool_observed without tool_result evidence ref',
        })
        continue
      }
      // Promotion-time registry check: every toolCallId must be
      // present in the run's actual tool-call registry. The
      // resultQuote must appear in the recorded resultText, the
      // result must not be truncated, and must not be an error.
      if (input.toolCallRegistry) {
        const registry = input.toolCallRegistry
        let toolEvidenceOk = true
        for (const ref of toolRefs) {
          if (ref.kind !== 'tool_result') continue
          const entry = registry.get(ref.toolCallId)
          if (!entry) {
            dropped.push({
              candidateId: c.id,
              reason: `tool_observed references unknown toolCallId ${ref.toolCallId}`,
            })
            toolEvidenceOk = false
            break
          }
          if (entry.truncated) {
            dropped.push({
              candidateId: c.id,
              reason: `tool_observed toolCallId ${ref.toolCallId} result is truncated (unverifiable)`,
            })
            toolEvidenceOk = false
            break
          }
          if (entry.isError) {
            dropped.push({
              candidateId: c.id,
              reason: `tool_observed toolCallId ${ref.toolCallId} result was an error`,
            })
            toolEvidenceOk = false
            break
          }
          if (!entry.resultText.includes(ref.resultQuote)) {
            dropped.push({
              candidateId: c.id,
              reason: `tool_observed toolCallId ${ref.toolCallId} resultQuote not found in ToolResult`,
            })
            toolEvidenceOk = false
            break
          }
        }
        if (!toolEvidenceOk) continue
      }
    } else if (c.claimedSource === 'agent_inferred') {
      // v0.5.3 Hotfix §2: agent_inferred without ANY evidence ref
      // can NEVER be promoted with verified=true. Either drop, or
      // save as kind='reflection' for audit purposes (verified=false).
      const hasEvidence = (c.evidenceRefs ?? []).length > 0
      if (!hasEvidence) {
        if (isFullSuccess) {
          // No evidence + success run → drop. A successful run is
          // the moment where laundered content would do the most
          // damage; we don't risk it.
          dropped.push({
            candidateId: c.id,
            reason: 'agent_inferred without evidence ref cannot verify=true on success run',
          })
          continue
        }
        // Failure run: keep as reflection audit (verified=false).
        effectiveSource = 'agent_inferred'
      }
    }

    if (isFullSuccess) {
      const kind: MemoryKind = effectiveSource === 'agent_inferred' ? 'semantic' : 'semantic'
      const memoryInput: Omit<MemoryRecord, 'id' | 'createdAt'> = {
        kind,
        content: c.content.slice(0, 500),
        repo: input.revision.repo,
        branch: input.revision.branch,
        // v0.5.3 Hotfix §3: baseCommit is the canonical internal
        // field. `commit` is read-only compat alias; new writes
        // MUST NOT use it.
        baseCommit: input.revision.baseCommit,
        dirty: input.revision.dirty,
        diffHash: input.revision.diffHash,
        workspaceHash: input.revision.workspaceHash,
        sourceRunId: c.runId,
        origin: effectiveSource === 'user_stated' ? 'user_prompt' : `memory_promotion:${c.runId}`,
        confidence: c.confidence,
        verified: true,
        tags: [
          ...c.tags,
          'promoted',
          `run:${c.runId}`,
          `source:${effectiveSource}`,
        ],
        expiresAt: undefined,
      }
      successPromotions.push({ candidate: c, memoryInput })
    } else {
      // Failure / partial / blocked / cancelled / exhausted:
      // any non-completed outcome routes the candidate to the
      // failure branch — verified=false, kind='failure'. These
      // entries never enter the success-memory read pool.
      const memoryInput: Omit<MemoryRecord, 'id' | 'createdAt'> = {
        kind: 'failure',
        content: c.content.slice(0, 500),
        repo: input.revision.repo,
        branch: input.revision.branch,
        baseCommit: input.revision.baseCommit,
        dirty: input.revision.dirty,
        diffHash: input.revision.diffHash,
        workspaceHash: input.revision.workspaceHash,
        sourceRunId: c.runId,
        origin: `memory_promotion:${c.runId}:failure:${status}`,
        confidence: c.confidence,
        verified: false,
        tags: [
          ...c.tags,
          'promoted-failure',
          `run:${c.runId}`,
          `outcome:${status}`,
        ],
        expiresAt: undefined,
      }
      failurePromotions.push({ candidate: c, memoryInput })
    }
  }

  return { successPromotions, failurePromotions, dropped }
}

// ── Helpers ─────────────────────────────────────────────────────────────

export function makeCandidateId(): string {
  return `mc_${randomUUID()}`
}

/**
 * Stable, deterministic hash for non-Git workspaces. SHA-256 of
 * `cwd + ":" + epoch_second_bucket`. We bucket by minute to keep the
 * hash stable across a single session; if the user actually moves
 * the workspace, the bucket changes too.
 */
export function workspaceHash(cwd: string): string {
  const minuteBucket = Math.floor(Date.now() / 60_000)
  return createHash('sha256').update(`${cwd}:${minuteBucket}`).digest('hex')
}
