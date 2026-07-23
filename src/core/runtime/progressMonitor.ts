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

/**
 * Records execution signals and produces snapshots + stall verdicts.
 * Pure given the recorded state — no I/O, no timers internally (the
 * caller drives iteration count + elapsed-minutes).
 */
export class ProgressMonitor {
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
   */
  recordToolCall(tool: string, input: Record<string, unknown>, result: { isError: boolean; content: string }): void {
    const fp = fingerprint(input)
    const key: ToolCallKey = { tool, inputFingerprint: fp }
    if (this.lastToolCall && this.lastToolCall.tool === tool && this.lastToolCall.inputFingerprint === fp) {
      this.repeatedToolCalls++
    } else {
      this.repeatedToolCalls = 0
    }
    this.lastToolCall = key

    if (result.isError) {
      const errFp = fingerprint({ msg: result.content.slice(0, 200) })
      if (errFp === this.lastErrorFingerprint) this.consecutiveErrors++
      else { this.consecutiveErrors = 1; this.lastErrorFingerprint = errFp }
    } else {
      this.consecutiveErrors = 0
      this.lastErrorFingerprint = null
    }

    // A successful Write/Edit changes a real file → meaningful progress.
    if (!result.isError && (tool === 'Edit' || tool === 'Write' || tool === 'NotebookEdit')) {
      const path = typeof input.file_path === 'string' ? input.file_path : ''
      if (path && !this.changedFiles.has(path)) {
        this.changedFiles.add(path)
        this.markProgress()
      }
    }
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
   */
  detectStall(elapsedMinutes: number, budgetRemainingFraction = 1): StallVerdict {
    const t = this.thresholds
    const snap = this.snapshot(elapsedMinutes)

    if (this.consecutiveErrors >= t.repeatedErrorLimit) {
      return { kind: 'repeated-failure', reason: `${this.consecutiveErrors} consecutive identical errors`, action: 'root-cause-subtask' }
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
}

/** Deterministic JSON fingerprint for repeat detection. */
function fingerprint(value: unknown): string {
  try {
    return JSON.stringify(stableSort(value))
  } catch {
    return String(value)
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
