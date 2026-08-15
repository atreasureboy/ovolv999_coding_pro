/**
 * RuntimeCoordinator — owns the Think → Act → Observe main loop.
 *
 * Responsibilities (from architecture plan §5.1):
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
import { calculateUSDCost, calculateUncachedUSDCost, type TokenUsage } from '../costTracker.js'
import { recordCacheEntry } from '../../utils/cacheStats.js'
import type { CostTracker } from '../costTracker.js'
import type { BackgroundTaskManager } from '../backgroundTaskManager.js'
import type { FileHistory } from '../fileHistory.js'
import type { PermissionManager } from '../permissionSystem.js'
import type { RendererInterface } from '../types.js'
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
import type { RoutingInput, ModelRouter, ProbeLease, ProbeOutcome, RouteApplication } from '../model/modelRouter.js'
import type { ProjectIdentity } from '../projectIdentity.js'
import { RoutingUnavailableError } from '../model/routingErrors.js'
import type { ContextManager } from '../context/contextManager.js'
import type { ToolPolicy } from '../toolRuntime/toolPolicy.js'
import type { ToolScheduler, ParsedToolCall } from '../toolRuntime/toolScheduler.js'
import type { ToolRegistry } from '../toolRuntime/toolRegistry.js'
import type { ModuleManager } from '../moduleRuntime/moduleManager.js'
import type { AgentModule, MemoryModuleControl } from '../module.js'
import type { SharedRuntimeState } from './sharedState.js'
import { resolveProjectIdentity } from '../projectIdentity.js'
import type { RunEventEmitter } from './events.js'
import { isTerminalRunStatus } from '../executionRun.js'
import type { ExecutionRunRegistry, RunStatus } from '../executionRun.js'
import { buildExecutionContext } from '../executionContext.js'
import { checkTermination } from './terminationPolicy.js'
import { evaluateCompletion, type CompletionVerdict } from './completionContract.js'
import type { TurnOutcome, CompletionStatus } from './turnOutcome.js'
import { shouldInvokeCritic } from './criticTrigger.js'
import { reviewRun } from './reviewer.js'
import type { TaskGraph } from './taskGraph.js'
import type { TaskGraphStore } from './taskGraphStore.js'
import { ControlMessageLog } from './internalControlMessage.js'
import { collectDeferredToolNames } from './deferredToolsReminder.js'
import { renderTodoPromptBlock, ensureLoaded } from '../todoStore.js'
import { collectRoutingSignals, signalsToRoutingInput } from '../model/routingSignalCollector.js'
import type { RepoStatsService } from '../repoStats.js'
import {
  type RunScopedRuntimeContext,
  type RunScopedRuntimeContextStore,
} from './runScopedContext.js'
import { classifyTaskIntent, type TaskIntent } from './taskIntent.js'
import { EXECUTION_PROFILES, resolveExecutionProfile } from '../effort.js'
import {
  assessProjectExploration,
  buildProjectExplorationProfile,
  isProjectExplorationRequest,
  type ProjectExplorationProfile,
} from './projectExploration.js'
import {
  detectPrematureHandoff,
  requiresExecutionVerification,
  workspaceAnalysisReadTarget,
} from './prematureHandoff.js'
import { boot } from './boot.js'

interface StreamingToolCall {
  index: number
  id: string
  name: string
  arguments: string
}

export interface CoordinatorDeps {
  config: EngineConfig
  renderer: RendererInterface
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
   * Optional ExecutionRun registry (runtime contract §三/§四). When set, the
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
   * v0.3.1 (runtime truth contract §五): the per-runId task-graph store. The
   * Coordinator uses this to mint a fresh graph for each runId so
   * turn N's graph does not leak into turn M.
   */
  taskGraphStore?: TaskGraphStore
  /**
   * v0.3.2 (run-scoped runtime contract §Phase 1): the per-runId RunScopedRuntimeContext
   * store. The Coordinator mints a fresh Context for each runId and
   * resolves the SAME Context for the tool, completion contract, and
   * router. Optional — absence falls back to the v0.3.1 taskGraphStore
   * path for back-compat.
   */
  runContextStore?: RunScopedRuntimeContextStore
  /**
   * v0.3.2 (run-scoped runtime contract §Phase 3): optional override of the taskKind
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
  routeModel?: (input: RoutingInput) => RouteApplication | Promise<RouteApplication>
  /**
   * v0.3.1 (runtime truth contract §三.1.3): the ModelRouter handle, used by the
   * coordinator's signal collector to read provider health. Optional —
   * absence just means no live health signals.
   */
  modelRouter?: ModelRouter
  /**
   * v0.5.2 (Stage 2.2): cached repository statistics. When supplied,
   * the routing signal collector uses the real `sourceFileCount`
   * instead of the `filesTouched * 10` proxy. The Router only reads
   * the snapshot; the walk + cache live in this service.
   */
  repoStats?: RepoStatsService
  /**
   * Parent run id (e.g. a `kind='loop'` run from runLoop). When set,
   * the per-turn run records it as parentRunId for hierarchical queries.
   */
  parentRunId?: string
  /**
   * v0.5.2 (C3 — borrowed from codex multi_agents_common.rs):
   * the parent's effective config slice. Coordinator uses this to
   * populate `RunScopedRuntimeContext.inheritedConfig` so child runs
   * cannot accidentally drift provider / model / sandbox / cwd.
   * When omitted, no inheritance is recorded (legacy behaviour).
   */
  inheritedConfig?: {
    provider?: string
    model?: string
    sandboxEnabled?: boolean
  }
}

export class RuntimeCoordinator {
  private readonly deps: CoordinatorDeps
  /** v0.3.2 (run-scoped runtime contract §Phase 7): per-turn model call attempts so
   *  the TurnOutcome can carry the full fallback chain. */
  private modelCallsThisRun: Array<{
    model: string
    provider: string
    profileId?: string
    /** v0.5.5 §9: scope id from the in-flight ProbeLease, if any. */
    attemptScopeId?: string
    startedAt: number
    endedAt: number
    success: boolean
    error?: string
    usage?: { inputTokens: number; outputTokens: number }
    /** P1-5 (cost observability): a successful call that carried no usage
     *  metadata — session cost is under-reported for this attempt. */
    usageMissing?: boolean
    estimatedCost?: number
    retryable: boolean
  }> = []
  /** P1-5: warn at most once per run about usage-less success responses. */
  private usageMissingWarned = false
  // v0.5.3 Hotfix §4: cache the resolved ProjectIdentity so
  // 20 sequential turns don't each spawn a fresh `git rev-parse`.
  private _projectIdentityCache: { cwd: string; identity: ProjectIdentity } | null = null
  // v0.5.3 P0-3: coordinator no longer carries its own provider
  // circuit state. The single source of truth is the ModelRouter's
  // per-profile circuit (consecutiveProfileFailures + circuitStates
  // in src/core/model/modelRouter.ts). callLLM() now consults
  // router.getProfileCircuitState(model) before each attempt.
  private static readonly MAX_BACKOFF_MS = 60_000

  constructor(deps: CoordinatorDeps) {
    this.deps = deps
  }

  /**
   * @deprecated v0.5.3 P0-3: kept as a thin shim that returns the
   * router's aggregation across profiles so legacy callers don't
   * crash. New code MUST read modelRouter.getProfileCircuitState()
   * or getRoutingFailureStats() directly.
   */
  getProviderCircuitState(): {
    status: 'closed' | 'open' | 'half-open'
    consecutiveFailures: number
    lastFailureAt: number
  } {
    const stats = this.deps.modelRouter?.getRoutingFailureStats()
    return {
      status: 'closed',
      consecutiveFailures: stats?.totalFailures ?? 0,
      lastFailureAt: 0,
    }
  }

  /** @deprecated v0.5.3 P0-3: shim — does nothing. The router owns
   *  circuit state; this method is preserved only to keep
   *  legacy/test imports compiling. */
  restoreProviderCircuitState(_state: {
    status: 'closed' | 'open' | 'half-open'
    consecutiveFailures: number
    lastFailureAt?: number
  }): void {
    // no-op — see comment above.
  }

  async run(
    userMessage: string,
    history: OpenAIMessage[],
    images?: Array<{ path: string; dataUrl: string }>,
    opts?: { parentRunId?: string },
  ): Promise<{ result: TurnResult; newHistory: OpenAIMessage[]; outcome: TurnOutcome }> {
    const { config, renderer, eventLog, sharedState, eventEmitter } = this.deps

    // v0.3.3 (background autonomy contract §十二.6): clear per-run state so consecutive turns
    // don't accumulate stale model-call attempts from prior turns.
    this.modelCallsThisRun = []
    this.usageMissingWarned = false

    // P1-2 fix: resolve the effective parentRunId ONCE. A per-turn
    // override (opts.parentRunId, e.g. from runLoop's kind='loop' run)
    // takes precedence over the static deps.parentRunId. This threads
    // the hierarchical Run tree so a loop's child turns — and every
    // grandchild Agent/Worker run they spawn — link back to the loop.
    const effectiveParentRunId = opts?.parentRunId ?? this.deps.parentRunId

    eventEmitter.emit({ type: 'RUN_STARTED', userMessage })

    // Round 27 (live todos): hydrate the persisted checklist for this
    // session BEFORE the first LLM call so resumed sessions keep steering.
    try { ensureLoaded(config.sessionDir) } catch { /* best-effort */ }

    // R7: SessionStart hook (best-effort, fires once at run start).
    if (config.hookRunner?.runSessionStart) {
      try {
        await config.hookRunner.runSessionStart('startup')
      } catch { /* best-effort */ }
    }

    if (config.hookRunner?.runUserPromptSubmit) {
      try {
        await config.hookRunner.runUserPromptSubmit(userMessage)
      } catch { /* best-effort */ }
    }

    // ── ExecutionRun tracking (GAP-C + v0.5.3 Hotfix §1) ──
    // Resolve effectiveRunId ONCE. Whether the registry is wired
    // in or not, every downstream consumer (activeRunId, RunContext,
    // ToolContext.execution.runId, MemoryCandidate.runId, TurnOutcome.
    // runId, Worker parentRunId, finally close) MUST read from this
    // single binding. No `?? 'unknown'` fallbacks downstream — the
    // id is guaranteed present from this point.
    const registry = this.deps.runRegistry
    const registryRun = registry
      ? registry.create({
          kind: 'turn',
          goal: userMessage.slice(0, 200),
          workspace: { cwd: config.cwd },
          parentRunId: effectiveParentRunId,
        })
      : undefined
    const effectiveRunId =
      registryRun?.runId
      ?? createLocalRunId()
    this.deps.sharedState.activeRunId = effectiveRunId
    if (registryRun && registry) {
      try {
        registry.transition(effectiveRunId, 'preparing', { phase: 'boot' })
      } catch { /* best-effort */ }
    }
    // v0.3.2 (run-scoped runtime contract §Phase 9): lifecycle start marker. Emitted
    // after RUN_STARTED but before the loop begins, so /trace can
    // show "execution started" distinctly from "run started" (the
    // latter is a logical event, the former a runtime event).
    this.deps.eventEmitter.emit({
      type: 'RUN_EXECUTION_STARTED',
      runId: effectiveRunId,
    })

    // ── ExecutionProfile resolution (v0.4.1 WS4) ──
    // Resolved BEFORE boot so module gating, tool exclusion and the
    // per-turn limits all derive from ONE decision. Precedence: sticky
    // override (--profile / /profile) > TaskIntent (informational →
    // fast) > prompt-shape detection (deep escalation) > standard.
    // This is the resource-depth axis; TaskKind (below) stays the
    // completion-semantics axis — two axes, one verdict each.
    sharedState.completedSubtasks.clear()
    const taskIntent = this.deps.classifyIntent
      ? this.deps.classifyIntent(userMessage, { planMode: sharedState.planModeActive })
      : classifyTaskIntent(userMessage, { planMode: sharedState.planModeActive })
    const profileResolution = resolveExecutionProfile(
      userMessage,
      taskIntent,
      sharedState.executionProfileOverride,
    )
    const profileSpec = EXECUTION_PROFILES[profileResolution.profile]
    const profileModules = [
      ...profileSpec.modules,
      ...(this.deps.moduleManager.modules.some(m => m.name === 'mcp') ? ['mcp'] : []),
      ...this.deps.moduleManager.modules
        .map((module) => module.name)
        .filter((name) => !['memory', 'workspace', 'critic', 'reflection', 'mcp'].includes(name)),
    ]
    const effectiveMaxIterations = profileSpec.maxIterations === undefined
      ? config.maxIterations
      : Math.min(config.maxIterations, profileSpec.maxIterations)
    const effectiveMaxOutputTokens = config.maxOutputTokens === undefined
      ? profileSpec.maxOutputTokens
      : profileSpec.maxOutputTokens === undefined
        ? config.maxOutputTokens
        : Math.min(config.maxOutputTokens, profileSpec.maxOutputTokens)
    eventEmitter.emit({
      type: 'PROFILE_RESOLVED',
      profile: profileResolution.profile,
      source: profileResolution.source,
      modules: profileModules,
    })

    // ── ProjectIdentity (v0.5.3 Hotfix §4) ──
    // Resolved ONCE per run, before boot, and threaded through to
    // every subsystem that needs the canonical project root.
    // Cached on the Coordinator so 20 sequential runs do not each
    // pay for a fresh `git rev-parse` spawn.
    if (!this._projectIdentityCache || this._projectIdentityCache.cwd !== config.cwd) {
      this._projectIdentityCache = {
        cwd: config.cwd,
        identity: await resolveProjectIdentity({ cwd: config.cwd }),
      }
    }
    const projectIdentity = this._projectIdentityCache.identity

    // ── Boot Sequence ──
    let bootResult
    // v0.5.5 §7: outer try/catch/finally covering the entire
    // post-identity lifecycle. Every failure (boot, identity,
    // router-unavailable, context abort) lands in the catch arm
    // for structured Outcome production. The finally block
    // (further down) cleans up activeRunId, runContext, and
    // candidate sink regardless of how the body exits.
    try {
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
        costTracker: this.deps.costTracker,
        // v0.5.3 Hotfix §4: every module that needs canonicalRoot
        // reads it from this binding rather than the legacy
        // bootCtx.cwd.
        projectIdentity,
        executionProfile: {
          modules: profileModules,
          excludedTools: profileSpec.excludedTools,
          taskKind: taskIntent.kind,
        },
        // v0.5.3 (P0.2): propagate the shared RepoStatsService so
        // WorkspaceWatcher can invalidate the Router's cache.
        repoStats: this.deps.repoStats,
      })
    } catch (bootErr) {
      const msg = (bootErr as Error).message || String(bootErr)
      if (registryRun && registry) {
        try { registry.transition(effectiveRunId, 'failed', { phase: 'boot', error: msg }) } catch { /* best-effort */ }
      }
      throw bootErr
    }
    if (registryRun && registry) {
      try {
        registry.transition(effectiveRunId, 'running', { phase: 'llm' })
      } catch { /* best-effort */ }
    }

    const { systemPrompt, toolDefs, toolContext, messages, turnAbortController } = bootResult
    const planMode = sharedState.planModeActive

    // runtime invariants P0-2: propagate the per-turn ExecutionContext through
    // ToolContext so tools (AgentTool, ClaudeCodeTool, Workflow, ...)
    // can read the current runId + parentRunId dynamically. The old
    // pattern of caching parentRunId in a Tool's constructor broke
    // for multi-turn reuse because every turn had a different RunId.
    toolContext.execution = buildExecutionContext({
      runId: effectiveRunId,
      parentRunId: effectiveParentRunId,
      cwd: config.cwd,
      signal: turnAbortController.signal,
      model: config.model,
    })

    // v0.5.3 P0-1: publish the memory provenance fields into
    // ToolContext so memory_write (and any future gated write) reads
    // repo/sourceRunId/verified from the engine, not from input
    // defaults. We publish only fields that have a real source —
    // branch/commit are repo-state fields the engine does not
    // currently resolve per turn; the gate will therefore reject
    // code-bound writes with a clear "no commit" error if the user
    // asks the model to remember an API snippet mid-session.
    {
      const ws = this.deps.contextManager.getWorkingState()
      const memoryCtx = {
        repo: config.cwd,
        sourceRunId: effectiveRunId,
        // True iff the working state's verification record is
        // non-empty AND has no failures. The CompletionContract
        // re-seals the verdict at end of turn; this flag is the
        // best per-iteration signal we can expose mid-turn.
        verified: ws.verification.passed.length > 0 && ws.verification.failed.length === 0,
      }
      toolContext.memoryToolContext = memoryCtx
      // Push the same value into MemoryModule so its current
      // snapshot (read at execute-time) carries the just-minted
      // runId. Without this, memory_write would receive the empty
      // initial snapshot and the gate would reject every write.
      for (const m of this.deps.moduleManager.modules) {
        if (m.name === 'memory') {
          const mm = m as AgentModule & Partial<MemoryModuleControl>
          try { mm.publishMemoryContext?.(memoryCtx) } catch { /* best-effort */ }
          // candidateSink publish happens AFTER runContext is created
          // — see below.
        }
      }
    }

    // v0.5.3 Final (task 9): pure-measure BEFORE signal collection
    // so the Router sees the current turn's tokens without us
    // v0.5.3 Final (P0 issue): the Router must read the
    // POST-compaction snapshot. We do measure → apply → re-measure
    // here BEFORE signal collection so the very first routing
    // decision is based on compacted-state (or, when no compaction
    // is needed, on the as-is snapshot — same value re-measured
    // is harmless). The previous order (measure → route →
    // budget_check → apply) let the Router see 90% before the
    // compaction kicked in.
    this.deps.contextManager.setActiveRunId(effectiveRunId)
    try {
      const initialSnap = this.deps.contextManager.measureBudget({ messages, toolDefs })
      await this.deps.contextManager.applyBudgetPolicy({
        messages, toolDefs, snapshot: initialSnap,
        abortSignal: turnAbortController.signal,
      })
      this.deps.contextManager.measureBudget({ messages, toolDefs })
    } catch (err) {
      // AbortError propagates — caller will catch. Other errors
      // are best-effort ignored; an uninitialized snapshot is a
      // valid signal (Router treats it as 'unknown').
      if ((err as { name?: string }).name === 'AbortError') throw err
    }

    // ── State machine driver ──
    let state: QueryState = transitionQueryState({ kind: 'boot' }, { type: 'booted' })

    // v0.3.2 P1-1 fix: create RunScopedRuntimeContext + classify TaskIntent
    // BEFORE routing so the router can consume the intent signal and the
    // scoped taskGraph. (Previously routing ran first — the router never
    // saw the intent or the per-run graph.)
    let runContext: RunScopedRuntimeContext | undefined
    // taskIntent was classified before boot (it feeds profile
    // resolution); the event is emitted here for every turn — a fast
    // turn still classifies, the classification is what MADE it fast.
    try {
    this.deps.eventEmitter.emit({
      type: 'TASK_INTENT_CLASSIFIED',
      runId: effectiveRunId,
      intent: {
        kind: taskIntent.kind,
        source: taskIntent.source,
        confidence: taskIntent.confidence,
      },
    })
    {
      const ctxStore = this.deps.runContextStore
      if (ctxStore) {
        runContext = ctxStore.get(effectiveRunId) ?? ctxStore.create(effectiveRunId, {
          parentRunId: effectiveParentRunId,
          taskKind: 'informational',
          // v0.5.3 Final (task 2): stash the original user message
          // on the run context so the MemoryPromoter can verify
          // sourceQuote claims later. Snapshot once at create-time —
          // do NOT re-read from messages[] because tool-added user
          // strings would let the model forge quotes.
          userMessage,
          // v0.5.2 (C3 — borrowed from codex multi_agents_common.rs):
          // capture the parent's effective config so child runs can
          // inherit it structurally instead of through ad-hoc field
          // reads. The Engine passes its resolved config via deps;
          // we expose only the slice that materially affects
          // sub-agent behaviour.
          inheritedConfig: this.deps.inheritedConfig ? {
            provider: this.deps.inheritedConfig.provider ?? this.deps.config.provider,
            model: this.deps.inheritedConfig.model ?? this.deps.config.model,
            cwd: this.deps.config.cwd,
            permissionMode: this.deps.config.permissionMode ?? 'default',
            sandboxEnabled: this.deps.inheritedConfig.sandboxEnabled ?? false,
            inheritedFrom: effectiveParentRunId ?? 'engine',
            inheritedAt: Date.now(),
          } : undefined,
          // v0.5.6 §8: ProjectIdentity is now a formal RunContext
          // field. Resolved once at the top of run(); no casts.
          projectIdentity,
        })
        runContext.taskKind = taskIntent.kind
        // v0.5.5 §2: mirror the per-run toolCallRegistry into
        // SharedState so the ToolExecutor can write tool results
        // (it does not hold a runContext reference). The Registry
        // is destroyed in the outer finally block.
        this.deps.sharedState.toolCallRegistry = runContext.toolCallRegistry
        // v0.5.3 Final (task 2): publish the per-run candidate sink.
        // memory_write routes candidates into runContext.memoryCandidates;
        // the MemoryPromoter reads them after CompletionContract.
        for (const m of this.deps.moduleManager.modules) {
          if (m.name === 'memory') {
            const mm = m as AgentModule & Partial<MemoryModuleControl>
            try {
              if (mm.publishCandidateSink) {
                mm.publishCandidateSink(effectiveRunId, (cand) => {
                  runContext!.memoryCandidates.push(cand)
                })
              }
            } catch { /* best-effort */ }
          }
        }
        // v0.3.5: do NOT write back to this.deps.taskGraph (shared mutable
        // global). Use the runContext's graph via a local variable instead.
      } else {
        const store = this.deps.taskGraphStore
        if (store) {
          let graph = store.get(effectiveRunId)
          if (!graph) graph = store.create(effectiveRunId)
          this.deps.taskGraph = graph
        }
      }
    }

    // v0.3.5: resolve the current TaskGraph from the per-run context
    // (preferred) or legacy deps (fallback for tests without context).
    const currentGraph = runContext?.taskGraph ?? this.deps.taskGraph
    const progressMonitor = runContext?.progressMonitor ?? this.deps.progressMonitor
    let explorationProfile: ProjectExplorationProfile | null = null
    if (isProjectExplorationRequest(userMessage)) {
      try {
        explorationProfile = buildProjectExplorationProfile(config.cwd)
      } catch {
        explorationProfile = null
      }
    }
    const genericAnalysisReadTarget = explorationProfile ? 0 : workspaceAnalysisReadTarget(userMessage)
    const executionVerificationRequired = requiresExecutionVerification(userMessage)

    // Phase 2: adaptive model routing — runs AFTER context creation so
    // signals include the per-run taskGraph + TaskIntent. v0.3.1 signals
    // derived from real runtime state (workingState, contextManager,
    // taskGraph, modelRouter health).
    if (this.deps.routeModel) {
      try {
        const ws = this.deps.contextManager.getWorkingState()
        const tg = currentGraph
        const router = this.deps.modelRouter
        // v0.5.2 (Stage 2.1): pull REAL context budget state from
        // ContextManager. Before evaluateBudget() runs, snapshot.initialized
        // is false; the collector keeps the values as undefined so the
        // Router treats them as 'unknown' rather than fabricated zeros.
        const budgetSnapshot = this.deps.contextManager.getBudgetSnapshot()
        const cmSignals = budgetSnapshot.initialized
          ? {
              contextUsageRatio: budgetSnapshot.usageRatio,
              budgetRemaining: budgetSnapshot.remainingRatio,
              recentFailureCount: ws.verification.failed.length,
            }
          : {
              // Pre-evaluation: no fabrication. Router scores these as
              // neutral (long-context/budget pressure signals = 0).
              contextUsageRatio: undefined,
              budgetRemaining: undefined,
              recentFailureCount: ws.verification.failed.length,
            }
        const signals = collectRoutingSignals({
          userMessage,
          workingState: {
            filesRead: [...ws.filesRead],
            filesChanged: [...ws.filesChanged],
            verification: { passed: [...ws.verification.passed], failed: [...ws.verification.failed] },
            unresolved: [...ws.unresolved],
          },
          contextManager: cmSignals,
          // v0.5.2 (Stage 2.2): real repository stats via the service.
          // v0.5.3 Final (task 8): the signal carries repoStatsState
          // and may report partial/unknown precisely. We never
          // synthesize `repoFileCount=100` from `filesTouched*10`.
          repoStats: (() => {
            const notWired = {
              state: 'unknown' as const,
              rootDir: config.cwd,
              sourceFileCount: undefined,
              totalFileCount: undefined,
              lowerBound: false,
              reason: 'repoStats not wired',
            }
            if (!this.deps.repoStats) return notWired
            const snap = this.deps.repoStats.snapshot(config.cwd)
            const state = (snap.state === 'pending' ? 'unknown' : snap.state)
            return {
              state,
              rootDir: snap.stats?.rootDir ?? config.cwd,
              sourceFileCount: snap.stats?.sourceFileCount,
              totalFileCount: snap.stats?.totalFileCount,
              lowerBound: snap.stats ? (snap.stats.sourceFileCount > 0) : false,
              reason: snap.reason,
            }
          })(),
          taskGraph: tg ? {
            nodeCount: tg.size(),
            preferredRoles: tg.list().map((n: { preferredRole?: string }) => n.preferredRole ?? '').filter(Boolean),
            // v0.5.2 (Stage 2.3): real structural impact from
            // TaskGraph.aggregateImpact(). When the graph has nodes
            // with `impact` metadata, these flags reflect that
            // structure; otherwise they fall back to the conservative
            // "all false" state (keyword-only routing).
            ...(() => {
              const agg = tg.aggregateImpact()
              if (!agg) {
                return {
                  hasConfigChanges: false,
                  hasCrossModuleEdits: false,
                  hasPublicInterfaceEdits: false,
                  hasRootCauseNode: false,
                  aggregateImpact: null,
                }
              }
              return {
                hasConfigChanges: agg.hasConfigChanges,
                hasCrossModuleEdits: agg.hasCrossModuleEdits,
                hasPublicInterfaceEdits: agg.hasPublicInterfaceEdits,
                hasRootCauseNode: agg.hasRootCauseNode,
                aggregateImpact: {
                  maxScope: agg.maxScope,
                  estimatedFiles: agg.estimatedFiles,
                },
              }
            })(),
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
            // v0.5.5 §14: session-wide counters are NOT routed
            // through as decision inputs. getRoutingFailureStats()
            // remains available for observability.
            // v0.5.3 P0-3: per-profile circuit visibility replaces
            // the old global flag. The Router's isProfileAvailable()
            // decides what's callable; the signal collector just
            // publishes the snapshot.
            profileCircuits: router.listProfiles().map((p: { id: string }) => ({
              profileId: p.id,
              state: router.getProfileCircuitState(p.id),
            })),
            // Distinguish manual override from auto routing so
            // the Router doesn't fight the user's choice.
            manualOverrideActive: router.getManualOverride() !== null,
          } : undefined,
        })
        if (runContext) runContext.routingSignals = signals
        const application = await this.deps.routeModel(signalsToRoutingInput(signals))
        // v0.5.5 Final: structured RouteApplication. The Coordinator
        // MUST distinguish the three kinds:
        //   - applied: Router picked a model; the Engine will switch
        //     config.model accordingly.
        //   - unchanged: same model already current.
        //   - unavailable: NO profile is available. The Run MUST
        //     terminate without calling the ModelGateway.
        eventEmitter.emit({
          type: 'ROUTING_DECIDED',
          selectedModel: application.decision.selectedModel,
          reasonCodes: application.decision.reasonCodes,
          estimatedComplexity: application.decision.estimatedComplexity,
        })
        if (application.kind === 'unavailable') {
          // v0.5.5 §2: all-profiles-open terminates the Run.
          // Emit the structured event ONCE (the Engine callback
          // does not double-emit), capture the decision, and
          // surface the run as blocked.
          eventLog?.append('protocol', 'engine', {
            type: 'ROUTING_UNAVAILABLE',
            reasonCodes: application.decision.reasonCodes,
          })
          eventEmitter?.emit({
            type: 'ROUTING_UNAVAILABLE',
            reasonCodes: application.decision.reasonCodes,
            profiles: application.decision.reasonCodes,
          })
          // Mark this Run as routing-blocked. Subsequent
          // llm_call / modelGateway.call invocations see this flag
          // and refuse to execute.
          sharedState.routingUnavailable = true
          renderer.error(
            `Router: all profiles in open circuit — no model available for this request. ` +
            `reasonCodes=${application.decision.reasonCodes.join(',')}`,
          )
          throw new RoutingUnavailableError(application.decision.reasonCodes)
        }
        if (application.kind === 'applied') {
          renderer.info(`Model routed to ${application.decision.selectedModel} (adaptive)`)
        }
      } catch (routeErr) {
        // v0.5.5 §6: RoutingUnavailableError MUST propagate up to
        // the outer try/catch/finally so the Run is terminated
        // BEFORE any ModelGateway call. All other errors are
        // best-effort swallowed (they never break the turn).
        if (routeErr instanceof RoutingUnavailableError) throw routeErr
      }
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
      config.turnTokenBudget ?? this.deps.contextManager.effectiveMaxOutputTokens(effectiveMaxOutputTokens) * 4
    const budgetTracker = createBudgetTracker()
    let turnTokensProduced = 0
    let emptyResponseCount = 0
    const MAX_EMPTY_RETRIES = 2
    let lengthRetryCount = 0
    const MAX_LENGTH_RETRIES = 3
    let explorationNoProgressCount = 0
    let explorationLastReadCount = 0
    const MAX_EXPLORATION_NO_PROGRESS = 3
    let completionContinuationCount = 0
    const MAX_COMPLETION_CONTINUATIONS = 3
    let lastAssistantText = ''

    let result: TurnResult
    const turnStartMs = Date.now()
    const turnStartHighResolutionMs = performance.now()
    let stallInterventionApplied = false // dedupe: one system nudge per stall episode
    // v0.3.1 (runtime truth contract §七): typed control messages. The provider sees
    // a snapshot rendered for THIS call; the log is drained after the
    // call so messages do NOT accumulate in the user-visible history.
    // v0.3.3 (background autonomy contract §十二.2/3): use the per-run ControlMessageLog
    // from RunScopedRuntimeContext when available — NOT a local instance.
    // This ensures all components share the same control-message channel.
    const controlMessageLog = runContext?.controlMessages ?? new ControlMessageLog()

    // R6: inject `<available-deferred-tools>` so the model knows it can
    // call search_extra_tools("select:<name>") to load them. Borrowed
    // from claude-code's deferred-tool system reminder. Deduped via
    // controlMessageLog.compact() — emitting the same set twice is a no-op.
    try {
      const deferredNames = collectDeferredToolNames(this.deps.toolRegistry ?? null)
      if (deferredNames.length > 0) {
        const alreadyAnnounced = controlMessageLog.peek().some(
          (m) => m.kind === 'available_deferred_tools'
            && m.tools.length === deferredNames.length
            && m.tools.every((t, i) => t === deferredNames[i]),
        )
        if (!alreadyAnnounced) {
          controlMessageLog.append({ kind: 'available_deferred_tools', tools: deferredNames })
        }
      }
    } catch { /* best-effort */ }

    try {
      while (!isTerminal(state)) {
        switch (state.kind) {
          case 'check_abort': {
            const decision = checkTermination({
              hardAborted: turnAbortController.signal.aborted,
              softAborted: this.deps.sharedState.claimSoftAbort(turnAbortController),
              iteration: state.iteration,
              maxIterations: effectiveMaxIterations,
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
              const pm = progressMonitor
              if (pm) {
                pm.tick()
                // v0.3.1 (runtime truth contract §六.1): feed real verification signal
                // into ProgressMonitor each iteration. A drop in failing
                // commands = meaningful progress; no change = stall timer
                // keeps running.
                pm.recordVerification(this.deps.contextManager.getWorkingState().verification.failed.length)
                const elapsedMin = (Date.now() - turnStartMs) / 60_000
                const verdict = pm.detectStall(elapsedMin, 1)
                this.deps.eventEmitter.emit({
                  type: 'PROGRESS_RECORDED',
                  kind: verdict.kind === 'progressing' ? 'progress' :
                        verdict.kind === 'blocked' ? 'stall' : 'replan',
                })
                if (verdict.kind !== 'progressing') {
                  renderer.warn(`Stall detected (${verdict.kind}): ${verdict.reason} → suggested: ${verdict.action}`)
                  eventEmitter.emit({ type: 'STALL_DETECTED', kind: verdict.kind, reason: verdict.reason, action: verdict.action })
                  // v0.3.1 (runtime truth contract §七): emit a typed ICM instead of
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
                    eventEmitter.emit({ type: 'REPLAN_REQUESTED', reason: verdict.reason })
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
            // v0.5.5 §17 — strict compact-hook timing.
            //   measure → plan → PreCompact → compact → re-measure → PostCompact.
            // PreCompact fires BEFORE the actual compact so user-
            // defined hooks can observe the pre-state and gate the
            // compact (e.g. save a snapshot). PostCompact fires
            // ONLY when compact actually ran. A failed compact
            // means PostCompact MUST NOT fire.
            const compactTrigger: 'auto' | 'manual' = 'auto'
            const preSnap = this.deps.contextManager.measureBudget({ messages, toolDefs })
            // Plan: would the policy actually compact? Mirror the
            // policy's threshold logic. The applyBudgetPolicy
            // implementation is the single source of truth; we
            // approximate here for hook ordering only.
            const willCompact = preSnap.usageRatio >= 0.85
            if (willCompact) {
              if (config.hookRunner?.runPreCompact) {
                try { await config.hookRunner.runPreCompact(compactTrigger) } catch { /* best-effort */ }
              }
            }
            let postSnap = preSnap
            let didCompact = false
            try {
              postSnap = await this.deps.contextManager.applyBudgetPolicy({
                messages,
                toolDefs,
                snapshot: preSnap,
                abortSignal: turnAbortController.signal,
              })
              didCompact = postSnap.usageRatio < preSnap.usageRatio
              if (didCompact) {
                // Re-measure to honor any post-compact mutations.
                postSnap = this.deps.contextManager.measureBudget({ messages, toolDefs })
              }
            } catch (err) {
              // v0.5.5 §17: a compact throw means PostCompact MUST
              // NOT fire (the post-state is undefined).
              if ((err as { name?: string }).name === 'AbortError') throw err
            }
            if (didCompact) {
              const strategy = preSnap.usageRatio >= 0.85 ? 'compaction' :
                               preSnap.usageRatio >= 0.70 ? 'microCompact' : 'snipCompact'
              eventEmitter.emit({
                type: 'CONTEXT_COMPACTED',
                strategy,
                tokensBefore: preSnap.estimatedInputTokens,
                tokensAfter: postSnap.estimatedInputTokens,
              })
              if (config.hookRunner?.runPostCompact) {
                try { await config.hookRunner.runPostCompact(compactTrigger) } catch { /* best-effort */ }
              }
            }
            state = transitionQueryState(state, { type: 'continue' })
            break
          }

          case 'module_iteration': {
            // v0.3.1 (runtime truth contract §六.3): single-track critic. The coordinator
            // computes the risk signal here and passes criticRequested to
            // the module. CriticModule is the SOLE critic actuator (LLM
            // review); the coordinator no longer injects its own critic
            // guidance. This eliminates the dual-critic problem.
            let criticRequested = false
            const pmSnap = progressMonitor
            if (pmSnap) {
              const snap = pmSnap.snapshot((Date.now() - turnStartMs) / 60_000)
              const ws = this.deps.contextManager.getWorkingState()
              // v0.3.1 (runtime truth contract §六.3): modelClaimingCompletion must be
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
            if (criticRequested) {
              // Check whether CriticModule actually injected a message.
              const lastMsg = messages[messages.length - 1]
              const lastContent =
                lastMsg?.role === 'system' && typeof lastMsg.content === 'string'
                  ? lastMsg.content
                  : ''
              const injected = lastContent !== '' && lastContent.startsWith('[runtime critic]')
              this.deps.eventEmitter.emit({
                type: 'CRITIC_COMPLETED',
                verdict: injected ? 'problems_found' : 'completed',
                problems: injected ? [lastContent] : [],
              })
              controlMessageLog.append({
                kind: 'critic_feedback',
                verdict: injected ? 'problems_found' : 'reviewed',
                problems: injected ? [lastContent.slice(0, 200)] : [],
              })
            }
            state = transitionQueryState(state, { type: 'continue' })
            break
          }

          case 'llm_call': {
            // runtime invariants §四: inject WorkingState into the system prompt
            // before each LLM call. The block is empty (and thus a
            // no-op) on the first iteration; after tools run it
            // carries filesRead/filesChanged/verification/unresolved
            // so the model sees structured progress without having
            // to parse its own prior tool outputs.
            const wsBlock = this.deps.contextManager.renderWorkingStateBlock()
            // Round 27 (live todos): re-state the checklist every LLM call
            // — this is what makes a todo list STEER the model instead of
            // being a one-shot tool output that compaction later eats.
            const todoBlock = renderTodoPromptBlock(config.sessionDir)
            const effectivePrompt = wsBlock
              ? `${systemPrompt}\n\n${wsBlock}${todoBlock ? '\n\n' + todoBlock : ''}`
              : todoBlock
                ? `${systemPrompt}\n\n${todoBlock}`
                : systemPrompt
            // v0.3.1 (runtime truth contract §七): render the typed control messages
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
                effectiveMaxOutputTokens,
                (from: string, to: string, reason: string) => {
                  controlMessageLog.append({
                    kind: 'provider_fallback',
                    from,
                    to,
                    reason,
                  })
                },
              )
            controlMessageLog.clear()

            if (assistantText) {
              lastAssistantText = assistantText
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
              // v0.3.1 (runtime truth contract §七): emit a typed InternalControlMessage
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
            if (explorationProfile) {
              const exploration = assessProjectExploration(
                explorationProfile,
                this.deps.contextManager.getWorkingState().filesRead,
              )
              if (!exploration.complete) {
                explorationNoProgressCount = exploration.filesRead > explorationLastReadCount
                  ? 0
                  : explorationNoProgressCount + 1
                explorationLastReadCount = exploration.filesRead
                if (explorationNoProgressCount <= MAX_EXPLORATION_NO_PROGRESS) {
                  controlMessageLog.append({
                    kind: 'project_exploration_continue',
                    missing: exploration.missing,
                    filesRead: exploration.filesRead,
                    target: exploration.targetReadCount,
                  })
                  state = transitionQueryState(state, { type: 'continue' })
                  break
                }
              }
            }
            if (completionContinuationCount < MAX_COMPLETION_CONTINUATIONS) {
              const workingState = this.deps.contextManager.getWorkingState()
              const handoff = detectPrematureHandoff({
                assistantText: lastAssistantText,
                intent: taskIntent,
                filesRead: workingState.filesRead.length,
                filesChanged: workingState.filesChanged.length,
                verificationCount: workingState.verification.passed.length + workingState.verification.failed.length,
              })
              if (handoff.continue && handoff.reason) {
                completionContinuationCount++
                controlMessageLog.append({
                  kind: 'task_completion_continue',
                  reason: handoff.reason,
                })
                state = transitionQueryState(state, { type: 'continue' })
                break
              }
            }
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
                  controlMessageLog.append({
                    kind: 'tool_recovery',
                    tool: tc.name,
                    error: `JSON parse error: expected object, got ${shape}`,
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
                controlMessageLog.append({
                  kind: 'tool_recovery',
                  tool: tc.name,
                  error: 'JSON parse failed (likely truncated by max_tokens)',
                })
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
      // v0.5.5 §6: RoutingUnavailableError must propagate to the
      // outer try/catch/finally so the Run produces a blocked
      // Outcome without ever calling the Gateway. Other errors
      // follow the standard failed-outcome path.
      if (err instanceof RoutingUnavailableError) throw err
      const errMsg = (err as Error).message || String(err)
      const errorIteration = 'iteration' in state ? state.iteration : 0
      if (turnAbortController.signal.aborted) {
        result = { stopped: true, reason: 'interrupted', output: computeFinalOutput() }
        // RUN_EXECUTION_STOPPED emitted in finally block below;
        // no separate RUN_CANCELLED event (removed — not in RunEvent union).
      } else {
      // best-effort: async hook rejections must not crash the turn
      // (unhandledRejection is process-fatal via cleanup.ts:59).
      // Promise.resolve() wraps the possibly-undefined / possibly-sync
      // HookResult[] return so .catch() is safe to call; a SYNC throw
      // from the hook propagates to the caller (preserving the existing
      // contract that a throwing onComplete fails the turn — see
      // v034OutcomeE2e "closes the run context when a completion hook
      // throws"). Mirrors contextManager.ts:428-431.
      void Promise.resolve(config.hookRunner?.runOnError?.(err as Error, {
        turnNumber: errorIteration,
        lastToolName,
      })).catch(() => { /* best-effort: onError hook */ })
      // v0.4.1 WS8 (render-once): the coordinator does NOT render the error
      // itself. It emits RUN_FAILED + returns a failed outcome; the FRONTEND
      // is the single renderer (Ink: App.handleSubmit catch; classic:
      // runSingleTask/runTask catch → formatErrorCardText). Pre-WS8 this
      // `renderer.error('Engine error: …')` double-printed under the
      // frontend's own error card on every engine failure.
      const errOutput = computeFinalOutput()
      eventEmitter.emit({ type: 'RUN_FAILED', error: errMsg, output: errOutput })
      result = { stopped: true, reason: 'error', output: errOutput || `[Error: ${errMsg}]` }
      }
    } finally {
      if (sharedState.currentTurnAbortController === turnAbortController) {
        sharedState.currentTurnAbortController = null
      }
      if (sharedState.softAbortRequested && sharedState.softAbortOwner === turnAbortController) {
        sharedState.softAbortRequested = false
        sharedState.softAbortOwner = null
      }
    }

    eventEmitter.emit({ type: 'RUN_EXECUTION_STOPPED', runId: effectiveRunId, stopReason: result.reason })

    // ── CompletionContract gate (v0.3.1: SINGLE source of truth) ──
    // stop_sequence only means the model stopped. The real verdict comes
    // from evaluateCompletion(). taskKind drives what "done" means:
    // informational (Q&A) doesn't need changes; mutation does.
    let completionVerdict: ReturnType<typeof evaluateCompletion> | null = null
    let reviewerFindings: string[] = []
    const ws = this.deps.contextManager.getWorkingState()
    const explorationAssessment = explorationProfile
      ? assessProjectExploration(explorationProfile, ws.filesRead)
      : null
    const hasChanges = ws.filesChanged.length > 0
    if (runContext) {
      const lastAssistant = [...messages].reverse().find((message) => message.role === 'assistant')
      runContext.completionCandidate = {
        hasToolCalls: Boolean(lastAssistant?.tool_calls?.length),
        text: result.output,
        changedFiles: [...ws.filesChanged],
        iteration: this.modelCallsThisRun.length,
      }
    }

    // Phase 5: final Reviewer — a deterministic post-run verdict from
    // structured state (NOT the model's self-report). Surfaces partial/
    // blocked loudly so false-success can't hide. The Reviewer findings
    // flow into evaluateCompletion so they can downgrade the verdict.
    try {
      const tg = currentGraph
      const tgSnapshot = tg && tg.size() > 0 ? tg.snapshot() : null
      const unsatisfiedFromGraph = tgSnapshot
        ? tgSnapshot.nodes.filter((n) => n.status !== 'completed').flatMap((n) =>
          n.acceptanceCriteria.map((desc) => `${n.id}: ${desc}`))
        : []
      const unsatisfiedExploration = explorationAssessment
        ? explorationAssessment.criteria.filter((criterion) => !criterion.satisfied).map((criterion) => criterion.description)
        : []
      const unsatisfiedGenericAnalysis = genericAnalysisReadTarget > ws.filesRead.length
        ? [`Inspect enough relevant files for evidence (${ws.filesRead.length}/${genericAnalysisReadTarget})`]
        : []
      const unsatisfiedExecutionVerification = executionVerificationRequired
        && ws.verification.passed.length + ws.verification.failed.length === 0
        ? ['Execute at least one real verification command and report its result']
        : []
      const review = reviewRun({
        taskKind: runContext?.taskKind ?? 'informational',
        goalPresent: userMessage.trim().length > 0,
        changedFiles: ws.filesChanged,
        verificationExecuted: ws.verification.passed.length + ws.verification.failed.length > 0,
        verificationPassed: ws.verification.failed.length === 0,
        unhandledFailures: ws.verification.failed.length,
        unresolvedBlockers: ws.unresolved.length,
        unsatisfiedCriteria: [
          ...unsatisfiedFromGraph,
          ...unsatisfiedExploration,
          ...unsatisfiedGenericAnalysis,
          ...unsatisfiedExecutionVerification,
        ],
        staleEvidence: [],
        scopeExcessive: ws.filesChanged.length > 20,
      })
      reviewerFindings = review.findings
      // Surface reviewer verdict + structured fields via EventLog for observability
      // (previously discarded — now logged so /trace and /why can surface them).
      eventLog?.append('protocol', 'reviewer', {
        verdict: review.verdict,
        taskKind: review.taskKind,
        satisfiedCriteria: review.satisfiedCriteria,
        unsatisfiedCriteria: review.unsatisfiedCriteria,
        staleEvidence: review.staleEvidence,
        verificationSummary: review.verificationSummary,
        residualRisks: review.residualRisks,
        findings: review.findings,
      })
      this.deps.eventEmitter.emit({ type: 'REVIEW_COMPLETED', verdict: review.verdict, findings: review.findings })
    } catch { /* best-effort */ }

    if (result.reason === 'stop_sequence') {
      // v0.3.2 P0-2 fix: use the pre-classified TaskIntent (runContext.taskKind)
      // as the authoritative task kind — NOT re-derived from hasChanges. A
      // mutation task that failed to produce changes must still be treated
      // as mutation (→ blocked), not silently reclassified as informational.
      // Falls back to the hasChanges heuristic only when no context exists.
      const taskKind = runContext?.taskKind ?? (hasChanges ? 'mutation' : 'informational')
      const tg = currentGraph
      const tgSnapshot = tg && tg.size() > 0 ? tg.snapshot() : null
      const acceptanceCriteria = tgSnapshot
        ? tgSnapshot.nodes.flatMap((n) =>
          n.acceptanceCriteria.map((desc, i) => ({ id: `${n.id}::${i}`, description: desc, satisfied: n.status === 'completed' })),
        )
        : []
      if (explorationAssessment) {
        acceptanceCriteria.push(...explorationAssessment.criteria)
      }
      if (genericAnalysisReadTarget > 0) {
        acceptanceCriteria.push({
          id: 'workspace-analysis-evidence',
          description: `Inspect enough relevant files for evidence (${ws.filesRead.length}/${genericAnalysisReadTarget})`,
          satisfied: ws.filesRead.length >= genericAnalysisReadTarget,
        })
      }
      if (executionVerificationRequired) {
        acceptanceCriteria.push({
          id: 'execution-verification-evidence',
          description: 'Execute at least one real verification command and report its result',
          satisfied: ws.verification.passed.length + ws.verification.failed.length > 0,
        })
      }
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
      if (runContext) runContext.completionVerdict = v
      // Serialize the verdict into the wire shape the event union
      // expects (a plain object with optional arrays). The full typed
      // verdict is preserved in the local `completionVerdict` for
      // downstream consumers.
      this.deps.eventEmitter.emit({
        type: 'COMPLETION_EVALUATED',
        verdict: serializeVerdict(v),
      })
      if (v.status !== 'completed') {
        this.deps.eventEmitter.emit({
          type: 'COMPLETION_REJECTED',
          verdict: serializeVerdict(v),
        })
        controlMessageLog.append({
          kind: 'completion_rejected',
          verdict: v.status,
          blockers: 'blockers' in v && v.blockers ? v.blockers :
                     'remaining' in v && v.remaining ? v.remaining : ['completion not accepted'],
        })
      }
    }

    if (!completionVerdict) {
      completionVerdict =
        result.reason === 'interrupted'
          ? { status: 'cancelled', reason: 'run interrupted' }
          : result.reason === 'max_iterations'
            ? {
                status: 'exhausted',
                reason: 'maximum iterations reached',
                iterationsUsed: 'iteration' in state ? state.iteration : effectiveMaxIterations,
                iterationsMax: effectiveMaxIterations,
              }
            : {
                status: 'failed',
                reason: result.output || `run stopped with ${result.reason}`,
                evidence: [],
              }
      if (runContext) runContext.completionVerdict = completionVerdict
    }

    // ── ExecutionRun terminal transition (GAP-C) ──
    if (registryRun && registry) {
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
        const run = registry.get(effectiveRunId)
        if (run && !isTerminalRunStatus(run.status)) {
          registry.transition(effectiveRunId, targetStatus, {
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
      // v0.3.2 (run-scoped runtime contract §Phase 9): emit RUN_STATUS_TRANSITIONED
      // before the final RUN_COMPLETED so consumers can observe the
      // exact status transition.
      this.deps.eventEmitter.emit({
        type: 'RUN_STATUS_TRANSITIONED',
        runId: effectiveRunId,
        from: 'running',
        to: targetStatus,
        verdict: serializeVerdict(completionVerdict ?? {
          status: 'failed',
          reason: 'no verdict',
          evidence: [],
        }),
      })
    }

    // v0.3.3 (background autonomy contract §十二.7): attach the completion verdict to the
    // TurnResult so CLI, Hook, Module, Loop and Eval can consume it.
    if (completionVerdict) {
      result.completionStatus = completionVerdict.status
      const reasons =
        'reasons' in completionVerdict ? completionVerdict.reasons
        : 'blockers' in completionVerdict ? completionVerdict.blockers
        : 'remaining' in completionVerdict ? completionVerdict.remaining
        : undefined
      result.completionReasons = reasons as string[] | undefined
    }

    // v0.3.4 (durable supervisor contract §Phase 1): construct the canonical TurnOutcome
    // BEFORE module/hook completion so they receive it.
    const wsFinal = this.deps.contextManager.getWorkingState()
    const status: CompletionStatus =
      result.reason === 'error' ? 'failed'
      : result.reason === 'interrupted' ? 'cancelled'
      : result.reason === 'max_iterations' ? 'exhausted'
      : (result.completionStatus as CompletionStatus) ?? 'completed'
    const outcome: TurnOutcome = {
      runId: effectiveRunId,
      stopReason: result.reason === 'interrupted' ? 'cancelled'
        : result.reason === 'max_iterations' ? 'max_iterations'
        : result.reason === 'error' ? 'error'
        : 'stop_sequence',
      completion: {
        status,
        reasons: result.completionReasons ?? [],
        // v0.4.1 WS7 (session truth): carry the REAL contract evidence and
        // next actions instead of hardcoded empties. The CompletionVerdict
        // branches that have evidence always populate it (completionContract
        // §evaluateCompletion); blocked verdicts carry blockers instead.
        evidence: completionVerdict && 'evidence' in completionVerdict
          ? completionVerdict.evidence.map((detail) => ({ type: 'contract', detail }))
          : [],
        requiredNextActions: completionVerdict
          ? ('remaining' in completionVerdict ? completionVerdict.remaining
            : 'blockers' in completionVerdict ? completionVerdict.blockers
            : [])
          : [],
      },
      output: result.output,
      changedFiles: [...wsFinal.filesChanged],
      artifacts: [],
      taskGraph: currentGraph && currentGraph.size() > 0 ? currentGraph.snapshot() : undefined,
      workerReferences: [
        ...[...sharedState.completedSubtasks.values()].map((worker) => ({ ...worker })),
        ...[...sharedState.activeSubtasks.entries()].map(([workerRunId, worker]) => ({
          runId: workerRunId,
          status: 'running',
          modelProfile: worker.modelProfile,
          modelRole: worker.modelRole,
          modelTier: worker.modelTier,
          model: worker.model,
          provider: worker.provider,
        })),
      ],
      verification: {
        executed: wsFinal.verification.passed.length + wsFinal.verification.failed.length > 0,
        passed: wsFinal.verification.failed.length === 0,
        failed: [...wsFinal.verification.failed],
      },
      modelAttempts: this.modelCallsThisRun.map((a) => ({
        profileId: a.model,
        model: a.model,
        provider: a.provider,
        startedAt: a.startedAt,
        endedAt: a.endedAt,
        status: a.success ? 'succeeded' as const : 'failed' as const,
        usage: a.usage,
        usageMissing: a.usageMissing,
        estimatedCost: a.estimatedCost,
        error: a.error,
      })),
      // v0.4.1 WS7 (session truth): wall-clock turn duration for the
      // session envelope's lastOutcome and the outcome card.
      durationMs: performance.now() - turnStartHighResolutionMs,
      // Deprecated compat
      stopped: result.stopped,
      reason: result.reason,
    }

    // v0.3.4 (durable supervisor contract §Phase 11): emit a status-specific terminal event.
    const terminalStatus = status
    eventEmitter.emit({ type: 'RUN_TERMINATED', status: terminalStatus, result })

    // R7: Stop hook fires on stop_sequence (model decides to stop).
    if (result.reason === 'stop_sequence' && config.hookRunner?.runStop) {
      try { await config.hookRunner.runStop('model_stopped') } catch { /* best-effort */ }
    }

    await this.deps.moduleManager.runComplete({
      cwd: config.cwd,
      sessionDir: config.sessionDir,
      turnResult: result,
      outcome,
      messages,
      eventLog,
      // v0.5.3 Final (task 2): pass the per-run context so the
      // MemoryModule's onComplete can promote this run's candidates.
      runContext: runContext ?? undefined,
      userMessage,
    })

    // best-effort: async hook rejections must not crash the turn
    // (unhandledRejection is process-fatal via cleanup.ts:59).
    // Promise.resolve() wraps the possibly-undefined / possibly-sync
    // HookResult[] return; a SYNC throw propagates to the caller
    // (existing contract: a throwing onComplete fails the turn — see
    // v034OutcomeE2e "closes the run context when a completion hook
    // throws"). Mirrors contextManager.ts:428-431.
    void Promise.resolve(config.hookRunner?.runOnComplete?.(result))
      .catch(() => { /* best-effort: onComplete hook */ })
    // v0.3.4 (durable supervisor contract §Phase 1): Hook receives the full TurnOutcome
    void Promise.resolve(config.hookRunner?.runOnCompleteWithOutcome?.(result, outcome))
      .catch(() => { /* best-effort: onCompleteWithOutcome hook */ })

    return { result, newHistory: messages, outcome }
    } catch (lifecycleErr) {
      // v0.5.5 §7: the entire post-identity lifecycle is wrapped.
      // Failures here mean the boot threw, the Router returned
      // unavailable, or something downstream raised before we
      // produced an Outcome. Convert to a structured Outcome.
      //
      // RoutingUnavailableError — v0.5.5 §6 — must produce a
      // blocked Outcome. NO Gateway call was made (the throw
      // happened in routeModel, before llm_call). The Run is
      // explicitly terminated and the audit trail is consistent.
      if (lifecycleErr instanceof RoutingUnavailableError) {
        const blocked: TurnOutcome = {
          runId: effectiveRunId,
          stopReason: 'routing_unavailable',
          completion: {
            status: 'blocked',
            reasons: ['routing-unavailable', ...lifecycleErr.reasonCodes],
            evidence: [],
            requiredNextActions: ['wait for profile recovery', 'check provider health'],
          },
          output: '',
          changedFiles: [],
          artifacts: [],
          verification: { executed: false, passed: false, failed: ['routing-unavailable'] },
          modelAttempts: [],
          stopped: true,
          reason: 'routing_unavailable',
        }
        eventEmitter.emit({
          type: 'RUN_TERMINATED',
          status: 'blocked',
          result: { reason: 'routing_unavailable', stopped: true, output: '' },
        })
        return { result: { reason: 'routing_unavailable', stopped: true, output: '' }, newHistory: history, outcome: blocked }
      }
      // Any other error: re-throw so the Engine's outer handler
      // turns it into a 'failed' Outcome.
      throw lifecycleErr
    }
    } finally {
      try { this.deps.runContextStore?.close(effectiveRunId) } catch { /* best-effort */ }
      // v0.5.3 Hotfix §1: clear activeRunId so consecutive turns
      // never see a stale id from a closed run.
      try {
        if (this.deps.sharedState.activeRunId === effectiveRunId) {
          this.deps.sharedState.activeRunId = null
        }
      } catch { /* best-effort */ }
      // v0.5.5 §7: routing-unavailable is per-run. Reset it so
      // the NEXT run on this engine can attempt routing again.
      try { this.deps.sharedState.routingUnavailable = false } catch { /* best-effort */ }
      // v0.5.5 §7: close the per-run candidate sink so a re-run
      // does not inherit candidates from a closed run.
      try {
        for (const m of this.deps.moduleManager.modules) {
          if (m.name === 'memory') {
            const mm = m as AgentModule & Partial<MemoryModuleControl>
            try { mm.closeCandidateSink?.(effectiveRunId) } catch { /* best-effort */ }
          }
        }
      } catch { /* best-effort */ }
    }
  }

  // ── Helpers ──────────────────────────────────────────────────────────────

  private async callLLM(
    systemPrompt: string,
    messages: OpenAIMessage[],
    toolDefs: ToolDefinition[],
    turnAbortSignal: AbortSignal,
    controlMessages: OpenAIMessage[] = [],
    // v0.4.1 WS4 (ExecutionProfile): the turn's resolved output-token base.
    // run() computes it as profileSpec.maxOutputTokens ?? config.maxOutputTokens;
    // absent (no other callers today) falls back to the plain config value so
    // this helper keeps its pre-v0.4.1 semantics if ever reused.
    turnMaxOutputTokens?: number,
    onFallback?: (from: string, to: string, reason: string) => void,
  ): Promise<{
    assistantText: string
    finishReason: string | null
    rawToolCalls: StreamingToolCall[]
    usage: TokenUsage | null
  }> {
    let modelAtStart = this.deps.config.model
    let caughtErr: unknown = null

    // v0.5.5 §6: if routing was unavailable for this Run, refuse
    // to invoke the Gateway at all. Caller must surface as a
    // blocked Outcome, NOT as a half-attempted completion.
    if (this.deps.sharedState.routingUnavailable) {
      throw new RoutingUnavailableError(
        ['routing-unavailable-still-active'],
      )
    }

    // v0.5.3 P0-3 + P1-3: per-profile circuit (router-owned) is
    // consulted here. CLOSED → call normally. HALF_OPEN → the
    // Router's probe lease (`tryAcquireProbe`) decides whether THIS
    // call is the probe; concurrent callers fail fast so the half-
    // open window carries exactly one in-flight call at a time.
    // OPEN → fail fast and let the caller advance via
    // nextFallback() to a different profile.
    const router = this.deps.modelRouter
    let probeLease: ProbeLease | null = null
    if (router) {
      const binding = router.listProfiles().find((p) => p.model === modelAtStart)
      if (binding) {
        const circuit = router.getProfileCircuitState(binding.id)
        if (circuit === 'open') {
          throw new Error(
            `Profile circuit OPEN for ${modelAtStart}: too many recent failures. ` +
            `Advance to a fallback profile before retrying.`,
          )
        }
        if (circuit === 'half-open') {
          // v0.5.3 Hotfix §7: lease-based probe acquisition. A
          // null lease means the profile is busy OR not yet
          // half-open — we don't release anything we don't own.
          probeLease = router.tryAcquireProbe(binding.id)
          if (!probeLease) {
            // Probe busy. Advance to fallback if available.
            const next = router.nextFallback(modelAtStart)
            if (!next) {
              // No fallback AND no lease: surface as a terminal
              // routing-unavailable condition.
              probeLease = null
              throw new Error(
                `Profile ${binding.id} is half-open with a probe in flight and no fallback available.`,
              )
            }
            // v0.5.5 §11: emit the fallback event BEFORE the
            // advance so the audit trail records exactly one
            // ROUTING_FALLBACK_APPLIED for the busy path. This
            // counter is the only signal that downstream
            // consumers have that a probe was skipped due to
            // contention (vs a normal open-circuit fallback).
            router.emitFallback(modelAtStart, next, 'half-open probe already in flight')
            router.applyRoutingDecision(next)
            onFallback?.(modelAtStart, next, 'half-open probe already in flight')
            modelAtStart = next
            // We never acquired the lease; the post-call cleanup
            // path therefore has nothing to release. Also, we do
            // NOT touch the OTHER run's lease — the Router's
            // probeInFlight Set is shared, but finishProbe is
            // gated by leaseId ownership, not profileId.
            probeLease = null
            // Re-evaluate the now-active profile's circuit.
            const newBinding = router.listProfiles().find((p) => p.model === modelAtStart)
            if (newBinding && router.getProfileCircuitState(newBinding.id) === 'open') {
              throw new Error(
                `After advancing to fallback ${next}, that profile is also OPEN. ` +
                `Skip this iteration; the next state-machine pass will re-route.`,
              )
            }
          }
        }
      }
    }

    // Exponential backoff driven by ROUTER-side consecutive failures
    // for the current profile (not a coordinator-local global).
    if (router) {
      const binding = router.listProfiles().find((p) => p.model === modelAtStart)
      if (binding) {
        // We rely on the same per-profile counter that the router
        // already updates via recordCall(); reading it via a new
        // accessor avoids duplicating bookkeeping here.
        const consecutive = router.getProfileConsecutiveFailures(binding.id)
        if (consecutive >= 2 && router.getProfileCircuitState(binding.id) === 'closed') {
          const baseMs = Math.min(
            RuntimeCoordinator.MAX_BACKOFF_MS,
            Math.pow(2, consecutive) * 1000,
          )
          const jitter = Math.floor(Math.random() * 500)
          const delayMs = baseMs + jitter
          this.deps.renderer.warn?.(`Provider backoff: waiting ${Math.round(delayMs / 1000)}s before retry (failure #${consecutive})`)
          await new Promise((resolve) => setTimeout(resolve, delayMs))
        }
      }
    }

    this.deps.eventEmitter.emit({ type: 'MODEL_REQUESTED', model: modelAtStart })
    let result: Awaited<ReturnType<typeof this.deps.modelGateway.call>> | null
    const attemptStartedAt = Date.now()
    this.deps.eventEmitter.emit({
      type: 'MODEL_ATTEMPT_STARTED',
      model: modelAtStart,
      attemptId: this.modelCallsThisRun.length,
    })
    try {
      // v0.3.1 (runtime truth contract §七): prepend control messages for this
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
          maxOutputTokens: this.deps.contextManager.effectiveMaxOutputTokens(
            turnMaxOutputTokens ?? this.deps.config.maxOutputTokens,
          ),
          abortSignal: turnAbortSignal,
          turnAbortController: this.deps.sharedState.currentTurnAbortController,
        },
        {
          onContextOverflow: async (msgs, signal) => {
            return this.deps.contextManager.reactiveCompact(msgs, signal)
          },
          // v0.3.1 (runtime truth contract §三.1.4): wire real fallback through the
          // Router. The Router's lastDecision.fallbackChain is the
          // source of truth; if it's exhausted, returns null and the
          // Gateway surfaces the original error.
          //
          // v0.5.3 P0-3: recordCall() is invoked ONCE per attempt
          // (the gateway already does this internally). On a
          // successful fallback we emit the structured event WITHOUT
          // also asking the router to record it — that was the
          // double-count bug. We DO increment the retry counter for
          // a same-model retry (different from a fallback).
          onProviderError: (failedModel, err) => {
            this.deps.eventEmitter.emit({ type: 'MODEL_FAILED', error: err.message })
            if (!this.deps.modelRouter) return null
            const next = this.deps.modelRouter.nextFallback(failedModel)
            if (next) {
              // Single source of truth: router bumps its own counter
              // and emits the routing-fallback event.
              this.deps.modelRouter.emitFallback(failedModel, next, err.message)
              try { this.deps.modelRouter.applyRoutingDecision(next) } catch { /* best-effort */ }
              onFallback?.(failedModel, next, err.message)
              return next
            }
            return null
          },
        },
      )
      for (const attempt of result.attempts) this.recordGatewayAttempt(attempt, {
        attemptScopeId: probeLease?.attemptScopeId,
        profileId: probeLease?.profileId,
      }) // result is non-null after await
    } catch (err) {
      const attempts = (err as { attempts?: Array<{
        model: string; provider: string; success: boolean; error?: string; latencyMs: number; usage: TokenUsage | null
      }> }).attempts
      // v0.5.3 Closure (P2): capture the error so the trailing
      // finally-block can release the probe lease AND we can
      // re-throw on the way out (the catch block is NOT a sink —
      // the error must propagate to run()).
      caughtErr = err
      if (attempts?.length) {
        for (const attempt of attempts) this.recordGatewayAttempt(attempt, {
          attemptScopeId: probeLease?.attemptScopeId,
          profileId: probeLease?.profileId,
        })
      } else {
        this.recordGatewayAttempt({
          model: modelAtStart,
          provider: 'unknown',
          success: false,
          error: (err as Error).message,
          latencyMs: Date.now() - attemptStartedAt,
          usage: null,
        }, {
          attemptScopeId: probeLease?.attemptScopeId,
          profileId: probeLease?.profileId,
        })
      }
    } finally {
      // v0.5.3 Closure (P2) + Hotfix §7: finishProbe MUST be
      // invoked exactly once per ACQUIRED lease token, in finally
      // so abort/throw/normal-return all release the lease and
      // resolve the half-open window. Verdict comes from the
      // SPECIFIC attempt for the probed profile, not the overall
      // gateway result. We do NOT call finishProbe unless we own
      // the lease — the token proves ownership.
      if (probeLease && router) {
        // v0.5.5 §9: only attempts whose attemptScopeId matches
        // the lease are eligible to drive the circuit verdict.
        // Earlier attempts (from a previous half-open probe) and
        // later attempts (from a subsequent successful call) MUST
        // NOT influence this lease's release.
        const scopedAttempts = this.modelCallsThisRun
          .filter((c) => c.attemptScopeId === probeLease!.attemptScopeId)
          .map((c) => ({
            model: c.model,
            provider: c.provider,
            success: c.success,
            latencyMs: c.endedAt - c.startedAt,
            usage: c.usage
              ? { inputTokens: c.usage.inputTokens, outputTokens: c.usage.outputTokens, totalTokens: c.usage.inputTokens + c.usage.outputTokens }
              : null,
            error: c.error,
          }))
        const probedBinding = router.listProfiles().find((p) => p.id === probeLease!.profileId)
        const probeAttempt = probedBinding
          ? scopedAttempts.find((a) => a.model === probedBinding.model)
          : undefined
        // v0.5.5 §10: explicit abort handling. If the turn was
        // aborted mid-probe, surface 'aborted' instead of
        // 'failure'. Aborted probes do NOT close the circuit.
        const wasAborted = turnAbortSignal.aborted
          || (caughtErr as { name?: string } | null)?.name === 'AbortError'
        const outcome: ProbeOutcome = wasAborted
          ? 'aborted'
          : probeAttempt?.success === true ? 'success' : 'failure'
        router.finishProbe(probeLease, outcome)
        probeLease = null
      }
    }

    // v0.5.3 Closure (P2): if the catch block above ran on a
    // gateway error, the original throw must propagate to the
    // outer run() so RUN_FAILED is emitted. The finally block
    // only owns the probe-lease lifecycle; the error must still
    // bubble up.
    if (caughtErr) {
      if (caughtErr instanceof Error) throw caughtErr
      const message = typeof caughtErr === 'string'
        ? caughtErr
        : (() => {
            try {
              return JSON.stringify(caughtErr) ?? 'unknown error'
            } catch {
              return 'unknown error'
            }
          })()
      throw new Error(message)
    }

    return result!
  }

  private recordGatewayAttempt(attempt: {
    model: string
    provider: string
    success: boolean
    error?: string
    latencyMs: number
    usage: TokenUsage | null
  }, meta?: { attemptScopeId?: string; profileId?: string }): void {
    const startedAt = Date.now() - attempt.latencyMs
    // R7 fix: delegate to modelGateway's retryable classifier so the
    // gateway and coordinator agree on what counts as retryable.
    const retryable = !attempt.success && this.deps.modelGateway.isRetryableProviderError(attempt.error ?? '')
    const usage = attempt.usage ?? undefined
    this.modelCallsThisRun.push({
      model: attempt.model,
      provider: attempt.provider,
      profileId: meta?.profileId,
      attemptScopeId: meta?.attemptScopeId,
      startedAt,
      endedAt: Date.now(),
      success: attempt.success,
      error: attempt.error,
      usage,
      estimatedCost: usage ? calculateUSDCost(attempt.model, usage) : 0,
      retryable,
    })
    const attemptId = this.modelCallsThisRun.length - 1
    // P1-5 (cost observability): a SUCCESSFUL call without usage metadata
    // used to be silently booked as $0 — indistinguishable from a free
    // call. Flag it instead: the attempt record carries usageMissing, the
    // EventLog gets an explicit entry, and the user sees one warning per
    // run. Nothing is fabricated — token totals stay accurate, the cost
    // total is visibly an under-report rather than a lie.
    if (attempt.success && !attempt.usage) {
      this.modelCallsThisRun[attemptId].usageMissing = true
      this.deps.eventLog?.append('llm_api_usage_missing', 'coordinator', {
        model: attempt.model,
        provider: attempt.provider,
      })
      if (!this.usageMissingWarned) {
        this.usageMissingWarned = true
        this.deps.renderer.warn?.(
          'LLM response carried no usage metadata — session costs are under-reported for this provider.',
        )
      }
    }
    this.deps.eventEmitter.emit(attempt.success
      ? {
          type: 'MODEL_ATTEMPT_SUCCEEDED',
          model: attempt.model,
          attemptId,
          latencyMs: attempt.latencyMs,
          usage,
        }
      : {
          type: 'MODEL_ATTEMPT_FAILED',
          model: attempt.model,
          attemptId,
          error: attempt.error ?? 'provider attempt failed',
          retryable,
        })
    this.deps.eventEmitter.emit({
      type: 'MODEL_CALL_RECORDED',
      profileId: meta?.profileId ?? 'unknown',
      ok: attempt.success,
      latencyMs: attempt.latencyMs,
      failureReason: attempt.error,
    })
    const binding = this.deps.modelRouter?.listProfiles().find((p) => p.model === attempt.model)
    // v0.5.3 P0-3: recordCall is invoked EXACTLY ONCE per attempt here.
    // The previous implementation also called recordCall from
    // recordUsage (below), which inflated success-call counts and
    // skewed the per-profile circuit + signal counters. recordUsage
    // no longer touches the router.
    if (binding) this.deps.modelRouter?.recordCall(binding.id, attempt.success, attempt.latencyMs, attempt.usage)
    if (attempt.success && attempt.usage) {
      this.recordUsage(attempt.usage, startedAt, attempt.model)
    }
  }

  private recordUsage(
    usage: TokenUsage | null,
    callStartMs: number,
    model: string,
  ): void {
    if (!usage) return // P0-3: null usage → no zero-cost bookkeeping
    const durationMs = Date.now() - callStartMs
    this.deps.costTracker.addUsage(model, usage, durationMs)
    // Prompt-cache observability (Round 27): /cache hit-rate + savings.
    if ((usage.cacheReadTokens ?? 0) > 0 || (usage.cacheWriteTokens ?? 0) > 0) {
      try {
        const saved = Math.max(
          0,
          calculateUncachedUSDCost(model, usage) - calculateUSDCost(model, usage),
        )
        recordCacheEntry(model, (usage.cacheReadTokens ?? 0) > 0, usage, saved)
      } catch { /* best-effort stats */ }
    }
    this.deps.eventLog?.append('llm_api', 'coordinator', {
      input_tokens: usage.inputTokens,
      output_tokens: usage.outputTokens,
      ...(usage.cacheReadTokens ? { cache_read_tokens: usage.cacheReadTokens } : {}),
      ...(usage.cacheWriteTokens ? { cache_write_tokens: usage.cacheWriteTokens } : {}),
      duration_ms: durationMs,
      model,
    })
  }

}

/**
 * v0.5.3 Hotfix §1 — mint a stable run id when no RunRegistry is
 * wired. Single source of truth; every consumer (activeRunId,
 * RunContext, ToolContext, MemoryCandidate, Worker parent,
 * TurnOutcome, finally close) binds to it through the Coordinator's
 * `effectiveRunId` local. Prefixed `local-` so legacy consumers
 * that try to distinguish registry-managed runs from
 * registry-less ones still work.
 */
export function createLocalRunId(): string {
  return `local-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
}

/**
 * Serialize a CompletionVerdict to the wire shape the RunEvent
 * union expects (a plain object with optional arrays). Consumers
 * that need the full discriminated union read `completionVerdict`
 * from the coordinator scope directly.
 */
function serializeVerdict(v: CompletionVerdict): {
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
