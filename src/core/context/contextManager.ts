/**
 * ContextManager — owns token estimation, budget evaluation, compaction
 * orchestration, and snip management. Extracted from engine.ts to
 * isolate context management from the run loop.
 *
 * State ownership:
 * - systemPromptTokens: cached per turn
 * - lastAssistantTs: wall-clock of last assistant message
 * - consecutiveCompactFailures: circuit breaker (max 3)
 * - suppressCompactWarning: one-shot latch
 * - resolvedContextWindow: cached model lookup
 * - pendingSnipCount: queued /snip request
 *
 * Mutates the messages array in place for microCompact, maybeCompact,
 * and snip operations.
 */

import type OpenAI from 'openai'
import type { OpenAIMessage, ToolDefinition, IHookRunner } from '../types.js'
import type { EventLog } from '../eventLog.js'
import type { Renderer } from '../../ui/renderer.js'
import {
  maybeCompactWithInvariants,
  microCompact,
  maybeTimeBasedMicroCompact,
  estimateTokens,
  estimateToolDefinitionTokens,
  getCompressionStrategy,
  CONTEXT_MICROCOMPACT_PCT,
  CONTEXT_WARN_PCT,
  CONTEXT_COMPACT_PCT,
  resolveContextWindow,
  clampMaxOutputTokens,
  effectiveInputBudget,
} from '../compact.js'

/**
 * Read-only snapshot of context budget state. Single source of truth
 * for the Router + Coordinator so the routing signal collector never
 * receives `undefined` for contextUsageRatio / budgetRemaining when
 * ContextManager is wired in. Both Router and evaluateBudget() read
 * from the same underlying estimation functions (estimateTokens +
 * effectiveInputBudget) so the values cannot diverge.
 */
export interface ContextBudgetSnapshot {
  /** v0.5.3 (P1.6): runId this snapshot belongs to. The Router MUST
   *  refuse to consume a snapshot whose runId differs from the
   *  active runId — otherwise a stale previous-turn snapshot
   *  leaks into a fresh turn's routing decision. */
  runId: string | null
  contextWindow: number
  estimatedInputTokens: number
  inputBudget: number
  usageRatio: number
  remainingTokens: number
  remainingRatio: number
  /** Last observed count of consecutive compaction failures (0..3). */
  compactFailureCount: number
  /** True when at least one evaluateBudget() call has run. */
  initialized: boolean
}
import { truncateToolResult, enforceAggregateToolResultBudget } from './toolResultBudget.js'
import {
  emptyWorkingState,
  recordFileRead,
  recordFileChange,
  recordVerification,
  serializeWorkingState,
  type WorkingState,
} from '../workingState.js'

export interface ContextManagerDeps {
  client: OpenAI
  model: string
  maxContextTokens?: number
  maxOutputTokens?: number
  sessionDir?: string
  renderer: Renderer
  eventLog?: EventLog
  hookRunner?: IHookRunner
}

export class ContextManager {
  private deps: ContextManagerDeps

  private systemPromptTokens = 0
  private lastAssistantTs: number | undefined = undefined
  private consecutiveCompactFailures = 0
  private suppressCompactWarning = false
  private resolvedContextWindow: number | null = null
  private pendingSnipCount: number | null = null
  /**
   * v0.5.2 (Stage 2.1): last computed context snapshot. Updated by
   * evaluateBudget() each iteration; read by Router and Coordinator
   * via getBudgetSnapshot(). Avoids passing `undefined` into the
   * routing signal collector when ContextManager is wired in.
   */
  private lastBudgetSnapshot: ContextBudgetSnapshot = {
    runId: null,
    contextWindow: 0,
    estimatedInputTokens: 0,
    inputBudget: 0,
    usageRatio: 0,
    remainingTokens: 0,
    remainingRatio: 0,
    compactFailureCount: 0,
    initialized: false,
  }
  /** v0.5.3 (P1.6): the active runId, set by the Coordinator before
   *  evaluateBudget() runs. The snapshot is stamped with this so
   *  the Router can refuse stale data. */
  private activeRunId: string | null = null
  /**
   * P1-6 (runtime invariants §十): structured task state. Updated deterministically
   * from tool events via applyToolEvent() and re-rendered into every
   * system prompt via renderWorkingStateBlock(). Lives OUTSIDE the
   * message log so compaction cannot silently drop constraints /
   * facts / unresolved items (invariants INV-1..INV-5).
   */
  private workingState: WorkingState = emptyWorkingState()

  constructor(deps: ContextManagerDeps) {
    this.deps = deps
  }

  // ── Accessors ──────────────────────────────────────────────────────────

  get contextWindow(): number {
    if (this.resolvedContextWindow === null) {
      this.resolvedContextWindow = resolveContextWindow(
        this.deps.model,
        this.deps.maxContextTokens,
      )
    }
    return this.resolvedContextWindow
  }

  effectiveMaxOutputTokens(maxOutputTokens?: number): number {
    return clampMaxOutputTokens(maxOutputTokens ?? this.deps.maxOutputTokens, this.contextWindow)
  }

  /**
   * P0-1 (transactional model switch): invalidate every piece of state
   * derived from `model` so the next call sees the new model's context
   * window, max-output clamp, and budget thresholds. Without this,
   * `engine.setModel()` left ContextManager pointing at the OLD model
   * — meaning budget evaluation, compaction thresholds, max_tokens
   * sent to the LLM, AND compaction summarization requests all used
   * the OLD model's parameters (or hit the OLD model outright).
   *
   * The deps object is intentionally `readonly` so callers cannot
   * mutate individual fields; we replace the whole reference here to
   * keep the constructor's "deps is a snapshot" invariant intact.
   */
  onModelChanged(model: string): void {
    if (this.deps.model === model) return
    this.deps = { ...this.deps, model }
    this.resolvedContextWindow = null
  }

  // ── WorkingState (P1-6, P1-7 / runtime invariants §十) ────────────────────────
  //
  // The WorkingState is the structured long-term memory. It is:
  //   - updated deterministically from tool events via applyToolEvent()
  //   - rendered into every system prompt via renderWorkingStateBlock()
  //   - preserved across compaction (invariants INV-1..INV-5)
  //
  // The model never gets to freely overwrite the whole state — only
  // deterministic events from tool results mutate it. This avoids the
  // failure mode where the model hallucinates "verification passed"
  // in a free-text summary.

  /** Replace the entire WorkingState. Use for tests + session restore. */
  setWorkingState(state: WorkingState): void {
    this.workingState = state
  }

  /** Read-only snapshot of the current WorkingState. */
  getWorkingState(): Readonly<WorkingState> {
    return this.workingState
  }

  /**
   * Render the WorkingState as a text block for inclusion in the
   * system prompt. Caller is responsible for actually concatenating
   * it into the prompt — ContextManager does NOT mutate the prompt.
   */
  renderWorkingStateBlock(): string {
    return serializeWorkingState(this.workingState)
  }

  /**
   * P1-6 (runtime invariants §十): apply a deterministic state update from a
   * completed tool call. Rules:
   *
   *   Read success     → filesRead += path
   *   Edit/Write succ  → filesChanged += path
   *   Bash exit=0      → verification.passed += command
   *   Bash exit!=0     → verification.failed += command
   *                      unresolved += "Bash failed: <cmd>"
   *
   * Unknown tools / errored calls are no-ops. The state is replaced
   * immutably so any snapshots taken earlier remain stable.
   */
  applyToolEvent(params: {
    toolName: string
    input: Record<string, unknown>
    result: { isError?: boolean; content?: string; exitCode?: number; status?: string }
  }): void {
    const { toolName, input, result } = params
    let s = this.workingState

    if (result.isError !== false && result.status !== 'success' && result.status !== 'blocked') {
      // Most error paths leave the state untouched — failures don't
      // mutate filesRead / filesChanged. Bash failures get recorded
      // below as verification.failed. Agent/Worker blocked results
      // are handled below (status === 'blocked' passes through).
      if (!(toolName === 'Bash')) return
    }

    if (toolName === 'Read' && typeof input.file_path === 'string') {
      s = recordFileRead(s, input.file_path)
    } else if ((toolName === 'Edit' || toolName === 'Write') && typeof input.file_path === 'string') {
      s = recordFileChange(s, input.file_path)
    } else if (toolName === 'Bash' && typeof input.command === 'string') {
      const cmd = input.command
      const exitCode = result.exitCode
      const passed = !result.isError && (exitCode === undefined || exitCode === 0)
      s = recordVerification(s, cmd, passed)
      if (!passed) {
        // runtime invariants §十: 测试失败 → unresolved 添加失败摘要
        s = { ...s, unresolved: [...s.unresolved, `Bash failed (exit ${exitCode ?? '?'}): ${cmd.slice(0, 120)}`] }
      } else {
        // Resolve any prior unresolved entries for THIS command (any
        // exit code). The previous failure's summary had a different
        // exit-code suffix, so we filter by command prefix instead
        // of exact-string match.
        const prefix = `: ${cmd.slice(0, 120)}`
        s = {
          ...s,
          unresolved: s.unresolved.filter(u => !u.includes('Bash failed') || !u.endsWith(prefix)),
        }
      }
    } else if ((toolName === 'Agent' || toolName === 'ClaudeCode') &&
               result.status === 'blocked') {
      // runtime invariants §四: Agent/Worker blocked → unresolved
      s = {
        ...s,
        unresolved: [...s.unresolved, `${toolName} blocked: ${(result.content ?? '').slice(0, 120)}`],
      }
    }

    this.workingState = s
  }

  // ── Turn lifecycle ─────────────────────────────────────────────────────

  beginTurn(systemPrompt: string): void {
    this.systemPromptTokens = Math.ceil(systemPrompt.length / 3.5) + 20
  }

  stampAssistantMessage(): void {
    this.lastAssistantTs = Date.now()
  }

  /**
   * v0.5.2 (Stage 2.1): read-only budget snapshot. The single
   * source of truth that the Router and Coordinator read to compute
   * contextUsageRatio / budgetRemaining. Reuses the same estimation
   * functions as evaluateBudget() so the values cannot drift.
   *
   * Before evaluateBudget() has run at least once, `initialized=false`
   * and ratio fields are 0 — callers must check `initialized` and
   * treat the snapshot as 'unknown' rather than 'empty context'.
   */
  getBudgetSnapshot(): ContextBudgetSnapshot {
    return this.lastBudgetSnapshot
  }

  /** v0.5.3 (P1.6): set the runId before evaluateBudget() so the
   *  snapshot carries it. The Router cross-checks the snapshot's
   *  runId against this.activeRunId. */
  setActiveRunId(runId: string | null): void {
    this.activeRunId = runId
  }

  getActiveRunId(): string | null {
    return this.activeRunId
  }

  // ── Budget evaluation ──────────────────────────────────────────────────

  /**
   * v0.5.3 Final (task 9): PURE measurement. No LLM, no message
   * mutation. Publishes a fresh snapshot and returns the same
   * snapshot so the Router (and the Coordinator) read the CURRENT
   * state without us having to mutate anything. AbortError propagates
   * out — only clearly-recoverable best-effort errors get swallowed.
   */
  measureBudget(params: {
    messages: OpenAIMessage[]
    toolDefs?: ToolDefinition[]
  }): ContextBudgetSnapshot {
    const { messages, toolDefs } = params
    const maxCtxTokens = this.contextWindow
    const messageTokens = estimateTokens(messages)
    const toolDefTokens = estimateToolDefinitionTokens(toolDefs)
    const totalTokens = messageTokens + this.systemPromptTokens + toolDefTokens
    const inputBudget = effectiveInputBudget(maxCtxTokens, this.deps.maxOutputTokens)
    const pct = totalTokens / inputBudget
    const remainingTokens = Math.max(0, inputBudget - totalTokens)
    const snapshot: ContextBudgetSnapshot = {
      runId: this.activeRunId,
      contextWindow: maxCtxTokens,
      estimatedInputTokens: totalTokens,
      inputBudget,
      usageRatio: pct,
      remainingTokens,
      remainingRatio: Math.max(0, Math.min(1, remainingTokens / inputBudget)),
      compactFailureCount: this.consecutiveCompactFailures,
      initialized: true,
    }
    this.lastBudgetSnapshot = snapshot
    return snapshot
  }

  /**
   * v0.5.3 Final (task 9): apply the budget policy on top of an
   * already-measured snapshot. This step MAY mutate messages (when
   * compaction fires) and MAY call the LLM. After mutation the
   * caller MUST re-measure so the Router sees post-compaction state.
   */
  async applyBudgetPolicy(params: {
    messages: OpenAIMessage[]
    toolDefs?: ToolDefinition[]
    snapshot: ContextBudgetSnapshot
    abortSignal?: AbortSignal
  }): Promise<ContextBudgetSnapshot> {
    const { messages, toolDefs, snapshot: prev, abortSignal } = params
    const suppressWarning = this.suppressCompactWarning
    this.suppressCompactWarning = false

    const pct = prev.usageRatio
    const shouldMicroCompact = pct >= CONTEXT_MICROCOMPACT_PCT
    const shouldWarn = pct >= CONTEXT_WARN_PCT
    const shouldCompact = pct >= CONTEXT_COMPACT_PCT
    const strategy = getCompressionStrategy(pct)

    if (!shouldCompact) {
      const tbResult = maybeTimeBasedMicroCompact(messages, this.lastAssistantTs)
      if (tbResult.compacted) {
        this.deps.eventLog?.append('context_compact', 'engine', {
          type: 'time_based_microcompact',
          tokens_before: tbResult.tokensBefore,
          tokens_after: tbResult.tokensAfter,
          tools_cleared: tbResult.toolsCleared,
        })
      }
    }

    if (shouldMicroCompact && !shouldCompact) {
      const mcResult = microCompact(messages)
      if (mcResult.compacted) {
        this.deps.eventLog?.append('context_compact', 'engine', {
          type: 'microcompact',
          tokens_before: mcResult.tokensBefore,
          tokens_after: mcResult.tokensAfter,
          tools_cleared: mcResult.toolsCleared,
        })
      }
    }

    if (this.deps.sessionDir && shouldWarn && !suppressWarning) {
      this.deps.renderer.contextWarning(prev.estimatedInputTokens, prev.contextWindow, pct)
    }

    if (shouldCompact && this.consecutiveCompactFailures < 3) {
      this.deps.renderer.compactStart(prev.estimatedInputTokens)
      this.deps.eventLog?.append('context_compact', 'engine', {
        strategy,
        tokens_before: prev.estimatedInputTokens,
        system_prompt_tokens: this.systemPromptTokens,
        pct,
      })

      let compactResult
      try {
        compactResult = await maybeCompactWithInvariants(
          this.deps.client,
          this.deps.model,
          messages,
          this.workingState,
          () => this.workingState,
          abortSignal,
        )
      } catch (err) {
        // AbortError propagates — caller decides whether to cancel.
        if ((err as { name?: string }).name === 'AbortError') throw err
        // Other transport errors increment the failure counter; the
        // snapshot is RE-measured from the unchanged messages.
        this.consecutiveCompactFailures++
        if (this.consecutiveCompactFailures >= 3) {
          this.deps.renderer.warn(
            `Auto-compact failed ${this.consecutiveCompactFailures} consecutive times — skipping further attempts. Consider starting a new session.`,
          )
        }
        return this.measureBudget({ messages, toolDefs })
      }

      if (compactResult.compacted) {
        messages.length = 0
        messages.push(...compactResult.messages)
        this.deps.renderer.compactDone(
          compactResult.originalTokens,
          compactResult.summaryTokens,
        )
        this.deps.eventLog?.append('context_compact', 'engine', {
          tokens_after: compactResult.summaryTokens,
          reduction: compactResult.originalTokens - compactResult.summaryTokens,
        })
        this.consecutiveCompactFailures = 0
        this.suppressCompactWarning = true
        void this.deps.hookRunner?.runOnContextOverflow?.(
          compactResult.originalTokens,
          compactResult.summaryTokens,
        )
        // v0.5.3 Final (task 9): re-measure AFTER compaction so the
        // Router reads the post-compaction usage, not the value that
        // triggered compaction.
        return this.measureBudget({ messages, toolDefs })
      } else {
        this.consecutiveCompactFailures++
        if (this.consecutiveCompactFailures >= 3) {
          this.deps.renderer.warn(
            `Auto-compact failed ${this.consecutiveCompactFailures} consecutive times — skipping further attempts. Consider starting a new session.`,
          )
        }
        return this.measureBudget({ messages, toolDefs })
      }
    }

    return prev
  }

  /**
   * v0.5.3 Final (task 9): BACKWARDS-COMPAT wrapper. Calls
   * measureBudget + applyBudgetPolicy + re-measure. New callers
   * should call measureBudget/applyBudgetPolicy directly so the
   * 'measure → route → apply → re-measure' invariant is explicit.
   */
  async evaluateBudget(params: {
    messages: OpenAIMessage[]
    toolDefs?: ToolDefinition[]
    abortSignal?: AbortSignal
  }): Promise<void> {
    const snapshot = this.measureBudget(params)
    await this.applyBudgetPolicy({
      messages: params.messages,
      toolDefs: params.toolDefs,
      snapshot,
      abortSignal: params.abortSignal,
    })
  }

  // ── Snip management ────────────────────────────────────────────────────

  queueSnip(keepRecent: number): void {
    if (typeof keepRecent === 'number' && keepRecent >= 0) {
      this.pendingSnipCount = Math.floor(keepRecent)
    }
  }

  applySnip(
    messages: OpenAIMessage[],
    keepRecent: number,
    reason?: string,
  ): { removed: number; tokensFreed: number } {
    const total = messages.length
    const removeCount = Math.max(0, total - keepRecent)
    if (removeCount === 0) {
      return { removed: 0, tokensFreed: 0 }
    }

    const tokensBefore = estimateTokens(messages)
    const kept = messages.slice(-keepRecent)
    const boundary: OpenAIMessage = {
      role: 'system',
      content:
        `[runtime snip] ${removeCount} older messages were removed to free context space` +
        (reason ? ` (${reason})` : '') +
        '. Continue working from the current context — earlier details are no longer available.',
    }

    messages.length = 0
    messages.push(boundary, ...kept)

    const tokensAfter = estimateTokens(messages)

    this.deps.eventLog?.append('context_compact', 'snip', {
      type: 'manual_snip',
      removed: removeCount,
      tokens_before: tokensBefore,
      tokens_after: tokensAfter,
      tokens_freed: tokensBefore - tokensAfter,
      reason: reason ?? null,
    })

    return { removed: removeCount, tokensFreed: tokensBefore - tokensAfter }
  }

  consumeQueuedSnip(messages: OpenAIMessage[]): void {
    if (this.pendingSnipCount !== null) {
      const queuedKeep = this.pendingSnipCount
      this.pendingSnipCount = null
      this.applySnip(messages, queuedKeep, 'queued via /snip')
    }
  }

  // ── Reactive compact (overflow recovery) ───────────────────────────────

  /**
   * Attempt compaction after a context-overflow API error.
   * Mutates messages in place on success. Returns true if compacted.
   */
  async reactiveCompact(messages: OpenAIMessage[], abortSignal: AbortSignal): Promise<boolean> {
    // P2-6: invariant-guarded compaction (see evaluateBudget).
    const compactResult = await maybeCompactWithInvariants(
      this.deps.client,
      this.deps.model,
      messages,
      this.workingState,
      () => this.workingState,
      abortSignal,
    )
    if (compactResult.compacted) {
      messages.length = 0
      messages.push(...compactResult.messages)
      this.deps.renderer.compactDone(compactResult.originalTokens, compactResult.summaryTokens)
      return true
    }
    return false
  }

  // ── Tool result budget ─────────────────────────────────────────────────

  truncateToolResult(result: string): string {
    return truncateToolResult(result, this.deps.sessionDir)
  }

  enforceAggregateBudget(
    results: Array<{ content: string; tc: { id: string; name: string } }>,
  ): void {
    enforceAggregateToolResultBudget(results, this.deps.sessionDir)
  }
}
