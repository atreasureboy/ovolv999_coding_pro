/**
 * v0.4.1 WS2 — providerProbe verifies a freshly configured provider BEFORE
 * the user enters the UI: streaming + tool calling, the two capabilities
 * every turn depends on. models.list is observability, not a gate (404 is
 * common on compatible providers and must not fail the probe).
 *
 * All tests inject a fake client through the DI seam — zero network.
 */
import { describe, it, expect } from 'vitest'
import { probeProvider, type ProbeClient } from '../src/config/providerProbe.js'

function streamOf(...chunks: unknown[]): AsyncIterable<unknown> {
  return (async function* () { for (const c of chunks) yield c })()
}

interface FakeShape {
  modelsList?: 'ok' | '404' | 'absent'
  create?: 'ok' | 'empty' | Error
}

interface FakeClient extends ProbeClient {
  createCalls: Array<Record<string, unknown>>
}

function fakeClient(o: FakeShape = {}): FakeClient {
  const createCalls: Array<Record<string, unknown>> = []
  const client: FakeClient = {
    createCalls,
    chat: {
      completions: {
        create: async (params: Record<string, unknown>) => {
          createCalls.push(params)
          if (o.create instanceof Error) throw o.create
          if (o.create === 'empty') return streamOf()
          return streamOf({ choices: [{ index: 0, delta: { content: 'ok' } }] })
        },
      },
    },
  }
  if (o.modelsList !== 'absent') {
    client.models = {
      list: async () => {
        if (o.modelsList === '404') {
          throw Object.assign(new Error('404 page not found'), { status: 404 })
        }
        return { data: [{ id: 'gpt-4o' }] }
      },
    }
  }
  return client
}

describe('probeProvider (v0.4.1 WS2)', () => {
  it('success: streams a chunk, and the request really carries stream + a tool definition', async () => {
    const client = fakeClient({ modelsList: 'ok', create: 'ok' })
    const result = await probeProvider({ apiKey: 'k', model: 'gpt-4o', client })

    expect(result.ok).toBe(true)
    expect(result.modelsListed).toBe(true)
    expect(result.model).toBe('gpt-4o')
    expect(result.latencyMs).toBeGreaterThanOrEqual(0)
    expect(result.error).toBeUndefined()

    // The WS2 contract: the probe must exercise exactly what a turn needs.
    expect(client.createCalls).toHaveLength(1)
    const params = client.createCalls[0]
    expect(params.stream).toBe(true)
    expect(params.max_tokens).toBe(16)
    const tools = params.tools as Array<{ type: string; function: { name: string } }>
    expect(tools).toHaveLength(1)
    expect(tools[0].type).toBe('function')
    expect(tools[0].function.name).toBe('probe_echo')
  })

  it('models.list 404 is NOT fatal — the completion probe is the verdict', async () => {
    const client = fakeClient({ modelsList: '404', create: 'ok' })
    const result = await probeProvider({ apiKey: 'k', model: 'local-model', client })
    expect(result.ok).toBe(true)
    expect(result.modelsListed).toBe(false)
  })

  it('client without a models API probes completions anyway', async () => {
    const client = fakeClient({ modelsList: 'absent', create: 'ok' })
    const result = await probeProvider({ apiKey: 'k', model: 'm', client })
    expect(result.ok).toBe(true)
    expect(result.modelsListed).toBeUndefined()
  })

  it('auth failure surfaces the REAL error (status 401), ok=false', async () => {
    const err = Object.assign(new Error('Incorrect API key provided'), { status: 401 })
    const client = fakeClient({ modelsList: 'ok', create: err })
    const result = await probeProvider({ apiKey: 'bad', model: 'gpt-4o', client })
    expect(result.ok).toBe(false)
    expect(result.error).toBe(err)
    expect((result.error as Error & { status?: number }).status).toBe(401)
  })

  it('network timeout surfaces with its code intact', async () => {
    const err = Object.assign(new Error('connect ETIMEDOUT 10.0.0.1:443'), { code: 'ETIMEDOUT' })
    const client = fakeClient({ modelsList: 'absent', create: err })
    const result = await probeProvider({ apiKey: 'k', model: 'm', client })
    expect(result.ok).toBe(false)
    expect((result.error as Error & { code?: string }).code).toBe('ETIMEDOUT')
  })

  it('an empty stream (connected, zero chunks) fails honestly', async () => {
    const client = fakeClient({ modelsList: 'ok', create: 'empty' })
    const result = await probeProvider({ apiKey: 'k', model: 'm', client })
    expect(result.ok).toBe(false)
    expect(result.error?.message).toContain('empty stream')
  })

  it('non-Error throws are wrapped, never swallowed', async () => {
    const client = fakeClient({ create: undefined })
    client.chat.completions.create = async () => {
      // eslint-disable-next-line @typescript-eslint/only-throw-error -- deliberate: probeProvider must WRAP non-Error throws, and this test proves it
      throw 'raw-string-failure'
    }
    const result = await probeProvider({ apiKey: 'k', model: 'm', client })
    expect(result.ok).toBe(false)
    expect(result.error?.message).toContain('raw-string-failure')
  })
})
