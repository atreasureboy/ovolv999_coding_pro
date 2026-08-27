/**
 * StreamConsumer — consumes streaming LLM responses, accumulating text
 * and tool calls. Extracted from engine.ts to isolate stream parsing
 * from the run loop.
 *
 * Responsibilities:
 * - thinking/reasoning content separation (via ThinkingTagFilter)
 * - assistant text aggregation
 * - tool_call incremental argument aggregation
 * - missing tool call ID synthesis (vLLM/Ollama compat)
 * - finish reason and usage extraction
 * - stream stall watchdog
 *
 * State ownership: none persistent — each consume() call is independent.
 * The ThinkingTagFilter is per-call.
 */

import type OpenAI from 'openai'
import { randomUUID } from 'crypto'
import { ThinkingTagFilter } from '../thinkingTagFilter.js'
import type { RendererInterface } from '../types.js'
import type { EventLog } from '../eventLog.js'

/**
 * StreamResult — the normalized output of consuming a streaming LLM
 * response. Produced by StreamConsumer, consumed by ModelGateway.
 */
export interface StreamResult {
  assistantText: string
  finishReason: string | null
  rawToolCalls: Array<{
    index: number
    id: string
    name: string
    arguments: string
  }>
  usage: {
    inputTokens: number
    outputTokens: number
    /** Input tokens served from the provider prompt cache (Anthropic
     *  cache_read_input_tokens / OpenAI prompt_tokens_details.cached_tokens).
     *  inputTokens is the TOTAL including these. */
    cacheReadTokens?: number
    /** Tokens written to the provider cache this call (Anthropic
     *  cache_creation_input_tokens; billed at a premium). */
    cacheWriteTokens?: number
  } | null
  /**
   * Round 42 (reasoning translation layer): reasoning text accumulated
   * from reasoning_content / reasoning / thinking deltas. Attached to the
   * assistant message as `reasoningContent`; replayed only for flavors
   * that require it (DeepSeek R1), stripped otherwise — see
   * normalizeHistoryForRequest.
   */
  reasoningText?: string
}

const STREAM_TIMEOUT_MS = 120_000

export interface StreamConsumerDeps {
  renderer: RendererInterface
  /** v0.4.1 C1: structured record for stream-protocol anomalies. */
  eventLog?: EventLog
}

export class StreamConsumer {
  private readonly deps: StreamConsumerDeps

  constructor(deps: StreamConsumerDeps) {
    this.deps = deps
  }

  /**
   * Consume a streaming response. Returns accumulated text, tool calls,
   * finish reason, and usage.
   *
   * The `turnAbortController` is used for watchdog-based force-abort on
   * stream stall. The `turnAbortSignal` is checked per-chunk for early exit.
   */
  async consume(
    stream: AsyncIterable<OpenAI.Chat.ChatCompletionChunk>,
    turnAbortSignal: AbortSignal,
    turnAbortController: AbortController | null,
  ): Promise<StreamResult> {
    let assistantText = ''
    /** Round 42: normalized reasoning accumulated from the stream. */
    let reasoningText = ''
    let finishReason: string | null = null
    let usage: StreamResult['usage'] = null
    const toolCallsMap = new Map<number, { index: number; id: string; name: string; arguments: string }>()
    const thinkingTagFilter = new ThinkingTagFilter()
    let firstToken = true

    let lastChunkTime = Date.now()

    const watchdog = setInterval(() => {
      if (Date.now() - lastChunkTime > STREAM_TIMEOUT_MS) {
        if (turnAbortController) {
          turnAbortController.abort('stream_timeout')
        }
      }
    }, 10_000)
    // R23: unref so the watchdog cannot keep the event loop alive if the
    // SDK's async iterator doesn't promptly honor the abort (the exact hang
    // it detects). Matches agent.ts:1062 / loopSupervisor.ts:204.
    if (typeof watchdog.unref === 'function') watchdog.unref()

    try {
      for await (const chunk of stream) {
        if (turnAbortSignal.aborted) break

        lastChunkTime = Date.now()

        if (chunk.usage) {
          // Prompt-cache accounting (Round 27): cached_tokens (OpenAI
          // convention, also emitted by our Anthropic translator) +
          // cache_creation_input_tokens (Anthropic write-side, non-standard
          // extra). Read defensively — OpenAI-compatible backends may omit
          // the details object entirely.
          const u = chunk.usage as unknown as {
            prompt_tokens?: number
            completion_tokens?: number
            prompt_tokens_details?: { cached_tokens?: number }
            cache_creation_input_tokens?: number
          }
          const details = u.prompt_tokens_details
          usage = {
            inputTokens: u.prompt_tokens ?? 0,
            outputTokens: u.completion_tokens ?? 0,
            ...(details?.cached_tokens ? { cacheReadTokens: details.cached_tokens } : {}),
            ...(u.cache_creation_input_tokens ? { cacheWriteTokens: u.cache_creation_input_tokens } : {}),
          }
        }

        const delta = chunk.choices[0]?.delta
        if (!delta) continue

        if (delta.content) {
          const visibleContent = thinkingTagFilter.push(delta.content)
          const thinkingContent = thinkingTagFilter.drainThinking()
          if (thinkingContent) {
            this.deps.renderer.streamReasoning?.(thinkingContent)
            reasoningText += thinkingContent
          }
          if (visibleContent) {
            if (firstToken) {
              this.deps.renderer.stopSpinner()
              this.deps.renderer.beginAssistantText()
              firstToken = false
            }
            this.deps.renderer.streamToken(visibleContent)
            assistantText += visibleContent
          }
        }

        // Round 42 (reasoning translation layer): vendor reasoning deltas
        // arrive normalized as reasoning_content (withReasoningNormali­
        // zation upstream). Render them as reasoning and accumulate for
        // history replay (DeepSeek R1 requires it on the next request).
        const reasoningDelta = (delta as Record<string, unknown>).reasoning_content
        if (typeof reasoningDelta === 'string' && reasoningDelta.length > 0) {
          this.deps.renderer.streamReasoning?.(reasoningDelta)
          reasoningText += reasoningDelta
        }

        if (delta.tool_calls) {
          for (const tc of delta.tool_calls) {
            const idx = tc.index
            if (!toolCallsMap.has(idx)) {
              toolCallsMap.set(idx, { index: idx, id: '', name: '', arguments: '' })
            }
            const acc = toolCallsMap.get(idx)!
            if (tc.id) acc.id = tc.id
            if (tc.function?.name) acc.name += tc.function.name
            if (tc.function?.arguments) acc.arguments += tc.function.arguments
          }
        }

        if (chunk.choices[0]?.finish_reason) {
          finishReason = chunk.choices[0].finish_reason
        }
      }

      const trailingContent = thinkingTagFilter.finish()
      const trailingThinking = thinkingTagFilter.drainThinking()
      if (trailingThinking) {
        this.deps.renderer.streamReasoning?.(trailingThinking)
      }
      if (trailingContent) {
        if (firstToken) {
          this.deps.renderer.stopSpinner()
          this.deps.renderer.beginAssistantText()
          firstToken = false
        }
        this.deps.renderer.streamToken(trailingContent)
        assistantText += trailingContent
      }
    } catch (err) {
      clearInterval(watchdog)
      this.deps.renderer.stopSpinner()
      throw err
    }

    clearInterval(watchdog)
    this.deps.renderer.stopSpinner()

    if (
      turnAbortSignal.aborted &&
      !finishReason &&
      turnAbortSignal.reason === 'stream_timeout'
    ) {
      throw new Error('Stream timed out — no data received for 120s')
    }

    if (assistantText) {
      this.deps.renderer.endAssistantText()
    }

    const rawToolCalls = Array.from(toolCallsMap.values()).sort(
      (a, b) => a.index - b.index,
    )
    // v0.4.1 C1 (callId truth): missing ids are synthesized — the documented
    // vLLM/Ollama compat contract, silently for the SINGLE-missing case. But
    // when a response carries MULTIPLE id-less tool calls, tool_result→call
    // attribution is unrecoverable: record it structurally (EventLog
    // protocol_error), warn visibly once per offending model call, and NEVER
    // fail the turn — the model's work still executes.
    let missingIds = 0
    for (const tc of rawToolCalls) {
      if (!tc.id) {
        missingIds++
        tc.id = `call_${randomUUID()}`
      }
    }
    if (rawToolCalls.length > 1 && missingIds >= 2) {
      this.deps.eventLog?.append('protocol', 'protocol_error', {
        kind: 'multiple_missing_tool_call_ids',
        toolCalls: rawToolCalls.length,
        missingIds,
      })
      this.deps.renderer.warn?.(
        `Stream protocol: ${missingIds}/${rawToolCalls.length} tool calls arrived without ids — their results may render as unattributed (provider quirk, the turn continues).`,
      )
    }

    return { assistantText, finishReason, rawToolCalls, usage, reasoningText: reasoningText || undefined }
  }
}
