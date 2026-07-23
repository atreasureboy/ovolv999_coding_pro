/**
 * ToolScheduler — partitions tool calls into batches and executes them
 * with correct concurrency semantics.
 *
 * Responsibilities (from replan.md §5.7):
 *   - Partition tool calls into safe (parallel) and stateful (serial) batches
 *   - Execute parallel batches via Promise.all
 *   - Execute serial batches one at a time
 *   - Renderer output (toolStart, toolResult)
 *   - EventLog entries
 *   - Push tool result messages
 *   - Enforce aggregate tool result budget (parallel batches)
 *   - Track active tool calls in SharedRuntimeState
 *   - Check soft abort between batches
 *
 * Does NOT handle: permission checks (executor's job), policy checks
 * (executor's job), hooks (executor's job), individual result truncation
 * (executor's job), or tool registration (ToolRegistry's job).
 */

import type { OpenAIMessage, Tool, ToolContext, IHookRunner } from '../types.js'
import type { EventLog } from '../eventLog.js'
import type { Renderer } from '../../ui/renderer.js'
import type { ContextManager } from '../context/contextManager.js'
import type { ToolExecutor } from './toolExecutor.js'
import type { ToolRegistry } from './toolRegistry.js'
import type { SharedRuntimeState } from '../runtime/sharedState.js'
import type { RunEventEmitter } from '../runtime/events.js'
import type { ResourceScheduler, ResourceLease } from '../resourceScheduler.js'
import { claimsConflictBetween } from '../resourceScheduler.js'
import type { ResourceClaim } from '../executionRun.js'

export interface ParsedToolCall {
  tc: { id: string; name: string; arguments: string }
  input: Record<string, unknown>
}

export interface ToolBatch {
  safe: boolean
  calls: ParsedToolCall[]
  /**
   * Accumulated resource claims of the calls in this batch. Populated
   * for parallel (safe) batches so the planner can test whether an
   * incoming call's claims conflict with the batch. Empty for serial
   * batches.
   */
  accumulatedClaims: ResourceClaim[]
}

/**
 * Partition tool calls into batches for execution (six_goal §六 / Phase 3).
 *
 * ResourceScheduler is the SOLE authority for concurrency: a tool call
 * may join a parallel batch ONLY IF it declares resource claims (via
 * `metadata.claims`) AND those claims don't pairwise-conflict with the
 * claims already accumulated in the batch. A tool that declares no
 * claims defaults to SERIAL (six_goal §六.3: "没有声明资源的工具默认
 * 串行执行") — it cannot be proven conflict-free, so it runs alone.
 *
 * This replaces the old name-based `LEGACY_CONCURRENCY_SAFE_TOOLS`
 * whitelist + static `concurrencySafe` metadata. The authoritative
 * correctness guard remains `ResourceScheduler.acquire()` in
 * `executeWithClaims` — partition is a best-effort planner that avoids
 * launching tools which would immediately block on the lock.
 */
export function partitionToolCalls(calls: ParsedToolCall[], tools?: Tool[]): ToolBatch[] {
  const batches: ToolBatch[] = []
  const findTool = (name: string) => tools?.find(t => t.name === name)

  for (const call of calls) {
    const tool = findTool(call.tc.name)
    // six_goal §六.3: only claim-declaring tools may parallelise.
    const claims = tool?.metadata?.claims ? tool.metadata.claims(call.input) : []
    const parallelizable = claims.length > 0
    const last = batches[batches.length - 1]

    if (
      parallelizable &&
      last?.safe &&
      last.accumulatedClaims.length > 0 &&
      !claimsConflictBetween(last.accumulatedClaims, claims)
    ) {
      last.calls.push(call)
      last.accumulatedClaims.push(...claims)
    } else {
      batches.push({
        safe: parallelizable,
        calls: [call],
        accumulatedClaims: [...claims],
      })
    }
  }

  return batches
}

export interface ToolSchedulerDeps {
  executor: ToolExecutor
  toolRegistry: ToolRegistry
  renderer: Renderer
  eventLog?: EventLog
  hookRunner?: IHookRunner
  contextManager: ContextManager
  sharedState: SharedRuntimeState
  eventEmitter?: RunEventEmitter
  claimSoftAbort: (controller: AbortController) => boolean
  /**
   * P1-1 (five_goal §八): ResourceScheduler for per-input resource
   * claims. When supplied, each tool execution is wrapped in
   * acquire/release so two tools touching the same file or git ref
   * serialize rather than race. Omit to disable (legacy behavior).
   */
  resourceScheduler?: ResourceScheduler
}

export class ToolScheduler {
  private readonly deps: ToolSchedulerDeps

  constructor(deps: ToolSchedulerDeps) {
    this.deps = deps
  }

  async schedule(
    parsedCalls: ParsedToolCall[],
    toolContext: ToolContext,
    planMode: boolean,
    turnAbortController: AbortController,
    messages: OpenAIMessage[],
    turnNumber: number,
  ): Promise<{ aborted: boolean }> {
    const turnAbortSignal = turnAbortController.signal
    const batches = partitionToolCalls(parsedCalls, this.deps.toolRegistry.getAll())

    for (const batch of batches) {
      if (turnAbortSignal.aborted) return { aborted: true }

      if (batch.safe && batch.calls.length > 1) {
        await this.executeParallelBatch(batch, toolContext, planMode, turnNumber, messages)
      } else {
        const aborted = await this.executeSerialBatch(
          batch, toolContext, planMode, turnNumber, messages, turnAbortSignal, turnAbortController,
        )
        if (aborted) return { aborted: true }
      }

      if (this.deps.claimSoftAbort(turnAbortController)) {
        return { aborted: true }
      }
    }

    return { aborted: false }
  }

  /**
   * P1-1/P1-2 (five_goal §八): acquire resource claims for a single
   * tool call before execution, release them in finally. Returns the
   * lease (or null if the scheduler is disabled or the tool makes no
   * claim) plus the wrapped execute call.
   *
   * P1-3 deadlock avoidance: the underlying ResourceScheduler does
   * atomic all-or-nothing acquire — this method never holds partial
   * locks, so two parallel tools asking for file1+file2 and file2+file1
   * in either order cannot deadlock. One will fully acquire; the other
   * waits or fails with ResourceConflictError.
   *
   * Failures here are surfaced as tool errors (isError:true) rather
   * than thrown — the scheduler's job is to gate execution, not crash
   * the turn. The caller sees a structured "blocked" result and can
   * retry.
   */
  private async executeWithClaims(
    callId: string,
    toolName: string,
    input: Record<string, unknown>,
    toolContext: ToolContext,
    planMode: boolean,
    turnNumber: number,
    runId: string | undefined,
  ): Promise<{ result: Awaited<ReturnType<ToolExecutor['execute']>>; lease: ResourceLease | null }> {
    const scheduler = this.deps.resourceScheduler
    const tool = this.deps.toolRegistry.getAll().find(t => t.name === toolName)
    const claims = tool?.metadata?.claims ? tool.metadata.claims(input) : []
    let lease: ResourceLease | null = null
    if (scheduler && claims.length > 0) {
      const acquireId = runId ?? `toolcall_${callId}`
      try {
        lease = await scheduler.acquire(acquireId, claims, {
          signal: toolContext.signal,
        })
      } catch (err) {
        // Acquire failed (conflict, timeout, or abort). Surface as a
        // structured tool error — do NOT execute the tool. The lease
        // is null so the finally below is a no-op.
        return {
          result: {
            content: `[${toolName}] blocked: resource unavailable — ${(err as Error).message}`,
            isError: true,
          },
          lease: null,
        }
      }
    }
    try {
      const result = await this.deps.executor.execute(callId, toolName, input, toolContext, planMode, turnNumber)
      return { result, lease }
    } finally {
      // Always release — even on throw, abort, or timeout. The
      // ResourceScheduler guarantees no partial-lock leak.
      if (lease) lease.release()
    }
  }

  /**
   * Resolve the runId to use for resource claims. Falls back to the
   * callId-derived id when no ExecutionContext is wired (legacy path).
   */
  private resolveClaimRunId(toolContext: ToolContext, callId: string): string | undefined {
    return toolContext.execution?.runId ?? `toolcall_${callId}`
  }

  private async executeParallelBatch(
    batch: ToolBatch,
    toolContext: ToolContext,
    planMode: boolean,
    turnNumber: number,
    messages: OpenAIMessage[],
  ): Promise<void> {
    const { executor, renderer, eventLog, contextManager, sharedState, eventEmitter } = this.deps

    for (const { tc, input } of batch.calls) {
      renderer.toolStart(tc.name, input)
      eventLog?.append('tool_call', tc.name, { input }, [tc.name])
      sharedState.activeToolCalls.set(tc.id, { callId: tc.id, toolName: tc.name, startedAt: Date.now() })
    }
    eventEmitter?.emit({ type: 'TOOL_BATCH_STARTED', count: batch.calls.length, parallel: true })

    // P0-9: wrap executor + instrumentation in try/finally so any
    // throw between set() and delete() (e.g. renderer.toolResult or
    // eventLog.append throwing on bad input) does not leak entries
    // in activeToolCalls for the rest of the process lifetime.
    //
    // P1-1/P1-2 (five_goal §八): each tool call is now wrapped in
    // acquire/release of its declared ResourceClaims. Atomic acquire
    // guarantees no partial-lock leak; release runs in finally inside
    // executeWithClaims even on throw.
    let results: Awaited<ReturnType<ToolExecutor['execute']>>[]
    try {
      results = await Promise.all(
        batch.calls.map(({ tc, input }) =>
          this.executeWithClaims(
            tc.id, tc.name, input, toolContext, planMode, turnNumber,
            this.resolveClaimRunId(toolContext, tc.id),
          ).then(r => r.result),
        ),
      )
    } finally {
      // Clear ALL entries this batch created, even on throw — the
      // caller (coordinator) converts thrown tool errors into a
      // terminal transition; surviving entries would be invisible
      // to the user but track as "in-flight" forever.
      for (const { tc } of batch.calls) {
        sharedState.activeToolCalls.delete(tc.id)
      }
    }

    // Aggregate budget enforcement — can only be done at scheduler level
    const aggregateResults = batch.calls.map((call, i) => ({
      content: results[i].content,
      tc: { id: call.tc.id, name: call.tc.name },
    }))
    contextManager.enforceAggregateBudget(aggregateResults)
    for (let i = 0; i < results.length; i++) {
      results[i] = { ...results[i], content: aggregateResults[i].content }
    }

    for (let i = 0; i < batch.calls.length; i++) {
      const { tc, input } = batch.calls[i]
      const result = results[i]
      try {
        renderer.toolResult(tc.name, result.content, result.isError)
        eventLog?.append('tool_result', tc.name, {
          content: result.content.slice(0, 500),
          isError: result.isError,
        }, [tc.name, result.isError ? 'error' : 'success'])
      } catch {
        // instrumentation failures must not propagate into the LLM
        // message stream — the tool itself succeeded, the result is
        // already in hand.
      }
      const safeContent = result.content.trim() || `(${tc.name} completed with no output)`
      messages.push({
        role: 'tool',
        tool_call_id: tc.id,
        content: safeContent,
        name: tc.name,
      })
    }
  }

  private async executeSerialBatch(
    batch: ToolBatch,
    toolContext: ToolContext,
    planMode: boolean,
    turnNumber: number,
    messages: OpenAIMessage[],
    turnAbortSignal: AbortSignal,
    turnAbortController: AbortController,
  ): Promise<boolean> {
    const { executor, renderer, eventLog, sharedState, eventEmitter } = this.deps

    eventEmitter?.emit({ type: 'TOOL_BATCH_STARTED', count: batch.calls.length, parallel: false })

    for (const { tc, input } of batch.calls) {
      if (turnAbortSignal.aborted) return true

      renderer.toolStart(tc.name, input)
      eventLog?.append('tool_call', tc.name, { input }, [tc.name])
      sharedState.activeToolCalls.set(tc.id, { callId: tc.id, toolName: tc.name, startedAt: Date.now() })

      // P0-9: wrap executor + instrumentation in try/finally so a
      // throw between set() and delete() cannot leak entries in
      // activeToolCalls. The executor itself has internal try/catch
      // (toolExecutor.ts) but the surrounding instrumentation does
      // not — previously a throwing renderer.toolResult or
      // eventLog.append would wedge the Map entry forever.
      //
      // P1-1/P1-2: claims acquired + released via executeWithClaims.
      let result: Awaited<ReturnType<ToolExecutor['execute']>>
      try {
        const wrapped = await this.executeWithClaims(
          tc.id, tc.name, input, toolContext, planMode, turnNumber,
          this.resolveClaimRunId(toolContext, tc.id),
        )
        result = wrapped.result
      } finally {
        sharedState.activeToolCalls.delete(tc.id)
      }

      try {
        renderer.toolResult(tc.name, result.content, result.isError)
        eventLog?.append('tool_result', tc.name, {
          content: result.content.slice(0, 500),
          isError: result.isError,
        }, [tc.name, result.isError ? 'error' : 'success'])
      } catch {
        // instrumentation failures must not propagate
      }

      const safeContent = result.content.trim() || `(${tc.name} completed with no output)`
      messages.push({
        role: 'tool',
        tool_call_id: tc.id,
        content: safeContent,
        name: tc.name,
      })

      if (this.deps.claimSoftAbort(turnAbortController)) {
        return true
      }
    }

    return false
  }
}
