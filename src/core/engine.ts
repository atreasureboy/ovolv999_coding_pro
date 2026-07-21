/**
 * ExecutionEngine — thin facade and assembly root.
 *
 * After Phases 2–6, the engine no longer owns the runtime loop. It:
 *   1. Wires subsystems (ModelGateway, ContextManager, ToolRuntime,
 *      ModuleManager) in the constructor.
 *   2. Delegates runTurn() to RuntimeCoordinator.
 *   3. Exposes the public lifecycle API (abort, softAbort, dispose,
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
import { ContextManager } from './context/contextManager.js'
import { ToolPolicy } from './toolRuntime/toolPolicy.js'
import { ToolExecutor } from './toolRuntime/toolExecutor.js'
import { ToolScheduler } from './toolRuntime/toolScheduler.js'
import { ToolRegistry } from './toolRuntime/toolRegistry.js'
import { RuntimeCoordinator } from './runtime/coordinator.js'
import { SharedRuntimeState } from './runtime/sharedState.js'
import { RunEventEmitter } from './runtime/events.js'

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
  private contextManager: ContextManager
  private toolPolicy: ToolPolicy
  private toolRegistry: ToolRegistry
  private toolScheduler: ToolScheduler
  private coordinator: RuntimeCoordinator
  private sharedState: SharedRuntimeState
  private eventEmitter: RunEventEmitter
  private _turnInFlight = false

  constructor(config: EngineConfig, renderer: Renderer, client?: OpenAI) {
    this.config = applyAgentToConfig(config)
    this.renderer = renderer
    this.client = client ?? new OpenAI({
      apiKey: config.apiKey,
      baseURL: config.baseURL,
      maxRetries: 5,
      timeout: 120_000,
    })
    this.tools = config.agentFactory
      ? createTools(config.extraTools ?? [], {
          factory: config.agentFactory,
          parentConfig: config,
          parentRenderer: renderer,
        })
      : createTools(config.extraTools ?? [])
    this.eventLog = config.eventLog
    this.costTracker = new CostTracker()
    this.backgroundTaskManager = new BackgroundTaskManager()
    this.sharedState = new SharedRuntimeState(config.planMode ?? false)
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

    this.modelGateway = new ModelGateway({ client: this.client, renderer: this.renderer })
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
    this.eventEmitter = new RunEventEmitter()
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
      claimSoftAbort: (ctrl) => this.claimSoftAbort(ctrl),
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
    })
  }

  private tools: Tool[]

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

  private claimSoftAbort(turnAbortController: AbortController): boolean {
    if (!this.sharedState.softAbortRequested) return false
    if (this.sharedState.softAbortOwner !== null && this.sharedState.softAbortOwner !== turnAbortController) {
      return false
    }
    this.sharedState.softAbortRequested = false
    this.sharedState.softAbortOwner = null
    return true
  }

  async runTurn(
    userMessage: string,
    history: OpenAIMessage[],
    images?: Array<{ path: string; dataUrl: string }>,
  ): Promise<{ result: TurnResult; newHistory: OpenAIMessage[] }> {
    if (this._turnInFlight) {
      throw new Error(
        'ExecutionEngine.runTurn rejected: another turn is already in progress on this engine instance. ' +
        'Each ExecutionEngine is single-turn; await the in-flight turn or spawn a new engine via EngineConfig.agentFactory.',
      )
    }
    this._turnInFlight = true
    try {
      return await this.coordinator.run(userMessage, history, images)
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
  setModel(model: string): void {
    if (this.config.model === model) return
    this.config.model = model
    this.contextManager.onModelChanged(model)
    this.moduleManager.notifyModelChanged(model)
    this.modelGateway.resetStreamUsageLatch()
  }

  getCostTracker(): CostTracker {
    return this.costTracker
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
}
