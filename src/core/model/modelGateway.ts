/**
 * ModelGateway — owns LLM API calls, streaming establishment, retry,
 * and provider compatibility. Extracted from engine.ts to isolate model
 * communication from the run loop.
 *
 * Responsibilities:
 * - Build and send chat completion requests
 * - stream_options.include_usage detection + fallback
 * - Reactive compaction on context-overflow errors (via callback)
 * - Usage recording (via callback)
 * - Stall timeout (via StreamConsumer watchdog)
 *
 * Does NOT decide what the agent does next. The coordinator drives
 * iteration; ModelGateway just sends requests and returns results.
 */

import type OpenAI from 'openai'
import type { OpenAIMessage, ToolDefinition } from '../types.js'
import type { TokenUsage } from '../costTracker.js'
import type { Renderer } from '../../ui/renderer.js'
import { StreamConsumer, type StreamResult } from './streamConsumer.js'

export interface ModelGatewayDeps {
  client: OpenAI
  renderer: Renderer
  streamConsumer?: StreamConsumer
}

export interface ModelCallParams {
  systemPrompt: string
  messages: OpenAIMessage[]
  toolDefs: ToolDefinition[]
  model: string
  temperature?: number
  maxOutputTokens: number
  abortSignal: AbortSignal
  /** The abort controller for watchdog-based force-abort on stream stall */
  turnAbortController: AbortController | null
}

export interface ModelGatewayCallbacks {
  /** Called after a successful API call with usage data */
  onUsage?: (usage: TokenUsage | null, callStartMs: number) => void
  /** Called when a context overflow error is detected. Should compact messages and return true on success. */
  onContextOverflow?: (messages: OpenAIMessage[], abortSignal: AbortSignal) => Promise<boolean>
}

export class ModelGateway {
  private readonly client: OpenAI
  private readonly renderer: Renderer
  private readonly streamConsumer: StreamConsumer
  private _streamUsageSupported = true

  constructor(deps: ModelGatewayDeps) {
    this.client = deps.client
    this.renderer = deps.renderer
    this.streamConsumer = deps.streamConsumer ?? new StreamConsumer({ renderer: this.renderer })
  }

  get streamUsageSupported(): boolean {
    return this._streamUsageSupported
  }

  markStreamUsageUnsupported(): void {
    this._streamUsageSupported = false
  }

  async call(
    params: ModelCallParams,
    callbacks?: ModelGatewayCallbacks,
  ): Promise<StreamResult> {
    const { systemPrompt, messages, toolDefs, model, temperature, maxOutputTokens, abortSignal, turnAbortController } = params

    this.renderer.startSpinner()
    const callStartMs = Date.now()

    let stream: AsyncIterable<OpenAI.Chat.ChatCompletionChunk>
    try {
      stream = await this.client.chat.completions.create(
        {
          model,
          messages: [
            { role: 'system', content: systemPrompt },
            ...(messages as OpenAI.Chat.ChatCompletionMessageParam[]),
          ],
          tools: toolDefs.length > 0 ? toolDefs : undefined,
          tool_choice: toolDefs.length > 0 ? 'auto' : undefined,
          temperature: temperature ?? 0,
          max_tokens: maxOutputTokens,
          stream: true,
          ...(this._streamUsageSupported ? { stream_options: { include_usage: true } } : {}),
        },
        { signal: abortSignal },
      )
    } catch (err: unknown) {
      this.renderer.stopSpinner()

      const errMsg = (err as Error).message || ''

      if (errMsg.includes('stream_options') || errMsg.includes('stream_options is not supported')) {
        this._streamUsageSupported = false
        stream = await this.client.chat.completions.create(
          {
            model,
            messages: [
              { role: 'system', content: systemPrompt },
              ...(messages as OpenAI.Chat.ChatCompletionMessageParam[]),
            ],
            tools: toolDefs,
            tool_choice: 'auto',
            temperature: temperature ?? 0,
            max_tokens: maxOutputTokens,
            stream: true,
          },
          { signal: abortSignal },
        )
        const result = await this.streamConsumer.consume(stream, abortSignal, turnAbortController)
        callbacks?.onUsage?.(result.usage, callStartMs)
        return result
      }

      if (this.isContextOverflowError(errMsg) && callbacks?.onContextOverflow) {
        this.renderer.warn('Context too long — auto-compacting and retrying...')
        const compacted = await callbacks.onContextOverflow(messages, abortSignal)
        if (compacted) {
          stream = await this.client.chat.completions.create(
            {
              model,
              messages: [
                { role: 'system', content: systemPrompt },
                ...(messages as OpenAI.Chat.ChatCompletionMessageParam[]),
              ],
              tools: toolDefs.length > 0 ? toolDefs : undefined,
              tool_choice: toolDefs.length > 0 ? 'auto' : undefined,
              temperature: temperature ?? 0,
              max_tokens: maxOutputTokens,
              stream: true,
              ...(this._streamUsageSupported ? { stream_options: { include_usage: true } } : {}),
            },
            { signal: abortSignal },
          )
          const result = await this.streamConsumer.consume(stream, abortSignal, turnAbortController)
          callbacks?.onUsage?.(result.usage, callStartMs)
          return result
        }
      }

      throw err
    }

    const result = await this.streamConsumer.consume(stream, abortSignal, turnAbortController)
    callbacks?.onUsage?.(result.usage, callStartMs)
    return result
  }

  private isContextOverflowError(errMsg: string): boolean {
    return (
      errMsg.includes('context_length_exceeded') ||
      errMsg.includes('maximum context length') ||
      /context[\s_-]{0,80}(?:is\s+)?too\s+long/i.test(errMsg) ||
      /too\s+long[\s_-]{0,80}(?:context|tokens?|input|window|limit)/i.test(errMsg)
    )
  }
}
