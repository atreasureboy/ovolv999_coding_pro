/**
 * ToolExecutor — executes a single tool call with all policy checks,
 * permission enforcement, hooks, result truncation, and module notification.
 *
 * Responsibilities (from replan.md §5.8):
 *   - Find tool in registry
 *   - Execution-time policy check (defense-in-depth: plan mode + agent allowlist)
 *   - Permission check (PermissionManager)
 *   - Pre/post hooks (PreToolCall, PostToolCall)
 *   - AbortSignal传递 (via ToolContext.signal)
 *   - Execute the tool
 *   - Error standardization
 *   - Tool Result truncation (individual, via ContextManager)
 *   - Module onToolCall notification
 *
 * Does NOT handle: batch scheduling (scheduler's job), aggregate budget
 * across parallel results (scheduler's job), or message pushing (scheduler's job).
 */

import type { ToolContext, ToolResult, IHookRunner } from '../types.js'
import type { PermissionManager } from '../permissionSystem.js'
import { classifyCommandRisk } from '../riskClassifier.js'
import type { Renderer } from '../../ui/renderer.js'
import type { ToolPolicy } from './toolPolicy.js'
import type { ToolRegistry } from './toolRegistry.js'
import type { ContextManager } from '../context/contextManager.js'
import type { RunEventEmitter } from '../runtime/events.js'
import { toLegacy, isStructuredResult, type AnyToolResult } from '../structuredToolResult.js'

export type NotifyToolCall = (
  toolName: string,
  input: Record<string, unknown>,
  result: ToolResult,
  turnNumber: number,
) => void

export interface ToolExecutorDeps {
  toolRegistry: ToolRegistry
  toolPolicy: ToolPolicy
  permissionManager: PermissionManager
  contextManager: ContextManager
  requestPermission?: (
    toolName: string,
    input: Record<string, unknown>,
    riskLevel: 'safe' | 'needs-approval' | 'dangerous',
  ) => Promise<{ approved: boolean; feedback?: string }>
  notifyToolCall: NotifyToolCall
  hookRunner?: IHookRunner
  eventEmitter?: RunEventEmitter
  renderer: Renderer
}

export class ToolExecutor {
  private readonly deps: ToolExecutorDeps

  constructor(deps: ToolExecutorDeps) {
    this.deps = deps
  }

  async execute(
    callId: string,
    toolName: string,
    input: Record<string, unknown>,
    context: ToolContext,
    planMode: boolean,
    turnNumber: number,
  ): Promise<ToolResult> {
    const { toolRegistry, toolPolicy, permissionManager, renderer, eventEmitter } = this.deps
    const allTools = toolRegistry.getAll()

    const tool = toolRegistry.get(toolName)
    if (!tool) {
      const result: ToolResult = { content: `Unknown tool: ${toolName}`, isError: true }
      eventEmitter?.emit({ type: 'TOOL_COMPLETED', callId, toolName, result })
      return result
    }

    // Execution-time policy check (defense in depth)
    const policyError = toolPolicy.checkExecutionAllowed(allTools, toolName, planMode)
    if (policyError) {
      const result: ToolResult = { content: policyError, isError: true }
      eventEmitter?.emit({ type: 'TOOL_COMPLETED', callId, toolName, result })
      return result
    }

    // Permission check
    const isDangerous =
      toolName === 'Bash' && typeof input.command === 'string'
        ? classifyCommandRisk(input.command) === 'dangerous'
        : false
    const permission = permissionManager.check(toolName, input, isDangerous)
    if (permission === 'deny') {
      const result: ToolResult = {
        content: `Permission denied for ${toolName}. Current mode: ${permissionManager.formatMode()}`,
        isError: true,
      }
      eventEmitter?.emit({ type: 'TOOL_COMPLETED', callId, toolName, result })
      return result
    }
    if (permission === 'ask') {
      if (this.deps.requestPermission) {
        const riskLevel = isDangerous ? 'dangerous' : 'needs-approval'
        const permResult = await this.deps.requestPermission(toolName, input, riskLevel)
        if (!permResult.approved) {
          const feedback = permResult.feedback?.trim()
          const result: ToolResult = {
            content: feedback
              ? `Permission denied by user for ${toolName}. Feedback: ${feedback}`
              : `Permission denied by user for ${toolName}.`,
            isError: true,
          }
          eventEmitter?.emit({ type: 'TOOL_COMPLETED', callId, toolName, result })
          return result
        }
      } else {
        renderer.warn(`Permission check: ${toolName} requires attention; continuing in single-user mode.`)
      }
    }

    // Pre-tool hook
    this.deps.hookRunner?.runPreToolCall(toolName, input)
    eventEmitter?.emit({ type: 'TOOL_STARTED', callId, toolName, input })

    let result: ToolResult
    try {
      // Tools may return either the legacy {content, isError} shape or
      // the structured shape (status/summary/exitCode/stdout/stderr/...).
      //
      // five_goal §三: the internal execution chain MUST preserve
      // structured fields (status, exitCode, stdout, stderr,
      // diagnostics, artifacts, retryable) all the way through to the
      // model-message boundary. Only ToolScheduler (which builds the
      // final {role:'tool'} message for the model API) flattens to
      // {content, isError} — and even there it reads content/isError
      // from the same object.
      //
      // Previously this called toLegacy() which created a NEW object
      // with ONLY {content, isError}, irretrievably dropping status,
      // exitCode, stdout, stderr, etc. — so WorkingState, verification,
      // and structured event consumers all saw undefined for those
      // fields. Now we merge: the legacy conversion provides
      // content/isError, and the structured fields are preserved on
      // the same object for downstream readers.
      const raw: AnyToolResult = await tool.execute(input, context)
      if (isStructuredResult(raw)) {
        const legacy = toLegacy(raw)
        result = { ...raw, content: legacy.content, isError: legacy.isError }
      } else {
        result = raw
      }
    } catch (err) {
      result = {
        content: `Tool execution error: ${(err as Error).message || String(err)}`,
        isError: true,
      }
    }

    // Individual tool result truncation (aggregate budget is scheduler's job)
    result = { ...result, content: this.deps.contextManager.truncateToolResult(result.content) }

    // Post-tool hook
    this.deps.hookRunner?.runPostToolCall(toolName, result.content, result.isError)
    eventEmitter?.emit({ type: 'TOOL_COMPLETED', callId, toolName, result })

    this.deps.notifyToolCall(toolName, input, result, turnNumber)

    // five_goal §四: update WorkingState from the structured tool
    // result. Best-effort — a WorkingState bug must never break the
    // turn. This is the single integration point: both direct executor
    // calls and scheduler-routed calls go through here.
    try {
      this.deps.contextManager.applyToolEvent({ toolName, input, result })
    } catch { /* best-effort */ }

    return result
  }
}
