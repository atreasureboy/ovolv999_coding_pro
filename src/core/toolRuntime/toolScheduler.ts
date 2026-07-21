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

export interface ParsedToolCall {
  tc: { id: string; name: string; arguments: string }
  input: Record<string, unknown>
}

export interface ToolBatch {
  safe: boolean
  calls: ParsedToolCall[]
}

const LEGACY_CONCURRENCY_SAFE_TOOLS = new Set([
  'Read', 'Glob', 'Grep', 'WebFetch', 'WebSearch', 'Bash', 'Agent', 'ShellSession', 'TmuxSession',
])

export function partitionToolCalls(calls: ParsedToolCall[], tools?: Tool[]): ToolBatch[] {
  const batches: ToolBatch[] = []

  for (const call of calls) {
    const tool = tools?.find(t => t.name === call.tc.name)
    const safe = tool?.isConcurrencySafe
      ? tool.isConcurrencySafe(call.input)
      : (tool?.metadata?.concurrencySafe ?? LEGACY_CONCURRENCY_SAFE_TOOLS.has(call.tc.name))
    const last = batches[batches.length - 1]

    if (last && last.safe && safe) {
      last.calls.push(call)
    } else {
      batches.push({ safe, calls: [call] })
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

    const results = await Promise.all(
      batch.calls.map(({ tc, input }) =>
        executor.execute(tc.id, tc.name, input, toolContext, planMode, turnNumber),
      ),
    )

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
      const { tc } = batch.calls[i]
      const result = results[i]
      renderer.toolResult(tc.name, result.content, result.isError)
      eventLog?.append('tool_result', tc.name, {
        content: result.content.slice(0, 500),
        isError: result.isError,
      }, [tc.name, result.isError ? 'error' : 'success'])
      sharedState.activeToolCalls.delete(tc.id)
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

      const result = await executor.execute(tc.id, tc.name, input, toolContext, planMode, turnNumber)

      renderer.toolResult(tc.name, result.content, result.isError)
      eventLog?.append('tool_result', tc.name, {
        content: result.content.slice(0, 500),
        isError: result.isError,
      }, [tc.name, result.isError ? 'error' : 'success'])
      sharedState.activeToolCalls.delete(tc.id)

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
