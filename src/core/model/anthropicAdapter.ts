/**
 * AnthropicAdapter — R8: now uses @anthropic-ai/sdk directly.
 *
 * We translate Anthropic SDK's `MessageStreamEvent`s into OpenAI's
 * `ChatCompletionChunk` shape so the existing StreamConsumer doesn't
 * change. Beta headers (prompt caching, extended thinking) are
 * forwarded via providerOptions.
 */

import type OpenAI from 'openai'
import Anthropic from '@anthropic-ai/sdk'
import type { ProviderAdapter, ProviderStreamRequest } from './providerAdapter.js'
import {
  AnthropicChunkTranslator,
  buildAnthropicRequest,
  extractAnthropicBetaHeaders,
  type AnthropicProviderOptions,
} from './anthropicSse.js'

export interface AnthropicAdapterConfig {
  apiKey: string
  baseURL?: string
  defaultMaxTokens?: number
  apiVersion?: string
}

const ANTHROPIC_DEFAULT_MAX_TOKENS = 8192

export class AnthropicAdapter implements ProviderAdapter {
  readonly providerId = 'anthropic'
  private readonly client: Anthropic
  private readonly defaultMaxTokens: number
  private _streamUsageSupported = true

  constructor(config: AnthropicAdapterConfig) {
    const clientConfig: { apiKey: string; baseURL?: string } = { apiKey: config.apiKey }
    if (config.baseURL) clientConfig.baseURL = config.baseURL
    this.client = new Anthropic(clientConfig)
    this.defaultMaxTokens = config.defaultMaxTokens ?? ANTHROPIC_DEFAULT_MAX_TOKENS
  }

  get streamUsageSupported(): boolean {
    return this._streamUsageSupported
  }

  resetStreamUsageLatch(): void {
    this._streamUsageSupported = true
  }

  markStreamUsageUnsupported(): void {
    this._streamUsageSupported = false
  }

  async stream(req: ProviderStreamRequest): Promise<AsyncIterable<OpenAI.Chat.ChatCompletionChunk>> {
    const providerOptions = (req as ProviderStreamRequest & { providerOptions?: AnthropicProviderOptions }).providerOptions
    const maxTokens = req.maxOutputTokens ?? this.defaultMaxTokens

    const { system, messages } = convertOpenAIMessages(req.messages, req.systemPrompt)
    const params = buildAnthropicRequest({
      model: req.model,
      systemPrompt: system,
      messages: messages,
      tools: req.tools,
      maxTokens,
      temperature: req.temperature,
      providerOptions,
    })

    const betaHeaders = extractAnthropicBetaHeaders(providerOptions)
    const betaHeader = betaHeaders.length > 0 ? betaHeaders.join(',') : undefined

    return this.iterate(params, req.model, req.signal, betaHeader)
  }

  private async *iterate(
    params: ReturnType<typeof buildAnthropicRequest>,
    modelId: string,
    signal: AbortSignal | undefined,
    betaHeader: string | undefined,
  ): AsyncGenerator<OpenAI.Chat.ChatCompletionChunk> {
    const translator = new AnthropicChunkTranslator(modelId)
    try {
      // The Anthropic SDK's MessageCreateParams has no `anthropic_beta` /
      // `betas` field — beta features are selected by sending the
      // `anthropic-beta` HTTP header on the request. The SDK's second
      // argument to `messages.stream` is a Core.RequestOptions that
      // accepts `headers`, so we pass the beta header there instead of
      // mutating the typed params object via a cast. (The prior code
      // attached `anthropic_beta` to params via `as unknown as`, which
      // the SDK silently ignores — the header never reached the wire.)
      const options: { signal?: AbortSignal; headers?: Record<string, string> } = {}
      if (signal) options.signal = signal
      if (betaHeader) options.headers = { 'anthropic-beta': betaHeader }
      const sdkStream = this.client.messages.stream(params, options)
      for await (const event of sdkStream) {
        if (signal?.aborted) {
          sdkStream.controller.abort()
          throw new Error('aborted')
        }
        const translated = translateEvent(event, translator)
        for (const chunk of translated) {
          yield chunk
        }
      }
      const final = translator.finalizeWithUsage(undefined)
      yield final
    } catch (err: unknown) {
      if (signal?.aborted) throw new Error('aborted', { cause: err })
      throw err instanceof Error ? err : new Error(String(err), { cause: err })
    }
  }
}

interface OpenAIToolCall {
  id: string
  type: 'function'
  function: { name: string; arguments: string }
}

 
function isOpenAIToolCall(value: unknown): value is OpenAIToolCall {
  if (!value || typeof value !== 'object') return false
  const obj = value as Record<string, unknown>
  if (obj.type !== 'function') return false
   
  const fn = obj.function
  if (!fn || typeof fn !== 'object') return false
  const fnObj = fn as Record<string, unknown>
  return typeof fnObj.name === 'string' && typeof fnObj.arguments === 'string'
}

function isOpenAITextPart(value: unknown): value is { type: 'text'; text: string } {
  if (!value || typeof value !== 'object') return false
  const obj = value as Record<string, unknown>
  return obj.type === 'text' && typeof obj.text === 'string'
}

function isOpenAIImagePart(value: unknown): value is { type: 'image_url'; image_url: { url: string } } {
  if (!value || typeof value !== 'object') return false
  const obj = value as Record<string, unknown>
  if (obj.type !== 'image_url') return false
  const img = obj.image_url
  if (!img || typeof img !== 'object') return false
  return typeof (img as Record<string, unknown>).url === 'string'
}

function convertOpenAIMessages(
  messages: OpenAI.Chat.ChatCompletionMessageParam[],
  systemPrompt: string,
): { system: string; messages: Array<{ role: 'user' | 'assistant'; content: string | Array<Record<string, unknown>> }> } {
  const converted: Array<{ role: 'user' | 'assistant'; content: string | Array<Record<string, unknown>> }> = []
  for (const msg of messages) {
    const role = (msg as { role: string }).role
    if (role === 'system') continue
    if (role === 'tool') {
      const toolCallId = (msg as { tool_call_id?: string }).tool_call_id
      const content = (msg as { content?: unknown }).content
      const text = typeof content === 'string' ? content : Array.isArray(content)
        ? content.map((p) => isOpenAITextPart(p) ? p.text : '').join('\n')
        : ''
      const isError = (msg as { is_error?: boolean }).is_error === true
      converted.push({
        role: 'user',
        content: [{
          type: 'tool_result',
          tool_use_id: toolCallId ?? '',
          content: text,
          is_error: isError,
        }],
      })
      continue
    }
    if (role === 'user') {
      const content = (msg as { content?: unknown }).content
      if (typeof content === 'string') {
        converted.push({ role: 'user', content })
      } else if (Array.isArray(content)) {
        const blocks: Array<Record<string, unknown>> = []
        for (const part of content) {
          if (isOpenAITextPart(part)) {
            blocks.push({ type: 'text', text: part.text })
          } else if (isOpenAIImagePart(part)) {
            const url = part.image_url.url
            if (url.startsWith('data:')) {
              const match = url.match(/^data:([^;]+);base64,(.+)$/)
              if (match) {
                blocks.push({
                  type: 'image',
                  source: { type: 'base64', media_type: match[1], data: match[2] },
                })
              }
            }
          }
        }
        converted.push({ role: 'user', content: blocks.length > 0 ? blocks : (Array.isArray(content) ? content : []) })
      } else {
        converted.push({ role: 'user', content: '' })
      }
      continue
    }
    if (role === 'assistant') {
      const toolCallsRaw = (msg as { tool_calls?: unknown }).tool_calls
      const toolCalls = Array.isArray(toolCallsRaw) ? toolCallsRaw.filter(isOpenAIToolCall) : []
      const text = (msg as { content?: unknown }).content
      const blocks: Array<Record<string, unknown>> = []
      if (typeof text === 'string' && text) {
        blocks.push({ type: 'text', text })
      }
      for (const tc of toolCalls) {
        let input: unknown = {}
        try { input = JSON.parse(tc.function.arguments || '{}') } catch { /* keep default {} */ }
        blocks.push({
          type: 'tool_use',
          id: tc.id,
          name: tc.function.name,
          input,
        })
      }
      if (blocks.length === 0) {
        converted.push({ role: 'assistant', content: '' })
      } else {
        converted.push({ role: 'assistant', content: blocks })
      }
    }
  }
  return { system: systemPrompt, messages: converted }
}

type AdaptedEvent = Parameters<AnthropicChunkTranslator['push']>[0]

function translateEvent(
  event: Anthropic.MessageStreamEvent,
  translator: AnthropicChunkTranslator,
): OpenAI.Chat.ChatCompletionChunk[] {
  const adapted = adaptEvent(event)
  // adaptEvent returns a Record<string, unknown> shaped to match AnthropicEvent.
  // The cast is a structural narrowing: adaptEvent's switch mirrors the
  // AnthropicEvent union members field-for-field, but TS can't verify the
  // record-to-union correspondence through the generic Record return, so we
  // assert the provenance here at the single push() boundary.
  if (adapted) return translator.push(adapted as unknown as AdaptedEvent)
  return []
}

function adaptEvent(event: Anthropic.MessageStreamEvent): (Record<string, unknown> & { type: string }) | null {
  const e = event as unknown as Record<string, unknown> & { type: string }
  return adaptEventRecord(e)
}

function adaptEventRecord(e: Record<string, unknown> & { type: string }): (Record<string, unknown> & { type: string }) | null {
  switch (e.type) {
    case 'message_start': {
      const m = (e.message ?? {}) as Record<string, unknown>
      const usage = m.usage as { input_tokens?: number; output_tokens?: number } | undefined
      return {
        type: 'message_start',
        message: {
          id: m.id,
          type: 'message',
          role: m.role,
          content: m.content,
          model: m.model,
          stop_reason: m.stop_reason,
          usage: usage ? { input_tokens: usage.input_tokens ?? 0, output_tokens: usage.output_tokens ?? 0 } : undefined,
        },
      }
    }
    case 'content_block_start': {
      const cb = (e.content_block ?? {}) as { type: string; id?: string; name?: string; input?: unknown; text?: string }
      const content_block = cb.type === 'tool_use'
        ? { type: 'tool_use', id: cb.id, name: cb.name, input: cb.input }
        : { type: 'text', text: cb.type === 'text' ? (cb.text ?? '') : '' }
      return { type: 'content_block_start', index: e.index, content_block }
    }
    case 'content_block_delta': {
      const delta = (e.delta ?? {}) as { type?: string; text?: string; partial_json?: string; thinking?: string; signature?: string }
      if (delta.type === 'text_delta') {
        return { type: 'content_block_delta', index: e.index, delta: { type: 'text_delta', text: delta.text ?? '' } }
      }
      if (delta.type === 'input_json_delta') {
        return { type: 'content_block_delta', index: e.index, delta: { type: 'input_json_delta', partial_json: delta.partial_json ?? '' } }
      }
      if (delta.type === 'thinking_delta') {
        return { type: 'content_block_delta', index: e.index, delta: { type: 'thinking_delta', thinking: delta.thinking ?? '' } }
      }
      if (delta.type === 'signature_delta') {
        return { type: 'content_block_delta', index: e.index, delta: { type: 'signature_delta', signature: delta.signature ?? '' } }
      }
      return null
    }
    case 'content_block_stop':
      return { type: 'content_block_stop', index: e.index }
    case 'message_delta': {
      const d = (e.delta ?? {}) as { stop_reason?: string | null; stop_sequence?: string | null }
      const usage = e.usage as { output_tokens?: number } | undefined
      return {
        type: 'message_delta',
        delta: {
          stop_reason: d.stop_reason ?? null,
          stop_sequence: d.stop_sequence ?? null,
        },
        usage: usage ? { output_tokens: usage.output_tokens ?? 0 } : undefined,
      }
    }
    case 'message_stop':
      return { type: 'message_stop' }
    case 'ping':
      return { type: 'ping' }
    case 'error': {
      const err = (e.error ?? {}) as { type: string; message: string }
      return { type: 'error', error: { type: err.type, message: err.message } }
    }
    default:
      return null
  }
}
