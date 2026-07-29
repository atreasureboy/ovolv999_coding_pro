/**
 * v0.4.1 C1 (callId truth) — StreamConsumer stream-protocol layer.
 *
 * Missing tool_call ids are synthesized (`call_<uuid>`) for the documented
 * vLLM/Ollama compatibility contract — the SINGLE-missing case stays SILENT.
 * But when a response carries MULTIPLE id-less tool calls, tool_result→call
 * attribution is unrecoverable: the consumer records a structured EventLog
 * `protocol` entry and warns once per consume — never failing the turn.
 */
import { describe, it, expect, vi } from 'vitest'
import type OpenAI from 'openai'
import { StreamConsumer } from '../src/core/model/streamConsumer.js'
import type { Renderer } from '../src/ui/renderer.js'
import type { EventLog } from '../src/core/eventLog.js'

type Chunk = OpenAI.Chat.ChatCompletionChunk

function toolChunk(
  calls: Array<{ index: number; id?: string; name?: string; args?: string }>,
): Chunk {
  return {
    choices: [{
      delta: {
        tool_calls: calls.map((c) => ({
          index: c.index,
          ...(c.id !== undefined ? { id: c.id } : {}),
          function: {
            ...(c.name !== undefined ? { name: c.name } : {}),
            ...(c.args !== undefined ? { arguments: c.args } : {}),
          },
        })),
      },
    }],
  } as unknown as Chunk
}

function finishChunk(): Chunk {
  return { choices: [{ delta: {}, finish_reason: 'tool_calls' }] } as unknown as Chunk
}

async function* streamOf(chunks: Chunk[]): AsyncGenerator<Chunk> {
  for (const c of chunks) yield c
}

function harness() {
  const warn = vi.fn()
  const renderer = {
    stopSpinner: vi.fn(),
    beginAssistantText: vi.fn(),
    streamToken: vi.fn(),
    streamReasoning: vi.fn(),
    endAssistantText: vi.fn(),
    warn,
  } as unknown as Renderer
  const append = vi.fn()
  const eventLog = { append } as unknown as EventLog
  const consumer = new StreamConsumer({ renderer, eventLog })
  const signal = new AbortController().signal
  const consume = (chunks: Chunk[]) => consumer.consume(streamOf(chunks), signal, null)
  return { warn, append, consume }
}

describe('StreamConsumer tool_call id synthesis (v0.4.1 C1)', () => {
  it('synthesizes a single missing id silently (vLLM/Ollama compat)', async () => {
    const { warn, append, consume } = harness()
    const result = await consume([
      toolChunk([{ index: 0, name: 'read_file', args: '{"path":"a.ts"}' }]),
      finishChunk(),
    ])
    expect(result.rawToolCalls).toHaveLength(1)
    expect(result.rawToolCalls[0].id).toMatch(/^call_/)
    expect(result.rawToolCalls[0].name).toBe('read_file')
    expect(result.rawToolCalls[0].arguments).toBe('{"path":"a.ts"}')
    expect(warn).not.toHaveBeenCalled()
    expect(append).not.toHaveBeenCalled()
  })

  it('records protocol_error and warns once when ≥2 of multiple calls lack ids', async () => {
    const { warn, append, consume } = harness()
    const result = await consume([
      toolChunk([{ index: 0, name: 'read_file', args: '{}' }]),
      toolChunk([{ index: 1, name: 'bash', args: '{}' }]),
      finishChunk(),
    ])
    expect(result.rawToolCalls).toHaveLength(2)
    const [a, b] = result.rawToolCalls
    expect(a.id).toMatch(/^call_/)
    expect(b.id).toMatch(/^call_/)
    expect(a.id).not.toBe(b.id)
    expect(append).toHaveBeenCalledExactlyOnceWith('protocol', 'protocol_error', {
      kind: 'multiple_missing_tool_call_ids',
      toolCalls: 2,
      missingIds: 2,
    })
    expect(warn).toHaveBeenCalledOnce()
    expect(String(warn.mock.calls[0][0])).toContain('2/2')
    // the turn still returns its work — attribution failure is not fatal
    expect(result.finishReason).toBe('tool_calls')
    expect(result.rawToolCalls.map((t) => t.name)).toEqual(['read_file', 'bash'])
  })

  it('stays silent when only one of multiple calls lacks an id', async () => {
    const { warn, append, consume } = harness()
    const result = await consume([
      toolChunk([{ index: 0, id: 'call_real_1', name: 'read_file', args: '{}' }]),
      toolChunk([{ index: 1, name: 'bash', args: '{}' }]),
      finishChunk(),
    ])
    expect(result.rawToolCalls[0].id).toBe('call_real_1')
    expect(result.rawToolCalls[1].id).toMatch(/^call_/)
    expect(result.rawToolCalls[1].id).not.toBe('call_real_1')
    expect(warn).not.toHaveBeenCalled()
    expect(append).not.toHaveBeenCalled()
  })

  it('leaves provider-supplied ids untouched', async () => {
    const { warn, append, consume } = harness()
    const result = await consume([
      toolChunk([{ index: 0, id: 'call_A', name: 'read_file', args: '{}' }]),
      toolChunk([{ index: 1, id: 'call_B', name: 'bash', args: '{}' }]),
      finishChunk(),
    ])
    expect(result.rawToolCalls.map((t) => t.id)).toEqual(['call_A', 'call_B'])
    expect(warn).not.toHaveBeenCalled()
    expect(append).not.toHaveBeenCalled()
  })
})
