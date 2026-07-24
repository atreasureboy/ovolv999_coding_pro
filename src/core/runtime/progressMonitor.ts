/**
 * ProgressMonitor + StallDetector (eight_goal Phase 4).
 *
 * The long-running-autonomy guard layer. The model alone cannot be
 * trusted to notice it has stalled ("两小时后提前宣布完成", "反复搜索但
 * 没有修改", "重复执行相同失败命令"). These pure modules turn real
 * execution signals into structured progress snapshots and stall
 * verdicts, so the loop can intervene (replan / escalate / block)
 * instead of pretending success.
 *
 * Meaningful progress (eight_goal §六) — only these reset the stall
 * timer:
 *   - a new file changed / a real patch produced
 *   - verification delta improved (fewer failing tests / errors)
 *   - a task node completed
 *   - a blocked condition cleared
 * Explicitly NOT meaningful: re-reading the same file, re-running the
 * same failing command, editing only a todo/plan doc, emitting a plan.
 */

export interface ProgressSnapshot {
  iteration: number
  changedFiles: string[]
  verificationDelta: number // change in failing-test/error count (negative = improved)
  newArtifacts: string[]
  repeatedToolCalls: number // calls repeated with identical input in-window
  repeatedErrors: number // consecutive identical error results
  minutesSinceLastMeaningfulProgress: number
  remainingAcceptanceCriteria: string[]
}

export type StallVerdict =
  | { kind: 'progressing' }
  | { kind: 'soft-stall'; reason: string; action: 'summarize-and-replan' }
  | { kind: 'hard-stall'; reason: string; action: 'escalate-critic' }
  | { kind: 'repeated-failure'; reason: string; action: 'root-cause-subtask' }
  | { kind: 'budget-pressure'; reason: string; action: 'narrow-scope' }
  | { kind: 'blocked'; reason: string; action: 'report-blocked' }

export interface StallThresholds {
  /** Minutes without meaningful progress before soft stall. */
  softStallMinutes: number
  /** Minutes before a soft stall escalates to hard stall. */
  hardStallMinutes: number
  /** Consecutive identical errors before root-cause escalation. */
  repeatedErrorLimit: number
  /** Identical-input tool-call repetitions counted as "no progress". */
  repeatedToolCallLimit: number
  /** Budget-remaining fraction below which scope narrows. */
  budgetPressureFraction: number
}

export const DEFAULT_THRESHOLDS: StallThresholds = {
  softStallMinutes: 10,
  hardStallMinutes: 25,
  repeatedErrorLimit: 3,
  repeatedToolCallLimit: 3,
  budgetPressureFraction: 0.2,
}

interface ToolCallKey { tool: string; inputFingerprint: string }
interface WindowedToolCall { tool: string; inputFingerprint: string; errFingerprint: string | null; patchHash: string | null; ts: number }

/**
 * Records execution signals and produces snapshots + stall verdicts.
 * Pure given the recorded state — no I/O, no timers internally (the
 * caller drives iteration count + elapsed-minutes).
 *
 * v0.3.1 (te_goal §六.2): the legacy `lastToolCall` + `lastErrorFingerprint`
 * detectors are augmented with a RingBuffer of recent calls so the
 * detector can spot A→B→A→B cycles (a single alternating pattern with
 * A≠B) and the same error repeated with different parameters. The
 * patchHash field also tracks per-file content hashes so re-running an
 * Edit that produces the identical bytes is NOT counted as progress.
 */
export class ProgressMonitor {
  /** v0.3.1 (te_goal §六.1 + §十一.14): TaskNode transition sink so
   *  task completion / failure feeds the same progress timer that
   *  tool calls do. Wired by Engine when a TaskGraph is created. */
  private graphSink: ((transition: 'started' | 'verifying' | 'completed' | 'failed' | 'blocked' | 'cancelled' | 'unblocked') => void) | null = null

  setGraphEventSink(sink: ((transition: 'started' | 'verifying' | 'completed' | 'failed' | 'blocked' | 'cancelled' | 'unblocked') => void) | null): void {
    this.graphSink = sink
  }

  /** Called by Engine when a TaskGraph node transitions. Terminal
   *  transitions (completed/failed/cancelled/unblocked) mark progress. */
  recordTaskNodeTransition(transition: 'started' | 'verifying' | 'completed' | 'failed' | 'blocked' | 'cancelled' | 'unblocked'): void {
    if (transition === 'completed' || transition === 'failed' || transition === 'cancelled' || transition === 'unblocked') {
      this.markProgress()
    }
  }

  private changedFiles = new Set<string>()
  private artifacts = new Set<string>()
  private remainingAcceptance: string[] = []
  private lastVerificationFailures = 0
  private verificationDelta = 0
  private iteration = 0
  private lastToolCall: ToolCallKey | null = null
  private repeatedToolCalls = 0
  private consecutiveErrors = 0
  private lastErrorFingerprint: string | null = null
  /** Elapsed-minutes value at the last meaningful progress (flushed lazily). */
  private lastMeaningfulProgressMin = 0
  /** Set by internal detectors (changed file etc.); flushed to minutes on snapshot. */
  private pendingProgress = false
  /** v0.3.1: sliding-window fingerprint detector. Length=8 covers A→B→A→B
   *  patterns with margin; older entries are evicted FIFO. */
  private readonly window: WindowedToolCall[] = []
  private static readonly WINDOW_SIZE = 8
  /** per-file content-hash → set of hashes seen. Used to detect when a
   *  re-edit produces the SAME bytes (no progress) vs. new bytes. */
  private readonly patchHashes = new Map<string, Set<string>>()

  constructor(private readonly thresholds: StallThresholds = DEFAULT_THRESHOLDS) {}

  /** Advance one iteration. Call at the top of each loop turn. */
  tick(): void {
    this.iteration++
  }

  setAcceptanceCriteria(items: string[]): void {
    this.remainingAcceptance = items.slice()
  }

  /** Mark a criterion satisfied (removed from remaining). */
  satisfyCriterion(criterion: string): void {
    const before = this.remainingAcceptance.length
    this.remainingAcceptance = this.remainingAcceptance.filter((c) => c !== criterion)
    if (this.remainingAcceptance.length < before) this.markProgress()
  }

  /**
   * Record a tool call result. Detects changed files, repeated calls,
   * and consecutive identical errors — the inputs to stall detection.
   *
   * v0.3.1: accepts an optional `patchHash` argument. When provided
   * and the bytes for a given file_path haven't changed, the call
   * does NOT mark progress even if the tool reported success.
   */
  recordToolCall(
    tool: string,
    input: Record<string, unknown>,
    result: { isError: boolean; content: string },
    patchHash?: string,
  ): void {
    const fp = fingerprint(input)
    const key: ToolCallKey = { tool, inputFingerprint: fp }
    if (this.lastToolCall && this.lastToolCall.tool === tool && this.lastToolCall.inputFingerprint === fp) {
      this.repeatedToolCalls++
    } else {
      this.repeatedToolCalls = 0
    }
    this.lastToolCall = key

    // v0.3.1: error fingerprint uses only the message prefix (first
    // 200 chars) so the same failure with slightly different args
    // still counts as "same error" (root-cause pattern).
    let errFp: string | null = null
    if (result.isError) {
      errFp = fingerprint({ msg: result.content.slice(0, 200) })
      if (errFp === this.lastErrorFingerprint) this.consecutiveErrors++
      else { this.consecutiveErrors = 1; this.lastErrorFingerprint = errFp }
    } else {
      this.consecutiveErrors = 0
      this.lastErrorFingerprint = null
    }

    // A successful Write/Edit changes a real file → meaningful progress,
    // BUT only if the bytes are different from any prior edit to the
    // same file (te_goal §六.2: "同一文件继续产生新的 patch hash
    // 应被视为新进展").
    if (!result.isError && (tool === 'Edit' || tool === 'Write' || tool === 'NotebookEdit')) {
      const path = typeof input.file_path === 'string' ? input.file_path : ''
      if (path) {
        if (!this.changedFiles.has(path)) {
          this.changedFiles.add(path)
          // Record the first hash so a later same-hash re-edit is
          // recognised as identical and does NOT mark progress.
          if (patchHash) {
            const seen = new Set<string>([patchHash])
            this.patchHashes.set(path, seen)
          }
          this.markProgress()
        } else if (patchHash) {
          const seen = this.patchHashes.get(path) ?? new Set<string>()
          if (!seen.has(patchHash)) {
            seen.add(patchHash)
            this.patchHashes.set(path, seen)
            this.markProgress()
          }
          // Same hash → no progress (the edit is byte-identical to a
          // previous one — common when the model "redoes" the same fix).
        }
      }
    }

    // Maintain the sliding window. Push then evict.
    this.window.push({ tool, inputFingerprint: fp, errFingerprint: errFp, patchHash: patchHash ?? null, ts: Date.now() })
    while (this.window.length > ProgressMonitor.WINDOW_SIZE) this.window.shift()
  }

  /**
   * v0.3.1: record multiple verdict fingerprints from a sub-agent
   * (e.g. N agents that each say "this approach failed"). When all
   * agree, the run is making no progress.
   */
  recordMultiAgentVerdict(fingerprints: string[]): boolean {
    if (fingerprints.length < 2) return false
    const first = fingerprints[0]
    if (fingerprints.every((f) => f === first)) {
      // All agents agree on the same failure → treat as a hard signal
      this.consecutiveErrors = Math.max(this.consecutiveErrors, 1) + 1
      return true
    }
    return false
  }

  /**
   * Record a verification result. A drop in failures is meaningful
   * progress; a rise or no change is not.
   */
  recordVerification(failingCount: number): void {
    const delta = failingCount - this.lastVerificationFailures
    this.verificationDelta = delta
    if (delta < 0) this.markProgress()
    this.lastVerificationFailures = failingCount
  }

  recordArtifact(name: string): void {
    if (!this.artifacts.has(name)) {
      this.artifacts.add(name)
      this.markProgress()
    }
  }

  /** Force a progress mark (e.g. a task node completed externally). */
  markProgress(): void {
    this.pendingProgress = true
  }

  snapshot(elapsedMinutes: number): ProgressSnapshot {
    if (this.pendingProgress) {
      this.lastMeaningfulProgressMin = elapsedMinutes
      this.pendingProgress = false
    }
    return {
      iteration: this.iteration,
      changedFiles: [...this.changedFiles],
      verificationDelta: this.verificationDelta,
      newArtifacts: [...this.artifacts],
      repeatedToolCalls: this.repeatedToolCalls,
      repeatedErrors: this.consecutiveErrors,
      minutesSinceLastMeaningfulProgress: Math.max(0, elapsedMinutes - this.lastMeaningfulProgressMin),
      remainingAcceptanceCriteria: this.remainingAcceptance.slice(),
    }
  }

  /**
   * Decide whether the run is stalled. Caller passes elapsed minutes
   * + remaining budget fraction. Returns a verdict the loop acts on.
   *
   * v0.3.1: in addition to time-based and consecutive-error detection,
   * this recognises A→B→A→B tool-call patterns and "same error
   * different params" patterns via the windowed detector.
   */
  detectStall(elapsedMinutes: number, budgetRemainingFraction = 1): StallVerdict {
    const t = this.thresholds
    const snap = this.snapshot(elapsedMinutes)

    if (this.consecutiveErrors >= t.repeatedErrorLimit) {
      return { kind: 'repeated-failure', reason: `${this.consecutiveErrors} consecutive identical errors`, action: 'root-cause-subtask' }
    }
    if (this.detectABABPattern()) {
      return { kind: 'repeated-failure', reason: 'A→B→A→B tool-call pattern detected (alternating repeat)', action: 'root-cause-subtask' }
    }
    if (budgetRemainingFraction < t.budgetPressureFraction) {
      return { kind: 'budget-pressure', reason: `budget remaining ${Math.round(budgetRemainingFraction * 100)}%`, action: 'narrow-scope' }
    }
    if (snap.minutesSinceLastMeaningfulProgress >= t.hardStallMinutes) {
      return { kind: 'hard-stall', reason: `no meaningful progress for ${Math.round(snap.minutesSinceLastMeaningfulProgress)} min`, action: 'escalate-critic' }
    }
    if (snap.minutesSinceLastMeaningfulProgress >= t.softStallMinutes) {
      return { kind: 'soft-stall', reason: `no meaningful progress for ${Math.round(snap.minutesSinceLastMeaningfulProgress)} min`, action: 'summarize-and-replan' }
    }
    if (this.repeatedToolCalls >= t.repeatedToolCallLimit) {
      return { kind: 'soft-stall', reason: `${this.repeatedToolCalls} repeated identical tool calls`, action: 'summarize-and-replan' }
    }
    return { kind: 'progressing' }
  }

  /**
   * v0.3.1: A→B→A→B detector. The window holds tool fingerprints in
   * time order. We look for two distinct fingerprints A and B such
   * that the last >=4 entries follow A,B,A,B (or B,A,B,A). A and B
   * must differ; the same call repeated 4× in a row is caught by
   * `repeatedToolCalls` instead.
   */
  private detectABABPattern(): boolean {
    if (this.window.length < 4) return false
    const last4 = this.window.slice(-4)
    const a = last4[0]
    const b = last4[1]
    if (a.inputFingerprint === b.inputFingerprint) return false // same-tool, not alternating
    const expect1 = [a.inputFingerprint, b.inputFingerprint, a.inputFingerprint, b.inputFingerprint]
    const expect2 = [b.inputFingerprint, a.inputFingerprint, b.inputFingerprint, a.inputFingerprint]
    const got = last4.map((w) => w.inputFingerprint)
    if (expect1.every((fp, i) => fp === got[i])) return true
    if (expect2.every((fp, i) => fp === got[i])) return true
    return false
  }
}

/** Deterministic JSON fingerprint for repeat detection. */
function fingerprint(value: unknown): string {
  try {
    return JSON.stringify(stableSort(value))
  } catch {
    return String(value)
  }
}

/**
 * Phase 4 intervention: map a stall verdict to a `role:system` nudge to
 * inject into the message history (NOT a user message — system is the
 * runtime-context role, so it doesn't forge user input or pollute the
 * user-visible transcript). Returns null when no intervention is due
 * (progressing, or already-blocked which the terminal transition handles).
 *
 * Pure + deterministic → unit-testable independently of real elapsed time.
 */
export function interventionMessageForStall(verdict: StallVerdict): { role: 'system'; content: string } | null {
  switch (verdict.kind) {
    case 'progressing':
      return null
    case 'blocked':
      return null // terminal-transition handles blocked
    case 'soft-stall':
      return {
        role: 'system',
        content: `[runtime stall guard · soft] ${verdict.reason}. Summarise the concrete evidence you have so far (files changed, tests still failing, root cause hypotheses) and change approach. Do not repeat the same tool calls or commands that have already failed to make progress.`,
      }
    case 'hard-stall':
      return {
        role: 'system',
        content: `[runtime stall guard · hard] ${verdict.reason}. STOP the current line of attack. Re-analyse from first principles: what is the actual blocker? If you cannot make further verifiable progress, state the blocker explicitly instead of pretending success.`,
      }
    case 'repeated-failure':
      return {
        role: 'system',
        content: `[runtime stall guard · repeated failure] ${verdict.reason}. Stop retrying the identical failing command. Diagnose the root cause before attempting it again, or pivot to a different command.`,
      }
    case 'budget-pressure':
      return {
        role: 'system',
        content: `[runtime stall guard · budget] ${verdict.reason}. Narrow scope: prioritise the core acceptance criteria and drop non-essential work so the task can still finish within budget.`,
      }
    default:
      return null
  }
}
function stableSort(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableSort)
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const k of Object.keys(value).sort()) {
      out[k] = stableSort((value as Record<string, unknown>)[k])
    }
    return out
  }
  return value
}
