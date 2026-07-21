/**
 * Module System — composable capability extensions for the unified Harness.
 *
 * Core principle (from AgentOS): all agents share one runtime (Harness).
 * Differentiated capabilities come from enabling/disabling modules, NOT from
 * hardcoded agent_type enums.
 *
 * Lifecycle hooks:
 *   boot()        — called once before the engine loop starts
 *   onIteration() — called at the top of each loop iteration
 *   onToolCall()  — called after each tool execution
 *   onComplete()  — called after the engine loop finishes
 */

import type OpenAI from 'openai'
import type { Tool, ToolContext, ToolResult, OpenAIMessage, TurnResult, EngineConfig } from './types.js'
import type { EventLog } from './eventLog.js'

/** Context passed to module factories — provides shared dependencies */
export interface ModuleContext {
  client: OpenAI
  model: string
  config: EngineConfig
}

/** Factory that creates a module instance from shared context */
export type ModuleFactory = (ctx: ModuleContext) => AgentModule

/** Context passed to module.boot() */
export interface ModuleBootContext {
  cwd: string
  sessionDir?: string
  config: EngineConfig
  /** The user's message for this run — used for relevance-based memory retrieval */
  userMessage?: string
}

/** Return value of module.boot() — what the module injects into the run */
export interface ModuleBootResult {
  /** Additional system prompt sections to inject */
  systemPromptSections?: string[]
  /** Additional tools this module provides */
  tools?: Tool[]
  /** Fields to merge into ToolContext */
  toolContextPatch?: Partial<ToolContext>
}

/** Context passed to module.onIteration() */
export interface ModuleIterationContext {
  iteration: number
  messages: OpenAIMessage[]
  abortSignal: AbortSignal
}

/** Return value of module.onIteration() — can inject a message into the conversation */
export interface ModuleIterationResult {
  /** If set, this message is injected as a user message before the LLM call */
  injectMessage?: string
}

/** Context passed to module.onComplete() */
export interface ModuleRunContext {
  cwd: string
  sessionDir?: string
  turnResult: TurnResult
  messages: OpenAIMessage[]
  eventLog?: EventLog
}

/**
 * Agent Module — a composable capability extension.
 *
 * Implementations: MemoryModule, CriticModule, WorkspaceModule, ReflectionModule.
 * Custom modules can be registered via ModuleRegistry.register().
 */
export interface AgentModule {
  readonly name: string
  /** Modules that must be enabled before this one (resolved by registry) */
  readonly dependencies?: string[]
  /**
   * P0-7: criticality. `critical` (default) → boot failure aborts the
   * engine; `best_effort` → boot failure is logged and the module is
   * dropped from iteration/complete hooks. Backwards-compatible: a
   * module that omits the field is treated as `critical`.
   */
  readonly criticality?: 'critical' | 'best_effort'

  /** Boot Sequence — inject prompt sections, tools, context patches */
  boot(ctx: ModuleBootContext): ModuleBootResult | Promise<ModuleBootResult>

  /** Called at the top of each engine loop iteration (e.g. critic check) */
  onIteration?(ctx: ModuleIterationContext): void | Promise<ModuleIterationResult | void>

  /** Called after each tool execution (e.g. episodic memory write) */
  onToolCall?(
    toolName: string,
    input: Record<string, unknown>,
    result: ToolResult,
    turnNumber: number,
  ): void

  /** Called after the engine loop finishes (e.g. reflection knowledge extraction) */
  onComplete?(ctx: ModuleRunContext): void | Promise<void>

  /**
   * P0-1 (transactional model switch): called when the runtime
   * switches models mid-session. Modules that capture `model` in
   * their factory (e.g. Critic, Reflection) MUST override this so
   * subsequent LLM calls hit the new model instead of the original.
   * Optional: modules that read `model` from a live reference on
   * every call can omit it.
   */
  onModelChanged?(model: string): void
}
