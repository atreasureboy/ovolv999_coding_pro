/**
 * Think-Act-Observe Engine — with streaming output
 *
 * Key features:
 * 1. Parallel tool execution — read-only tools batched via Promise.all;
 *    state-mutating tools run serially.
 * 2. AbortController per turn — engine.abort() cancels in-flight API calls
 *    and tool executions.
 * 3. Plan mode — only read-only tools are exposed/executed.
 * 4. Hook callbacks around every tool call.
 * 5. Critic loop — every N iterations a lightweight LLM call reviews recent
 *    context for common failure modes and injects corrections.
 * 6. Context budget management — automatic compression with anchor preservation.
 *
 * Architecture:
 *   runTurn() orchestrates the high-level loop, delegating to:
 *     - buildSystemPrompt()        → compose system prompt
 *     - evaluateContextBudget()    → check token usage, compact if needed
 *     - maybeRunCritic()           → inject correction every N iterations
 *     - callLLM()                  → streaming LLM invocation
 *     - consumeStream()            → parse streamed response
 *     - scheduleToolCalls()        → partition + execute tool calls
 *     - executeToolCall()          → single tool execution
 */

import OpenAI from 'openai'
import type {
  EngineConfig,
  OpenAIMessage,
  ContentPart,
  Tool,
  ToolContext,
  ToolResult,
  TurnResult,
  ToolDefinition,
} from './types.js'
import { createTools, findTool, getToolDefinitions } from '../tools/index.js'
import { getPlanModePrefix } from '../prompts/system.js'
import type { Renderer } from '../ui/renderer.js'
import type { AgentModule, ModuleBootResult, ModuleBootContext } from './module.js'
import { globalModuleRegistry } from './moduleRegistry.js'
import { applyAgentToConfig } from './agentPresets.js'
import { filterToolsForSubAgent } from './agentToolFilter.js'
import { clearFileState } from './fileState.js'
import {
  transitionQueryState,
  isTerminal,
  createBudgetTracker,
  checkTokenBudget,
  type QueryState,
} from './queryStateMachine.js'
import { CostTracker, type TokenUsage } from './costTracker.js'
import { BackgroundTaskManager } from './backgroundTaskManager.js'
import { FileHistory } from './fileHistory.js'
import { PermissionManager } from './permissionSystem.js'
import { classifyCommandRisk } from './riskClassifier.js'
import { normalizeCJKInput } from './strings.js'
import { ModelGateway } from './model/modelGateway.js'
import { ContextManager } from './context/contextManager.js'

const LEGACY_PLAN_MODE_TOOLS = new Set(['Read', 'Glob', 'Grep', 'WebFetch', 'WebSearch', 'ExitPlanMode'])
const LEGACY_CONCURRENCY_SAFE_TOOLS = new Set(['Read', 'Glob', 'Grep', 'WebFetch', 'WebSearch', 'Bash', 'Agent', 'ShellSession', 'TmuxSession'])

// ── Internal types ───────────────────────────────────────────────────────────

interface StreamingToolCall {
  index: number
  id: string
  name: string
  arguments: string
}

interface ParsedToolCall {
  tc: StreamingToolCall
  input: Record<string, unknown>
}

interface ToolBatch {
  safe: boolean
  calls: ParsedToolCall[]
}

// ── Pure helper functions ────────────────────────────────────────────────────

/**
 * Partition tool calls into scheduling batches:
 * - All safe tools → merged into one parallel batch (Promise.all)
 * - Stateful tools (Write, Edit, etc.) → each gets its own serial batch
 *
 * Uses per-input isConcurrencySafe(input) when available (Claude Code pattern),
 * falls back to static CONCURRENCY_SAFE_TOOLS set.
 */
function partitionToolCalls(calls: ParsedToolCall[], tools?: Tool[]): ToolBatch[] {
  const batches: ToolBatch[] = []

  for (const call of calls) {
    // Per-input check: if the tool implements isConcurrencySafe, use it
    const tool = tools?.find(t => t.name === call.tc.name)
    const safe = tool?.isConcurrencySafe
      ? tool.isConcurrencySafe(call.input)
      : (tool?.metadata?.concurrencySafe ?? LEGACY_CONCURRENCY_SAFE_TOOLS.has(call.tc.name))
    const last = batches[batches.length - 1]

    if (last && last.safe && safe) {
      last.calls.push(call) // extend existing parallel batch
    } else {
      batches.push({ safe, calls: [call] }) // new batch
    }
  }

  return batches
}

// ── Engine class ─────────────────────────────────────────────────────────────

export class ExecutionEngine {
  private client: OpenAI
  private tools: Tool[]
  private config: EngineConfig
  private renderer: Renderer
  /** Abort controller for the current turn — null when idle */
  private currentTurnAbortController: AbortController | null = null
  /** Soft-interrupt flag: pause after current tool finishes */
  private softAbortRequested = false
  /**
   * Owner of the soft-abort request — the controller that was current at the
   * moment {@link softAbort} was called. Lets the per-turn `finally` block
   * decide whether the flag belongs to it (safe to clear) or to a sibling
   * turn that started after this one (must be preserved). null means the
   * request was queued while no turn was running; the next turn claims it.
   */
  private softAbortOwner: AbortController | null = null
  /** Event log — may be undefined if not configured */
  private eventLog: EngineConfig['eventLog']
  /** Enabled capability modules */
  private modules: AgentModule[]
  /** Cached boot results (populated in runTurn) */
  private moduleBootResults: ModuleBootResult[] = []
  /** All available tools — base + module-provided (populated in runTurn) */
  private allTools: Tool[]
  /** Cost tracker — accumulates real API token usage and USD cost */
  private costTracker: CostTracker
  /** Background task manager — async long-running task lifecycle */
  private backgroundTaskManager: BackgroundTaskManager
  /** Mutable plan-mode flag — can be toggled off by ExitPlanMode tool */
  private planModeActive: boolean
  /** File history — backs up files before edits for undo/checkpoint */
  private fileHistory: FileHistory | null
  /** Unified permission manager — checked before every tool execution */
  private permissionManager: PermissionManager
  /** Model gateway — owns LLM API calls, streaming, retry */
  private modelGateway: ModelGateway
  /** Context manager — owns budget evaluation, compaction, snip */
  private contextManager: ContextManager
  /**
   * Reentrancy guard for `runTurn`. Every ExecutionEngine is single-turn
   * per instance: the legacy design reused a singleton slot
   * (`currentTurnAbortController`) for the in-flight turn, which allowed
   * two `runTurn` calls to overlap and share mutable state — aborted siblings
   * would clobber each other's controllers, systemPromptTokens, the message
   * accumulator, cost-tracker entries, etc. The fix is structural: a
   * concurrent `runTurn` call observes this flag and rejects with a clear
   * error BEFORE any side effects fire. This is the "explicitly reject"
   * branch of priority-1.
   */
  private _turnInFlight = false

  constructor(config: EngineConfig, renderer: Renderer, client?: OpenAI) {
    // Merge agent config into effective config (overrides legacy fields)
    this.config = applyAgentToConfig(config)
    this.renderer = renderer
    this.client = client ?? new OpenAI({
      apiKey: config.apiKey,
      baseURL: config.baseURL,
      maxRetries: 5,      // SDK auto-retries 429/5xx with exponential backoff
      timeout: 120_000,   // 2 min — covers slow reasoning models (deepseek-reasoner)
    })
    // Wire the engine's private AgentTool only when an agentFactory is
    // available. With no factory, the AgentTool is constructed without
    // wiring and returns "not initialized" at action time — callers can
    // still build engines that legitimately do not spawn sub-agents.
    this.tools = config.agentFactory
      ? createTools(config.extraTools ?? [], {
          // Give THIS engine's AgentTool a private binding to its own
          // factory + config + renderer. The factory closure keeps
          // concurrency isolated; see src/tools/agent.ts for the rationale.
          factory: config.agentFactory,
          parentConfig: config,
          parentRenderer: renderer,
        })
      : createTools(config.extraTools ?? [])
    this.allTools = this.tools  // will be updated with module tools in runTurn
    this.eventLog = config.eventLog
    this.costTracker = new CostTracker()
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
    this.backgroundTaskManager = new BackgroundTaskManager()
    this.planModeActive = config.planMode ?? false
    this.fileHistory = config.sessionDir ? new FileHistory(config.sessionDir) : null
    this.permissionManager = config.permissionManager ?? new PermissionManager()
    if (!config.permissionManager) {
      if (config.permissionMode === 'auto') this.permissionManager.setMode('bypassPermissions')
      else if (config.permissionMode === 'deny') this.permissionManager.setMode('plan')
      else this.permissionManager.setMode('default')
    }

    // Resolve enabled modules
    const enabledNames = this.deriveEnabledModules()
    this.modules = enabledNames.length > 0
      ? globalModuleRegistry.resolve(enabledNames, {
          client: this.client,
          model: config.model,
          config,
        })
      : []
  }

  /**
   * Determine which modules to enable.
   * If config.enabledModules is explicitly set, use it.
   * Otherwise auto-derive from available config (backward compat).
   */
  private deriveEnabledModules(): string[] {
    if (this.config.enabledModules !== undefined) {
      return this.config.enabledModules
    }
    // Auto-derive for backward compatibility
    const auto: string[] = []
    if (this.config.semanticMemory && this.config.episodicMemory) {
      auto.push('memory')
    }
    if (this.config.sessionDir && !this.planModeActive) {
      auto.push('critic')
    }
    if (this.config.sessionDir) {
      auto.push('workspace')
    }
    return auto
  }

  /** Hard cancel — immediately aborts in-flight API calls and tool executions */
  abort(): void {
    this.currentTurnAbortController?.abort('user_cancelled')
  }

  /**
   * Tear down engine-owned side effects. Currently delegates to the
   * BackgroundTaskManager so any long-running tasks spawned during the
   * engine's lifetime (e.g. via the Bash tool's `run_in_background:true`)
   * do not outlive the engine. Required by AgentTool so child engines —
   * which have their own BackgroundTaskManager distinct from the parent's —
   * are disposed when the sub-agent completes, aborts, or errors.
   *
   * Also calls dispose() on each module that implements it (e.g. McpModule
   * closes its stdio server processes). Modules that don't expose dispose()
   * are skipped — this method is opt-in per module.
   *
   * Safe to call multiple times (the underlying manager's dispose is
   * idempotent). Safe to call before any turn has run (no-op on an
   * empty task map). Never throws.
   */
  dispose(): void {
    try {
      this.backgroundTaskManager.dispose()
    } catch {
      // disposal must not throw — AgentTool calls this from a finally
      // block and any throw would propagate out of the host's runTurn
    }
    for (const module of this.modules) {
      const dispose = (module as { dispose?: () => void | Promise<void> }).dispose
      if (typeof dispose === 'function') {
        Promise.resolve(dispose.call(module)).catch(() => {
          // module dispose failures must never break engine disposal
        })
      }
    }
  }

  /** Soft interrupt — pause after current tool, preserve history */
  softAbort(): void {
    this.softAbortRequested = true
    // Owner = the controller of whichever turn was current at the time of
    // the request. If no turn is running, owner is null and the next turn
    // claims the request on its first check_abort.
    this.softAbortOwner = this.currentTurnAbortController
  }

  /**
   * Attempt to claim a pending soft-abort request for the supplied turn
   * controller. Returns true iff the flag was set AND its owner is either
   * null (queued while idle) or matches our controller. On success, the
   * flag and owner are cleared so subsequent turns see a clean slate.
   */
  private claimSoftAbort(turnAbortController: AbortController): boolean {
    if (!this.softAbortRequested) return false
    if (this.softAbortOwner !== null && this.softAbortOwner !== turnAbortController) {
      return false
    }
    this.softAbortRequested = false
    this.softAbortOwner = null
    return true
  }

  // ── System prompt ───────────────────────────────────────────────────────

  private buildSystemPrompt(planMode: boolean, moduleSections: string[] = []): string {
    const baseSystemPrompt = this.config.systemPrompt ?? ''
    const sections = moduleSections.length > 0
      ? baseSystemPrompt + '\n\n---\n\n' + moduleSections.join('\n\n---\n\n')
      : baseSystemPrompt
    if (planMode) {
      return getPlanModePrefix() + sections
    }
    return sections
  }

  // ── Tool definitions ────────────────────────────────────────────────────

  private getToolDefinitions(planMode: boolean, moduleTools: Tool[] = []): ToolDefinition[] {
    // Merge base tools + module-provided tools
    const allTools = [...this.tools, ...moduleTools]
    let defs = getToolDefinitions(allTools)
    // Filter by agent tool list when a sub-agent config is in play.
    //
    // Two shapes of filtering here:
    //   1. Sub-agent (config.agent set): delegate to filterToolsForSubAgent
    //      so the global denylist (Agent, EnterPlanMode, …) is enforced in
    //      addition to the per-agent allow/deny lists.
    //   2. Main thread with an explicit `agent.tools` (rare — agent.tools on
    //      the main thread is an unusual override path) — just apply the
    //      allowlist, no global denylist.
    if (this.config.agent) {
      const allNames = defs.map(t => t.function.name)
      const filtered = filterToolsForSubAgent(
        allNames,
        this.config.agent.tools,
        this.config.agent.disallowedTools,
      )
      const allowedSet = new Set(filtered)
      defs = defs.filter(t => allowedSet.has(t.function.name))
    }
    // Filter by plan mode (read-only tools only)
    if (planMode) {
      defs = defs.filter((t) => {
        const tool = allTools.find(candidate => candidate.name === t.function.name)
        return tool?.metadata?.readOnly === true || LEGACY_PLAN_MODE_TOOLS.has(t.function.name)
      })
    }
    return defs
  }

  // ── LLM call ────────────────────────────────────────────────────────────

  private async callLLM(
    systemPrompt: string,
    messages: OpenAIMessage[],
    toolDefs: ReturnType<typeof getToolDefinitions>,
    turnAbortSignal: AbortSignal,
  ): Promise<{
    assistantText: string
    finishReason: string | null
    rawToolCalls: StreamingToolCall[]
    usage: TokenUsage | null
  }> {
    const result = await this.modelGateway.call(
      {
        systemPrompt,
        messages,
        toolDefs,
        model: this.config.model,
        temperature: this.config.temperature,
        maxOutputTokens: this.contextManager.effectiveMaxOutputTokens(this.config.maxOutputTokens),
        abortSignal: turnAbortSignal,
        turnAbortController: this.currentTurnAbortController,
      },
      {
        onUsage: (usage, callStartMs) => this.recordUsage(usage, callStartMs),
        onContextOverflow: async (msgs, signal) => {
          return this.contextManager.reactiveCompact(msgs, signal)
        },
      },
    )
    return result
  }

  /** Feed API usage into the cost tracker (if present) */
  private recordUsage(usage: TokenUsage | null, callStartMs: number): void {
    if (usage) {
      const durationMs = Date.now() - callStartMs
      this.costTracker.addUsage(this.config.model, usage, durationMs)
      this.eventLog?.append('tool_call', 'llm_api', {
        input_tokens: usage.inputTokens,
        output_tokens: usage.outputTokens,
        duration_ms: durationMs,
      })
    }
  }

  // ── Tool execution ──────────────────────────────────────────────────────

  private async executeToolCall(
    toolName: string,
    input: Record<string, unknown>,
    context: ToolContext,
    planMode: boolean,
    turnNumber: number,
  ): Promise<ToolResult> {
    const tool = findTool(this.allTools, toolName)
    if (!tool) {
      return { content: `Unknown tool: ${toolName}`, isError: true }
    }

    // In plan mode, block write tools (defence in depth)
    if (planMode && !(tool.metadata?.readOnly === true || LEGACY_PLAN_MODE_TOOLS.has(toolName))) {
      return {
        content: `Tool "${toolName}" is not available in plan mode. Only read-only tools are allowed. Output your plan as text.`,
        isError: true,
      }
    }

    // Enforce agent tool list (defence in depth — LLM shouldn't see tools
    // it hasn't been granted, AND we re-check the global sub-agent
    // denylist at call time so a model that guesses a tool name can't
    // reach it via a parallel call that slipped past `getToolDefinitions`).
    // The locals below sidestep a TS narrowing quirk where `else if
    // (this.config.agent?.tools)` collapses to `never` after the outer
    // `if (this.config.agent)` narrows the property to non-undefined.
    const agent = this.config.agent
    const agentToolsFallback = agent?.tools
    if (agent) {
      const allNames = this.allTools.map(t => t.name)
      const filtered = filterToolsForSubAgent(
        allNames,
        agent.tools,
        agent.disallowedTools,
      )
      if (!filtered.includes(toolName)) {
        return {
          content: `Tool "${toolName}" is not available to this agent.`,
          isError: true,
        }
      }
    } else if (agentToolsFallback && !agentToolsFallback.includes(toolName)) {
      return {
        content: `Tool "${toolName}" is not available to this agent.`,
        isError: true,
      }
    }

    const isDangerous =
      toolName === 'Bash' && typeof input.command === 'string'
        ? classifyCommandRisk(input.command) === 'dangerous'
        : false
    const permission = this.permissionManager.check(toolName, input, isDangerous)
    if (permission === 'deny') {
      return {
        content: `Permission denied for ${toolName}. Current mode: ${this.permissionManager.formatMode()}`,
        isError: true,
      }
    }
    if (permission === 'ask') {
      if (this.config.requestPermission) {
        const riskLevel = isDangerous ? 'dangerous' : 'needs-approval'
        const permResult = await this.config.requestPermission(toolName, input, riskLevel)
        if (!permResult.approved) {
          const feedback = permResult.feedback?.trim()
          return {
            content: feedback
              ? `Permission denied by user for ${toolName}. Feedback: ${feedback}`
              : `Permission denied by user for ${toolName}.`,
            isError: true,
          }
        }
      } else {
        this.renderer.warn(`Permission check: ${toolName} requires attention; continuing in single-user mode.`)
      }
    }

    const result = await tool.execute(input, context)

    // Notify modules of tool execution (e.g. episodic memory write)
    for (const module of this.modules) {
      module.onToolCall?.(toolName, input, result, turnNumber)
    }

    return result
  }

  // ── Tool scheduling ─────────────────────────────────────────────────────

  /**
   * Schedule tool calls: parallel batches for safe tools, serial for
   * state-mutating ones. Returns true if a soft abort was requested
   * during execution.
   */
  private async scheduleToolCalls(
    parsedCalls: ParsedToolCall[],
    toolContext: ToolContext,
    planMode: boolean,
    turnAbortController: AbortController,
    messages: OpenAIMessage[],
    turnNumber: number,
  ): Promise<{ aborted: boolean }> {
    const turnAbortSignal = turnAbortController.signal
    const batches = partitionToolCalls(parsedCalls, this.allTools)

    for (const batch of batches) {
      if (turnAbortSignal.aborted) return { aborted: true }

      if (batch.safe && batch.calls.length > 1) {
        // ── Parallel batch ───────────────────────────────────
        for (const { tc, input } of batch.calls) {
          this.renderer.toolStart(tc.name, input)
          this.config.hookRunner?.runPreToolCall(tc.name, input)
          this.eventLog?.append('tool_call', tc.name, { input }, [tc.name])
        }

        const results = await Promise.all(
          batch.calls.map(({ tc, input }) =>
            this.executeToolCall(tc.name, input, toolContext, planMode, turnNumber),
          ),
        )

        // Enforce aggregate budget: if the total of all parallel results
        // exceeds the limit, persist the largest to disk before pushing
        const aggregateResults = batch.calls.map((call, i) => ({
          content: results[i].content,
          tc: { id: call.tc.id, name: call.tc.name },
        }))
        this.contextManager.enforceAggregateBudget(aggregateResults)
        // Write back any persisted replacements
        for (let i = 0; i < results.length; i++) {
          results[i] = { ...results[i], content: aggregateResults[i].content }
        }

        for (let i = 0; i < batch.calls.length; i++) {
          const { tc } = batch.calls[i]
          const result = results[i]
          this.config.hookRunner?.runPostToolCall(
            tc.name,
            result.content,
            result.isError,
          )
          this.renderer.toolResult(tc.name, result.content, result.isError)
          this.eventLog?.append(
            'tool_result',
            tc.name,
            {
              content: result.content.slice(0, 500),
              isError: result.isError,
            },
            [tc.name, result.isError ? 'error' : 'success'],
          )
          // Prevent empty tool-result content — some models emit stop sequence
          // and end their turn with zero output when tool_result is empty
          const safeContent = result.content.trim() || `(${tc.name} completed with no output)`
          messages.push({
            role: 'tool',
            tool_call_id: tc.id,
            content: this.contextManager.truncateToolResult(safeContent),
            name: tc.name,
          })
        }
      } else {
        // ── Serial batch ─────────────────────────────────────
        for (const { tc, input } of batch.calls) {
          if (turnAbortSignal.aborted) return { aborted: true }

          this.renderer.toolStart(tc.name, input)
          this.config.hookRunner?.runPreToolCall(tc.name, input)
          this.eventLog?.append('tool_call', tc.name, { input }, [tc.name])

          const result = await this.executeToolCall(
            tc.name,
            input,
            toolContext,
            planMode,
            turnNumber,
          )

          this.config.hookRunner?.runPostToolCall(
            tc.name,
            result.content,
            result.isError,
          )
          this.renderer.toolResult(tc.name, result.content, result.isError)
          this.eventLog?.append(
            'tool_result',
            tc.name,
            {
              content: result.content.slice(0, 500),
              isError: result.isError,
            },
            [tc.name, result.isError ? 'error' : 'success'],
          )

          const serialSafeContent = result.content.trim() || `(${tc.name} completed with no output)`
          messages.push({
            role: 'tool',
            tool_call_id: tc.id,
            content: this.contextManager.truncateToolResult(serialSafeContent),
            name: tc.name,
          })

          // Soft-interrupt check after each serial tool — ownership-aware:
          // a sibling turn's soft-abort request must NOT be consumed here.
          if (this.claimSoftAbort(turnAbortController)) {
            return { aborted: true }
          }
        }
      }

      // Soft-interrupt check after each batch (parallel too) — same
      // ownership check as the serial path.
      if (this.claimSoftAbort(turnAbortController)) {
        return { aborted: true }
      }
    }

    return { aborted: false }
  }

  // ── Build tool context ──────────────────────────────────────────────────

  private buildToolContext(
    turnAbortSignal: AbortSignal,
    modulePatches: Partial<ToolContext> = {},
  ): ToolContext {
    return {
      cwd: this.config.cwd,
      permissionMode: this.config.permissionMode,
      permissionManager: this.permissionManager,
      signal: turnAbortSignal,
      apiConfig: {
        apiKey: this.config.apiKey,
        baseURL: this.config.baseURL,
        model: this.config.model,
      },
      eventLog: this.eventLog,
      backgroundTaskManager: this.backgroundTaskManager,
      askUserQuestion: this.config.askUserQuestion,
      exitPlanMode: async (plan: string): Promise<boolean> => {
        const approved = await this.config.exitPlanMode?.(plan) ?? true
        if (approved) this.exitPlanMode()
        return approved
      },
      enterPlanMode: () => { this.enterPlanMode() },
      fileHistory: this.fileHistory ?? undefined,
      // Module patches override/extend the base context (incl. availableToolNames)
      ...modulePatches,
    }
  }

  // ── Main loop ───────────────────────────────────────────────────────────

  /**
   * Execute a single user turn with streaming output.
   *
   * State-machine-driven Think → Act → Observe loop with module lifecycle hooks.
   * The loop drives a pure reducer (transitionQueryState) — each iteration
   * inspects the current state, performs its side effects, and emits the next
   * event. This replaces the legacy inline while-loop with explicit, testable
   * states: boot → check_abort → budget_check → module_iteration → llm_call →
   * continuation_check → parse_response → tool_execution → check_abort …
   */
  async runTurn(
    userMessage: string,
    history: OpenAIMessage[],
    images?: Array<{ path: string; dataUrl: string }>,
  ): Promise<{ result: TurnResult; newHistory: OpenAIMessage[] }> {
    // ── Reentrancy guard ──────────────────────────────────────────────────
    // The engine is single-turn per instance: every mutable field
    // (currentTurnAbortController, systemPromptTokens, moduleBootResults,
    // costTracker, the messages accumulator, _consecutiveCompactFailures,
    // etc.) is shared. Two overlapping runTurn calls would silently
    // overwrite each other's state — a sibling's `finally` could null
    // the controller of the turn currently in flight. Reject the second
    // call up front so callers can't accidentally race.
    //
    // Resolution paths:
    //   1. Concurrent call → reject with a clear error before any work
    //   2. For nested sub-agents, build a NEW ExecutionEngine per spawn
    //      (AgentTool's factory pattern — already the supported path)
    //   3. For "queue the next prompt", await the current turn and call
    //      runTurn again — the flag clears in the `finally`.
    if (this._turnInFlight) {
      throw new Error(
        'ExecutionEngine.runTurn rejected: another turn is already in progress on this engine instance. ' +
        'Each ExecutionEngine is single-turn; await the in-flight turn or spawn a new engine via EngineConfig.agentFactory.',
      )
    }
    this._turnInFlight = true

    // Every line of code below runs inside an OUTER try/finally whose
    // sole job is releasing `_turnInFlight`. Critical: any throw between
    // here and the existing inner try would previously have leaked the
    // flag and permanently locked the engine. Setup steps that can
    // throw include:
    //   - clearFileState() (filesystem)
    //   - module boot (each module's `boot()` is a third-party hook)
    //   - buildSystemPrompt() (pure but allocates heavily)
    //   - buildToolContext() (renders initial tool context)
    // The outer finally is the single, unconditional release point —
    // success, soft-abort, hard-abort, and ANY thrown error all flow
    // through it, so the engine can never get stuck.
    let result: TurnResult
    try {
      const planMode = this.planModeActive

      // Clear file read state for this turn (read-before-edit is per-turn, not cross-turn)
      clearFileState()

      // ── Boot Sequence: resolve + boot modules ──
      const bootCtx: ModuleBootContext = {
        cwd: this.config.cwd,
        sessionDir: this.config.sessionDir,
        config: this.config,
        userMessage,
      }
      this.moduleBootResults = await Promise.all(
        this.modules.map(m => Promise.resolve(m.boot(bootCtx))),
      )
      const moduleSections = this.moduleBootResults.flatMap(r => r.systemPromptSections ?? [])
      const toolContextPatch = this.moduleBootResults.reduce(
        (acc, r) => ({ ...acc, ...r.toolContextPatch }),
        {} as Partial<ToolContext>,
      )
      // Collect tools provided by modules
      const moduleTools = this.moduleBootResults.flatMap(r => r.tools ?? [])
      this.allTools = [...this.tools, ...moduleTools]

      // Record boot trajectory (AgentOS pattern)
      this.eventLog?.append('boot_context', 'engine', {
        trajectory: 'boot_context',
        modules: this.modules.map(m => m.name),
        module_sections: moduleSections.length,
        module_tools: moduleTools.length,
        user_message_length: userMessage.length,
      })

      // Build system prompt (with module sections) and tool definitions
      const systemPrompt = this.buildSystemPrompt(planMode, moduleSections)
      // Estimate system prompt tokens for accurate context budget
      this.contextManager.beginTurn(systemPrompt)
      const toolDefs = this.getToolDefinitions(planMode, moduleTools)

      // Per-turn AbortController
      const turnAbortController = new AbortController()
      this.currentTurnAbortController = turnAbortController

      // Initialize messages — construct multimodal content if images are provided
      let userContent: string | ContentPart[]
      if (images && images.length > 0) {
        userContent = [
          { type: 'text', text: normalizeCJKInput(userMessage) },
          ...images.map((img) => ({ type: 'image_url' as const, image_url: { url: img.dataUrl } })),
        ]
      } else {
        userContent = normalizeCJKInput(userMessage)
      }
      const messages: OpenAIMessage[] = [...history, { role: 'user', content: userContent }]

      // Apply a queued `/snip [N]` first, if any. Consumed at turn start
      // so the very first LLM call sees the truncated history.
      this.contextManager.consumeQueuedSnip(messages)

      const toolContext = this.buildToolContext(
        turnAbortController.signal,
        {
          ...toolContextPatch,
          availableToolNames: toolDefs.map(t => t.function.name),
          // `snipMessages` mutates the live `messages` array held by
          // this `runTurn`. Provided here (not via module patch) because
          // it needs closure over the *local* `messages` reference.
          snipMessages: (keepRecent: number, reason?: string) =>
            this.contextManager.applySnip(messages, keepRecent, reason),
          // Snapshot accessor for introspection tools (Brief, CtxInspect).
          // Returns a shallow copy so tools can't mutate the live array.
          getMessages: () => messages.map(m => ({ ...m })),
        },
      )

      // ── State machine driver ───────────────────────────────────────────
      let state: QueryState = transitionQueryState({ kind: 'boot' }, { type: 'booted' })

      let finalOutput = ''
      let lastToolName: string | undefined
      // Tool calls pending parse — stashed in llm_call, consumed in parse_response
      let pendingToolCalls: StreamingToolCall[] = []
      // Parsed tool calls — stashed in parse_response, consumed in tool_execution
      let pendingParsedCalls: ParsedToolCall[] = []
      // Continuation budget tracking (opt-in via config.enableContinuation)
      const enableContinuation = this.config.enableContinuation ?? false
      const turnTokenBudget =
        this.config.turnTokenBudget ?? this.contextManager.effectiveMaxOutputTokens(this.config.maxOutputTokens) * 4
      const budgetTracker = createBudgetTracker()
      let turnTokensProduced = 0
      let emptyResponseCount = 0
      const MAX_EMPTY_RETRIES = 2
      let lengthRetryCount = 0
      const MAX_LENGTH_RETRIES = 3

    try {
      while (!isTerminal(state)) {
        switch (state.kind) {
          case 'check_abort': {
            if (turnAbortController.signal.aborted) {
              state = transitionQueryState(state, { type: 'hard_abort', output: finalOutput })
            } else if (this.claimSoftAbort(turnAbortController)) {
              state = transitionQueryState(state, { type: 'soft_abort', output: finalOutput })
            } else if (state.iteration > this.config.maxIterations) {
              this.renderer.warn(
                `Max iterations (${this.config.maxIterations}) reached`,
              )
              state = transitionQueryState(state, { type: 'max_iterations', output: finalOutput })
            } else {
              state = transitionQueryState(state, { type: 'continue' })
            }
            break
          }

          case 'budget_check': {
            await this.contextManager.evaluateBudget({ messages, toolDefs, abortSignal: turnAbortController.signal })
            state = transitionQueryState(state, { type: 'continue' })
            break
          }

          case 'module_iteration': {
            for (const module of this.modules) {
              if (!module.onIteration) continue
              const iterResult = await module.onIteration({
                iteration: state.iteration,
                messages,
                abortSignal: turnAbortController.signal,
              })
              if (iterResult?.injectMessage) {
                const msg = iterResult.injectMessage
                // Show full critic output to user via renderer (not raw stdout)
                const lines = msg.split('\n').filter(l => l.trim())
                for (const line of lines) {
                  this.renderer.warn(`[${module.name}] ${line}`)
                }
                this.eventLog?.append('module_flag', module.name, {
                  message: msg.slice(0, 500),
                  iteration: state.iteration,
                })
                messages.push({ role: 'user', content: msg })
              }
            }
            state = transitionQueryState(state, { type: 'continue' })
            break
          }

          case 'llm_call': {
            const { assistantText, finishReason, rawToolCalls } =
              await this.callLLM(
                systemPrompt,
                messages,
                toolDefs,
                turnAbortController.signal,
              )

            if (assistantText) {
              finalOutput = assistantText
              turnTokensProduced += Math.ceil(assistantText.length / 3.5)
            }

            // Build assistant message
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

            // Stamp the wall-clock time of THIS assistant message so the
            // next evaluateContextBudget pass can decide whether the prompt
            // cache has gone cold. Recorded AFTER the message is pushed
            // because the time-based compact gate uses this as its baseline.
            this.contextManager.stampAssistantMessage()

            // Detect empty response (no text AND no tool calls) — nudge the model
            if (!assistantText && rawToolCalls.length === 0 && emptyResponseCount < MAX_EMPTY_RETRIES) {
              emptyResponseCount++
              messages.push({
                role: 'user',
                content: 'Your previous response was empty (no text, no tool call). Please respond with text or invoke a tool.',
              })
              // Re-enter budget_check to loop back to llm_call
              state = transitionQueryState(state, { type: 'continue' })
              break
            }

            // Detect truncated response (finish_reason='length') — the model
            // hit max_tokens mid-response. Inject "continue" and retry up to 3x.
            if (finishReason === 'length' && rawToolCalls.length === 0 && lengthRetryCount < MAX_LENGTH_RETRIES) {
              lengthRetryCount++
              this.eventLog?.append('module_flag', 'length_retry', {
                retry: lengthRetryCount,
                max: MAX_LENGTH_RETRIES,
                partial_length: assistantText.length,
              })
              messages.push({
                role: 'user',
                content: 'Continue your previous response from where it was cut off. Do not repeat what you already wrote — just continue.',
              })
              state = transitionQueryState(state, { type: 'continue' })
              break
            }

            pendingToolCalls = rawToolCalls
            state = transitionQueryState(state, {
              type: 'llm_done',
              finishReason,
              hasToolCalls: rawToolCalls.length > 0,
              output: finalOutput,
            })
            break
          }

          case 'continuation_check': {
            // When continuation is enabled and budget remains, nudge the model
            // to keep producing instead of stopping on finish_reason=stop.
            if (enableContinuation) {
              const decision = checkTokenBudget(budgetTracker, turnTokenBudget, turnTokensProduced)
              if (decision.action === 'continue') {
                this.eventLog?.append('module_flag', 'continuation', {
                  continuation_count: decision.continuationCount,
                  pct: decision.pct,
                  turn_tokens: decision.turnTokens,
                  budget: decision.budget,
                })
                messages.push({ role: 'user', content: decision.nudgeMessage })
                state = transitionQueryState(state, { type: 'continue' })
                break
              }
            }
            // Default: stop and complete
            state = transitionQueryState(state, { type: 'stop' })
            break
          }

          case 'parse_response': {
            const validCalls: ParsedToolCall[] = []
            for (const tc of pendingToolCalls) {
              let input: Record<string, unknown>
              try {
                const parsed: unknown = JSON.parse(tc.arguments || '{}')
                // Tools require a JSON object — primitives (string/number/
                // boolean), null, and arrays are NOT valid input shapes.
                // The legacy code cast any JSON.parse result to
                // `Record<string, unknown>` regardless of shape, which
                // meant a model that emitted `null`, `[...]`, `"foo"`, or
                // `42` as arguments would reach the tool with a
                // misshaped object — tools then either crashed trying
                // to read `.foo` on null/undefined or silently produced
                // nonsense. Reject these shapes here with a clear tool-
                // result error so the LLM can retry with a real object.
                if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
                  const shape = parsed === null
                    ? 'null'
                    : Array.isArray(parsed)
                      ? 'array'
                      : typeof parsed
                  this.renderer.warn(
                    `Warning: malformed tool arguments for ${tc.name} (expected JSON object, got ${shape}).`,
                  )
                  this.eventLog?.append('tool_call', tc.name, {
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
                // Malformed JSON — do NOT execute the tool. Push a synthetic
                // error result so the LLM knows its arguments were bad.
                this.renderer.warn(`Warning: malformed tool arguments for ${tc.name} (JSON parse failed, likely truncated).`)
                this.eventLog?.append('tool_call', tc.name, { parse_error: true, raw_args: tc.arguments.slice(0, 200) })
                messages.push({
                  role: 'tool',
                  tool_call_id: tc.id,
                  name: tc.name,
                  content: `Could not parse tool arguments as valid JSON (likely truncated by max_tokens). Raw args (first 200 chars): ${tc.arguments.slice(0, 200)}. Retry with shorter or simpler arguments.`,
                })
                continue  // skip this call — don't add to validCalls
              }
              validCalls.push({ tc, input })
            }

            pendingParsedCalls = validCalls

            // Track last tool name for OnError hook
            if (pendingParsedCalls.length > 0) {
              lastToolName = pendingParsedCalls[pendingParsedCalls.length - 1].tc.name
            }

            state = transitionQueryState(state, { type: 'continue' })
            break
          }

          case 'tool_execution': {
            const { aborted } = await this.scheduleToolCalls(
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
              output: finalOutput,
            })
            break
          }

          case 'boot':
            // Unreachable — boot transitions to check_abort before the loop
            state = transitionQueryState(state, { type: 'booted' })
            break
        }
      }

      // State machine reached a terminal state
      if (state.kind === 'complete') {
        result = { stopped: true, reason: state.reason, output: state.output }
      } else {
        // Defensive fallback — should never happen
        result = { stopped: true, reason: 'error', output: finalOutput }
      }
    } catch (err) {
      // Lifecycle hook: OnError
      const errMsg = (err as Error).message || String(err)
      const errorIteration = 'iteration' in state ? state.iteration : 0
      this.config.hookRunner?.runOnError?.(err as Error, {
        turnNumber: errorIteration,
        lastToolName,
      })
      // Surface the error to the user — don't swallow it silently
      this.renderer.error(`Engine error: ${errMsg}`)
      // Don't re-throw — construct error result so onComplete hooks still fire
      result = { stopped: true, reason: 'error', output: finalOutput || `[Error: ${errMsg}]` }
    } finally {
      // Inner finally: cleans up ONLY what setup reached. If the outer
      // try's setup threw before `turnAbortController` was constructed,
      // this finally never runs — the outer finally handles that case
      // with its own scope-bounded cleanup (it touches no setup-local
      // symbols).
      //
      // Ownership-aware cleanup: only release the singleton slot if it still
      // points at OUR controller. Without this check, an in-flight older
      // turn whose `finally` runs after a newer turn has installed its own
      // controller would null out the new turn's slot, making subsequent
      // `engine.abort()` calls silently no-op.
      if (this.currentTurnAbortController === turnAbortController) {
        this.currentTurnAbortController = null
      }
      // Ownership-aware soft-flag cleanup: if the flag is still set and its
      // owner is OUR controller (we never claimed it via check_abort),
      // clear it. If the owner is a different controller — meaning a newer
      // turn called softAbort() while we were running — preserve it so the
      // newer turn's check_abort can still see the request.
      if (this.softAbortRequested && this.softAbortOwner === turnAbortController) {
        this.softAbortRequested = false
        this.softAbortOwner = null
      }
    }

    // ── Module onComplete hooks (reflection, etc.) ──
    for (const module of this.modules) {
      try {
        await module.onComplete?.({
          cwd: this.config.cwd,
          sessionDir: this.config.sessionDir,
          turnResult: result,
          messages,
          eventLog: this.eventLog,
        })
      } catch {
        // module onComplete failures must never break the engine
      }
    }

    // ── Lifecycle hook: OnComplete ──
    this.config.hookRunner?.runOnComplete?.(result)

    return { result, newHistory: messages }
    } finally {
      // OUTER finally: the SINGLE point that releases _turnInFlight.
      // Runs unconditionally — success, soft-abort, hard-abort, state-
      // machine catch-and-suppress, AND any throw from setup (module
      // boot, file state clear, buildSystemPrompt, buildToolContext)
      // ALL flow through here. Without this outer finally the flag
      // would leak on every setup throw, permanently locking the
      // engine against future turns.
      this._turnInFlight = false
    }
  }

  getModel(): string {
    return this.config.model
  }

  setModel(model: string): void {
    this.config.model = model
  }

  /** Expose the cost tracker for end-of-session cost display */
  getCostTracker(): CostTracker {
    return this.costTracker
  }

  /** Expose the background task manager for cleanup / inspection */
  getBackgroundTaskManager(): BackgroundTaskManager {
    return this.backgroundTaskManager
  }

  /** Expose unified permissions for slash commands and diagnostics */
  getPermissionManager(): PermissionManager {
    return this.permissionManager
  }

  /** Whether plan mode is currently active */
  isPlanMode(): boolean {
    return this.planModeActive
  }

  /**
   * Expose the live EngineConfig reference so slash commands (e.g. /poor)
   * can mutate fields and have modules see the change immediately. The
   * returned object is the SAME reference modules hold via ModuleContext.config,
   * so mutations propagate live.
   */
  getConfig(): EngineConfig {
    return this.config
  }

  /** Exit plan mode — called by the ExitPlanMode tool after user approval */
  exitPlanMode(): void {
    this.planModeActive = false
  }

  /** Enter plan mode — called by the EnterPlanMode tool */
  enterPlanMode(): void {
    this.planModeActive = true
  }

  /**
   * Queue a manual "snip" for the start of the next `runTurn`.
   * Called by the `/snip [N]` slash command. Drops all but the most
   * recent `keepRecent` messages and inserts a `[snip]` boundary marker
   * before the first LLM call of the next turn.
   *
   * The snip is applied at runTurn entry — not synchronously here —
   * because the messages array lives inside `runTurn` and we don't have
   * a stable reference outside it.
   */
  queueSnip(keepRecent: number): void {
    this.contextManager.queueSnip(keepRecent)
  }

  /** Get the file history tracker (null if no sessionDir) */
  getFileHistory(): FileHistory | null {
    return this.fileHistory
  }
}

// Export partitionToolCalls for testing
export { partitionToolCalls }
