/**
 * Brief Tool — concise situation snapshot for the agent
 *
 * Gives the model a compact summary of its current state: context
 * pressure, budget consumption, active goals, background tasks, and
 * memory pointers. Inspired by Claude Code's internal "brief"
 * injected before each turn — exposed here as an on-demand tool so
 * the model can self-assess when it feels lost or before wrapping up.
 */

import type { Tool, ToolContext, ToolDefinition, ToolResult } from '../core/types.js'
import { calculateContextState, MODEL_MAX_CONTEXT_TOKENS } from '../core/compact.js'

export class BriefTool implements Tool {
  name = 'Brief'
  metadata = { readOnly: true, concurrencySafe: true }

  definition: ToolDefinition = {
    type: 'function',
    function: {
      name: 'Brief',
      description: `Get a concise snapshot of the current session state: context pressure, token budget, active goals, background tasks, and recent memory.

## When to Use
- When unsure how much context budget remains
- Before starting a large multi-step operation (to check headroom)
- When the conversation feels long and you want to decide whether to compact
- At the start of a new turn after resuming a session

## Output
A short status block with token usage, pressure level, and pointers to active state.`,
      parameters: {
        type: 'object',
        properties: {
          detail: {
            type: 'string',
            enum: ['short', 'full'],
            description: 'short (default): one-line summary. full: detailed breakdown.',
          },
        },
      },
    },
  }

  isConcurrencySafe(): boolean {
    return true
  }

  async execute(input: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const detail = (input.detail as string) ?? 'short'
    const lines: string[] = []

    // ── Context pressure ──────────────────────────────────────────────────
    const messages = ctx.getMessages?.() ?? []
    const ctxState = calculateContextState(messages, MODEL_MAX_CONTEXT_TOKENS)
    const tokenCount = ctxState.currentTokens
    const pct = Math.round(ctxState.pct * 100)
    const pressureLabel =
      ctxState.pct > 0.85 ? 'HIGH' :
      ctxState.pct > 0.7 ? 'elevated' :
      ctxState.pct > 0.5 ? 'moderate' : 'low'

    lines.push(`Context: ${pct}% used (${tokenCount.toLocaleString()}/${MODEL_MAX_CONTEXT_TOKENS.toLocaleString()} tokens) — pressure ${pressureLabel}`)
    lines.push(`Messages: ${messages.length}`)

    // ── Goals (best-effort import to avoid hard coupling) ─────────────────
    try {
      const { listGoals } = await import('../core/goals.js')
      const active = listGoals({ status: 'in_progress' })
      const pending = listGoals({ status: 'pending' })
      if (active.length + pending.length > 0) {
        lines.push(`Goals: ${active.length} in-progress, ${pending.length} pending`)
      }
    } catch { /* goals module unavailable */ }

    // ── Background tasks ──────────────────────────────────────────────────
    if (ctx.backgroundTaskManager) {
      try {
        const tasks = ctx.backgroundTaskManager.listTasks()
        const running = tasks.filter((t: { status: string }) => t.status === 'running')
        if (running.length > 0) {
          lines.push(`Background tasks: ${running.length} running`)
        }
      } catch { /* ignore */ }
    }

    // ── Memory pointers ───────────────────────────────────────────────────
    if (ctx.semanticMemory) {
      try {
        const entries = ctx.semanticMemory.readAll()
        if (entries.length > 0) {
          lines.push(`Semantic memory: ${entries.length} entries`)
        }
      } catch { /* ignore */ }
    }

    // ── Working directory ─────────────────────────────────────────────────
    lines.push(`CWD: ${ctx.cwd}`)

    const content = detail === 'full'
      ? `=== Session Brief ===\n${lines.join('\n')}\n=== End Brief ===`
      : lines.join(' | ')

    return { content, isError: false }
  }
}
