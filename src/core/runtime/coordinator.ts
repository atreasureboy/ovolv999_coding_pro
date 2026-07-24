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
import type { RoutingInput, ModelRouter } from '../model/modelRouter.js'
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
import { shouldInvokeCritic } from './criticTrigger.js'
import { reviewRun } from './reviewer.js'
import type { TaskGraph } from './taskGraph.js'
import type { TaskGraphStore } from './taskGraphStore.js'
import { ControlMessageLog } from './internalControlMessage.js'
import { collectRoutingSignals, signalsToRoutingInput } from '../model/routingSignalCollector.js'
import {
  InMemoryRunScopedRuntimeContextStore,
  type RunScopedRuntimeContext,
  type RunScopedRuntimeContextStore,
  type CompletionCandidate,
} from './runScopedContext.js'
import { classifyTaskIntent, type TaskIntent } from './taskIntent.js'
import { boot } from './boot.js'
import type { TurnOutcome, ModelCallAttemptSnapshot } from './turnOutcome.js'

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
   * v0.3.1 (te_goal §五): the per-runId task-graph store. The
   * Coordinator uses this to mint a fresh graph for each runId so
   * turn N's graph does not leak into turn M.
   */
  taskGraphStore?: TaskGraphStore
  /**
   * v0.3.2 (ele_goal §Phase 1): the per-runId RunScopedRuntimeContext
   * store. The Coordinator mints a fresh Context for each runId and
   * resolves the SAME Context for the tool, completion contract, and
   * router. Optional — absence falls back to the v0.3.1 taskGraphStore
   * path for back-compat.
   */
  runContextStore?: RunScopedRuntimeContextStore
  /**
   * v0.3.2 (ele_goal §Phase 3): optional override of the taskKind
   * classifier. Production uses the static-rule classifier; tests can
   * inject a mock to make classification deterministic.
   */
  classifyIntent?: (userMessage: string, options: { planMode?: boolean }) => TaskIntent
  /**
   * Phase 2: per-turn adaptive model routing. Called once after boot
   * with the turn's signals; if it returns a model string, the engine
   * has switched this turn's model. Null = no change / routing off /
   * manual override in effect.
   */
  routeModel?: (input: RoutingInput) => string | null
  /**
   * v0.3.1 (te_goal §三.1.3): the ModelRouter handle, used by the
   * coordinator's signal collector to read provider health. Optional —
   * absence just means no live health signals.
   */
  modelRouter?: ModelRouter
  /**
   * Parent run id (e.g. a `kind='loop'` run from runLoop). When set,
   * the per-turn run records it as parentRunId for hierarchical queries.
   */
  parentRunId?: string
}

export class RuntimeCoordinator {
  private readonly deps: CoordinatorDeps
  /** v0.3.2 (ele_goal §Phase 7): per-turn model call attempts so
   *  the TurnOutcome can carry the full fallback chain. */
  private modelCallsThisRun: Array<{
    model: string
    startedAt: number
    endedAt: number
    success: boolean
    error?: string
    usage?: { inputTokens: number; outputTokens: number }
    retryable: boolean
  }> = []

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
    // v0.3.2 (ele_goal §Phase 9): lifecycle start marker. Emitted
    // after RUN_STARTED but before the loop begins, so /trace can
    // show "execution started" distinctly from "run started" (the
    // latter is a logical event, the former a runtime event).
    if (runId) {
      this.deps.eventEmitter.emit({
        type: 'RUN_EXECUTION_STARTED',
        runId,
      } as never)
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
    // boot, before the first LLM call. v0.3.1 (te_goal §三.1.3): collect
    // the FULL signal set (11+ te_goal bullets) before calling the
    // router. Signals are derived from real runtime state (workingState,
    // contextManager, taskGraph, budgetTracker, modelRouter health) plus
    // static goal analysis. The collector also exposes reasonCodes so
    // /route and /why can explain WHY the router chose what it chose.
    if (this.deps.routeModel) {
      try {
        const ws = this.deps.contextManager.getWorkingState()
        const tg = this.deps.taskGraph
        const router = this.deps.modelRouter
        const signals = collectRoutingSignals({
          userMessage,
          workingState: {
            filesRead: [...ws.filesRead],
            filesChanged: [...ws.filesChanged],
            verification: { passed: [...ws.verification.passed], failed: [...ws.verification.failed] },
            unresolved: [...ws.unresolved],
          },
          contextManager: {
            contextUsageRatio: 0, // refined when budget tracker integration ships
            budgetRemaining: 1,
            recentFailureCount: ws.verification.failed.length,
          },
          taskGraph: tg ? {
            nodeCount: tg.size(),
            preferredRoles: tg.list().map((n: { preferredRole?: string }) => n.preferredRole ?? '').filter(Boolean),
            hasConfigChanges: false,
            hasCrossModuleEdits: false,
            hasPublicInterfaceEdits: false,
            hasRootCauseNode: false,
          } : undefined,
          routerHealth: router ? {
            providerHealth: router.listProfiles().map((p: { id: string }) => {
              const h = router.getProfileHealth(p.id)
              return {
                profileId: p.id,
                failRate: h && h.calls > 0 ? h.failures / h.calls : 0,
                avgLatencyMs: h?.ewmaLatency ?? 0,
              }
            }),
            previousRoutingFailures: 0,
          } : undefined,
        })
        const routed = this.deps.routeModel(signalsToRoutingInput(signals))
        if (routed) renderer.info(`Model routed to ${routed} (adaptive)`)
      } catch { /* best-effort: routing must never break the turn */ }
    }

    // v0.3.2 (ele_goal §Phase 1 + §Phase 3): mint a fresh
    // RunScopedRuntimeContext per runId. The Context owns the taskGraph,
    // progressMonitor, controlMessages, routingSignals, taskKind, and
    // completionVerdict. The legacy taskGraphStore path is preserved
    // as a back-compat shim — production should wire runContextStore.
    let runContext: RunScopedRuntimeContext | undefined
    if (runId) {
      const ctxStore = this.deps.runContextStore
      if (ctxStore) {
        runContext = ctxStore.get(runId) ?? ctxStore.create(runId, {
          parentRunId: effectiveParentRunId,
          taskKind: 'informational', // refined below after routing
        })
        // Phase 3: classify intent BEFORE routing so the router
        // can consume the intent signal.
        const planMode = this.deps.sharedState.planModeActive
        const intent = this.deps.classifyIntent
          ? this.deps.classifyIntent(userMessage, { planMode })
          : classifyTaskIntent(userMessage, { planMode })
        runContext.taskKind = intent.kind
        this.deps.eventEmitter.emit({
          type: 'TASK_INTENT_CLASSIFIED',
          runId,
          intent: {
            kind: intent.kind,
            source: intent.source,
            confidence: intent.confidence,
          },
        } as never)
        // The Context's taskGraph is the source of truth.
        this.deps.taskGraph = runContext.taskGraph
      } else {
        // Fallback: legacy taskGraphStore path.
        const store = this.deps.taskGraphStore
        if (store) {
          let graph = store.get(runId)
          if (!graph) graph = store.create(runId)
          this.deps.taskGraph = graph
        }
      }
    } else {
      // No runId → fall back to the legacy single-graph shim.
      this.deps.taskGraph?.reset()
    }

    // Old-style TaskGraph store call (kept for tests that don't
    // wire runContextStore). Best-effort, ignored if runContextStore
    // already set the graph above.
    if (runId && !this.deps.runContextStore) {
      // already handled above
    } else if (!runId) {
      this.deps.taskGraph?.reset()
    }

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
    // v0.3.1 (te_goal §七): typed control messages. The provider sees
    // a snapshot rendered for THIS call; the log is drained after the
    // call so messages do NOT accumulate in the user-visible history.
    const controlMessageLog = new ControlMessageLog()

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
                // v0.3.1 (te_goal §六.1): feed real verification signal
                // into ProgressMonitor each iteration. A drop in failing
                // commands = meaningful progress; no change = stall timer
                // keeps running.
                pm.recordVerification(this.deps.contextManager.getWorkingState().verification.failed.length)
                const elapsedMin = (Date.now() - turnStartMs) / 60_000
                const verdict = pm.detectStall(elapsedMin, 1)
                if (verdict.kind !== 'progressing') {
                  renderer.warn(`Stall detected (${verdict.kind}): ${verdict.reason} → suggested: ${verdict.action}`)
                  eventEmitter.emit({ type: 'STALL_DETECTED', kind: verdict.kind, reason: verdict.reason, action: verdict.action })
                  // v0.3.1 (te_goal §七): emit a typed ICM instead of
                  // pushing a role:system string. The message is
                  // rendered to the provider each turn via
                  // controlMessageLog.renderForProvider(); it does not
                  // accumulate in the user-visible history.
                  if (!stallInterventionApplied && (verdict.kind === 'soft-stall' || verdict.kind === 'hard-stall' || verdict.kind === 'repeated-failure' || verdict.kind === 'budget-pressure')) {
                    controlMessageLog.append({
                      kind: 'stall_replan',
                      level: verdict.kind === 'hard-stall' ? 'hard' : 'soft',
                      reason: verdict.reason,
                    })
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
              // v0.3.1 (te_goal §六.3): modelClaimingCompletion must be
              // TRUE when the model is about to emit stop_sequence
              // (or its final completion). We detect this by the most
              // recent assistant message having no tool calls AND the
              // most recent raw call having finishReason='stop' or
              // 'length'. This is the highest-value CriticTrigger.
              let modelClaimingCompletion = false
              const lastMsg = messages[messages.length - 1]
              if (lastMsg && lastMsg.role === 'assistant' && (!lastMsg.tool_calls || lastMsg.tool_calls.length === 0)) {
                modelClaimingCompletion = true
              }
              criticRequested = shouldInvokeCritic({
                snapshot: snap,
                modelClaimingCompletion,
                isCoreArchitecture: /architect|refactor|redesign|root cause/i.test(userMessage),
                changedFilesCount: ws.filesChanged.length,
                unresolvedCount: ws.unresolved.length,
                remainingAcceptanceCount: snap.remainingAcceptanceCriteria.length,
              }).invoke
              if (criticRequested) {
                this.deps.eventEmitter.emit({
                  type: 'CRITIC_INVOKED',
                  reason: modelClaimingCompletion ? 'model-claiming-completion' : 'risk-signal',
                  modelClaimingCompletion,
                })
              }
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
            // v0.3.1 (te_goal §七): render the typed control messages
            // for this call. We pass them as a SEPARATE array; the
            // callLLM layer prepends them to the assistant-visible
            // history just for this request, then drains the log so
            // they do NOT accumulate as user-visible history.
            const controlMessages = controlMessageLog.renderForProvider()
            // usage is consumed inside callLLM via the recordUsage
            // callback (which feeds costTracker + modelRouter.recordCall).
            const { assistantText, finishReason, rawToolCalls } =
              await this.callLLM(
                effectivePrompt,
                messages,
                toolDefs,
                turnAbortController.signal,
                controlMessages,
              )
            controlMessageLog.clear()

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
              // v0.3.1 (te_goal §七): emit a typed InternalControlMessage
              // and let the LLM-call loop render it for the provider.
              // The message does NOT stay in the user-visible history.
              controlMessageLog.append({
                kind: 'retry_empty_response',
                retryCount: emptyResponseCount,
                max: MAX_EMPTY_RETRIES,
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
              controlMessageLog.append({
                kind: 'continue_after_length',
                remainingTokens: turnTokenBudget - turnTokensProduced,
                partialLength: assistantText.length,
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
                controlMessageLog.append({
                  kind: 'budget_warning',
                  remainingPct: 1 - decision.pct,
                })
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

    eventEmitter.emit({ type: 'RUN_EXECUTION_STOPPED', runId: runId ?? 'unknown', stopReason: result.reason })

    // ── CompletionContract gate (v0.3.1: SINGLE source of truth) ──
    // stop_sequence only means the model stopped. The real verdict comes
    // from evaluateCompletion(). taskKind drives what "done" means:
    // informational (Q&A) doesn't need changes; mutation does.
    let completionVerdict: ReturnType<typeof evaluateCompletion> | null = null
    let reviewerFindings: string[] = []
    const ws = this.deps.contextManager.getWorkingState()
    const hasChanges = ws.filesChanged.length > 0

    // Phase 5: final Reviewer — a deterministic post-run verdict from
    // structured state (NOT the model's self-report). Surfaces partial/
    // blocked loudly so false-success can't hide. The Reviewer findings
    // flow into evaluateCompletion so they can downgrade the verdict.
    try {
      const tg = this.deps.taskGraph
      const tgSnapshot = tg && tg.size() > 0 ? tg.snapshot() : null
      const unsatisfiedFromGraph = tgSnapshot
        ? tgSnapshot.nodes.reduce((sum, n) => sum + n.acceptanceCriteria.length, 0)
        : 0
      const review = reviewRun({
        goalPresent: userMessage.trim().length > 0,
        changedFiles: ws.filesChanged,
        verificationExecuted: ws.verification.passed.length + ws.verification.failed.length > 0,
        verificationPassed: ws.verification.failed.length === 0,
        unhandledFailures: ws.verification.failed.length,
        unresolvedBlockers: ws.unresolved.length,
        unsatisfiedAcceptance: unsatisfiedFromGraph,
        scopeExcessive: ws.filesChanged.length > 20,
      })
      reviewerFindings = review.findings
      if (review.verdict !== 'completed') {
        renderer.warn(`Reviewer verdict: ${review.verdict} — ${review.findings.join('; ')}`)
      }
    } catch { /* best-effort */ }

    if (result.reason === 'stop_sequence') {
      // v0.3.1: only actual file changes make it a 'mutation' task.
      // Running verification alone (no changes) is informational.
      const taskKind = hasChanges ? 'mutation' : 'informational'
      const tg = this.deps.taskGraph
      const tgSnapshot = tg && tg.size() > 0 ? tg.snapshot() : null
      const acceptanceCriteria = tgSnapshot
        ? tgSnapshot.nodes.flatMap((n) =>
          n.acceptanceCriteria.map((desc, i) => ({ id: `${n.id}::${i}`, description: desc, satisfied: n.status === 'completed' })),
        )
        : []
      const v = evaluateCompletion({
        taskKind,
        modelStopped: true,
        acceptanceCriteria,
        verification: {
          executed: ws.verification.passed.length + ws.verification.failed.length > 0,
          passed: ws.verification.failed.length === 0,
          failed: [...ws.verification.failed],
        },
        taskGraph: tgSnapshot ? {
          nodes: tgSnapshot.nodes.map((n) => ({ id: n.id, status: n.status })),
        } : undefined,
        activeWorkers: [...sharedState.activeSubtasks.entries()].map(([id]) => ({ id, status: 'running' as const })),
        unresolvedBlockers: [...ws.unresolved],
        changedFiles: [...ws.filesChanged],
        reviewerFindings,
        budgetState: { remaining: 1, exceeded: false },
      })
      completionVerdict = v
      // Serialize the verdict into the wire shape the event union
      // expects (a plain object with optional arrays). The full typed
      // verdict is preserved in the local `completionVerdict` for
      // downstream consumers.
      this.deps.eventEmitter.emit({
        type: 'COMPLETION_EVALUATED',
        verdict: serializeVerdict(v),
      })
      if (v.status !== 'completed') {
        let detail: string
        if (v.status === 'blocked') detail = v.blockers.join('; ')
        else if (v.status === 'partial' || v.status === 'incomplete') detail = v.remaining.join('; ')
        else detail = v.reason
        renderer.warn(`Completion gate: ${v.status} — ${detail}`)
        this.deps.eventEmitter.emit({
          type: 'COMPLETION_REJECTED',
          verdict: serializeVerdict(v),
        })
      }
    }

    // ── ExecutionRun terminal transition (GAP-C) ──
    if (runId && registry) {
      // Map CompletionStatus → RunStatus: exhausted/failed/cancelled are
      // distinct terminal states; everything else non-completed maps to
      // 'blocked' so the RunRegistry contract is preserved.
      const targetStatus: RunStatus =
        result.reason === 'stop_sequence'
          ? (completionVerdict && completionVerdict.status === 'completed' ? 'succeeded'
            : completionVerdict?.status === 'failed' ? 'failed'
            : completionVerdict?.status === 'cancelled' ? 'cancelled'
            : completionVerdict?.status === 'exhausted' ? 'blocked'
            : completionVerdict ? 'blocked'
            : 'failed')
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
              : targetStatus === 'cancelled'
                ? 'user/system cancelled'
                : targetStatus === 'blocked'
                  ? completionVerdict
                    ? `completion ${completionVerdict.status}: ${('blockers' in completionVerdict && completionVerdict.blockers?.join('; ')) || ('remaining' in completionVerdict && completionVerdict.remaining?.join('; ')) || ('reason' in completionVerdict && completionVerdict.reason) || ''}`
                    : 'turn hit max_iterations ceiling'
                  : undefined,
          })
        }
      } catch { /* best-effort: never break the turn result */ }
      // v0.3.2 (ele_goal §Phase 9): emit RUN_STATUS_TRANSITIONED
      // before the final RUN_COMPLETED so consumers can observe the
      // exact status transition.
      this.deps.eventEmitter.emit({
        type: 'RUN_STATUS_TRANSITIONED',
        runId,
        from: 'running',
        to: targetStatus,
        verdict: serializeVerdict(completionVerdict ?? {
          status: 'failed',
          reason: 'no verdict',
          evidence: [],
        }),
      } as never)
    }

    // v0.3.2 (ele_goal §Phase 9): the final RUN_COMPLETED is emitted
    // AFTER the CompletionContract and the RunRegistry transition
    // have both been evaluated. This ordering is required for the
    // event-order assertion in ele_goal §Phase 0 test 5.
    eventEmitter.emit({ type: 'RUN_COMPLETED', result })

    // ── Module onComplete hooks (v0.3.2: receives TurnOutcome) ──
    const turnOutcome: TurnOutcome = {
      runId: runId ?? 'unknown',
      stopReason: result.reason,
      completion: completionVerdict ?? {
        status: 'failed',
        reason: 'no verdict produced',
        evidence: [],
      },
      output: result.output,
      changedFiles: [...ws.filesChanged],
      verification: {
        executed: ws.verification.passed.length + ws.verification.failed.length > 0,
        passed: ws.verification.failed.length === 0,
        failed: [...ws.verification.failed],
      },
      artifacts: [],
      modelCalls: this.modelCallsThisRun,
    }
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
    controlMessages: OpenAIMessage[] = [],
  ): Promise<{
    assistantText: string
    finishReason: string | null
    rawToolCalls: StreamingToolCall[]
    usage: TokenUsage | null
  }> {
    const callStartMs = Date.now()
    const modelAtStart = this.deps.config.model
    this.deps.eventEmitter.emit({ type: 'MODEL_REQUESTED', model: modelAtStart })
    let result: Awaited<ReturnType<typeof this.deps.modelGateway.call>> | null = null
    let providerFailed = false
    let attemptModel = modelAtStart
    const attemptStartedAt = Date.now()
    this.deps.eventEmitter.emit({
      type: 'MODEL_ATTEMPT_STARTED',
      model: attemptModel,
      attemptId: this.modelCallsThisRun.length,
    } as never)
    try {
      // v0.3.1 (te_goal §七): prepend control messages for this
      // single call. The caller (the LLM state machine) drains the
      // log right after; the user-visible history `messages` array
      // is NEVER mutated.
      const messagesForCall = controlMessages.length > 0
        ? [...controlMessages, ...messages]
        : messages
      result = await this.deps.modelGateway.call(
        {
          systemPrompt,
          messages: messagesForCall,
          toolDefs,
          model: modelAtStart,
          temperature: this.deps.config.temperature,
          maxOutputTokens: this.deps.contextManager.effectiveMaxOutputTokens(this.deps.config.maxOutputTokens),
          abortSignal: turnAbortSignal,
          turnAbortController: this.deps.sharedState.currentTurnAbortController,
        },
        {
          onUsage: (usage, t0) => this.recordUsage(usage, t0, modelAtStart, true),
          onContextOverflow: async (msgs, signal) => {
            return this.deps.contextManager.reactiveCompact(msgs, signal)
          },
          // v0.3.1 (te_goal §三.1.4): wire real fallback through the
          // Router. The Router's lastDecision.fallbackChain is the
          // source of truth; if it's exhausted, returns null and the
          // Gateway surfaces the original error.
          onProviderError: (failedModel, err) => {
            providerFailed = true
            this.deps.eventEmitter.emit({ type: 'MODEL_FAILED', error: err.message })
            // v0.3.2 (ele_goal §Phase 7): record the failed attempt
            // before the fallback chain advances.
            this.modelCallsThisRun.push({
              model: failedModel,
              startedAt: attemptStartedAt,
              endedAt: Date.now(),
              success: false,
              error: err.message,
              retryable: /\b(429|5\d\d|ETIMEDOUT|rate limit|timeout)\b/i.test(err.message),
            })
            this.deps.eventEmitter.emit({
              type: 'MODEL_ATTEMPT_FAILED',
              model: failedModel,
              attemptId: this.modelCallsThisRun.length - 1,
              error: err.message,
              retryable: /\b(429|5\d\d|ETIMEDOUT|rate limit|timeout)\b/i.test(err.message),
            } as never)
            if (!this.deps.modelRouter) return null
            const next = this.deps.modelRouter.nextFallback(failedModel)
            if (next) {
              attemptModel = next
              // Apply the fallback model to the engine so the next
              // LLM call uses it. This is an automatic (NOT manual)
              // change so we route through applyRoutingDecision via
              // the engine sink to keep the event stream consistent.
              try { this.deps.modelRouter.applyRoutingDecision(next) } catch { /* best-effort */ }
              this.deps.eventEmitter.emit({
                type: 'MODEL_ATTEMPT_STARTED',
                model: next,
                attemptId: this.modelCallsThisRun.length,
              } as never)
              return next
            }
            return null
          },
        },
      )
      // v0.3.2 (ele_goal §Phase 7): record the successful attempt.
      this.modelCallsThisRun.push({
        model: attemptModel,
        startedAt: attemptStartedAt,
        endedAt: Date.now(),
        success: true,
        usage: result.usage ? { inputTokens: result.usage.inputTokens, outputTokens: result.usage.outputTokens } : undefined,
        retryable: false,
      })
      this.deps.eventEmitter.emit({
        type: 'MODEL_ATTEMPT_SUCCEEDED',
        model: attemptModel,
        attemptId: this.modelCallsThisRun.length - 1,
        latencyMs: Date.now() - attemptStartedAt,
        usage: result.usage ? { inputTokens: result.usage.inputTokens, outputTokens: result.usage.outputTokens } : undefined,
      } as never)
    } catch (err) {
      // Record the failure against the profile even if the gateway
      // threw (helps /models show real health after retries).
      const durationMs = Date.now() - callStartMs
      const router = this.deps.modelRouter
      if (router) {
        const binding = router.listProfiles().find((p) => p.model === modelAtStart)
        if (binding) router.recordCall(binding.id, false, durationMs, null)
      }
      // Ensure the failed attempt is recorded even if onProviderError
      // did not fire (e.g. the error was non-retryable).
      if (!providerFailed) {
        this.modelCallsThisRun.push({
          model: modelAtStart,
          startedAt: attemptStartedAt,
          endedAt: Date.now(),
          success: false,
          error: (err as Error).message,
          retryable: false,
        })
        this.deps.eventEmitter.emit({
          type: 'MODEL_ATTEMPT_FAILED',
          model: modelAtStart,
          attemptId: this.modelCallsThisRun.length - 1,
          error: (err as Error).message,
          retryable: false,
        } as never)
      }
      throw err
    }

    // Success: record against the model that actually completed (which
    // may be the fallback if the gateway retried).
    const durationMs = Date.now() - callStartMs
    const router = this.deps.modelRouter
    if (router) {
      const finalModel = this.deps.config.model
      const binding = router.listProfiles().find((p) => p.model === finalModel)
      if (binding) router.recordCall(binding.id, !providerFailed, durationMs, result.usage)
    }
    return result
  }

  private recordUsage(
    usage: TokenUsage | null,
    callStartMs: number,
    model: string,
    ok: boolean,
  ): void {
    if (usage) {
      const durationMs = Date.now() - callStartMs
      this.deps.costTracker.addUsage(model, usage, durationMs)
      this.deps.eventLog?.append('tool_call', 'llm_api', {
        input_tokens: usage.inputTokens,
        output_tokens: usage.outputTokens,
        duration_ms: durationMs,
        model,
      })
    }
    // Always record against the Router even when usage is null —
    // te_goal §三.1.4 requires health to track every call.
    const router = this.deps.modelRouter
    if (router) {
      const binding = router.listProfiles().find((p) => p.model === model)
      if (binding) router.recordCall(binding.id, ok, Date.now() - callStartMs, usage)
    }
  }

}

/**
 * Serialize a CompletionVerdict to the wire shape the RunEvent
 * union expects (a plain object with optional arrays). Consumers
 * that need the full discriminated union read `completionVerdict`
 * from the coordinator scope directly.
 */
function serializeVerdict(v: import('./completionContract.js').CompletionVerdict): {
  status: string; reasons?: string[]; blockers?: string[]; remaining?: string[]; evidence?: string[]
} {
  if (v.status === 'completed') {
    return { status: v.status, evidence: v.evidence, reasons: v.residualRisks }
  }
  if (v.status === 'partial') {
    return { status: v.status, remaining: v.remaining, evidence: v.evidence }
  }
  if (v.status === 'blocked') {
    return { status: v.status, blockers: v.blockers }
  }
  if (v.status === 'failed') {
    return { status: v.status, evidence: v.evidence }
  }
  if (v.status === 'cancelled') {
    return { status: v.status, reasons: [v.reason] }
  }
  if (v.status === 'exhausted') {
    return { status: v.status, reasons: [v.reason] }
  }
  return { status: v.status, remaining: v.remaining }
}


function makeTurnOutcome(input: import("./turnOutcome.js").TurnOutcome): import("./turnOutcome.js").TurnOutcome {
  return input
}
