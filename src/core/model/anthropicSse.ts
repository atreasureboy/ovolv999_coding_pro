/**
 * Anthropic request body builder + OpenAI ChatCompletionChunk translator.
 *
 * R8: the SSE parser itself was replaced with `@anthropic-ai/sdk`'s
 * built-in event stream (`client.messages.stream()`). We keep only the
 * two pieces that don't ship in any SDK:
 *
 *   1. `buildAnthropicRequest()` — translates OpenAI ChatCompletionRequest
 *      fields (systemPrompt, tools, maxTokens, temperature) into the
 *      Anthropic Messages API shape, with optional providerOptions for
 *      prompt caching + extended thinking.
 *   2. `AnthropicChunkTranslator` — translates SDK `MessageStreamEvent`s
 *      into OpenAI `ChatCompletionChunk` so the existing StreamConsumer
 *      doesn't change.
 *
 * Note: `extractAnthropicBetaHeaders()` is also kept here because it
 * decides which `anthropic-beta:` header to add to the request (the
 * SDK doesn't expose a clean way to override this from outside).
 */

import Anthropic from '@anthropic-ai/sdk'
import type OpenAI from 'openai'

export type AnthropicEvent =
  | { type: 'message_start'; message: { id: string; type: string; role: string; content: unknown[]; model: string; stop_reason: string | null; usage?: { input_tokens: number; output_tokens: number } } }
  | { type: 'content_block_start'; index: number; content_block: { type: string; id?: string; name?: string; input?: unknown; text?: string } }
  | { type: 'content_block_delta'; index: number; delta: { type: 'text_delta'; text: string } | { type: 'input_json_delta'; partial_json: string } | { type: 'thinking_delta'; thinking: string } | { type: 'signature_delta'; signature: string } }
  | { type: 'content_block_stop'; index: number }
  | { type: 'message_delta'; delta: { stop_reason: string | null; stop_sequence: string | null }; usage?: { output_tokens: number } }
  | { type: 'message_stop' }
  | { type: 'ping' }
  | { type: 'error'; error: { type: string; message: string } }

export interface AnthropicProviderOptions {
  anthropicBeta?: string[]
  cacheSystem?: boolean
  cacheTools?: boolean
  thinkingBudget?: number
}

interface ToolAccumulator {
  id: string
  name: string
  args: string
  sentInitialChunk: boolean
}

export function buildAnthropicRequest(input: {
  model: string
  systemPrompt: string
  messages: Array<{ role: 'user' | 'assistant'; content: string | Array<Record<string, unknown>> }>
  tools: Array<{ type: 'function'; function: { name: string; description?: string; parameters?: Record<string, unknown> } }>
  maxTokens: number
  temperature?: number
  providerOptions?: AnthropicProviderOptions
}): Anthropic.MessageCreateParamsNonStreaming {
  const anthropicTools: Anthropic.Tool[] = (input.tools ?? []).map((tool, idx, all) => {
    const isLast = idx === all.length - 1
    const t: Anthropic.Tool = {
      name: tool.function.name,
      description: tool.function.description ?? '',
      input_schema: (tool.function.parameters ?? { type: 'object', properties: {} }) as Anthropic.Tool.InputSchema,
    }
    if (isLast && input.providerOptions?.cacheTools) {
      return { ...t, cache_control: { type: 'ephemeral' } } as Anthropic.Tool
    }
    return t
  })

  const systemBlocks: Anthropic.MessageCreateParamsNonStreaming['system'] = input.providerOptions?.cacheSystem
    ? [{ type: 'text', text: input.systemPrompt, cache_control: { type: 'ephemeral' } } as Anthropic.TextBlockParam]
    : input.systemPrompt

  const params: Anthropic.MessageCreateParamsNonStreaming = {
    model: input.model,
    system: systemBlocks,
    messages: input.messages.map((m) => ({
      role: m.role,
      content: m.content as Anthropic.MessageParam['content'],
    })),
    tools: anthropicTools,
    max_tokens: input.maxTokens,
    temperature: input.temperature,
  }

  if (input.providerOptions?.thinkingBudget && input.providerOptions.thinkingBudget > 0) {
    (params as { thinking?: unknown }).thinking = {
      type: 'enabled',
      budget_tokens: input.providerOptions.thinkingBudget,
    }
  }

  return params
}

export function extractAnthropicBetaHeaders(providerOptions?: AnthropicProviderOptions): string[] {
  if (!providerOptions?.anthropicBeta || providerOptions.anthropicBeta.length === 0) return []
  if (providerOptions.thinkingBudget && providerOptions.thinkingBudget > 0
    && !providerOptions.anthropicBeta.some((b) => b.includes('thinking'))) {
    return [...providerOptions.anthropicBeta, 'extended-thinking-2025-01-01']
  }
  return providerOptions.anthropicBeta
}

/**
 * Translate Anthropic SDK `MessageStreamEvent`s into OpenAI
 * `ChatCompletionChunk`s. Maintains tool-call accumulator state per
 * stream index and emits synthetic OpenAI delta chunks.
 *
 * Kept for backward compatibility — the AnthropicAdapter still feeds
 * events through this translator so StreamConsumer doesn't change.
 */
export class AnthropicChunkTranslator {
  private readonly chunks: OpenAI.Chat.ChatCompletionChunk[] = []
  private readonly toolAccumulators = new Map<number, ToolAccumulator>()
  private readonly modelId: string
  private inputTokens = 0
  private outputTokens = 0
  private finishReason: string | null = null
  private readonly created: number

  constructor(modelId: string) {
    this.modelId = modelId
    this.created = Math.floor(Date.now() / 1000)
  }

  push(event: AnthropicEvent): OpenAI.Chat.ChatCompletionChunk[] {
    const out: OpenAI.Chat.ChatCompletionChunk[] = []
    switch (event.type) {
      case 'message_start': {
        this.inputTokens = event.message.usage?.input_tokens ?? 0
        if (event.message.usage?.output_tokens) {
          this.outputTokens = event.message.usage.output_tokens
        }
        break
      }
      case 'content_block_start': {
        if (event.content_block.type === 'tool_use') {
          const acc: ToolAccumulator = {
            id: event.content_block.id ?? `toolu_${event.index}`,
            name: event.content_block.name ?? '',
            args: '',
            sentInitialChunk: false,
          }
          this.toolAccumulators.set(event.index, acc)
          out.push(this.makeChunk({
            choices: [{
              index: 0,
              delta: {
                tool_calls: [{
                  index: event.index,
                  id: acc.id,
                  type: 'function',
                  function: { name: acc.name, arguments: '' },
                }],
              },
            }],
          }))
          acc.sentInitialChunk = true
        }
        break
      }
      case 'content_block_delta': {
        const delta = event.delta
        if (delta.type === 'text_delta') {
          out.push(this.makeChunk({
            choices: [{
              index: 0,
              delta: { content: delta.text },
            }],
          }))
        } else if (delta.type === 'input_json_delta') {
          const acc = this.toolAccumulators.get(event.index)
          if (acc) {
            acc.args += delta.partial_json
            out.push(this.makeChunk({
              choices: [{
                index: 0,
                delta: {
                  tool_calls: [{
                    index: event.index,
                    function: { arguments: delta.partial_json },
                  }],
                },
              }],
            }))
          }
        }
        break
      }
      case 'message_delta': {
        if (event.delta.stop_reason) this.finishReason = event.delta.stop_reason
        if (event.usage?.output_tokens) this.outputTokens += event.usage.output_tokens
        break
      }
      case 'message_stop': {
        out.push(this.makeChunk({
          choices: [{
            index: 0,
            delta: {},
            finish_reason: this.mapFinishReason(this.finishReason),
          }],
          usage: this.outputTokens > 0
            ? {
                prompt_tokens: this.inputTokens,
                completion_tokens: this.outputTokens,
                total_tokens: this.inputTokens + this.outputTokens,
              }
            : undefined,
        }))
        break
      }
      default:
        break
    }
    this.chunks.push(...out)
    return out
  }

  private makeChunk(payload: {
    choices: Array<{ index: number; delta: Record<string, unknown>; finish_reason?: string }>
    usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number }
  }): OpenAI.Chat.ChatCompletionChunk {
    const chunk: OpenAI.Chat.ChatCompletionChunk = {
      id: `chatcmpl-${Date.now().toString(36)}`,
      object: 'chat.completion.chunk',
      created: this.created,
      model: this.modelId,
      choices: payload.choices.map((c) => ({
        index: c.index,
        delta: c.delta,
        finish_reason: c.finish_reason as OpenAI.Chat.ChatCompletionChunk.Choice['finish_reason'],
        logprobs: null,
      })),
    }
    if (payload.usage) {
      chunk.usage = {
        prompt_tokens: payload.usage.prompt_tokens,
        completion_tokens: payload.usage.completion_tokens,
        total_tokens: payload.usage.total_tokens,
      }
    }
    return chunk
  }

  private mapFinishReason(reason: string | null): string {
    switch (reason) {
      case 'end_turn':
      case 'stop_sequence':
        return 'stop'
      case 'max_tokens':
        return 'length'
      case 'tool_use':
        return 'tool_calls'
      case null:
      case undefined:
        return 'stop'
      default:
        return 'stop'
    }
  }

  finalizeWithUsage(usage: { inputTokens?: number; outputTokens?: number } | undefined): OpenAI.Chat.ChatCompletionChunk {
    const inputTokens = usage?.inputTokens ?? this.inputTokens
    const outputTokens = usage?.outputTokens ?? this.outputTokens
    const chunk = this.makeChunk({
      choices: [{
        index: 0,
        delta: {},
        finish_reason: this.mapFinishReason(this.finishReason ?? 'end_turn'),
      }],
      usage: {
        prompt_tokens: inputTokens,
        completion_tokens: outputTokens,
        total_tokens: inputTokens + outputTokens,
      },
    })
    this.chunks.push(chunk)
    return chunk
  }
}

export { Anthropic }

export function buildAssistantMessageToAnthropicContent(
  text: string | null,
  toolCalls: Array<{ id: string; name: string; arguments: string }>,
): Array<Record<string, unknown>> {
  const blocks: Array<Record<string, unknown>> = []
  if (text) blocks.push({ type: 'text', text })
  for (const tc of toolCalls) {
    let input: unknown = {}
    try { input = JSON.parse(tc.arguments || '{}') } catch { input = {} }
    blocks.push({ type: 'tool_use', id: tc.id, name: tc.name, input })
  }
  return blocks
}

export function toolResultToAnthropicUserBlock(toolCallId: string, content: string, isError: boolean): Record<string, unknown> {
  return {
    type: 'tool_result',
    tool_use_id: toolCallId,
    content,
    is_error: isError,
  }
}
