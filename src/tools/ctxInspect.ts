/**
 * CtxInspect Tool — conversation context inspector
 *
 * Lets the model inspect the composition of its own context: per-message
 * token estimates, the largest messages, what microCompact / snipCompact
 * would reclaim, and duplicate/near-duplicate detection.
 *
 * This is a read-only diagnostic — it never mutates the conversation.
 * Use the Snip tool to actually prune, or let autoCompact handle it.
 */

import type { Tool, ToolContext, ToolDefinition, ToolResult } from '../core/types.js'
import type { OpenAIMessage } from '../core/types.js'
import { estimateTokens, estimateTextTokens } from '../core/compact.js'
import { estimateSnipSavings, snipCompact } from '../core/snipCompact.js'

const TOP_N_DEFAULT = 10

export class CtxInspectTool implements Tool {
  name = 'CtxInspect'
  metadata = { readOnly: true, concurrencySafe: true }

  definition: ToolDefinition = {
    type: 'function',
    function: {
      name: 'CtxInspect',
      description: `Inspect the composition of the current conversation context. Shows per-message token estimates, the largest messages, and what compaction strategies would reclaim.

## When to Use
- Diagnosing why context is filling up
- Deciding between Snip, microCompact, or full compact
- Identifying oversized tool results or redundant messages

## Output
Token breakdown by message role, top-N largest messages, and projected savings from snip compaction.`,
      parameters: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            enum: ['summary', 'largest', 'breakdown', 'projection'],
            description: 'summary (default): overview. largest: top-N biggest messages. breakdown: per-role stats. projection: what snip would save.',
          },
          top_n: {
            type: 'number',
            description: 'Number of largest messages to show (for "largest" action). Default 10.',
          },
        },
      },
    },
  }

  isConcurrencySafe(): boolean {
    return true
  }

  async execute(input: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const action = (input.action as string) ?? 'summary'
    const topN = (input.top_n as number) ?? TOP_N_DEFAULT
    const messages = ctx.getMessages?.() ?? []

    if (messages.length === 0) {
      return { content: 'No messages in context.', isError: false }
    }

    switch (action) {
      case 'largest':
        return { content: this.renderLargest(messages, topN), isError: false }
      case 'breakdown':
        return { content: this.renderBreakdown(messages), isError: false }
      case 'projection':
        return { content: this.renderProjection(messages), isError: false }
      case 'summary':
      default:
        return { content: this.renderSummary(messages), isError: false }
    }
  }

  private renderSummary(messages: OpenAIMessage[]): string {
    const total = estimateTokens(messages)
    const lines: string[] = [
      `Context Summary:`,
      `  Total tokens: ~${total.toLocaleString()}`,
      `  Messages: ${messages.length}`,
    ]

    // Per-role counts
    const roles: Record<string, number> = {}
    for (const m of messages) {
      roles[m.role] = (roles[m.role] ?? 0) + 1
    }
    const roleParts = Object.entries(roles).map(([r, c]) => `${r}=${c}`)
    lines.push(`  Roles: ${roleParts.join(', ')}`)

    // Largest single message
    let largestIdx = 0
    let largestTokens = 0
    for (let i = 0; i < messages.length; i++) {
      const t = estimateTokens([messages[i]])
      if (t > largestTokens) {
        largestTokens = t
        largestIdx = i
      }
    }
    lines.push(`  Largest message: #${largestIdx} (~${largestTokens.toLocaleString()} tokens)`)

    // Projection
    const snipSavings = estimateSnipSavings(messages)
    if (snipSavings > 0) {
      lines.push(`  Snipable: ~${snipSavings.toLocaleString()} tokens recoverable`)
    } else {
      lines.push(`  Snipable: nothing to trim`)
    }

    return lines.join('\n')
  }

  private renderLargest(messages: OpenAIMessage[], topN: number): string {
    const indexed = messages.map((m, i) => ({
      idx: i,
      role: m.role,
      tokens: estimateTokens([m]),
      preview: messagePreview(m),
    }))
    indexed.sort((a, b) => b.tokens - a.tokens)
    const top = indexed.slice(0, Math.min(topN, indexed.length))

    const lines = [`Top ${top.length} largest messages:`]
    for (const m of top) {
      lines.push(`  #${m.idx} [${m.role}] ~${m.tokens.toLocaleString()} tok — ${m.preview}`)
    }
    return lines.join('\n')
  }

  private renderBreakdown(messages: OpenAIMessage[]): string {
    const stats: Record<string, { count: number; tokens: number }> = {}
    for (const m of messages) {
      if (!stats[m.role]) stats[m.role] = { count: 0, tokens: 0 }
      stats[m.role].count++
      stats[m.role].tokens += estimateTokens([m])
    }

    const lines = ['Token breakdown by role:']
    let grandTotal = 0
    for (const [role, s] of Object.entries(stats)) {
      lines.push(`  ${role}: ${s.count} msgs, ~${s.tokens.toLocaleString()} tokens`)
      grandTotal += s.tokens
    }
    lines.push(`  TOTAL: ~${grandTotal.toLocaleString()} tokens`)
    return lines.join('\n')
  }

  private renderProjection(messages: OpenAIMessage[]): string {
    const snipSavings = estimateSnipSavings(messages)
    const total = estimateTokens(messages)
    const projection = snipCompact(messages.map((m) => ({ ...m })))

    const lines = [
      `Compaction Projection:`,
      `  Current: ~${total.toLocaleString()} tokens`,
      `  Snip estimate: ~${snipSavings.toLocaleString()} tokens recoverable`,
      `  Snip actual (dry run): ${projection.tokensBefore.toLocaleString()} → ${projection.tokensAfter.toLocaleString()}`,
      `    trimmed=${projection.messagesTrimmed} dropped=${projection.messagesDropped} thinking=${projection.thinkingStripped}`,
    ]

    if (projection.snipped) {
      const pct = ((projection.tokensBefore - projection.tokensAfter) / projection.tokensBefore * 100).toFixed(1)
      lines.push(`  Reduction: ${pct}%`)
      lines.push(`  Recommendation: run Snip to reclaim context`)
    } else {
      lines.push(`  Recommendation: nothing to snip — consider full compact if pressure is high`)
    }

    return lines.join('\n')
  }
}

function messagePreview(m: OpenAIMessage): string {
  let text: string
  if (typeof m.content === 'string') {
    text = m.content
  } else if (Array.isArray(m.content)) {
    text = m.content
      .filter((p): p is { type: 'text'; text?: string } => p.type === 'text' && typeof p.text === 'string')
      .map((p) => p.text ?? '')
      .join(' ')
  } else {
    text = ''
  }

  const collapsed = text.replace(/\s+/g, ' ').trim()
  if (collapsed.length === 0) return '(empty)'
  return collapsed.length > 60 ? collapsed.slice(0, 57) + '...' : collapsed
}
