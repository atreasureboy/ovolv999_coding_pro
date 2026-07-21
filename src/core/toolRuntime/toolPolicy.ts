/**
 * ToolPolicy — unified tool exposure and execution policy.
 *
 * Two layers of defense:
 *
 * exposure policy: which tools the model CAN SEE (getToolDefinitions).
 * execution policy: which tools the model CAN RUN (executeToolCall).
 *
 * Both layers must agree — a model that guesses a hidden tool name
 * must still be blocked at execution time. This class is the single
 * source of truth for both, eliminating the previous duplication
 * between engine.getToolDefinitions and engine.executeToolCall.
 *
 * State: none — pure policy functions parameterized by config.
 */

import type { Tool, ToolDefinition } from '../types.js'
import type { AgentConfig } from '../agentPresets.js'
import { getToolDefinitions, findTool } from '../../tools/index.js'
import { filterToolsForSubAgent } from '../agentToolFilter.js'

const LEGACY_PLAN_MODE_TOOLS = new Set([
  'Read', 'Glob', 'Grep', 'WebFetch', 'WebSearch', 'ExitPlanMode',
])

export interface ToolPolicyConfig {
  agent?: AgentConfig
}

export class ToolPolicy {
  private readonly config: ToolPolicyConfig

  constructor(config: ToolPolicyConfig) {
    this.config = config
  }

  // ── Exposure: which tool definitions to send to the LLM ────────────────

  /**
   * Filter tool definitions for the LLM request.
   * Applies sub-agent allowlist (if agent config is set) and plan mode.
   */
  getExposedDefinitions(
    allTools: Tool[],
    planMode: boolean,
  ): ToolDefinition[] {
    let defs = getToolDefinitions(allTools)

    if (this.config.agent) {
      const allNames = defs.map(t => t.function.name)
      const filtered = filterToolsForSubAgent(
        allNames,
        this.config.agent.tools,
        this.config.agent.disallowedTools,
      )
      const allowedSet = new Set(filtered)
      defs = defs.filter(t => allowedSet.has(t.function.name))
    }

    if (planMode) {
      defs = defs.filter((t) => {
        const tool = findTool(allTools, t.function.name)
        return tool?.metadata?.readOnly === true || LEGACY_PLAN_MODE_TOOLS.has(t.function.name)
      })
    }

    return defs
  }

  // ── Execution: defense-in-depth at call time ────────────────────────────

  /**
   * Check whether a tool is allowed to execute.
   * Returns null if allowed, or an error message if denied.
   *
   * This re-checks plan mode and agent allowlist at execution time
   * so a model that fabricates a hidden tool name is still blocked.
   */
  checkExecutionAllowed(
    allTools: Tool[],
    toolName: string,
    planMode: boolean,
  ): string | null {
    // Plan mode defense-in-depth
    if (planMode) {
      const tool = findTool(allTools, toolName)
      if (!tool || !(tool.metadata?.readOnly === true || LEGACY_PLAN_MODE_TOOLS.has(toolName))) {
        return `Tool "${toolName}" is not available in plan mode. Only read-only tools are allowed. Output your plan as text.`
      }
    }

    // Agent allowlist defense-in-depth
    if (this.config.agent) {
      const allNames = allTools.map(t => t.name)
      const filtered = filterToolsForSubAgent(
        allNames,
        this.config.agent.tools,
        this.config.agent.disallowedTools,
      )
      if (!filtered.includes(toolName)) {
        return `Tool "${toolName}" is not available to this agent.`
      }
    }

    return null
  }
}
