/**
 * ExecutionEngine — assembly root + lifecycle facade.
 *
 * After Phases 2–6, the engine no longer owns the runtime loop; the
 * RuntimeCoordinator drives the Think→Act→Observe cycle. The engine:
 *   1. Wires subsystems (Registry, EventBus, ResourceScheduler,
 *      ModelGateway, ContextManager, ToolRuntime, ModuleManager) in
 *      the constructor in dependency-correct order.
 *   2. Delegates runTurn() to RuntimeCoordinator (forwarding an
 *      optional per-turn parentRunId so loop/agent turns link into
 *      the hierarchical Run tree).
 *   3. Owns genuinely engine-level concerns that don't belong to any
 *      single subsystem: crash-recovery reconciliation
 *      (recoverNonTerminalRuns + scheduled recoverWorkers), the
 *      transactional model switch (setModel with rollback), and
 *      resource teardown (dispose/disposeAsync).
 *   4. Exposes the public lifecycle API (abort, softAbort, dispose,
 *      plan-mode toggles, cost/background-task/permission accessors).
 *
 * Architecture:
 *   ┌─────────────────────────────────────────────┐
 *   │              ExecutionEngine (facade)         │
 *   ├─────────────────────────────────────────────┤
 *   │  RuntimeCoordinator → main loop driver       │
 *   │    ├── ModelGateway     → LLM API + stream   │
 *   │    ├── ContextManager   → budget + compaction│
 *   │    ├── ToolScheduler    → partition + batch  │
 *   │    ├── ToolExecutor     → single tool exec   │
 *   │    ├── ToolPolicy       → exposure + exec    │
 *   │    └── ModuleManager    → lifecycle hooks    │
 *   └─────────────────────────────────────────────┘
 */

import OpenAI from 'openai'
import type {
  EngineConfig,
  OpenAIMessage,
  TurnResult,
  Tool,
} from './types.js'
import { createTools } from '../tools/index.js'
import type { Renderer } from '../ui/renderer.js'
import { globalModuleRegistry } from './moduleRegistry.js'
import { ModuleManager } from './moduleRuntime/moduleManager.js'
import { applyAgentToConfig } from './agentPresets.js'
import { CostTracker } from './costTracker.js'
import { BackgroundTaskManager } from './backgroundTaskManager.js'
import { FileHistory } from './fileHistory.js'
import { PermissionManager } from './permissionSystem.js'
import { ModelGateway } from './model/modelGateway.js'
import { createProviderAdapter } from './model/providerAdapter.js'
import { ModelRouter, routerFromSingleModel, type ModelProfile, type RoutingConfig, type BudgetAllocation } from './model/modelRouter.js'
import { validateProfiles, BindingRegistry } from './model/modelRuntimeManager.js'
import { ProgressMonitor } from './runtime/progressMonitor.js'
import { TaskGraph } from './runtime/taskGraph.js'
import { InMemoryTaskGraphStore, type TaskGraphStore } from './runtime/taskGraphStore.js'
import { ContextManager } from './context/contextManager.js'
import { ToolPolicy } from './toolRuntime/toolPolicy.js'
import { ToolExecutor } from './toolRuntime/toolExecutor.js'
import { ToolScheduler } from './toolRuntime/toolScheduler.js'
import { ToolRegistry } from './toolRuntime/toolRegistry.js'
import { RuntimeCoordinator } from './runtime/coordinator.js'
import { SharedRuntimeState } from './runtime/sharedState.js'
import { RunEventEmitter } from './runtime/events.js'
import { ExecutionRunRegistry, isTerminalRunStatus } from './executionRun.js'
import { ResourceScheduler } from './resourceScheduler.js'
import {
  ExecutionRunEventBus,
  JsonlEventStore,
  recoverRegistryFromStore,
} from './executionRunEvents.js'

/**
 * Phase 2: construct the ModelRouter from EngineConfig. Validates the
 * raw `models.profiles` (unknown[]) into typed ModelProfile[]. Falls
 * back to a single-profile router wrapping the configured model when
 * profiles are absent/invalid — so routing is always a safe no-op when
 * unconfigured, and override/health/`/route` still function.
 */
function buildRouter(config: EngineConfig): ModelRouter {
  const rawProfiles = config.models?.profiles
  if (Array.isArray(rawProfiles) && rawProfiles.length > 0) {
    const profiles: ModelProfile[] = []
    for (const rp of rawProfiles) {
      if (!rp || typeof rp !== 'object') continue
      const p = rp as Record<string, unknown>
      if (typeof p.model !== 'string' || !p.model) continue
      const cap = (p.capabilities ?? {}) as Record<string, unknown>
      const num = (v: unknown, d: number): number => typeof v === 'number' && Number.isFinite(v) ? v : d
      profiles.push({
        id: typeof p.id === 'string' ? p.id : p.model,
        provider: typeof p.provider === 'string' ? p.provider : (config.provider ?? 'openai'),
        model: p.model,
        capabilities: {
          reasoning: num(cap.reasoning, 0.7),
          coding: num(cap.coding, 0.7),
          contextWindow: num(cap.contextWindow, 128_000),
          toolCalling: num(cap.toolCalling, 0.7),
          speed: num(cap.speed, 0.6),
          cost: num(cap.cost, 0.5),
        },
        roles: Array.isArray(p.roles) ? p.roles.filter((r): r is string => typeof r === 'string') : ['main'],
        available: p.available !== false,
      })
    }
    if (profiles.length > 0) {
      // v0.3.1 (te_goal §三.1.2): reject cross-provider profiles up
      // front so the runtime never has to swap transports. The current
      // engine has only one OpenAI-compatible transport — multi-
      // provider rebinding is explicitly out of scope until the
      // ProviderRuntime abstraction lands.
      validateProfiles({ activeProvider: config.provider ?? 'openai', profiles })
      const r = config.models?.routing ?? {}
      const routing: RoutingConfig = {
        enabled: r.enabled !== false,
        longContextThreshold: r.longContextThreshold,
        failureEscalationThreshold: r.failureEscalationThreshold,
      }
      return new ModelRouter(profiles, routing)
    }
  }
  return routerFromSingleModel(config.model, config.provider ?? 'openai')
}

export class ExecutionEngine {
  private client: OpenAI
  private config: EngineConfig
  private renderer: Renderer
  private eventLog: EngineConfig['eventLog']
  private moduleManager: ModuleManager
  private costTracker: CostTracker
  private backgroundTaskManager: BackgroundTaskManager
  private fileHistory: FileHistory | null
  private permissionManager: PermissionManager
  private modelGateway: ModelGateway
  /**
   * Phase 2: adaptive model router. Holds configured profiles, tracks
   * per-profile health, and produces explainable RoutingDecisions.
   * Manual setModel() is registered as the sticky override (highest
   * priority). /route and /models read this.
   */
  private readonly modelRouter: ModelRouter
  /**
   * v0.3.1 (te_goal §三.1.2): the resolved ProviderRuntimeBinding for
   * each profile. /models + /route read this for health attribution
   * and cross-provider diagnostics.
   */
  private readonly bindingRegistry: BindingRegistry
  /**
   * v0.3.1 (te_goal §五): per-runId task-graph store. The legacy
   * single shared graph is replaced; each run mints its own graph.
   */
  private readonly taskGraphStore: TaskGraphStore
  /**
   * Phase 4: progress + stall monitor. ToolExecutor feeds every tool
   * result here; the coordinator queries detectStall() each iteration.
   * Drives /progress and the soft/hard-stall interventions.
   */
  private readonly progressMonitor: ProgressMonitor
  /**
   * Phase 3: optional task-decomposition DAG. Empty for simple tasks
   * (eight_goal §五.1 — don't force a graph on trivial work). A
   * planner/model populates it; the CompletionContract gate refuses
   * 'completed' while it has unfinished nodes.
   */
  private readonly taskGraph: TaskGraph
  private contextManager: ContextManager
  private toolPolicy: ToolPolicy
  private toolRegistry: ToolRegistry
  private toolScheduler: ToolScheduler
  private coordinator: RuntimeCoordinator
  private sharedState: SharedRuntimeState
  private eventEmitter: RunEventEmitter
  private _turnInFlight = false
  /**
   * five_goal P0-1: the ExecutionRun registry is ALWAYS present.
   * Previously this was optional and only created when
   * `executionRunLogDir` was set, which violated the spec
   * ("不得将'是否开启持久化'与'是否拥有 ExecutionRun'绑定").
   * Persistence is governed by `runStore` being set; the registry
   * itself is mandatory runtime state.
   */
  private readonly runRegistry: ExecutionRunRegistry
  /**
   * The ExecutionRunEventBus is always present too — persistence is
   * optional (via EventStore) but event fan-out is core.
   */
  private readonly runEventBus: ExecutionRunEventBus
  private readonly runStore?: JsonlEventStore
  /**
   * P1-1 (five_goal §八): ResourceScheduler is ALWAYS present and
   * wired into ToolScheduler. Per-tool resource claims (file/dir/git
   * R/W/X) are acquired before execution and released in finally.
   */
  private readonly resourceScheduler: ResourceScheduler

  constructor(config: EngineConfig, renderer: Renderer, client?: OpenAI) {
    this.config = applyAgentToConfig(config)
    this.renderer = renderer
    this.client = client ?? new OpenAI({
      apiKey: config.apiKey,
      baseURL: config.baseURL,
      maxRetries: 5,
      timeout: 120_000,
    })
    // ── ExecutionRun registry + event bus (five_goal P0-1) ───────────
    // Registry and bus ALWAYS exist — the spec forbids tying "has a
    // Run registry" to "has persistence configured". Only the
    // EventStore (JSONL backing) is optional; the in-memory registry
    // and bus are core runtime state.
    //
    // CREATED FIRST (before tools, executor, scheduler, coordinator)
    // so every downstream subsystem can be wired with the registry
    // handle. Previously createTools ran here and never received the
    // registry, leaving AgentTool/ClaudeCodeTool unable to mint child
    // runs — a critical wiring gap.
    const registry = new ExecutionRunRegistry()
    let bus: ExecutionRunEventBus
    if (config.executionRunLogDir) {
      const store = new JsonlEventStore(config.executionRunLogDir)
      const recovered = recoverRegistryFromStore(store)
      this.runStore = store
      this.runRegistry = recovered
      bus = new ExecutionRunEventBus(recovered, store)
      // P2-7: non-terminal runs are reconciled AFTER tools are created
      // so we can try reattach for external_worker runs. See
      // recoverNonTerminalRuns() below.
      this.pendingRecovery = true
    } else {
      this.runRegistry = registry
      bus = new ExecutionRunEventBus(registry)
    }
    this.runEventBus = bus

    // ── ResourceScheduler (five_goal P1-1) ──────────────────────────
    // Always created and wired into ToolScheduler. Tools declare
    // per-input claims via metadata.claims; the scheduler acquires
    // them atomically before execution and releases in finally.
    this.resourceScheduler = new ResourceScheduler({
      workspaceKey: config.cwd,
      registry: this.runRegistry,
      eventBus: bus,
    })

    // ── Tools (NOW wired with the registry) ─────────────────────────
    // createTools receives runRegistry so AgentTool/ClaudeCodeTool
    // can create child runs linked to the current TurnRun. The
    // per-turn runId is still injected dynamically via
    // ToolContext.execution (coordinator.ts) — the constructor only
    // passes the registry handle, not a fixed parentRunId.
    //
    // Phase 3/4: progress monitor + task graph must exist BEFORE
    // createTools (the TaskPlan tool receives the graph handle).
    this.modelRouter = buildRouter(this.config)
    // v0.3.1 (te_goal §三.1.2): resolve ProviderRuntimeBindings for
    // every profile so /models + /route can report the actual
    // transport, baseURL, and capabilities tied to the active engine.
    // resolveBindings reuses the engine's existing adapter (one
    // transport) — the BindingRegistry is a read-only view, not a
    // second router or adapter.
    const providerAdapter = createProviderAdapter({ provider: this.config.provider, client: this.client })
    this.bindingRegistry = new BindingRegistry(
      this.modelRouter.listProfiles().map((profile) => ({
        profileId: profile.id,
        provider: this.config.provider ?? 'openai',
        model: profile.model,
        baseURL: this.config.baseURL,
        apiKeyRef: this.config.provider === 'openai'
          ? 'OPENAI_API_KEY'
          : this.config.provider === 'minimax'
            ? 'ANTHROPIC_AUTH_TOKEN'
            : undefined,
        adapter: providerAdapter,
        capabilities: profile.capabilities,
        roles: profile.roles,
      })),
    )
    this.progressMonitor = new ProgressMonitor()
    this.eventEmitter = new RunEventEmitter()
    // v0.3.1 (te_goal §五): the TaskGraphStore is the new source of
    // truth. The `this.taskGraph` field is kept as a back-compat shim
    // — it points at the most-recently-created graph so legacy callers
    // (TaskPlanTool, /tasks) still work. New code should prefer the
    // store.
    this.taskGraphStore = new InMemoryTaskGraphStore()
    // v0.3.1 (te_goal §五 + §六.1 + §十一.14): wire TaskGraph events
    // into BOTH the RunEventEmitter (for /trace + EventStore replay)
    // and a hook that records node transitions on the ProgressMonitor
    // (so node completions / failures count as progress for the stall
    // detector). Single setEventSink call — TASK_GRAPH_CREATED is
    // emitted on every store.create().
    this.taskGraphStore.setEventSink((evt) => {
      // The store emits TASK_GRAPH_CREATED which is declared on the
      // RunEvent union. RunEventEmitter.emit accepts RunEvent directly
      // so the original payload is accepted without a cast.
      this.eventEmitter.emit(evt)
    })
    this.taskGraph = this.taskGraphStore.create('default')
    // Wire every graph created (including future per-runId ones)
    // back into the same progress monitor.
    const wireGraph = (g: import('./runtime/taskGraph.js').TaskGraph) => {
      g.setNodeTransitionSink((t) => this.progressMonitor.recordTaskNodeTransition(t))
    }
    wireGraph(this.taskGraph)
    this.tools = config.agentFactory
      ? createTools(config.extraTools ?? [], {
           factory: config.agentFactory,
           parentConfig: config,
           parentRenderer: renderer,
           runRegistry: this.runRegistry,
           taskGraph: this.taskGraph,
         })
      : createTools(config.extraTools ?? [], {
           runRegistry: this.runRegistry,
           taskGraph: this.taskGraph,
         })
    this.eventLog = config.eventLog
    this.costTracker = new CostTracker()
    this.backgroundTaskManager = new BackgroundTaskManager()
    this.sharedState = new SharedRuntimeState(config.planMode ?? false, config.model)
    this.fileHistory = config.sessionDir ? new FileHistory(config.sessionDir) : null
    this.permissionManager = config.permissionManager ?? new PermissionManager()
    if (!config.permissionManager) {
      if (config.permissionMode === 'auto') this.permissionManager.setMode('bypassPermissions')
      else if (config.permissionMode === 'deny') this.permissionManager.setMode('plan')
      else this.permissionManager.setMode('default')
    }

    const enabledNames = this.deriveEnabledModules()
    const resolvedModules = enabledNames.length > 0
      ? globalModuleRegistry.resolve(enabledNames, {
          client: this.client,
          model: config.model,
          config,
        })
      : []
    this.moduleManager = new ModuleManager({
      modules: resolvedModules,
      renderer: this.renderer,
      eventLog: this.eventLog,
    })

    this.modelGateway = new ModelGateway({
      // Phase 1: ModelGateway delegates to a ProviderAdapter instead of
      // touching the OpenAI SDK directly. The adapter owns provider
      // request shape + stream_options probing; selection is driven by
      // config.provider (default openai-compatible).
      adapter: createProviderAdapter({ provider: this.config.provider, client: this.client }),
      renderer: this.renderer,
    })
    // NOTE: `this.modelRouter` is assigned once above (line 235). v0.3.1
    // removed the duplicate buildRouter() that previously overwrote the
    // router used by coordinator/tools — single-router invariant.
    this.contextManager = new ContextManager({
      client: this.client,
      model: this.config.model,
      maxContextTokens: this.config.maxContextTokens,
      maxOutputTokens: this.config.maxOutputTokens,
      sessionDir: this.config.sessionDir,
      renderer: this.renderer,
      eventLog: this.eventLog,
      hookRunner: this.config.hookRunner,
    })
    this.toolPolicy = new ToolPolicy({ agent: this.config.agent })
    this.toolRegistry = new ToolRegistry(this.renderer)
    // v0.3.1 (te_goal §三.1.1): wire ModelRouter as a sink to this
    // engine. All router-side model changes funnel through Engine's
    // switchModel() so config.model + ContextManager + ModuleManager +
    // sharedState + ModelGateway + RunEventEmitter stay consistent.
    // CRITICAL: the sink here calls switchModel / applyBudgetAllocation
    // directly (not the public setModelByUser) so the router's event
    // emission is the one and only source of these events — no recursion.
    this.modelRouter.setSink({
      setModelByUser: (model: string) => this.switchModel(model),
      applyRoutingDecision: (model: string, alloc) => {
        this.switchModel(model)
        if (alloc) this.applyBudgetAllocation(alloc)
      },
      clearModelOverride: () => { /* no engine-side state to clear */ },
    })
    this.modelRouter.setEventListener((evt) => {
      // Bridge Router events into RunEventEmitter for /trace + /why.
      // The router event payload is structurally a subtype of the
      // RunEvent union variants; we map them field-by-field.
      const e: import('./runtime/events.js').RunEventEmitter = this.eventEmitter
      switch (evt.type) {
        case 'MODEL_OVERRIDE_SET':
          e.emit({
            type: 'MODEL_OVERRIDE_SET',
            modelOrProfile: String(evt.payload?.modelOrProfile ?? ''),
          })
          break
        case 'MODEL_OVERRIDE_CLEARED':
          e.emit({ type: 'MODEL_OVERRIDE_CLEARED' })
          break
        case 'ROUTING_DECISION_APPLIED':
          e.emit({
            type: 'ROUTING_APPLIED',
            from: this.config.model,
            to: String(evt.payload?.selectedModel ?? ''),
            reasonCodes: [],
          })
          break
        case 'ROUTING_FALLBACK_APPLIED':
          e.emit({
            type: 'ROUTING_FALLBACK',
            from: String(evt.payload?.from ?? ''),
            to: String(evt.payload?.to ?? ''),
            error: String(evt.payload?.error ?? ''),
          })
          break
        case 'BUDGET_ALLOCATION_APPLIED':
          e.emit({
            type: 'BUDGET_ALLOCATION_APPLIED',
            allocation: evt.payload?.allocation ?? {},
          })
          break
      }
    })
    const toolExecutor = new ToolExecutor({
      toolRegistry: this.toolRegistry,
      toolPolicy: this.toolPolicy,
      permissionManager: this.permissionManager,
      contextManager: this.contextManager,
      requestPermission: this.config.requestPermission,
      notifyToolCall: (toolName, input, result, turnNumber) =>
        this.moduleManager.notifyToolCall(toolName, input, result, turnNumber),
      hookRunner: this.config.hookRunner,
      eventEmitter: this.eventEmitter,
      progressMonitor: this.progressMonitor,
      renderer: this.renderer,
    })
    this.toolScheduler = new ToolScheduler({
      executor: toolExecutor,
      toolRegistry: this.toolRegistry,
      renderer: this.renderer,
      eventLog: this.eventLog,
      hookRunner: this.config.hookRunner,
      contextManager: this.contextManager,
      sharedState: this.sharedState,
      eventEmitter: this.eventEmitter,
      claimSoftAbort: (ctrl) => this.sharedState.claimSoftAbort(ctrl),
      resourceScheduler: this.resourceScheduler,
    })

    this.coordinator = new RuntimeCoordinator({
      config: this.config,
      renderer: this.renderer,
      eventLog: this.eventLog,
      costTracker: this.costTracker,
      backgroundTaskManager: this.backgroundTaskManager,
      permissionManager: this.permissionManager,
      fileHistory: this.fileHistory,
      modelGateway: this.modelGateway,
      contextManager: this.contextManager,
      toolScheduler: this.toolScheduler,
      toolPolicy: this.toolPolicy,
      toolRegistry: this.toolRegistry,
      moduleManager: this.moduleManager,
      baseTools: this.tools,
      sharedState: this.sharedState,
      eventEmitter: this.eventEmitter,
      runRegistry: this.runRegistry,
      progressMonitor: this.progressMonitor,
      taskGraph: this.taskGraph,
      // v0.3.1 (te_goal §五): per-runId graph store
      taskGraphStore: this.taskGraphStore,
      // v0.3.1 (te_goal §三.1.3): expose ModelRouter to the coordinator
      // so the signal collector can read live provider health.
      modelRouter: this.modelRouter,
      // Phase 2: per-turn adaptive routing. The callback runs the router
      // and, when routing is enabled with no manual override and the
      // decision differs from the current model, transactionally switches
      // (setModel) for this turn. Honours --model//model override priority.
      // v0.3.1: passes the full RoutingDecision (not just the model) so
      // budgetAllocation.maxOutputTokens is applied.
      routeModel: (input) => {
        const router = this.modelRouter
        if (!router.isRoutingEnabled() || router.getManualOverride()) return null
        const decision = router.route(input)
        if (decision.selectedModel && decision.selectedModel !== this.config.model) {
          try {
            // v0.3.1: applyRoutingDecision does NOT set manual override —
            // auto-routing must remain re-routable on subsequent turns.
            // It also applies decision.budgetAllocation so the Router's
            // budget-pressure decision actually constrains maxOutputTokens.
            this.applyRoutingDecision(decision.selectedModel, decision.budgetAllocation)
            return decision.selectedModel
          } catch { return null }
        }
        return null
      },
    })

    // P2-7: reconcile non-terminal runs AFTER tools are created so
    // recoverWorkers() can call adapter.reattach().
    this.recoverNonTerminalRuns()
    // P1-3 fix: schedule the async worker reattach so external_worker
    // runs don't stay stuck in 'recovery-pending-reattach' forever.
    // runWorkerRecovery() is a no-op when nothing is pending; the
    // scheduled promise is merged with any explicit recoverWorkers()
    // call so tests/hosts that invoke it manually get the same result.
    this.recoveryInFlight = this.runWorkerRecovery().catch(() => ({ reattached: 0, lost: 0 }))
  }

  private tools: Tool[]
  private pendingRecovery = false
  /**
   * P1-3: in-flight worker-recovery promise. Set by the constructor's
   * auto-schedule; consumed (and cleared) by an explicit recoverWorkers()
   * call so manual callers never double-process the same pending runs.
   */
  private recoveryInFlight: Promise<{ reattached: number; lost: number }> | null = null

  /**
   * P2-7 (five_goal §十四): reconcile non-terminal runs from the
   * previous process. Called synchronously at the end of the
   * constructor.
   *
   *   non-worker runs (turn/agent/workflow/shell_task) → 'failed'
   *   external_worker runs                            → kept non-terminal
   *     with phase 'recovery-pending-reattach' so the async
   *     recoverWorkers() method can try reattach.
   */
  private recoverNonTerminalRuns(): void {
    if (!this.pendingRecovery) return
    this.pendingRecovery = false
    const registry = this.runRegistry
    const nonTerminal = registry.list().filter(r =>
      r.status === 'preparing' ||
      r.status === 'running' ||
      r.status === 'verifying' ||
      r.status === 'waiting',
    )
    for (const run of nonTerminal) {
      if (run.kind === 'external_worker') {
        // Defer to async recoverWorkers() — keep non-terminal.
        try {
          registry.update(run.runId, {
            phase: 'recovery-pending-reattach',
            error: 'process restarted mid-run',
          })
        } catch { /* best-effort */ }
      } else {
        // Non-worker runs cannot survive restart.
        try {
          registry.transition(run.runId, 'failed', {
            phase: 'recovery-marked-failed',
            error: 'process restarted mid-run',
          })
        } catch { /* best-effort */ }
      }
    }
  }

  /**
   * P2-7: try to reattach external_worker runs that survived the
   * process restart. For each pending-reattach run, checks if the
   * tmux session still exists via the tool's WorkerAdapter.reattach().
   * On success, the run stays non-terminal and the runId→session
   * mapping is restored. On failure, the run transitions to 'lost'.
   *
   * Call this once after construction (e.g. in the boot flow) if
   * executionRunLogDir is configured.
   */
  async recoverWorkers(): Promise<{ reattached: number; lost: number }> {
    // P1-3: if the constructor already auto-scheduled recovery, await
    // that single pass instead of starting a concurrent one (which
    // could double-transition the same pending runs). Once consumed,
    // subsequent callers run a fresh (usually no-op) pass.
    if (this.recoveryInFlight) {
      const result = await this.recoveryInFlight
      this.recoveryInFlight = null
      return result
    }
    return this.runWorkerRecovery()
  }

  private async runWorkerRecovery(): Promise<{ reattached: number; lost: number }> {
    const registry = this.runRegistry
    const pending = registry.list().filter(r =>
      r.kind === 'external_worker' &&
      r.phase === 'recovery-pending-reattach' &&
      !isTerminalRunStatus(r.status),
    )
    if (pending.length === 0) return { reattached: 0, lost: 0 }

    // Find WorkerAdapter tools.
    const adapters: import('./workerAdapter.js').WorkerAdapter[] = []
    for (const tool of this.tools) {
      if (typeof (tool as { reattach?: unknown }).reattach === 'function') {
        adapters.push(tool as unknown as import('./workerAdapter.js').WorkerAdapter)
      }
    }

    let reattached = 0
    let lost = 0
    for (const run of pending) {
      let didReattach = false
      for (const adapter of adapters) {
        if (!adapter.reattach) continue
        try {
          const handle = await adapter.reattach(run.runId, {
            type: 'tmux',
            sessionId: run.worker,
          })
          if (handle) {
            didReattach = true
            break
          }
        } catch { /* best-effort */ }
      }
      if (didReattach) {
        try {
          registry.update(run.runId, { phase: 'reattached', error: undefined })
        } catch { /* best-effort */ }
        reattached++
      } else {
        try {
          registry.transition(run.runId, 'lost', {
            phase: 'recovery-reattach-failed',
            error: 'worker pane not found after restart',
          })
        } catch { /* best-effort */ }
        lost++
      }
    }
    return { reattached, lost }
  }

  private deriveEnabledModules(): string[] {
    if (this.config.enabledModules !== undefined) {
      return this.config.enabledModules
    }
    const auto: string[] = []
    if (this.config.semanticMemory && this.config.episodicMemory) {
      auto.push('memory')
    }
    if (this.config.sessionDir && !this.sharedState.planModeActive) {
      auto.push('critic')
    }
    if (this.config.sessionDir) {
      auto.push('workspace')
    }
    return auto
  }

  /** Hard cancel — immediately aborts in-flight API calls and tool executions */
  abort(): void {
    this.sharedState.currentTurnAbortController?.abort('user_cancelled')
  }

  /**
   * Tear down engine-owned side effects. Delegates to the
   * BackgroundTaskManager and ModuleManager so resources spawned during
   * the engine's lifetime do not outlive it.
   *
   * P0-9: also tears down the global tmuxLayout singleton (kills the
   * agent monitor tmux session unless a user is currently attached)
   * and clears SharedRuntimeState.activeToolCalls defensively in case
   * a ToolScheduler exit path left entries behind (e.g. mid-batch
   * hard abort).
   *
   * This is the SYNC dispose — best-effort, fire-and-forget. The
   * async disposer (disposeAsync) awaits ModuleManager.disposeAsync
   * so MCP child processes / async resources are fully reaped before
   * the host process exits. Callers that can await should prefer
   * disposeAsync().
   */
  dispose(): void {
    try {
      this.backgroundTaskManager.dispose()
    } catch {
      // disposal must not throw
    }
    this.moduleManager.dispose()
    // Clear any straggler active-tool-call entries. (ToolScheduler
    // already does this per-call in finally, but a hard abort between
    // batches can leave entries; clearing here is defense-in-depth.)
    try {
      this.sharedState.activeToolCalls.clear()
    } catch {
      // best-effort
    }
    // P0-9: kill the monitor tmux session. tmuxLayout.destroy() is
    // best-effort and skips killing when a user is attached (so we
    // don't yank the monitor out from under someone watching it).
    try {
      // Lazy require to avoid importing tmux at module load on hosts
      // that never enter the multi-pane path.
      const { tmuxLayout } = require('../../ui/tmuxLayout.js') as {
        tmuxLayout: { destroy: () => void }
      }
      tmuxLayout.destroy()
    } catch {
      // tmuxLayout is best-effort; never throw out of dispose
    }
  }

  /**
   * P0-9: async dispose — awaits ModuleManager.disposeAsync so MCP
   * child processes, file handles, and other async resources are
   * fully reaped before the host exits. Then runs the sync dispose
   * for everything else.
   *
   * Callers that can await (e.g. CLI graceful shutdown) should prefer
   * this over `dispose()`. The SIGTERM / crash path should still
   * call `dispose()` so we don't block exit on slow MCP servers.
   */
  async disposeAsync(): Promise<void> {
    try {
      await this.moduleManager.disposeAsync()
    } catch {
      // disposal must not throw
    }
    this.dispose()
  }

  /** Soft interrupt — pause after current tool, preserve history */
  softAbort(): void {
    this.sharedState.softAbortRequested = true
    this.sharedState.softAbortOwner = this.sharedState.currentTurnAbortController
  }

  async runTurn(
    userMessage: string,
    history: OpenAIMessage[],
    images?: Array<{ path: string; dataUrl: string }>,
    opts?: { parentRunId?: string },
  ): Promise<{ result: TurnResult; newHistory: OpenAIMessage[] }> {
    if (this._turnInFlight) {
      throw new Error(
        'ExecutionEngine.runTurn rejected: another turn is already in progress on this engine instance. ' +
        'Each ExecutionEngine is single-turn; await the in-flight turn or spawn a new engine via EngineConfig.agentFactory.',
      )
    }
    this._turnInFlight = true
    try {
      return await this.coordinator.run(userMessage, history, images, opts)
    } finally {
      this._turnInFlight = false
    }
  }

  getModel(): string {
    return this.config.model
  }

  /**
   * P0-1 (transactional model switch): update the model atomically.
   *
   * Previously this method only mutated `config.model`, leaving every
   * downstream subsystem holding stale state derived from the old
   * model:
   *   - ContextManager.deps.model + resolvedContextWindow cache
   *     → wrong budget thresholds, wrong max_tokens sent to the LLM,
   *       compaction summarization requests hitting the OLD model.
   *   - CriticModule/ReflectionModule capture `model` in their
   *     factory → background LLM calls (critic loop, post-run
   *     knowledge extraction) silently targeted the OLD model.
   *   - ModelGateway._streamUsageSupported latch → switching from a
   *     provider that rejected stream_options to one that supports
   *     it left usage streaming permanently disabled.
   *
   * The transaction order below matches fi_goal.md §P0-1:
   *   resolve model → resolve Provider → resolve capabilities →
   *   update context window → clear caches → notify dependents →
   *   commit config.
   *
   * Cross-Provider switches (different apiKey / baseURL) are NOT
   * supported here — they require constructing a new ExecutionEngine
   * (or restart). That is explicitly out of scope until Phase 8
   * (Provider Capability Abstraction) lands.
   */
    /**
     * v0.3.1 (te_goal §三.1.1): split manual vs auto model switching.
     * setModel / setModelByUser set the sticky override (CLI --model,
     * /model). applyRoutingDecision does NOT — otherwise one auto-route
     * locks the model forever and subsequent turns never re-route.
     */
    setModel(model: string): void {
      this.setModelByUser(model)
    }

    setModelByUser(model: string): void {
      this.validateModelProviderMatch(model, 'manual')
      // v0.3.1 (te_goal §三.1.1): route through ModelRouter.setModelByUser
      // (NOT the legacy setManualOverride) so the router is the one
      // source of truth for the manual-override flag, emits the
      // MODEL_OVERRIDE_SET event, and calls the sink which calls
      // switchModel() here. No double-switch, no recursion.
      this.modelRouter.setModelByUser(model)
    }

    /** Auto-routing path: switch WITHOUT setting the manual override. */
    applyRoutingDecision(model: string, budgetAllocation?: BudgetAllocation): void {
      this.validateModelProviderMatch(model, 'auto')
      this.switchModel(model)
      if (budgetAllocation) this.applyBudgetAllocation(budgetAllocation)
    }

    /** Clear the manual override, restoring auto-routing (/model auto). */
    clearModelOverride(): void {
      this.modelRouter.setManualOverride(null)
    }

    /**
     * v0.3.1 (te_goal §三.1.2 + §三.1.4): a model whose profile declares
     * a different provider than the active engine transport is
     * rejected. We don't have multi-adapter switching; the engine
     * comment at line 639-642 documents this. With no profile match
     * (the user typed a bare model string), accept it through and
     * let /models + audit surface the mismatch.
     */
    private validateModelProviderMatch(modelOrProfile: string, _path: 'manual' | 'auto'): void {
      const router = this.modelRouter
      const profile = router.listProfiles().find(
        (p) => p.id === modelOrProfile || p.model === modelOrProfile,
      )
      if (!profile) return
      const activeProvider = this.config.provider ?? 'openai'
      if (profile.provider && profile.provider !== activeProvider) {
        throw new Error(
          `Cross-provider model switch rejected: profile "${profile.id}" ` +
          `targets provider "${profile.provider}" but engine transport is ` +
          `"${activeProvider}". Update config.models.profiles to match the ` +
          `single configured provider, or restart with a different ` +
          `--provider flag.`,
        )
      }
    }

    /**
     * v0.3.1 (te_goal §三.1.4): apply a routing-decided budget
     * allocation. We mutate maxOutputTokens only (maxInputTokens is
     * governed by the model profile's context window, already on the
     * active ContextManager). The latch prevents thrash — repeated
     * identical allocations are no-ops.
     */
    private lastAppliedBudget: { maxOutputTokens?: number } | null = null
    private applyBudgetAllocation(alloc: BudgetAllocation): void {
      const next = { maxOutputTokens: alloc.maxOutputTokens }
      if (this.lastAppliedBudget
        && this.lastAppliedBudget.maxOutputTokens === next.maxOutputTokens) {
        return
      }
      this.lastAppliedBudget = next
      if (alloc.maxOutputTokens !== undefined) {
        this.config.maxOutputTokens = alloc.maxOutputTokens
        this.contextManager.onModelChanged(this.config.model)
      }
    }

    private switchModel(model: string): void {
      if (this.config.model === model) return
      const previousModel = this.config.model
      try {
        this.config.model = model
        this.contextManager.onModelChanged(model)
        this.moduleManager.notifyModelChanged(model)
        this.modelGateway.resetStreamUsageLatch()
        this.sharedState.updateModelState({ model })
        this.eventEmitter.emit({ type: 'MODEL_CHANGED', from: previousModel, to: model })
      } catch (err) {
        this.config.model = previousModel
        try {
          this.contextManager.onModelChanged(previousModel)
          this.moduleManager.notifyModelChanged(previousModel)
          this.sharedState.updateModelState({ model: previousModel })
        } catch { /* best-effort rollback */ }
        // Rollback router override too — failed manual switch must not
        // leave a sticky bad override (te_goal §三.1.1).
        if (this.modelRouter.getManualOverride()
          && this.modelRouter.getManualOverride() !== previousModel) {
          this.modelRouter.setManualOverride(null)
        }
        throw err
      }
    }

  getCostTracker(): CostTracker {
    return this.costTracker
  }

  /** Phase 2: adaptive model router (profiles, health, /route, /models). */
  getModelRouter(): ModelRouter {
    return this.modelRouter
  }

  /**
   * v0.3.1 (te_goal §三.1.2): resolved ProviderRuntimeBindings for
   * each profile. /models + /route use this to display the active
   * transport, baseURL, and apiKeyRef so misconfigurations surface
   * instead of being silently masked.
   */
  getBindingRegistry(): BindingRegistry {
    return this.bindingRegistry
  }

  /** Phase 4: progress/stall monitor (fed by ToolExecutor, queried each iteration). */
  getProgressMonitor(): ProgressMonitor {
    return this.progressMonitor
  }

  /** v0.3.1 (te_goal §八): expose ContextManager so /progress can
   *  render the working state (files changed, verification, etc.). */
  getContextManager(): ContextManager {
    return this.contextManager
  }

  /** Phase 3: task-decomposition graph (empty for simple tasks). */
  getTaskGraph(): TaskGraph {
    return this.taskGraph
  }

  /**
   * v0.3.1 (te_goal §五): the per-runId task-graph store. Use this
   * for new code; getTaskGraph() returns the legacy default-run shim.
   */
  getTaskGraphStore(): TaskGraphStore {
    return this.taskGraphStore
  }

  getBackgroundTaskManager(): BackgroundTaskManager {
    return this.backgroundTaskManager
  }

  getPermissionManager(): PermissionManager {
    return this.permissionManager
  }

  isPlanMode(): boolean {
    return this.sharedState.planModeActive
  }

  getConfig(): EngineConfig {
    return this.config
  }

  /**
   * five_goal P0-1: the ExecutionRun registry is ALWAYS present.
   * (Previously returned undefined when persistence was off — that
   * broke any caller that wanted to mint child runs without
   * configuring a log directory.)
   */
  getRunRegistry(): ExecutionRunRegistry {
    return this.runRegistry
  }

  /**
   * The ExecutionRun event bus. Always present; subscribers receive
   * every run/tool/artifact/verification event with persist-first
   * ordering (when an EventStore is wired in).
   */
  getRunEventBus(): ExecutionRunEventBus {
    return this.runEventBus
  }

  exitPlanMode(): void {
    this.sharedState.planModeActive = false
  }

  enterPlanMode(): void {
    this.sharedState.planModeActive = true
  }

  queueSnip(keepRecent: number): void {
    this.contextManager.queueSnip(keepRecent)
  }

  getFileHistory(): FileHistory | null {
    return this.fileHistory
  }

  getToolRegistry(): ToolRegistry {
    return this.toolRegistry
  }

  getEventEmitter(): RunEventEmitter {
    return this.eventEmitter
  }

  getSharedState(): SharedRuntimeState {
    return this.sharedState
  }

  /**
   * Returns the base tool list constructed by createTools. These are
   * the same Tool instances wired into the ToolRegistry. Useful for
   * integration tests that need to inspect per-tool wiring (e.g.
   * verify AgentTool.runRegistry was set by the Engine constructor).
   */
  getTools(): Tool[] {
    return this.tools
  }

  /**
   * Returns the ToolScheduler instance used by the coordinator.
   * Integration tests inspect its deps to verify ResourceScheduler
   * wiring.
   */
  getToolScheduler(): ToolScheduler {
    return this.toolScheduler
  }

  /**
   * Returns the ResourceScheduler. Always present (five_goal P1-1).
   */
  getResourceScheduler(): ResourceScheduler {
    return this.resourceScheduler
  }
}
