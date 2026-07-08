/**
 * ExitPlanMode Tool — let the LLM present a plan and exit plan mode
 *
 * Inspired by Claude Code's ExitPlanModeTool.
 *
 * In plan mode, the LLM analyzes and plans but cannot write/edit. When the
 * plan is ready, it calls this tool with the plan text. The tool:
 *   1. Presents the plan to the user for approval
 *   2. If approved: switches off plan mode → write tools become available
 *   3. If rejected: stays in plan mode so the LLM can revise
 *
 * The approval flow is handled by a callback (`ctx.exitPlanMode`) provided
 * by the REPL. Sub-agents / piped mode auto-approve.
 */

import type { Tool, ToolContext, ToolDefinition, ToolResult } from '../core/types.js'

export class ExitPlanModeTool implements Tool {
  name = 'ExitPlanMode'

  definition: ToolDefinition = {
    type: 'function',
    function: {
      name: 'ExitPlanMode',
      description: `Present your plan to the user and exit plan mode to start coding. Use this when you have finished analyzing and are ready to implement.

## When to Use
- You are in plan mode and have completed your analysis
- You have a concrete plan ready for the user to approve
- You need the user's go-ahead before making changes

## When NOT to Use
- You're still gathering information — use Read/Grep/Glob instead
- You haven't written a plan yet — analyze first, then exit
- You're not in plan mode (this tool is only available in plan mode)

## Plan Format
Write a clear, structured plan with:
- What files will be created/modified
- Key implementation steps in order
- Any decisions that need user confirmation
- Potential risks or trade-offs

The user can approve the plan as-is, or ask you to revise. Once approved, you'll have access to all tools (Write, Edit, Bash, etc.) to implement the plan.`,
      parameters: {
        type: 'object',
        properties: {
          plan: {
            type: 'string',
            description: 'The complete plan text to present to the user for approval',
          },
        },
        required: ['plan'],
      },
    },
  }

  isConcurrencySafe(): boolean {
    return true
  }

  async execute(input: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const plan = input.plan as string | undefined
    if (!plan || typeof plan !== 'string' || !plan.trim()) {
      return { content: 'Error: plan text is required', isError: true }
    }

    // No callback — sub-agent or piped mode: auto-approve
    if (!ctx.exitPlanMode) {
      return {
        content: 'Plan mode exited (auto-approved in non-interactive mode). You can now proceed with implementation.\n\n## Plan:\n' + plan,
        isError: false,
      }
    }

    try {
      const approved = await ctx.exitPlanMode(plan)
      if (approved) {
        return {
          content: `User has approved your plan. You can now start coding. Start with updating your todo list if applicable.\n\n## Approved Plan:\n${plan}`,
          isError: false,
        }
      } else {
        return {
          content: `User has NOT approved your plan. Please revise your plan based on their feedback and try again. You are still in plan mode — only read-only tools are available.`,
          isError: false,
        }
      }
    } catch (err) {
      return {
        content: `Failed to get plan approval: ${(err as Error).message}`,
        isError: true,
      }
    }
  }
}
