import { describe, expect, it } from 'vitest'
import { OpenAIResponsesAdapter } from '../../src/core/model/responsesAdapter.js'

function events(): AsyncIterable<unknown> {
  return (async function* () {
    yield { type: 'response.output_item.added', item: { type: 'function_call', id: 'item_1', call_id: 'call_1', name: 'Read', arguments: '' } }
    yield { type: 'response.function_call_arguments.delta', item_id: 'item_1', delta: '{"file_path":"a.ts"}' }
    yield { type: 'response.completed', response: { usage: { input_tokens: 12, output_tokens: 7, total_tokens: 19, input_tokens_details: { cached_tokens: 3 } } } }
  })()
}

describe('OpenAIResponsesAdapter', () => {
  it('translates Responses requests and streamed function calls', async () => {
    let request: Record<string, unknown> | undefined
    const client = {
      responses: {
        create: async (body: Record<string, unknown>) => {
          request = body
          return events()
        },
      },
    }
    const adapter = new OpenAIResponsesAdapter(client as never)
    const stream = await adapter.stream({
      model: 'gpt-test',
      systemPrompt: 'system',
      messages: [
        { role: 'user', content: 'read it' },
        { role: 'assistant', content: null, tool_calls: [{ id: 'old_call', type: 'function', function: { name: 'Read', arguments: '{"file_path":"old.ts"}' } }] },
        { role: 'tool', tool_call_id: 'old_call', content: 'old contents' },
      ],
      tools: [{ type: 'function', function: { name: 'Read', description: 'Read file', parameters: { type: 'object', properties: {} } } }],
      maxOutputTokens: 100,
      signal: new AbortController().signal,
    })
    const chunks = []
    for await (const chunk of stream) chunks.push(chunk)

    expect(request?.instructions).toBe('system')
    expect(request?.tools).toEqual([{ type: 'function', name: 'Read', description: 'Read file', parameters: { type: 'object', properties: {} }, strict: false }])
    expect(request?.input).toEqual([
      { role: 'user', content: 'read it' },
      { type: 'function_call', call_id: 'old_call', name: 'Read', arguments: '{"file_path":"old.ts"}' },
      { type: 'function_call_output', call_id: 'old_call', output: 'old contents' },
    ])
    expect(chunks[0].choices[0]?.delta.tool_calls?.[0]?.function?.name).toBe('Read')
    expect(chunks[1].choices[0]?.delta.tool_calls?.[0]?.function?.arguments).toBe('{"file_path":"a.ts"}')
    expect(chunks[2].choices[0]?.finish_reason).toBe('tool_calls')
    expect(chunks[2].usage?.prompt_tokens).toBe(12)
  })

  it('translates text and failures', async () => {
    const client = {
      responses: {
        create: async () => (async function* () {
          yield { type: 'response.output_text.delta', delta: 'hello' }
          yield { type: 'response.completed', response: { usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } }
        })(),
      },
    }
    const adapter = new OpenAIResponsesAdapter(client as never)
    const stream = await adapter.stream({
      model: 'gpt-test', systemPrompt: 'system', messages: [], tools: [], maxOutputTokens: 10,
      signal: new AbortController().signal,
    })
    const chunks = []
    for await (const chunk of stream) chunks.push(chunk)
    expect(chunks[0].choices[0]?.delta.content).toBe('hello')
    expect(chunks[1].choices[0]?.finish_reason).toBe('stop')
  })

  it('maps response.incomplete to finish_reason length instead of failing the stream', async () => {
    const client = {
      responses: {
        create: async () => (async function* () {
          yield { type: 'response.output_text.delta', delta: 'partial' }
          yield { type: 'response.incomplete', response: { usage: { input_tokens: 5, output_tokens: 9, total_tokens: 14 } } }
        })(),
      },
    }
    const adapter = new OpenAIResponsesAdapter(client as never)
    const stream = await adapter.stream({
      model: 'gpt-test', systemPrompt: 'system', messages: [], tools: [], maxOutputTokens: 10,
      signal: new AbortController().signal,
    })
    const chunks = []
    for await (const chunk of stream) chunks.push(chunk)
    expect(chunks[0].choices[0]?.delta.content).toBe('partial')
    expect(chunks[1].choices[0]?.finish_reason).toBe('length')
    expect(chunks[1].usage?.completion_tokens).toBe(9)
  })
})
