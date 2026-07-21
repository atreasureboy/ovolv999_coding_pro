/**
 * ContextManager — owns token estimation, budget evaluation, compaction
 * orchestration, and snip management. Extracted from engine.ts to
 * isolate context management from the run loop.
 *
 * State ownership:
 * - systemPromptTokens: cached per turn
 * - lastAssistantTs: wall-clock of last assistant message
 * - consecutiveCompactFailures: circuit breaker (max 3)
 * - suppressCompactWarning: one-shot latch
 * - resolvedContextWindow: cached model lookup
 * - pendingSnipCount: queued /snip request
 *
 * Mutates the messages array in place for microCompact, maybeCompact,
 * and snip operations.
 */

import type OpenAI from 'openai'
import type { OpenAIMessage, ToolDefinition, IHookRunner } from '../types.js'
import type { EventLog } from '../eventLog.js'
import type { Renderer } from '../../ui/renderer.js'
import {
  maybeCompact,
  microCompact,
  maybeTimeBasedMicroCompact,
  estimateTokens,
  estimateToolDefinitionTokens,
  getCompressionStrategy,
  CONTEXT_MICROCOMPACT_PCT,
  CONTEXT_WARN_PCT,
  CONTEXT_COMPACT_PCT,
  resolveContextWindow,
  clampMaxOutputTokens,
  effectiveInputBudget,
} from '../compact.js'
import { truncateToolResult, enforceAggregateToolResultBudget } from './toolResultBudget.js'

export interface ContextManagerDeps {
  client: OpenAI
  model: string
  maxContextTokens?: number
  maxOutputTokens?: number
  sessionDir?: string
  renderer: Renderer
  eventLog?: EventLog
  hookRunner?: IHookRunner
}

export class ContextManager {
  private readonly deps: ContextManagerDeps

  private systemPromptTokens = 0
  private lastAssistantTs: number | undefined = undefined
  private consecutiveCompactFailures = 0
  private suppressCompactWarning = false
  private resolvedContextWindow: number | null = null
  private pendingSnipCount: number | null = null

  constructor(deps: ContextManagerDeps) {
    this.deps = deps
  }

  // ── Accessors ──────────────────────────────────────────────────────────

  get contextWindow(): number {
    if (this.resolvedContextWindow === null) {
      this.resolvedContextWindow = resolveContextWindow(
        this.deps.model,
        this.deps.maxContextTokens,
      )
    }
    return this.resolvedContextWindow
  }

  effectiveMaxOutputTokens(maxOutputTokens?: number): number {
    return clampMaxOutputTokens(maxOutputTokens ?? this.deps.maxOutputTokens, this.contextWindow)
  }

  // ── Turn lifecycle ─────────────────────────────────────────────────────

  beginTurn(systemPrompt: string): void {
    this.systemPromptTokens = Math.ceil(systemPrompt.length / 3.5) + 20
  }

  stampAssistantMessage(): void {
    this.lastAssistantTs = Date.now()
  }

  // ── Budget evaluation ──────────────────────────────────────────────────

  async evaluateBudget(params: {
    messages: OpenAIMessage[]
    toolDefs?: ToolDefinition[]
    abortSignal?: AbortSignal
  }): Promise<void> {
    const { messages, toolDefs, abortSignal } = params

    const suppressWarning = this.suppressCompactWarning
    this.suppressCompactWarning = false

    const maxCtxTokens = this.contextWindow
    const messageTokens = estimateTokens(messages)
    const toolDefTokens = estimateToolDefinitionTokens(toolDefs)
    const totalTokens = messageTokens + this.systemPromptTokens + toolDefTokens
    const inputBudget = effectiveInputBudget(maxCtxTokens, this.deps.maxOutputTokens)
    const pct = totalTokens / inputBudget

    const shouldMicroCompact = pct >= CONTEXT_MICROCOMPACT_PCT
    const shouldWarn = pct >= CONTEXT_WARN_PCT
    const shouldCompact = pct >= CONTEXT_COMPACT_PCT
    const strategy = getCompressionStrategy(pct)

    // Time-based microCompact — free when cache is cold
    if (!shouldCompact) {
      const tbResult = maybeTimeBasedMicroCompact(messages, this.lastAssistantTs)
      if (tbResult.compacted) {
        this.deps.eventLog?.append('context_compact', 'engine', {
          type: 'time_based_microcompact',
          tokens_before: tbResult.tokensBefore,
          tokens_after: tbResult.tokensAfter,
          tools_cleared: tbResult.toolsCleared,
        })
      }
    }

    // Pressure-based microCompact — clear old tool results at 50%
    if (shouldMicroCompact && !shouldCompact) {
      const mcResult = microCompact(messages)
      if (mcResult.compacted) {
        this.deps.eventLog?.append('context_compact', 'engine', {
          type: 'microcompact',
          tokens_before: mcResult.tokensBefore,
          tokens_after: mcResult.tokensAfter,
          tools_cleared: mcResult.toolsCleared,
        })
      }
    }

    if (this.deps.sessionDir && shouldWarn && !suppressWarning) {
      this.deps.renderer.contextWarning(totalTokens, maxCtxTokens, pct)
    }

    if (shouldCompact && this.consecutiveCompactFailures < 3) {
      this.deps.renderer.compactStart(totalTokens)
      this.deps.eventLog?.append('context_compact', 'engine', {
        strategy,
        tokens_before: totalTokens,
        system_prompt_tokens: this.systemPromptTokens,
        pct,
      })

      const compactResult = await maybeCompact(
        this.deps.client,
        this.deps.model,
        messages,
        abortSignal,
      )

      if (compactResult.compacted) {
        messages.length = 0
        messages.push(...compactResult.messages)
        this.deps.renderer.compactDone(
          compactResult.originalTokens,
          compactResult.summaryTokens,
        )
        this.deps.eventLog?.append('context_compact', 'engine', {
          tokens_after: compactResult.summaryTokens,
          reduction: compactResult.originalTokens - compactResult.summaryTokens,
        })
        this.consecutiveCompactFailures = 0
        this.suppressCompactWarning = true
        this.deps.hookRunner?.runOnContextOverflow?.(
          compactResult.originalTokens,
          compactResult.summaryTokens,
        )
      } else {
        this.consecutiveCompactFailures++
        if (this.consecutiveCompactFailures >= 3) {
          this.deps.renderer.warn(
            `Auto-compact failed ${this.consecutiveCompactFailures} consecutive times — skipping further attempts. Consider starting a new session.`,
          )
        }
      }
    }
  }

  // ── Snip management ────────────────────────────────────────────────────

  queueSnip(keepRecent: number): void {
    if (typeof keepRecent === 'number' && keepRecent >= 0) {
      this.pendingSnipCount = Math.floor(keepRecent)
    }
  }

  applySnip(
    messages: OpenAIMessage[],
    keepRecent: number,
    reason?: string,
  ): { removed: number; tokensFreed: number } {
    const total = messages.length
    const removeCount = Math.max(0, total - keepRecent)
    if (removeCount === 0) {
      return { removed: 0, tokensFreed: 0 }
    }

    const tokensBefore = estimateTokens(messages)
    const kept = messages.slice(-keepRecent)
    const boundary: OpenAIMessage = {
      role: 'user',
      content:
        `[snip] ${removeCount} older messages were removed to free context space` +
        (reason ? ` (${reason})` : '') +
        '. Continue working from the current context — earlier details are no longer available.',
    }

    messages.length = 0
    messages.push(boundary, ...kept)

    const tokensAfter = estimateTokens(messages)

    this.deps.eventLog?.append('context_compact', 'snip', {
      type: 'manual_snip',
      removed: removeCount,
      tokens_before: tokensBefore,
      tokens_after: tokensAfter,
      tokens_freed: tokensBefore - tokensAfter,
      reason: reason ?? null,
    })

    return { removed: removeCount, tokensFreed: tokensBefore - tokensAfter }
  }

  consumeQueuedSnip(messages: OpenAIMessage[]): void {
    if (this.pendingSnipCount !== null) {
      const queuedKeep = this.pendingSnipCount
      this.pendingSnipCount = null
      this.applySnip(messages, queuedKeep, 'queued via /snip')
    }
  }

  // ── Reactive compact (overflow recovery) ───────────────────────────────

  /**
   * Attempt compaction after a context-overflow API error.
   * Mutates messages in place on success. Returns true if compacted.
   */
  async reactiveCompact(messages: OpenAIMessage[], abortSignal: AbortSignal): Promise<boolean> {
    const compactResult = await maybeCompact(
      this.deps.client,
      this.deps.model,
      messages,
      abortSignal,
    )
    if (compactResult.compacted) {
      messages.length = 0
      messages.push(...compactResult.messages)
      this.deps.renderer.compactDone(compactResult.originalTokens, compactResult.summaryTokens)
      return true
    }
    return false
  }

  // ── Tool result budget ─────────────────────────────────────────────────

  truncateToolResult(result: string): string {
    return truncateToolResult(result, this.deps.sessionDir)
  }

  enforceAggregateBudget(
    results: Array<{ content: string; tc: { id: string; name: string } }>,
  ): void {
    enforceAggregateToolResultBudget(results, this.deps.sessionDir)
  }
}
