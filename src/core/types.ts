// Core types for ovolv999 execution engine

import type { EventLog } from './eventLog.js'
import type { SemanticMemory } from './semanticMemory.js'
import type { EpisodicMemory } from './episodicMemory.js'
import type { AgentConfig } from './agentPresets.js'
import type { BackgroundTaskManager } from './backgroundTaskManager.js'
import type { ResourceClaim } from './executionRun.js'
import type { ExecutionContext } from './executionContext.js'
import type { FileHistory } from './fileHistory.js'
import type { PermissionManager } from './permissionSystem.js'
import type { McpServerConfig } from './mcpClient.js'

// OpenAI-compatible tool call format
export interface ToolCall {
  id: string
  type: 'function'
  function: {
    name: string
    arguments: string
  }
}

/**
 * Minimal surface a child engine needs to expose to AgentTool. Defined in
 * types.ts so `EngineConfig.agentFactory` can reference it without importing
 * the tools package (which would re-import types.ts → circular).
 *
 * `dispose` is OPTIONAL — a child that owns long-running background work
 * (BackgroundTaskManager) implements it so AgentTool can tear the work down
 * when the sub-agent finishes / aborts / errors. Absent in plain stubs and
 * in tests that don't model background work.
 */
export interface ChildEngineLike {
  runTurn: (msg: string, history: never[]) => Promise<{ result: { output: string; reason: string } }>
  abort: () => void
  /**
   * Tear down engine-owned side effects (background tasks, transient
   * caches). Idempotent — safe to call multiple times. Must NOT throw.
   * AgentTool invokes this exactly once per child after the child's
   * runTurn resolves/rejects, regardless of outcome.
   */
  dispose?: () => void
}

/**
 * Factory used by AgentTool to spawn a child engine for a sub-task.
 * Per-EngineConfig, so each engine owns its own factory closure — no
 * module-level mutable state, safe under concurrency and across multiple
 * ExecutionEngine instances running side-by-side.
 */
export type AgentChildEngineFactory = (
  config: EngineConfig,
  renderer: unknown,
) => ChildEngineLike

/** Content part for multimodal messages (vision/image support). */
export interface ContentPart {
  type: 'text' | 'image_url'
  text?: string
  image_url?: { url: string }
}

export interface OpenAIMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string | null | ContentPart[]
  tool_calls?: ToolCall[]
  tool_call_id?: string
  name?: string
}

export interface ToolDefinition {
  type: 'function'
  function: {
    name: string
    description: string
    parameters: {
      type: 'object'
      properties: Record<string, unknown>
      required?: string[]
    }
  }
}

export interface ToolResult {
  content: string
  isError: boolean
}

export interface ToolMetadata {
  /** Safe to expose in plan/read-only mode. */
  readOnly?: boolean
  /** Default concurrency behavior when isConcurrencySafe is not implemented. */
  concurrencySafe?: boolean
  /** Tool may mutate workspace files or local state. */
  mutatesState?: boolean
  /** Tool can run for a long time or create async work. */
  longRunning?: boolean
  /** Tool may access network resources. */
  requiresNetwork?: boolean
  /**
   * GAP-D: Per-input resource claims (fi_goal §五). When provided,
   * the engine can route the tool's execution through the
   * ResourceScheduler so two tools that touch the same file or git
   * ref serialize rather than race. The builder takes the same
   * `input` object passed to `execute()` and returns the claims
   * that should be held for the duration of the call.
   *
   * Returning an empty array (or omitting the function) means the
   * tool makes no claim and is unscheduled. Tools that already
   * declare `concurrencySafe: true` typically also omit this since
   * their reads are idempotent and don't need serialization.
   */
  claims?: (input: Record<string, unknown>) => ResourceClaim[]
}

export interface Tool {
  name: string
  metadata?: ToolMetadata
  definition: ToolDefinition
  execute(input: Record<string, unknown>, context: ToolContext): Promise<ToolResult>
  /**
   * Per-input concurrency check (Claude Code pattern).
   * If implemented, engine uses this instead of the static CONCURRENCY_SAFE_TOOLS set.
   * Returns true if this specific call can run in parallel with other safe calls.
   * Default (not implemented) → falls back to static set.
   */
  isConcurrencySafe?(input: Record<string, unknown>): boolean
}

export interface ToolContext {
  cwd: string
  permissionMode: 'auto' | 'ask' | 'deny'
  /** Unified permission manager used by the engine before tool execution. */
  permissionManager?: PermissionManager
  /** AbortSignal — tools should honour this to support Ctrl+C cancellation */
  signal?: AbortSignal
  /**
   * five_goal P0-2: per-turn execution context. Carries the current
   * RunId, parent RunId, workspace id, and resolved model info. Tools
   * that spawn child runs (AgentTool, ClaudeCodeTool) MUST read
   * `context.execution.runId` as the parentRunId rather than caching
   * a value at construction time.
   */
  execution?: ExecutionContext
  /** Progress update function for long-running tools */
  updateProgress?: (progress: number, recoveryData?: Record<string, unknown>) => void
  /**
   * API config forwarded from engine — allows tools that need LLM calls
   * (e.g. image analysis via vision API) to reuse the same endpoint + key.
   */
  apiConfig?: { apiKey: string; baseURL?: string; model: string }
  /** Session output directory — for tools that need to write artifacts
   * (e.g. generated files, logs, reports). */
  sessionDir?: string
  /** Event log for audit trail — best-effort, never throws */
  eventLog?: EventLog
  /** Semantic memory — cross-turn knowledge persistence */
  semanticMemory?: SemanticMemory
  /** Episodic memory — action trajectory persistence */
  episodicMemory?: EpisodicMemory
  /** Tool names available to this agent — used for skill permission checks */
  availableToolNames?: string[]
  /** Background task manager — for async long-running task lifecycle */
  backgroundTaskManager?: BackgroundTaskManager
  /**
   * Ask-user-question callback — lets the AskUserQuestion tool pause the
   * LLM loop and prompt the user for input. Provided by the REPL; absent
   * in sub-agents / piped mode (tool degrades gracefully).
   */
  askUserQuestion?: (questions: AskUserQuestionInput[], signal?: AbortSignal) => Promise<Record<string, string>>
  /**
   * Exit-plan-mode callback — lets the ExitPlanMode tool present a plan
   * for user approval and switch off plan mode. Returns true if approved.
   * Provided by the REPL; absent in sub-agents / piped mode.
   */
  exitPlanMode?: (plan: string) => Promise<boolean>
  /**
   * Enter-plan-mode callback — lets the EnterPlanMode tool switch the
   * engine into plan mode (read-only analysis). Absent in sub-agents /
   * piped mode.
   */
  enterPlanMode?: () => void
  /** File history — backs up files before edits for undo/checkpoint */
  fileHistory?: FileHistory
  /**
   * Snip old messages from the conversation. Returns how many were removed
   * and approximate tokens freed. Provided by `runTurn` so the Snip tool
   * can prune context without an LLM call (zero-cost context reduction).
   * Absent in sub-agents / tests that don't model the live messages array.
   */
  snipMessages?: (keepRecent: number, reason?: string) => { removed: number; tokensFreed: number }
  /**
   * Snapshot accessor for the current conversation messages. Used by
   * introspection tools (Brief, CtxInspect) that need to report on
   * context size / composition without mutating it. Returns a copy so
   * tools can't accidentally alter the live array.
   */
  getMessages?: () => OpenAIMessage[]
}

// ── AskUserQuestion types (shared between tool, context, and REPL) ──────────

export interface AskUserOption {
  label: string
  description: string
}

export interface AskUserQuestionInput {
  question: string
  header: string
  options: AskUserOption[]
  multiSelect?: boolean
}

export type AskUserQuestionHandler = (
  questions: AskUserQuestionInput[],
  signal?: AbortSignal,
) => Promise<Record<string, string>>

/**
 * Structured outcome of a single hook command execution.
 * Returned (rather than thrown) so the engine never blocks on hook failures.
 */
export interface HookResult {
  /** Which hook entry fired (PreToolCall, PostToolCall, ...). */
  hook: string
  /** The shell command that ran. */
  command: string
  /** True iff the command exited with status 0. */
  ok: boolean
  /** Exit status from the child process, or null when unavailable. */
  status: number | null
  /** Termination signal (e.g. SIGTERM from timeout), or null. */
  signal: NodeJS.Signals | null
  /** Wall-clock duration in milliseconds. */
  durationMs: number
  /** Failure reason — already scrubbed of sensitive env values. */
  error?: string
  /** Suggested error code — 'not_found', 'timeout', 'non_zero', 'spawn_failed', or 'unknown'. */
  errorCode?: HookErrorCode
}

export type HookErrorCode =
  | 'not_found'       // ENOENT — the binary doesn't exist
  | 'timeout'         // child exceeded timeoutMs
  | 'non_zero'        // exited with status != 0
  | 'spawn_failed'    // other spawn errors
  | 'unknown'

/**
 * Interface for hook runners — decouples engine from config layer.
 * Hooks are best-effort: implementations must never throw. Each method
 * returns the structured outcome of every hook entry that fired so callers
 * (and tests) can inspect success or failure without aborting the agent loop.
 */
export interface IHookRunner {
  runPreToolCall(toolName: string, input: Record<string, unknown>): HookResult[]
  runPostToolCall(toolName: string, result: string, isError: boolean): HookResult[]
  runUserPromptSubmit(prompt: string): HookResult[]
  /** Called when the engine encounters an unrecoverable error */
  runOnError?(error: Error, context: { turnNumber: number; lastToolName?: string }): HookResult[]
  /** Called when a run completes (any reason: stop, max_iterations, error, interrupted) */
  runOnComplete?(result: TurnResult): HookResult[]
  /** Called after context compaction (auto-summary of older messages) */
  runOnContextOverflow?(tokensBefore: number, tokensAfter: number): HookResult[]
}

export interface EngineConfig {
  model: string
  baseURL?: string
  apiKey: string
  /**
   * Phase 1 (six_goal §四): provider id driving ProviderAdapter
   * selection (e.g. 'openai', 'minimax', 'anthropic'). Omit for the
   * default openai-compatible adapter. All currently-supported
   * providers speak the OpenAI Chat Completions shape; this field is
   * the extension point for native adapters.
   */
  provider?: string
  maxIterations: number
  cwd: string
  permissionMode: 'auto' | 'ask' | 'deny'
  /** Unified permission manager; if omitted the engine creates one from permissionMode. */
  permissionManager?: PermissionManager
  systemPrompt?: string
  /** Extra tools to inject (e.g. MCP tools) */
  extraTools?: Tool[]
  /**
   * Plan mode: restrict tools to read-only (Read, Glob, Grep, WebFetch, WebSearch).
   * The agent analyzes and plans but cannot write, edit, or execute.
   */
  planMode?: boolean
  /** Poor/Budget mode — skip non-essential LLM calls (critic, reflection) */
  poor?: { enabled: boolean }
  /** MCP servers — tools are dynamically injected at boot. See McpModule. */
  mcp?: { servers: McpServerConfig[] }
  /** Hook runner for PreToolCall / PostToolCall / UserPromptSubmit events */
  hookRunner?: IHookRunner
  /** Session output directory — injected into sub-agent prompts */
  sessionDir?: string
  /**
   * Optional ExecutionRun event log path. When set, the engine:
   *   - constructs a JsonlEventStore at this path
   *   - on startup, replays the log via recoverRegistryFromStore
   *     so in-flight runs from a previous (crashed) process are
   *     visible in the new registry
   *   - wires an ExecutionRunEventBus that persists every transition
   *     for future recovery (fi_goal.md §四 Phase 3)
   * When unset, ExecutionRun registry stays in-memory only.
   */
  executionRunLogDir?: string
  /** Maximum context window in tokens for the selected model.
   * Defaults to 200_000 (claude-sonnet-4-x).  Used to compute percentage-based
   * compact/warn thresholds instead of a flat token count.
   */
  maxContextTokens?: number
  /** LLM sampling temperature (default: 0) */
  temperature?: number
  /** Max output tokens per LLM response (default: 8192) */
  maxOutputTokens?: number
  /**
   * Continuation nudging — when the LLM stops (finish_reason=stop) but output
   * token budget remains, inject a "continue" nudge instead of completing.
   * Default: false (preserve original stop-on-finish behavior).
   * Inspired by Claude Code's tokenBudget continuation logic.
   */
  enableContinuation?: boolean
  /**
   * Output token budget for a single turn — drives continuation decisions when
   * enableContinuation is true. Defaults to maxOutputTokens * 4 if unset.
   */
  turnTokenBudget?: number
  /** Event log for audit trail */
  eventLog?: EventLog
  /** Semantic memory — cross-turn knowledge persistence */
  semanticMemory?: SemanticMemory
  /** Episodic memory — action trajectory persistence */
  episodicMemory?: EpisodicMemory
  /**
   * Enabled module names — determines which capability modules are active.
   * If omitted, the engine auto-enables modules based on available config
   * (memory if semanticMemory set, critic if sessionDir set, workspace if
   * sessionDir set). Set to [] for a lightweight agent with no modules.
   */
  enabledModules?: string[]
  /** Agent configuration — composable identity + modules + tools.
   * When set, overrides systemPrompt / planMode / enabledModules / etc.
   * Replaces the legacy AgentType enum with config-driven differentiation.
   */
  agent?: AgentConfig
  /**
   * Ask-user-question callback — provided by the REPL so the
   * AskUserQuestion tool can prompt the user. Absent in sub-agents /
   * piped mode (tool degrades gracefully).
   */
  askUserQuestion?: AskUserQuestionHandler
  /**
   * Exit-plan-mode callback — provided by the REPL so the ExitPlanMode
   * tool can present a plan for user approval. Returns true if approved.
   * Absent in sub-agents / piped mode (tool auto-approves).
   */
  exitPlanMode?: (plan: string) => Promise<boolean>
  /**
   * Enter-plan-mode callback — provided by the REPL so the EnterPlanMode
   * tool can switch the engine into plan mode. Absent in sub-agents /
   * piped mode (tool degrades gracefully).
   */
  enterPlanMode?: () => void
  /**
   * Permission-request callback — when the PermissionManager returns 'ask'
   * for a tool, the engine calls this (if present) to prompt the user for
   * approval. Returns true to allow, false to deny. Absent in bypass/auto
   * mode (tools run without prompts).
   */
  requestPermission?: (
    toolName: string,
    input: Record<string, unknown>,
    riskLevel: 'safe' | 'needs-approval' | 'dangerous',
  ) => Promise<{ approved: boolean; feedback?: string }>
  /**
   * Factory for spawning a child engine from AgentTool. Optional: an
   * ExecutionEngine can be built without one (e.g. for tests / REPLs that
   * don't spawn sub-agents). When set, the engine constructor wires its
   * private AgentTool from this value — the closure is per-engine so
   * concurrent and nested Agent calls never share state. When unset,
   * the AgentTool's action returns "not initialized" at runtime.
   */
  agentFactory?: AgentChildEngineFactory
  /**
   * Internal — AgentTool threads its current call-chain depth through the
   * config so the MAX_CALL_DEPTH check stays global across nested spawns
   * without resorting to module-level mutable counters. Callers normally
   * leave this unset.
   */
  initialAgentDepth?: number
}

export interface TurnResult {
  stopped: boolean
  /**
   * stop_sequence  — LLM returned finish_reason=stop with no tool calls
   * max_iterations — hit maxIterations ceiling
   * error          — hard abort (Ctrl+C × 2) or unrecoverable API error
   * interrupted    — soft pause requested (Ctrl+C × 1), partial history preserved
   */
  reason: 'max_iterations' | 'stop_sequence' | 'error' | 'interrupted'
  output: string
}
