/**
 * ToolExecutor — executes a single tool call with all policy checks,
 * permission enforcement, and module notification.
 *
 * Responsibilities:
 * - Find tool in registry
 * - Execution-time policy check (defense-in-depth: plan mode + agent allowlist)
 * - Permission check (PermissionManager)
 * - Execute the tool
 * - Notify modules (onToolCall)
 *
 * Does NOT handle: hooks (scheduler's job), message pushing (scheduler's job),
 * or result truncation (scheduler's job).
 */

import type { Tool, ToolContext, ToolResult } from '../types.js'
import type { PermissionManager } from '../permissionSystem.js'
import { classifyCommandRisk } from '../riskClassifier.js'
import type { Renderer } from '../../ui/renderer.js'
import type { ToolPolicy } from './toolPolicy.js'

export type NotifyToolCall = (
  toolName: string,
  input: Record<string, unknown>,
  result: ToolResult,
  turnNumber: number,
) => void

export interface ToolExecutorDeps {
  toolPolicy: ToolPolicy
  permissionManager: PermissionManager
  requestPermission?: (
    toolName: string,
    input: Record<string, unknown>,
    riskLevel: 'safe' | 'needs-approval' | 'dangerous',
  ) => Promise<{ approved: boolean; feedback?: string }>
  notifyToolCall: NotifyToolCall
  renderer: Renderer
}

export class ToolExecutor {
  private readonly deps: ToolExecutorDeps

  constructor(deps: ToolExecutorDeps) {
    this.deps = deps
  }

  async execute(
    allTools: Tool[],
    toolName: string,
    input: Record<string, unknown>,
    context: ToolContext,
    planMode: boolean,
    turnNumber: number,
  ): Promise<ToolResult> {
    const tool = allTools.find(t => t.name === toolName)
    if (!tool) {
      return { content: `Unknown tool: ${toolName}`, isError: true }
    }

    // Execution-time policy check (defense in depth)
    const policyError = this.deps.toolPolicy.checkExecutionAllowed(allTools, toolName, planMode)
    if (policyError) {
      return { content: policyError, isError: true }
    }

    // Permission check
    const isDangerous =
      toolName === 'Bash' && typeof input.command === 'string'
        ? classifyCommandRisk(input.command) === 'dangerous'
        : false
    const permission = this.deps.permissionManager.check(toolName, input, isDangerous)
    if (permission === 'deny') {
      return {
        content: `Permission denied for ${toolName}. Current mode: ${this.deps.permissionManager.formatMode()}`,
        isError: true,
      }
    }
    if (permission === 'ask') {
      if (this.deps.requestPermission) {
        const riskLevel = isDangerous ? 'dangerous' : 'needs-approval'
        const permResult = await this.deps.requestPermission(toolName, input, riskLevel)
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
        this.deps.renderer.warn(`Permission check: ${toolName} requires attention; continuing in single-user mode.`)
      }
    }

    const result = await tool.execute(input, context)

    this.deps.notifyToolCall(toolName, input, result, turnNumber)

    return result
  }
}
