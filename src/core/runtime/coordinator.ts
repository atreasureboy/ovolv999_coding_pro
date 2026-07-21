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
import type { ModelGateway } from '../model/modelGateway.js'
import type { ContextManager } from '../context/contextManager.js'
import type { ToolPolicy } from '../toolRuntime/toolPolicy.js'
import type { ToolScheduler, ParsedToolCall } from '../toolRuntime/toolScheduler.js'
import type { ToolRegistry } from '../toolRuntime/toolRegistry.js'
import type { ModuleManager } from '../moduleRuntime/moduleManager.js'
import type { SharedRuntimeState } from './sharedState.js'
import type { RunEventEmitter } from './events.js'
import { isTerminalRunStatus } from '../executionRun.js'
import type { ExecutionRunRegistry, RunStatus } from '../executionRun.js'
import { checkTermination } from './terminationPolicy.js'
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
  ): Promise<{ result: TurnResult; newHistory: OpenAIMessage[] }> {
    const { config, renderer, eventLog, sharedState, eventEmitter } = this.deps

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
          parentRunId: this.deps.parentRunId,
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

    // ── State machine driver ──
    let state: QueryState = transitionQueryState({ kind: 'boot' }, { type: 'booted' })

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

    // ── ExecutionRun terminal transition (GAP-C) ──
    if (runId && registry) {
      const targetStatus: RunStatus =
        result.reason === 'stop_sequence' ? 'succeeded'
        : result.reason === 'interrupted' ? 'cancelled'
        : result.reason === 'max_iterations' ? 'succeeded'
        : 'failed'
      try {
        const run = registry.get(runId)
        if (run && !isTerminalRunStatus(run.status)) {
          registry.transition(runId, targetStatus, {
            phase: 'completed',
            error: targetStatus === 'failed' ? (result.output || 'turn failed') : undefined,
          })
        }
      } catch { /* best-effort: never break the turn result */ }
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
