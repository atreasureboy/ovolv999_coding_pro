/**
 * RuntimeCoordinator — owns the Think → Act → Observe main loop.
 *
 * Responsibilities (from replan.md §5.1):
 *   - Boot the runtime for a turn (modules, system prompt, tool defs)
 *   - Drive the state-machine loop (boot → check_abort → budget_check →
 *     module_iteration → llm_call → continuation_check → parse_response →
 *     tool_execution → check_abort …)
 *   - Delegate ALL concrete work to subsystems:
 *       ModelGateway   → LLM API calls
 *       ContextManager → budget + compaction
 *       ToolScheduler  → partition + execute tool calls
 *       ModuleManager  → lifecycle hooks
 *   - Decide termination via TerminationPolicy
 *   - Clean up in finally (abort controller, soft-abort ownership)
 *
 * Does NOT:
 *   - Parse stream chunks directly (StreamConsumer's job)
 *   - Execute tools directly (ToolExecutor's job)
 *   - Compact context directly (ContextManager's job)
 *   - Check permissions directly (ToolExecutor's job)
 *
 * State ownership:
 * - Per-turn loop variables (finalOutput, pendingToolCalls, retry counters)
 *   are local to `run()` — created fresh each turn.
 * - Cross-turn state (abort controllers, plan mode, allTools) lives in
 *   SharedRuntimeState, shared with the Engine facade.
 */

import type {
  EngineConfig,
  OpenAIMessage,
  ContentPart,
  Tool,
  ToolContext,
  ToolDefinition,
  TurnResult,
} from '../types.js'
import type { TokenUsage } from '../costTracker.js'
import type { CostTracker } from '../costTracker.js'
import type { BackgroundTaskManager } from '../backgroundTaskManager.js'
import type { FileHistory } from '../fileHistory.js'
import type { PermissionManager } from '../permissionSystem.js'
import type { Renderer } from '../../ui/renderer.js'
import type { EventLog } from '../eventLog.js'
import type { ModuleBootContext } from '../module.js'
import { getPlanModePrefix } from '../../prompts/system.js'
import { normalizeCJKInput } from '../strings.js'
import { clearFileState } from '../fileState.js'
import {
  transitionQueryState,
  isTerminal,
  createBudgetTracker,
  checkTokenBudget,
  type QueryState,
} from '../queryStateMachine.js'
import type { ModelGateway } from '../model/modelGateway.js'
import type { ContextManager } from '../context/contextManager.js'
import type { ToolPolicy } from '../toolRuntime/toolPolicy.js'
import type { ToolScheduler, ParsedToolCall } from '../toolRuntime/toolScheduler.js'
import type { ModuleManager } from '../moduleRuntime/moduleManager.js'
import type { SharedRuntimeState } from './sharedState.js'
import { checkTermination } from './terminationPolicy.js'

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
  moduleManager: ModuleManager
  baseTools: Tool[]

  sharedState: SharedRuntimeState
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
  ): Promise<{ result: TurnResult; newHistory: OpenAIMessage[] }> {
    const { config, renderer, eventLog, sharedState } = this.deps
    const planMode = sharedState.planModeActive

    clearFileState()

    // ── Boot Sequence ──
    const bootCtx: ModuleBootContext = {
      cwd: config.cwd,
      sessionDir: config.sessionDir,
      config,
      userMessage,
    }
    const bootOutput = await this.deps.moduleManager.boot(bootCtx)
    const { systemPromptSections: moduleSections, toolContextPatch, tools: moduleTools } = bootOutput
    sharedState.allTools = [...this.deps.baseTools, ...moduleTools]

    eventLog?.append('boot_context', 'engine', {
      trajectory: 'boot_context',
      modules: this.deps.moduleManager.moduleNames,
      module_sections: moduleSections.length,
      module_tools: moduleTools.length,
      user_message_length: userMessage.length,
    })

    const systemPrompt = this.buildSystemPrompt(planMode, moduleSections)
    this.deps.contextManager.beginTurn(systemPrompt)
    const toolDefs = this.deps.toolPolicy.getExposedDefinitions(sharedState.allTools, planMode)

    const turnAbortController = new AbortController()
    sharedState.currentTurnAbortController = turnAbortController

    // Build initial messages
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

    this.deps.contextManager.consumeQueuedSnip(messages)

    const toolContext = this.buildToolContext(
      turnAbortController.signal,
      {
        ...toolContextPatch,
        availableToolNames: toolDefs.map(t => t.function.name),
        snipMessages: (keepRecent: number, reason?: string) =>
          this.deps.contextManager.applySnip(messages, keepRecent, reason),
        getMessages: () => messages.map(m => ({ ...m })),
      },
      sharedState,
    )

    // ── State machine driver ──
    let state: QueryState = transitionQueryState({ kind: 'boot' }, { type: 'booted' })

    let finalOutput = ''
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

    try {
      while (!isTerminal(state)) {
        switch (state.kind) {
          case 'check_abort': {
            const decision = checkTermination({
              hardAborted: turnAbortController.signal.aborted,
              softAborted: this.claimSoftAbort(turnAbortController, sharedState),
              iteration: state.iteration,
              maxIterations: config.maxIterations,
            })
            if (decision.kind === 'hard_abort') {
              state = transitionQueryState(state, { type: 'hard_abort', output: finalOutput })
            } else if (decision.kind === 'soft_abort') {
              state = transitionQueryState(state, { type: 'soft_abort', output: finalOutput })
            } else if (decision.kind === 'max_iterations') {
              renderer.warn(`Max iterations (${decision.maxIterations}) reached`)
              state = transitionQueryState(state, { type: 'max_iterations', output: finalOutput })
            } else {
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
            await this.deps.moduleManager.runIteration({
              iteration: state.iteration,
              messages,
              abortSignal: turnAbortController.signal,
            })
            state = transitionQueryState(state, { type: 'continue' })
            break
          }

          case 'llm_call': {
            const { assistantText, finishReason, rawToolCalls } =
              await this.callLLM(systemPrompt, messages, toolDefs, turnAbortController.signal)

            if (assistantText) {
              finalOutput = assistantText
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

            if (!assistantText && rawToolCalls.length === 0 && emptyResponseCount < MAX_EMPTY_RETRIES) {
              emptyResponseCount++
              messages.push({
                role: 'user',
                content: 'Your previous response was empty (no text, no tool call). Please respond with text or invoke a tool.',
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
            if (enableContinuation) {
              const decision = checkTokenBudget(budgetTracker, turnTokenBudget, turnTokensProduced)
              if (decision.action === 'continue') {
                eventLog?.append('module_flag', 'continuation', {
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
              output: finalOutput,
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
        result = { stopped: true, reason: 'error', output: finalOutput }
      }
    } catch (err) {
      const errMsg = (err as Error).message || String(err)
      const errorIteration = 'iteration' in state ? state.iteration : 0
      config.hookRunner?.runOnError?.(err as Error, {
        turnNumber: errorIteration,
        lastToolName,
      })
      renderer.error(`Engine error: ${errMsg}`)
      result = { stopped: true, reason: 'error', output: finalOutput || `[Error: ${errMsg}]` }
    } finally {
      if (sharedState.currentTurnAbortController === turnAbortController) {
        sharedState.currentTurnAbortController = null
      }
      if (sharedState.softAbortRequested && sharedState.softAbortOwner === turnAbortController) {
        sharedState.softAbortRequested = false
        sharedState.softAbortOwner = null
      }
    }

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

  // ── Helpers (moved from engine) ──────────────────────────────────────────

  private buildSystemPrompt(planMode: boolean, moduleSections: string[] = []): string {
    const baseSystemPrompt = this.deps.config.systemPrompt ?? ''
    const sections = moduleSections.length > 0
      ? baseSystemPrompt + '\n\n---\n\n' + moduleSections.join('\n\n---\n\n')
      : baseSystemPrompt
    if (planMode) {
      return getPlanModePrefix() + sections
    }
    return sections
  }

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

  private buildToolContext(
    turnAbortSignal: AbortSignal,
    modulePatches: Partial<ToolContext>,
    sharedState: SharedRuntimeState,
  ): ToolContext {
    const { config, permissionManager, eventLog, backgroundTaskManager, fileHistory } = this.deps
    return {
      cwd: config.cwd,
      permissionMode: config.permissionMode,
      permissionManager,
      signal: turnAbortSignal,
      apiConfig: {
        apiKey: config.apiKey,
        baseURL: config.baseURL,
        model: config.model,
      },
      eventLog,
      backgroundTaskManager,
      askUserQuestion: config.askUserQuestion,
      exitPlanMode: async (plan: string): Promise<boolean> => {
        const approved = await config.exitPlanMode?.(plan) ?? true
        if (approved) sharedState.planModeActive = false
        return approved
      },
      enterPlanMode: () => { sharedState.planModeActive = true },
      fileHistory: fileHistory ?? undefined,
      ...modulePatches,
    }
  }

  private claimSoftAbort(turnAbortController: AbortController, sharedState: SharedRuntimeState): boolean {
    if (!sharedState.softAbortRequested) return false
    if (sharedState.softAbortOwner !== null && sharedState.softAbortOwner !== turnAbortController) {
      return false
    }
    sharedState.softAbortRequested = false
    sharedState.softAbortOwner = null
    return true
  }
}
