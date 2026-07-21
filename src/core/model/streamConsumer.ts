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
import type { Renderer } from '../../ui/renderer.js'

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
  } | null
}

const STREAM_TIMEOUT_MS = 120_000

export interface StreamConsumerDeps {
  renderer: Renderer
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

    try {
      for await (const chunk of stream) {
        if (turnAbortSignal.aborted) break

        lastChunkTime = Date.now()

        if (chunk.usage) {
          usage = {
            inputTokens: chunk.usage.prompt_tokens,
            outputTokens: chunk.usage.completion_tokens,
          }
        }

        const delta = chunk.choices[0]?.delta
        if (!delta) continue

        if (delta.content) {
          const visibleContent = thinkingTagFilter.push(delta.content)
          const thinkingContent = thinkingTagFilter.drainThinking()
          if (thinkingContent) {
            this.deps.renderer.streamReasoning?.(thinkingContent)
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
    ).map((tc) => {
      if (!tc.id) {
        tc.id = `call_${randomUUID()}`
      }
      return tc
    })

    return { assistantText, finishReason, rawToolCalls, usage }
  }
}
