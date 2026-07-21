/**
 * Runtime types — the unified state model and event protocol for the
 * agent runtime. These types form the single source of truth that
 * subsystems (ModelGateway, ContextManager, ToolRuntime, ModuleManager)
 * operate on.
 *
 * Design principles:
 * - RunState is the ONLY authority on runtime phase, iteration, abort,
 *   plan mode, and completion status.
 * - RunEvent is the internal protocol for state transitions.
 * - Subsystem interfaces are minimal and stable — they describe WHAT
 *   the coordinator needs, not HOW subsystems implement it.
 * - Existing types (OpenAIMessage, ToolResult, TurnResult) are reused.
 */

import type { OpenAIMessage, ToolResult, TurnResult, ToolDefinition } from '../types.js'

// ── Run Phase ─────────────────────────────────────────────────────────────

export type RunPhase =
  | 'booting'
  | 'running'
  | 'completing'
  | 'completed'

export type TerminationReason = TurnResult['reason']

// ── Abort ────────────────────────────────────────────────────────────────

export interface AbortState {
  requested: boolean
  kind?: 'soft' | 'hard'
  reason?: string
}

// ── Plan Mode ─────────────────────────────────────────────────────────────

export interface PlanModeState {
  active: boolean
  /** When true, ExitPlanMode must be called before tools are unlocked. */
  verificationRequired: boolean
}

// ── Budget ────────────────────────────────────────────────────────────────

export interface BudgetState {
  inputTokens: number
  outputTokens: number
  maxContextTokens: number
  contextUsageRatio: number
}

// ── Active Tool Call ──────────────────────────────────────────────────────

export interface ActiveToolCall {
  callId: string
  toolName: string
  startedAt: number
}

// ── Run State — single source of truth ────────────────────────────────────

export interface RunState {
  runId: string
  phase: RunPhase
  iteration: number

  messages: OpenAIMessage[]

  planMode: PlanModeState
  budget: BudgetState
  abort: AbortState

  activeToolCalls: Map<string, ActiveToolCall>

  completion?: {
    status: 'completed' | 'failed' | 'cancelled' | 'budget_exhausted'
    reason: TerminationReason
    output: string
  }

  // ── Cached boot outputs (set once during boot, read by subsystems) ──
  systemPrompt?: string
  systemPromptTokens?: number
  toolDefinitions?: ToolDefinition[]
}

// ── Run Event — internal state transition protocol ────────────────────────

export type RunEvent =
  | { type: 'RUN_STARTED'; runId: string }
  | { type: 'BOOT_COMPLETED'; systemPrompt: string; systemPromptTokens: number; toolDefinitions: ToolDefinition[] }
  | { type: 'ITERATION_STARTED'; iteration: number }
  | { type: 'MODEL_REQUESTED'; requestId: string }
  | { type: 'MODEL_STREAM_STARTED'; requestId: string }
  | { type: 'MODEL_COMPLETED'; requestId: string; assistantText: string; finishReason: string | null }
  | { type: 'MODEL_FAILED'; requestId: string; error: string }
  | { type: 'TOOL_REQUESTED'; callId: string; toolName: string }
  | { type: 'TOOL_STARTED'; callId: string }
  | { type: 'TOOL_COMPLETED'; callId: string; toolName: string; result: ToolResult }
  | { type: 'TOOL_FAILED'; callId: string; toolName: string; error: string }
  | { type: 'CONTEXT_COMPACTED'; strategy: string; tokensBefore: number; tokensAfter: number }
  | { type: 'PLAN_MODE_ENTERED' }
  | { type: 'PLAN_MODE_EXITED' }
  | { type: 'ABORT_REQUESTED'; kind: 'soft' | 'hard'; reason: string }
  | { type: 'BUDGET_WARNING'; pct: number; tokensUsed: number; maxTokens: number }
  | { type: 'RUN_COMPLETED'; reason: TerminationReason; output: string }
  | { type: 'RUN_FAILED'; error: string; output: string }

// ── Runtime Result ────────────────────────────────────────────────────────

export interface RuntimeResult {
  result: TurnResult
  newHistory: OpenAIMessage[]
}

// ── Stream Result (output of ModelGateway.call) ───────────────────────────

export interface StreamResult {
  assistantText: string
  finishReason: string | null
  rawToolCalls: Array<{
    index: number
    id: string
    name: string
    arguments: string
  }>
  usage: {
    inputTokens: number
    outputTokens: number
  } | null
}

// ── Subsystem Interfaces ──────────────────────────────────────────────────
//
// These are the minimal contracts the RuntimeCoordinator depends on.
// Each subsystem owns its internal implementation details.

/**
 * ModelGateway — owns LLM API calls, streaming, retry, and provider
 * compatibility. Does NOT decide what the agent does next.
 */
export interface IModelGateway {
  call(params: {
    systemPrompt: string
    messages: OpenAIMessage[]
    toolDefs: ToolDefinition[]
    model: string
    temperature?: number
    maxOutputTokens: number
    abortSignal: AbortSignal
  }): Promise<StreamResult>

  /** Whether the endpoint supports stream_options.include_usage */
  readonly streamUsageSupported: boolean

  /** Mark the endpoint as not supporting stream_options (after a 400) */
  markStreamUsageUnsupported(): void
}

/**
 * ContextManager — owns token estimation, budget evaluation, and
 * compaction orchestration. Mutates the messages array in place.
 */
export interface IContextManager {
  /** Set at turn start — caches system prompt token estimate */
  beginTurn(systemPrompt: string): void

  /** Stamp the wall-clock time of the latest assistant message */
  stampAssistantMessage(): void

  /** Evaluate budget and compact if needed (mutates messages in place) */
  evaluateBudget(params: {
    messages: OpenAIMessage[]
    toolDefs?: ToolDefinition[]
    abortSignal?: AbortSignal
  }): Promise<void>

  /** Attempt reactive compaction after a context-overflow API error */
  handleOverflowError(params: {
    error: unknown
    messages: OpenAIMessage[]
    abortSignal: AbortSignal
  }): Promise<boolean>

  /** Queue a manual snip for the next turn */
  queueSnip(keepRecent: number): void

  /** Apply a snip immediately (mid-turn) */
  applySnip(messages: OpenAIMessage[], keepRecent: number, reason?: string): { removed: number; tokensFreed: number }

  /** Consume any queued snip at turn start */
  consumeQueuedSnip(messages: OpenAIMessage[]): void

  /** Truncate a single tool result to fit context */
  truncateToolResult(result: string): string

  /** Enforce aggregate budget across parallel tool results */
  enforceAggregateBudget(results: Array<{ content: string; tc: { id: string; name: string } }>): void

  /** Resolved context window for the current model */
  readonly contextWindow: number

  /** Effective max output tokens (clamped to window) */
  effectiveMaxOutputTokens(maxOutputTokens?: number): number
}

/**
 * ToolRuntime — owns tool registration, policy, scheduling, and execution.
 */
export interface IToolRuntime {
  /** Register base + module tools */
  setTools(tools: import('../types.js').Tool[]): void

  /** Get all registered tools */
  getTools(): import('../types.js').Tool[]

  /** Get filtered tool definitions for the LLM (exposure policy) */
  getDefinitions(params: {
    planMode: boolean
    agentConfig?: import('../agentPresets.js').AgentConfig
  }): ToolDefinition[]

  /** Execute a batch of tool calls (scheduling + execution policy) */
  executeBatch(params: {
    calls: Array<{ tc: { id: string; name: string; arguments: string }; input: Record<string, unknown> }>
    context: import('../types.js').ToolContext
    planMode: boolean
    abortController: AbortController
    messages: OpenAIMessage[]
    turnNumber: number
  }): Promise<{ aborted: boolean }>
}

/**
 * ModuleManager — owns module lifecycle orchestration.
 */
export interface IModuleManager {
  /** Boot all modules, return prompt sections + tools + context patch */
  boot(params: {
    cwd: string
    sessionDir?: string
    userMessage: string
  }): Promise<{
    systemPromptSections: string[]
    tools: import('../types.js').Tool[]
    toolContextPatch: Partial<import('../types.js').ToolContext>
  }>

  /** Run onIteration hooks */
  runIteration(params: {
    iteration: number
    messages: OpenAIMessage[]
    abortSignal: AbortSignal
  }): Promise<Array<{ moduleName: string; message: string }>>

  /** Notify all modules of a tool call */
  notifyToolCall(toolName: string, input: Record<string, unknown>, result: ToolResult, turnNumber: number): void

  /** Run onComplete hooks */
  runComplete(params: {
    cwd: string
    sessionDir?: string
    turnResult: TurnResult
    messages: OpenAIMessage[]
  }): Promise<void>

  /** Dispose all modules */
  dispose(): void

  /** Module names for logging */
  readonly moduleNames: string[]
}

// ── Runtime Dependencies ──────────────────────────────────────────────────

export interface RuntimeDependencies {
  modelGateway: IModelGateway
  contextManager: IContextManager
  toolRuntime: IToolRuntime
  moduleManager: IModuleManager
}
