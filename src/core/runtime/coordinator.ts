/**
 * RuntimeCoordinator — owns the Think → Act → Observe main loop.
 *
 * Responsibilities (from replan.md §5.1):
 *   - Boot the runtime for a turn (delegated to boot.ts)
 *   - Drive the state-machine loop (boot → check_abort → budget_check →
 *     module_iteration → llm_call → continuation_check → parse_response →
 *     tool_execution → check_abort …)
 *   - Delegate ALL concrete work to subsystems:
 *       ModelGateway   → LLM API calls
 *       ContextManager → budget + compaction
 *       ToolScheduler  → partition + execute tool calls
 *       ModuleManager  → lifecycle hooks
 *       ToolRegistry   → tool registration + lookup
 *   - Emit RunEvents at every state transition
 *   - Decide termination via TerminationPolicy
 *   - Clean up in finally (abort controller, soft-abort ownership)
 *
 * Does NOT:
 *   - Parse stream chunks directly (StreamConsumer's job)
 *   - Execute tools directly (ToolExecutor's job)
 *   - Compact context directly (ContextManager's job)
 *   - Check permissions directly (ToolExecutor's job)
 *   - Register tools directly (ToolRegistry's job, via boot.ts)
 */

import type {
  EngineConfig,
  OpenAIMessage,
  TurnResult,
  Tool,
  ToolDefinition,
} from '../types.js'
import type { TokenUsage } from '../costTracker.js'
import type { CostTracker } from '../costTracker.js'
import type { BackgroundTaskManager } from '../backgroundTaskManager.js'
import type { FileHistory } from '../fileHistory.js'
import type { PermissionManager } from '../permissionSystem.js'
import type { Renderer } from '../../ui/renderer.js'
import type { EventLog } from '../eventLog.js'
import {
  transitionQueryState,
  isTerminal,
  createBudgetTracker,
  checkTokenBudget,
  type QueryState,
} from '../queryStateMachine.js'
import type { ProgressMonitor } from './progressMonitor.js'
import type { ModelGateway } from '../model/modelGateway.js'
import type { RoutingInput } from '../model/modelRouter.js'
import type { ContextManager } from '../context/contextManager.js'
import type { ToolPolicy } from '../toolRuntime/toolPolicy.js'
import type { ToolScheduler, ParsedToolCall } from '../toolRuntime/toolScheduler.js'
import type { ToolRegistry } from '../toolRuntime/toolRegistry.js'
import type { ModuleManager } from '../moduleRuntime/moduleManager.js'
import type { SharedRuntimeState } from './sharedState.js'
import type { RunEventEmitter } from './events.js'
import { isTerminalRunStatus } from '../executionRun.js'
import type { ExecutionRunRegistry, RunStatus } from '../executionRun.js'
import { buildExecutionContext } from '../executionContext.js'
import { checkTermination } from './terminationPolicy.js'
import { evaluateCompletion } from './completionContract.js'
import { interventionMessageForStall } from './progressMonitor.js'
import { shouldInvokeCritic } from './criticTrigger.js'
import { reviewRun } from './reviewer.js'
import type { TaskGraph } from './taskGraph.js'
import { boot } from './boot.js'

interface StreamingToolCall {
  index: number
  id: string
  name: string
  arguments: string
}

export interface CoordinatorDeps {
  config: EngineConfig
  renderer: Renderer
  eventLog?: EventLog
  costTracker: CostTracker
  backgroundTaskManager: BackgroundTaskManager
  permissionManager: PermissionManager
  fileHistory: FileHistory | null

  modelGateway: ModelGateway
  contextManager: ContextManager
  toolScheduler: ToolScheduler
  toolPolicy: ToolPolicy
  toolRegistry: ToolRegistry
  moduleManager: ModuleManager
  baseTools: Tool[]

  sharedState: SharedRuntimeState
  eventEmitter: RunEventEmitter

  /**
   * Optional ExecutionRun registry (fi_goal §三/§四). When set, the
   * coordinator mints a `kind='turn'` run for each call to `.run()`
   * and walks it through queued → preparing → running → succeeded/failed.
   * Absent = back-compat (no run tracked).
   */
  runRegistry?: ExecutionRunRegistry
  /** Phase 4: progress/stall monitor (queried each iteration). */
  progressMonitor?: ProgressMonitor
  /** Phase 3: task graph — gates completion when it has unfinished nodes. */
  taskGraph?: TaskGraph
  /**
   * Phase 2: per-turn adaptive model routing. Called once after boot
   * with the turn's signals; if it returns a model string, the engine
   * has switched this turn's model. Null = no change / routing off /
   * manual override in effect.
   */
  routeModel?: (input: RoutingInput) => string | null
  /**
   * Parent run id (e.g. a `kind='loop'` run from runLoop). When set,
   * the per-turn run records it as parentRunId for hierarchical queries.
   */
  parentRunId?: string
}

export class RuntimeCoordinator {
  private readonly deps: CoordinatorDeps

  constructor(deps: CoordinatorDeps) {
    this.deps = deps
  }

  async run(
    userMessage: string,
    history: OpenAIMessage[],
    images?: Array<{ path: string; dataUrl: string }>,
    opts?: { parentRunId?: string },
  ): Promise<{ result: TurnResult; newHistory: OpenAIMessage[] }> {
    const { config, renderer, eventLog, sharedState, eventEmitter } = this.deps

    // P1-2 fix: resolve the effective parentRunId ONCE. A per-turn
    // override (opts.parentRunId, e.g. from runLoop's kind='loop' run)
    // takes precedence over the static deps.parentRunId. This threads
    // the hierarchical Run tree so a loop's child turns — and every
    // grandchild Agent/Worker run they spawn — link back to the loop.
    const effectiveParentRunId = opts?.parentRunId ?? this.deps.parentRunId

    eventEmitter.emit({ type: 'RUN_STARTED', userMessage })

    // ── ExecutionRun tracking (GAP-C) ──
    // If a registry is wired in, mint a `kind='turn'` run that
    // reflects this turn's lifecycle. The registry is optional so
    // existing call sites (and tests) that don't supply one keep
    // working byte-for-byte. All registry calls are best-effort: a
    // registry bug must NEVER break the actual turn.
    const registry = this.deps.runRegistry
    const runId = registry
      ? registry.create({
          kind: 'turn',
          goal: userMessage.slice(0, 200),
          workspace: { cwd: config.cwd },
          parentRunId: effectiveParentRunId,
        }).runId
      : undefined
    if (runId && registry) {
      try {
        registry.transition(runId, 'preparing', { phase: 'boot' })
      } catch { /* best-effort */ }
    }

    // ── Boot Sequence ──
    let bootResult
    try {
      bootResult = await boot({
        userMessage,
        history,
        images,
        config,
        baseTools: this.deps.baseTools,
        sharedState,
        moduleManager: this.deps.moduleManager,
        contextManager: this.deps.contextManager,
        toolPolicy: this.deps.toolPolicy,
        toolRegistry: this.deps.toolRegistry,
        permissionManager: this.deps.permissionManager,
        backgroundTaskManager: this.deps.backgroundTaskManager,
        fileHistory: this.deps.fileHistory,
        eventLog,
        eventEmitter,
      })
    } catch (bootErr) {
      const msg = (bootErr as Error).message || String(bootErr)
      if (runId && registry) {
        try { registry.transition(runId, 'failed', { phase: 'boot', error: msg }) } catch { /* best-effort */ }
      }
      throw bootErr
    }
    if (runId && registry) {
      try {
        registry.transition(runId, 'running', { phase: 'llm' })
      } catch { /* best-effort */ }
    }

    const { systemPrompt, toolDefs, toolContext, messages, turnAbortController } = bootResult
    const planMode = sharedState.planModeActive

    // five_goal P0-2: propagate the per-turn ExecutionContext through
    // ToolContext so tools (AgentTool, ClaudeCodeTool, Workflow, ...)
    // can read the current runId + parentRunId dynamically. The old
    // pattern of caching parentRunId in a Tool's constructor broke
    // for multi-turn reuse because every turn had a different RunId.
    if (runId) {
      toolContext.execution = buildExecutionContext({
        runId,
        parentRunId: effectiveParentRunId,
        cwd: config.cwd,
        signal: turnAbortController.signal,
        model: config.model,
      })
    }

    // ── State machine driver ──
    let state: QueryState = transitionQueryState({ kind: 'boot' }, { type: 'booted' })

    // Phase 2: adaptive model routing — one decision per turn, after
    // boot, before the first LLM call. Driven by goal complexity +
    // context usage (not every iteration, to avoid thrashing). Honours
    // manual override + routing-enabled (handled in the engine callback).
    if (this.deps.routeModel) {
      try {
        const routed = this.deps.routeModel({
          userGoal: userMessage,
          // contextUsageRatio omitted at turn start (context is just
          // system prompt + user msg); the router defaults to no pressure.
        })
        if (routed) renderer.info(`Model routed to ${routed} (adaptive)`)
      } catch { /* best-effort: routing must never break the turn */ }
    }

    // v0.3.1 (te_goal §五): reset the TaskGraph at the start of each
    // turn so turn 2 doesn't inherit turn 1's nodes.
    this.deps.taskGraph?.reset()

    // P0-2 (continuation output completeness): collect EVERY assistant
    // text segment emitted during this turn — including continuation
    // segments after `finish_reason='length'`, budget-continuation
    // segments, and inter-tool-iteration text — and concatenate them
    // for the final TurnResult.output. Previously `finalOutput` was
    // OVERWRITTEN on each LLM round, so multi-segment turns surfaced
    // only the last fragment to hooks, event subscribers, and the UI
    // even though the message history accumulated all segments.
    // The invariant guaranteed here is:
    //   result.output === concat(all assistant segments in order)
    //                  === sum of new assistant `content` added this turn
    const turnAssistantSegments: string[] = []
    const computeFinalOutput = (): string => turnAssistantSegments.join('')
    let lastToolName: string | undefined
    let pendingToolCalls: StreamingToolCall[] = []
    let pendingParsedCalls: ParsedToolCall[] = []
    const enableContinuation = config.enableContinuation ?? false
    const turnTokenBudget =
      config.turnTokenBudget ?? this.deps.contextManager.effectiveMaxOutputTokens(config.maxOutputTokens) * 4
    const budgetTracker = createBudgetTracker()
    let turnTokensProduced = 0
    let emptyResponseCount = 0
    const MAX_EMPTY_RETRIES = 2
    let lengthRetryCount = 0
    const MAX_LENGTH_RETRIES = 3

    let result: TurnResult
    const turnStartMs = Date.now()
    let stallInterventionApplied = false // dedupe: one system nudge per stall episode

    try {
      while (!isTerminal(state)) {
        switch (state.kind) {
          case 'check_abort': {
            const decision = checkTermination({
              hardAborted: turnAbortController.signal.aborted,
              softAborted: this.deps.sharedState.claimSoftAbort(turnAbortController),
              iteration: state.iteration,
              maxIterations: config.maxIterations,
            })
            if (decision.kind === 'hard_abort') {
              eventEmitter.emit({ type: 'ABORT_REQUESTED', kind: 'hard', reason: 'user_cancelled' })
              state = transitionQueryState(state, { type: 'hard_abort', output: computeFinalOutput() })
            } else if (decision.kind === 'soft_abort') {
              eventEmitter.emit({ type: 'ABORT_REQUESTED', kind: 'soft', reason: 'user_interrupt' })
              state = transitionQueryState(state, { type: 'soft_abort', output: computeFinalOutput() })
            } else if (decision.kind === 'max_iterations') {
              eventEmitter.emit({ type: 'MAX_ITERATIONS_REACHED', maxIterations: decision.maxIterations })
              renderer.warn(`Max iterations (${decision.maxIterations}) reached`)
              state = transitionQueryState(state, { type: 'max_iterations', output: computeFinalOutput() })
            } else {
              // Phase 4: stall detection. Before continuing, ask the
              // ProgressMonitor whether the run has stalled. On a non-
              // progressing verdict, surface a warning + structured event
              // (observable via /trace). Active replan-injection is the
              // InternalControlMessage (Phase 1.2) follow-up; detection is
              // live here so stalls never pass silently.
              const pm = this.deps.progressMonitor
              if (pm) {
                pm.tick()
                const elapsedMin = (Date.now() - turnStartMs) / 60_000
                const verdict = pm.detectStall(elapsedMin, 1)
                if (verdict.kind !== 'progressing') {
                  renderer.warn(`Stall detected (${verdict.kind}): ${verdict.reason} → suggested: ${verdict.action}`)
                  eventEmitter.emit({ type: 'STALL_DETECTED', kind: verdict.kind, reason: verdict.reason, action: verdict.action })
                  // Phase 4 active intervention: inject a role:system nudge
                  // (NOT a user message) once per stall episode to force a
                  // strategy change. Reset when progress resumes.
                  const nudge = interventionMessageForStall(verdict)
                  if (nudge && !stallInterventionApplied) {
                    messages.push(nudge)
                    stallInterventionApplied = true
                  }
                } else {
                  stallInterventionApplied = false
                }
                // v0.3.1: critic is now single-track — the risk signal is
                // computed in module_iteration and passed to CriticModule
                // via criticRequested. No separate coordinator injection.
              }
              eventEmitter.emit({ type: 'ITERATION_STARTED', iteration: state.iteration })
              state = transitionQueryState(state, { type: 'continue' })
            }
            break
          }

          case 'budget_check': {
            await this.deps.contextManager.evaluateBudget({ messages, toolDefs, abortSignal: turnAbortController.signal })
            state = transitionQueryState(state, { type: 'continue' })
            break
          }

          case 'module_iteration': {
            // v0.3.1 (te_goal §六.3): single-track critic. The coordinator
            // computes the risk signal here and passes criticRequested to
            // the module. CriticModule is the SOLE critic actuator (LLM
            // review); the coordinator no longer injects its own critic
            // guidance. This eliminates the dual-critic problem.
            let criticRequested = false
            const pmSnap = this.deps.progressMonitor
            if (pmSnap) {
              const snap = pmSnap.snapshot((Date.now() - turnStartMs) / 60_000)
              const ws = this.deps.contextManager.getWorkingState()
              criticRequested = shouldInvokeCritic({
                snapshot: snap,
                modelClaimingCompletion: false,
                isCoreArchitecture: /architect|refactor|redesign|root cause/i.test(userMessage),
                changedFilesCount: ws.filesChanged.length,
                unresolvedCount: ws.unresolved.length,
                remainingAcceptanceCount: snap.remainingAcceptanceCriteria.length,
              }).invoke
            }
            await this.deps.moduleManager.runIteration({
              iteration: state.iteration,
              messages,
              abortSignal: turnAbortController.signal,
              criticRequested,
            })
            state = transitionQueryState(state, { type: 'continue' })
            break
          }

          case 'llm_call': {
            // five_goal §四: inject WorkingState into the system prompt
            // before each LLM call. The block is empty (and thus a
            // no-op) on the first iteration; after tools run it
            // carries filesRead/filesChanged/verification/unresolved
            // so the model sees structured progress without having
            // to parse its own prior tool outputs.
            const wsBlock = this.deps.contextManager.renderWorkingStateBlock()
            const effectivePrompt = wsBlock ? `${systemPrompt}\n\n${wsBlock}` : systemPrompt
            const { assistantText, finishReason, rawToolCalls } =
              await this.callLLM(effectivePrompt, messages, toolDefs, turnAbortController.signal)

            if (assistantText) {
              turnAssistantSegments.push(assistantText)
              turnTokensProduced += Math.ceil(assistantText.length / 3.5)
            }

            const assistantMsg: OpenAIMessage = {
              role: 'assistant',
              content: assistantText || null,
              tool_calls:
                rawToolCalls.length > 0
                  ? rawToolCalls.map((tc) => ({
                      id: tc.id,
                      type: 'function' as const,
                      function: { name: tc.name, arguments: tc.arguments },
                    }))
                  : undefined,
            }
            messages.push(assistantMsg)
            this.deps.contextManager.stampAssistantMessage()

            eventEmitter.emit({
              type: 'MODEL_COMPLETED',
              assistantText,
              finishReason,
              toolCallCount: rawToolCalls.length,
            })

            if (!assistantText && rawToolCalls.length === 0 && emptyResponseCount < MAX_EMPTY_RETRIES) {
              emptyResponseCount++
              messages.push({
                role: 'system',
                content: '[runtime] Your previous response was empty (no text, no tool call). Please respond with text or invoke a tool.',
              })
              state = transitionQueryState(state, { type: 'continue' })
              break
            }

            if (finishReason === 'length' && rawToolCalls.length === 0 && lengthRetryCount < MAX_LENGTH_RETRIES) {
              lengthRetryCount++
              eventLog?.append('module_flag', 'length_retry', {
                retry: lengthRetryCount,
                max: MAX_LENGTH_RETRIES,
                partial_length: assistantText.length,
              })
              messages.push({
                role: 'system',
                content: '[runtime] Continue your previous response from where it was cut off. Do not repeat what you already wrote — just continue.',
              })
              state = transitionQueryState(state, { type: 'continue' })
              break
            }

            pendingToolCalls = rawToolCalls
            state = transitionQueryState(state, {
              type: 'llm_done',
              finishReason,
              hasToolCalls: rawToolCalls.length > 0,
              output: computeFinalOutput(),
            })
            break
          }

          case 'continuation_check': {
            if (enableContinuation) {
              const decision = checkTokenBudget(budgetTracker, turnTokenBudget, turnTokensProduced)
              if (decision.action === 'continue') {
                eventLog?.append('module_flag', 'continuation', {
                  continuation_count: decision.continuationCount,
                  pct: decision.pct,
                  turn_tokens: decision.turnTokens,
                  budget: decision.budget,
                })
                messages.push({ role: 'system', content: `[runtime] ${decision.nudgeMessage}` })
                state = transitionQueryState(state, { type: 'continue' })
                break
              }
            }
            state = transitionQueryState(state, { type: 'stop' })
            break
          }

          case 'parse_response': {
            const validCalls: ParsedToolCall[] = []
            for (const tc of pendingToolCalls) {
              let input: Record<string, unknown>
              try {
                const parsed: unknown = JSON.parse(tc.arguments || '{}')
                if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
                  const shape = parsed === null
                    ? 'null'
                    : Array.isArray(parsed)
                      ? 'array'
                      : typeof parsed
                  renderer.warn(
                    `Warning: malformed tool arguments for ${tc.name} (expected JSON object, got ${shape}).`,
                  )
                  eventLog?.append('tool_call', tc.name, {
                    parse_error: true,
                    shape,
                    raw_args: tc.arguments.slice(0, 200),
                  })
                  messages.push({
                    role: 'tool',
                    tool_call_id: tc.id,
                    name: tc.name,
                    content: `Tool arguments must be a JSON object, but got ${shape}. Raw args (first 200 chars): ${tc.arguments.slice(0, 200)}. Retry with a JSON object like {"key": "value"}.`,
                  })
                  continue
                }
                input = parsed as Record<string, unknown>
              } catch {
                renderer.warn(`Warning: malformed tool arguments for ${tc.name} (JSON parse failed, likely truncated).`)
                eventLog?.append('tool_call', tc.name, { parse_error: true, raw_args: tc.arguments.slice(0, 200) })
                messages.push({
                  role: 'tool',
                  tool_call_id: tc.id,
                  name: tc.name,
                  content: `Could not parse tool arguments as valid JSON (likely truncated by max_tokens). Raw args (first 200 chars): ${tc.arguments.slice(0, 200)}. Retry with shorter or simpler arguments.`,
                })
                continue
              }
              validCalls.push({ tc, input })
            }

            pendingParsedCalls = validCalls

            if (pendingParsedCalls.length > 0) {
              lastToolName = pendingParsedCalls[pendingParsedCalls.length - 1].tc.name
            }

            state = transitionQueryState(state, { type: 'continue' })
            break
          }

          case 'tool_execution': {
            const { aborted } = await this.deps.toolScheduler.schedule(
              pendingParsedCalls,
              toolContext,
              planMode,
              turnAbortController,
              messages,
              state.iteration,
            )

            const hardAborted = turnAbortController.signal.aborted
            state = transitionQueryState(state, {
              type: 'tools_done',
              aborted: aborted || hardAborted,
              hardAborted,
              output: computeFinalOutput(),
            })
            break
          }

          case 'boot':
            state = transitionQueryState(state, { type: 'booted' })
            break
        }
      }

      if (state.kind === 'complete') {
        result = { stopped: true, reason: state.reason, output: state.output }
      } else {
        result = { stopped: true, reason: 'error', output: computeFinalOutput() }
      }
    } catch (err) {
      const errMsg = (err as Error).message || String(err)
      const errorIteration = 'iteration' in state ? state.iteration : 0
      config.hookRunner?.runOnError?.(err as Error, {
        turnNumber: errorIteration,
        lastToolName,
      })
      renderer.error(`Engine error: ${errMsg}`)
      const errOutput = computeFinalOutput()
      eventEmitter.emit({ type: 'RUN_FAILED', error: errMsg, output: errOutput })
      result = { stopped: true, reason: 'error', output: errOutput || `[Error: ${errMsg}]` }
    } finally {
      if (sharedState.currentTurnAbortController === turnAbortController) {
        sharedState.currentTurnAbortController = null
      }
      if (sharedState.softAbortRequested && sharedState.softAbortOwner === turnAbortController) {
        sharedState.softAbortRequested = false
        sharedState.softAbortOwner = null
      }
    }

    eventEmitter.emit({ type: 'RUN_COMPLETED', result })

    // ── CompletionContract gate (v0.3.1: SINGLE source of truth) ──
    // stop_sequence only means the model stopped. The real verdict comes
    // from evaluateCompletion(). taskKind drives what "done" means:
    // informational (Q&A) doesn't need changes; mutation does.
    let completionVerdict: { status: string; blockers?: string[]; remaining?: string[] } | null = null
    if (result.reason === 'stop_sequence') {
      const ws = this.deps.contextManager.getWorkingState()
      const hasChanges = ws.filesChanged.length > 0
      // v0.3.1: only actual file changes make it a 'mutation' task.
      // Running verification alone (no changes) is informational.
      const taskKind = hasChanges ? 'mutation' : 'informational'
      const tg = this.deps.taskGraph
      const v = evaluateCompletion({
        taskKind,
        acceptanceCriteria: tg && tg.size() > 0 ? tg.snapshot().nodes.flatMap((n) => n.acceptanceCriteria) : [],
        satisfiedCriteria: [],
        verificationExecuted: ws.verification.passed.length + ws.verification.failed.length > 0,
        verificationPassed: ws.verification.failed.length === 0,
        runningChildren: sharedState.activeSubtasks.size,
        unhandledFailures: ws.verification.failed.length,
        changedFiles: ws.filesChanged,
      })
      completionVerdict = v
      if (v.status !== 'completed') {
        const detail = 'blockers' in v && v.blockers ? v.blockers.join('; ')
          : 'remaining' in v && v.remaining ? v.remaining.join('; ')
          : v.status
        renderer.warn(`Completion gate: ${v.status} — ${detail}`)
      }
    }

    // ── ExecutionRun terminal transition (GAP-C) ──
    if (runId && registry) {
      const targetStatus: RunStatus =
        result.reason === 'stop_sequence'
          ? (completionVerdict && completionVerdict.status !== 'completed' ? 'blocked' : 'succeeded')
        : result.reason === 'interrupted' ? 'cancelled'
        : result.reason === 'max_iterations' ? 'blocked'
        : 'failed'
      try {
        const run = registry.get(runId)
        if (run && !isTerminalRunStatus(run.status)) {
          registry.transition(runId, targetStatus, {
            phase: result.reason === 'max_iterations' ? 'iteration-budget-exhausted'
              : completionVerdict && completionVerdict.status !== 'completed' ? `completion-${completionVerdict.status}`
              : 'completed',
            error: targetStatus === 'failed'
              ? (result.output || 'turn failed')
              : targetStatus === 'blocked'
                ? completionVerdict && completionVerdict.status !== 'completed'
                  ? `completion ${completionVerdict.status}: ${('blockers' in completionVerdict && completionVerdict.blockers?.join('; ')) || ('remaining' in completionVerdict && completionVerdict.remaining?.join('; ')) || ''}`
                  : 'turn hit max_iterations ceiling'
                : undefined,
          })
        }
      } catch { /* best-effort: never break the turn result */ }
    }

    // Phase 5: final Reviewer — a deterministic post-run verdict from
    // structured state (NOT the model's self-report). Surfaces partial/
    // blocked loudly so false-success can't hide. Best-effort.
    try {
      const ws = this.deps.contextManager.getWorkingState()
      const review = reviewRun({
        goalPresent: userMessage.trim().length > 0,
        changedFiles: ws.filesChanged,
        verificationExecuted: ws.verification.passed.length + ws.verification.failed.length > 0,
        verificationPassed: ws.verification.failed.length === 0,
        unhandledFailures: ws.verification.failed.length,
        unresolvedBlockers: ws.unresolved.length,
        unsatisfiedAcceptance: 0,
        scopeExcessive: ws.filesChanged.length > 20,
      })
      if (review.verdict !== 'completed') {
        renderer.warn(`Reviewer verdict: ${review.verdict} — ${review.findings.join('; ')}`)
      }
    } catch { /* best-effort */ }

    // ── Module onComplete hooks ──
    await this.deps.moduleManager.runComplete({
      cwd: config.cwd,
      sessionDir: config.sessionDir,
      turnResult: result,
      messages,
      eventLog,
    })

    config.hookRunner?.runOnComplete?.(result)

    return { result, newHistory: messages }
  }

  // ── Helpers ──────────────────────────────────────────────────────────────

  private async callLLM(
    systemPrompt: string,
    messages: OpenAIMessage[],
    toolDefs: ToolDefinition[],
    turnAbortSignal: AbortSignal,
  ): Promise<{
    assistantText: string
    finishReason: string | null
    rawToolCalls: StreamingToolCall[]
    usage: TokenUsage | null
  }> {
    this.deps.eventEmitter.emit({ type: 'MODEL_REQUESTED', model: this.deps.config.model })
    const result = await this.deps.modelGateway.call(
      {
        systemPrompt,
        messages,
        toolDefs,
        model: this.deps.config.model,
        temperature: this.deps.config.temperature,
        maxOutputTokens: this.deps.contextManager.effectiveMaxOutputTokens(this.deps.config.maxOutputTokens),
        abortSignal: turnAbortSignal,
        turnAbortController: this.deps.sharedState.currentTurnAbortController,
      },
      {
        onUsage: (usage, callStartMs) => this.recordUsage(usage, callStartMs),
        onContextOverflow: async (msgs, signal) => {
          return this.deps.contextManager.reactiveCompact(msgs, signal)
        },
      },
    )
    return result
  }

  private recordUsage(usage: TokenUsage | null, callStartMs: number): void {
    if (usage) {
      const durationMs = Date.now() - callStartMs
      this.deps.costTracker.addUsage(this.deps.config.model, usage, durationMs)
      this.deps.eventLog?.append('tool_call', 'llm_api', {
        input_tokens: usage.inputTokens,
        output_tokens: usage.outputTokens,
        duration_ms: durationMs,
      })
    }
  }

}
