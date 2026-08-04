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
    // Verify user_stated source. Model-passed `claimedSource` is
    // not trusted — only the sourceQuote proves it.
    let effectiveSource: ClaimedMemorySource = c.claimedSource
    if (c.claimedSource === 'user_stated') {
      if (!c.sourceQuote || c.sourceQuote.length === 0) {
        // No proof — treat as agent_inferred but DROP for failure
        // runs (we don't trust the inferred content either).
        dropped.push({ candidateId: c.id, reason: 'user_stated missing sourceQuote' })
        if (!isFullSuccess) continue
        effectiveSource = 'agent_inferred'
      } else if (!isNormalizedSubstring(c.sourceQuote, input.userMessage)) {
        // Quote doesn't match. Trust NO part of the claim. Demote +
        // drop on failure runs (we're not going to record an inferred
        // fact based on a forged user quote — that's still an
        // attempt to launder fake content).
        dropped.push({ candidateId: c.id, reason: 'user_stated sourceQuote not in userMessage' })
        if (!isFullSuccess) continue
        effectiveSource = 'agent_inferred'
      }
      // else: sourceQuote verified → proceed
    }

    if (isFullSuccess) {
      const kind: MemoryKind = effectiveSource === 'agent_inferred' ? 'semantic' : 'semantic'
      const memoryInput: Omit<MemoryRecord, 'id' | 'createdAt'> = {
        kind,
        content: c.content.slice(0, 500),
        repo: input.revision.repo,
        branch: input.revision.branch,
        commit: input.revision.baseCommit,
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
        commit: input.revision.baseCommit,
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
