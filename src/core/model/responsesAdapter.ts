import type OpenAI from 'openai'
import type { ToolDefinition } from '../types.js'
import type { ProviderAdapter, ProviderStreamRequest } from './providerAdapter.js'

type ResponseEvent = Record<string, unknown>

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' ? value as Record<string, unknown> : undefined
}

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function contentText(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content.map((part) => {
    if (typeof part === 'string') return part
    const value = record(part)
    if (typeof value?.text === 'string') return value.text
    return ''
  }).join('')
}

function responseInput(messages: ProviderStreamRequest['messages']): OpenAI.Responses.ResponseInput {
  const input: OpenAI.Responses.ResponseInputItem[] = []
  for (const message of messages) {
    if (message.role === 'system' || message.role === 'developer') {
      // Keep array-carried system messages: the coordinator prepends
      // runtime control messages ([runtime control · …]) this way —
      // dropping them voids the control-message contract on this
      // transport. `instructions` alone is not enough.
      input.push({ role: message.role, content: contentText(message.content) })
      continue
    }
    if (message.role === 'tool') {
      input.push({
        type: 'function_call_output',
        call_id: message.tool_call_id,
        output: contentText(message.content),
      })
      continue
    }
    if (message.role === 'assistant' && message.tool_calls?.length) {
      const text = contentText(message.content)
      if (text) input.push({ role: 'assistant', content: text })
      for (const call of message.tool_calls) {
        if (call.type !== 'function') continue
        input.push({
          type: 'function_call',
          call_id: call.id,
          name: call.function.name,
          arguments: call.function.arguments,
        })
      }
      continue
    }
    if (message.role === 'function') {
      // Legacy chat-completions-only role: no producer in this codebase,
      // and Responses has no valid item for it without a paired
      // function_call. Surface the text as a user message rather than
      // dropping it or sending an item the API would 400.
      input.push({ role: 'user', content: contentText(message.content) })
      continue
    }
    input.push({ role: message.role, content: contentText(message.content) })
  }
  return input
}

function responseTools(tools: ToolDefinition[]): OpenAI.Responses.Tool[] {
  return tools.map((tool) => ({
    type: 'function',
    name: tool.function.name,
    description: tool.function.description,
    parameters: tool.function.parameters,
    strict: false,
  }))
}

function chatChunk(delta: Record<string, unknown>, finishReason: string | null = null): OpenAI.Chat.ChatCompletionChunk {
  return {
    id: 'responses-stream',
    created: Math.floor(Date.now() / 1000),
    model: '',
    object: 'chat.completion.chunk',
    choices: [{ index: 0, delta, finish_reason: finishReason, logprobs: null }],
  } as OpenAI.Chat.ChatCompletionChunk
}

async function* translateResponseStream(stream: AsyncIterable<unknown>): AsyncIterable<OpenAI.Chat.ChatCompletionChunk> {
  const callIndexes = new Map<string, number>()
  let nextCallIndex = 0
  let hasToolCalls = false

  for await (const raw of stream) {
    const event = raw as ResponseEvent
    const type = typeof event.type === 'string' ? event.type : ''
    if (type === 'response.output_text.delta' && typeof event.delta === 'string') {
      yield chatChunk({ content: event.delta })
      continue
    }
    if (type === 'response.reasoning_summary_text.delta' && typeof event.delta === 'string') {
      yield chatChunk({ reasoning_content: event.delta })
      continue
    }
    if (type === 'response.output_item.added') {
      const item = record(event.item)
      if (item?.type !== 'function_call') continue
      const key = stringValue(item.id) || stringValue(item.call_id) || String(nextCallIndex)
      const index = nextCallIndex++
      callIndexes.set(key, index)
      const callId = stringValue(item.call_id)
      if (callId) callIndexes.set(callId, index)
      hasToolCalls = true
      yield chatChunk({
        tool_calls: [{
          index,
          id: callId || stringValue(item.id),
          type: 'function',
          function: { name: stringValue(item.name), arguments: stringValue(item.arguments) },
        }],
      })
      continue
    }
    if (type === 'response.function_call_arguments.delta' && typeof event.delta === 'string') {
      const key = stringValue(event.item_id) || stringValue(event.call_id)
      const index = callIndexes.get(key)
      // Unknown id (relay omitted output_item.added, or reordered events):
      // appending to index 0 would merge two parallel calls' JSON into one
      // broken argument string — drop the fragment instead.
      if (index === undefined) continue
      yield chatChunk({ tool_calls: [{ index, function: { arguments: event.delta } }] })
      continue
    }
    if (type === 'response.completed' || type === 'response.incomplete') {
      // Chat-completions parity: `response.incomplete` (e.g. max_output_tokens
      // truncation) maps to finish_reason 'length', not a stream failure — a
      // truncated turn stays usable for the completion contract to judge.
      const response = record(event.response)
      const usage = record(response?.usage)
      const details = record(usage?.input_tokens_details)
      const finished = hasToolCalls ? 'tool_calls' : type === 'response.incomplete' ? 'length' : 'stop'
      const chunk = chatChunk({}, finished)
      chunk.usage = {
        prompt_tokens: Number(usage?.input_tokens ?? 0),
        completion_tokens: Number(usage?.output_tokens ?? 0),
        total_tokens: Number(usage?.total_tokens ?? 0),
        prompt_tokens_details: { cached_tokens: Number(details?.cached_tokens ?? 0), audio_tokens: 0 },
        completion_tokens_details: { reasoning_tokens: 0, audio_tokens: 0, accepted_prediction_tokens: 0, rejected_prediction_tokens: 0 },
      }
      yield chunk
      continue
    }
    if (type === 'error' || type === 'response.failed' || type === 'response.cancelled') {
      const response = record(event.response)
      const error = record(event.error) ?? record(response?.error)
      throw new Error(stringValue(error?.message) || `OpenAI Responses API stream ended with ${type}`)
    }
  }
}

export class OpenAIResponsesAdapter implements ProviderAdapter {
  readonly providerId = 'openai' as const
  readonly streamUsageSupported = true

  constructor(private readonly client: OpenAI) {}

  resetStreamUsageLatch(): void {}

  markStreamUsageUnsupported(): void {}

  async stream(req: ProviderStreamRequest): Promise<AsyncIterable<OpenAI.Chat.ChatCompletionChunk>> {
    // Mirror buildReasoningParams' openai-effort semantics: enabled:false
    // omits reasoning entirely (OpenAI models can't turn it off via the
    // body), and budgetTokens is effort-flavor only.
    const reasoning = req.reasoning?.enabled === false
      ? undefined
      : req.reasoning?.effort
        ? { effort: req.reasoning.effort }
        : undefined
    const stream = await this.client.responses.create({
      model: req.model,
      instructions: req.systemPrompt,
      input: responseInput(req.messages),
      tools: req.tools.length ? responseTools(req.tools) : undefined,
      tool_choice: req.tools.length ? 'auto' : undefined,
      max_output_tokens: req.maxOutputTokens,
      temperature: req.temperature,
      reasoning,
      stream: true,
    }, { signal: req.signal })
    return translateResponseStream(stream)
  }
}
