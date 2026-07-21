/**
 * ToolScheduler — partitions tool calls into batches and executes them
 * with correct concurrency semantics.
 *
 * Responsibilities:
 * - Partition tool calls into safe (parallel) and stateful (serial) batches
 * - Execute parallel batches via Promise.all
 * - Execute serial batches one at a time
 * - Pre/post hooks (PreToolCall, PostToolCall)
 * - Renderer output (toolStart, toolResult)
 * - EventLog entries
 * - Push tool result messages
 * - Enforce aggregate tool result budget (parallel batches)
 * - Check soft abort between batches
 *
 * Does NOT handle: permission checks (executor's job), policy checks
 * (executor's job), or tool registration (engine's job).
 */

import type { OpenAIMessage, Tool, ToolContext, ToolResult, IHookRunner } from '../types.js'
import type { EventLog } from '../eventLog.js'
import type { Renderer } from '../../ui/renderer.js'
import type { ContextManager } from '../context/contextManager.js'
import type { ToolExecutor } from './toolExecutor.js'

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
  renderer: Renderer
  eventLog?: EventLog
  hookRunner?: IHookRunner
  contextManager: ContextManager
  allTools: () => Tool[]
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
    const batches = partitionToolCalls(parsedCalls, this.deps.allTools())

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
    const { executor, renderer, eventLog, hookRunner, contextManager } = this.deps
    const allTools = this.deps.allTools()

    for (const { tc, input } of batch.calls) {
      renderer.toolStart(tc.name, input)
      hookRunner?.runPreToolCall(tc.name, input)
      eventLog?.append('tool_call', tc.name, { input }, [tc.name])
    }

    const results = await Promise.all(
      batch.calls.map(({ tc, input }) =>
        executor.execute(allTools, tc.name, input, toolContext, planMode, turnNumber),
      ),
    )

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
      hookRunner?.runPostToolCall(tc.name, result.content, result.isError)
      renderer.toolResult(tc.name, result.content, result.isError)
      eventLog?.append('tool_result', tc.name, {
        content: result.content.slice(0, 500),
        isError: result.isError,
      }, [tc.name, result.isError ? 'error' : 'success'])
      const safeContent = result.content.trim() || `(${tc.name} completed with no output)`
      messages.push({
        role: 'tool',
        tool_call_id: tc.id,
        content: contextManager.truncateToolResult(safeContent),
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
    const { executor, renderer, eventLog, hookRunner, contextManager } = this.deps
    const allTools = this.deps.allTools()

    for (const { tc, input } of batch.calls) {
      if (turnAbortSignal.aborted) return true

      renderer.toolStart(tc.name, input)
      hookRunner?.runPreToolCall(tc.name, input)
      eventLog?.append('tool_call', tc.name, { input }, [tc.name])

      const result = await executor.execute(allTools, tc.name, input, toolContext, planMode, turnNumber)

      hookRunner?.runPostToolCall(tc.name, result.content, result.isError)
      renderer.toolResult(tc.name, result.content, result.isError)
      eventLog?.append('tool_result', tc.name, {
        content: result.content.slice(0, 500),
        isError: result.isError,
      }, [tc.name, result.isError ? 'error' : 'success'])

      const serialSafeContent = result.content.trim() || `(${tc.name} completed with no output)`
      messages.push({
        role: 'tool',
        tool_call_id: tc.id,
        content: contextManager.truncateToolResult(serialSafeContent),
        name: tc.name,
      })

      if (this.deps.claimSoftAbort(turnAbortController)) {
        return true
      }
    }

    return false
  }
}
