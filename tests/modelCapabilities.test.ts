/**
 * ModelCapabilities tests (fi_goal.md §九 Phase 8 / Round 10).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import {
  capabilitiesForModel,
  capabilitiesFromInfo,
  effectiveInputBudget,
  allCapabilities,
  registerProviderAdapter,
  getProviderAdapter,
  hasProviderAdapter,
  clearProviderAdapters,
  type ModelCapabilities,
  type ProviderAdapter,
  type ProviderRequestInput,
  type InternalStreamEvent,
} from '../src/core/modelCapabilities.js'
import { MODELS } from '../src/core/providers.js'

// ─────────────────────────────────────────────────────────────────────
// capabilitiesForModel
// ─────────────────────────────────────────────────────────────────────
describe('capabilitiesForModel', () => {
  it('resolves capabilities for a known model', () => {
    const caps = capabilitiesForModel('gpt-4o')
    expect(caps.toolCalling).toBe(true)
    expect(caps.parallelToolCalling).toBe(true)
    expect(caps.imageInput).toBe(true)
    expect(caps.maxContext).toBe(128_000)
  })

  it('resolves capabilities for an Anthropic model', () => {
    const caps = capabilitiesForModel('claude-sonnet-4-5')
    expect(caps.toolCalling).toBe(true)
    expect(caps.imageInput).toBe(true)
    expect(caps.maxContext).toBe(200_000)
    expect(caps.promptCaching).toBe(true) // Anthropic default
    expect(caps.usageStreaming).toBe(true) // Anthropic default
  })

  it('resolves capabilities for an o-series reasoning model', () => {
    const caps = capabilitiesForModel('o3')
    expect(caps.reasoningTokens).toBe(true)
    expect(caps.toolCalling).toBe(true)
  })

  it('returns safe defaults for an unknown model', () => {
    const caps = capabilitiesForModel('not-a-real-model-xyz')
    expect(caps.toolCalling).toBe(false)
    expect(caps.parallelToolCalling).toBe(false)
    expect(caps.reasoningTokens).toBe(false)
    expect(caps.promptCaching).toBe(false)
    expect(caps.usageStreaming).toBe(false)
    expect(caps.imageInput).toBe(false)
    expect(caps.maxContext).toBeGreaterThan(0)
    expect(caps.maxOutput).toBeGreaterThan(0)
  })

  it('maxOutput defaults to 8192 when ModelInfo omits it', () => {
    const caps = capabilitiesForModel('gpt-4o')
    expect(caps.maxOutput).toBe(8192)
  })
})

// ─────────────────────────────────────────────────────────────────────
// capabilitiesFromInfo
// ─────────────────────────────────────────────────────────────────────
describe('capabilitiesFromInfo', () => {
  it('reads supportsTools → toolCalling', () => {
    const info = MODELS.find((m) => m.id === 'gpt-4o')!
    const caps = capabilitiesFromInfo(info)
    expect(caps.toolCalling).toBe(true)
  })

  it('reads supportsParallelTools → parallelToolCalling', () => {
    const info = MODELS.find((m) => m.id === 'gpt-4o')!
    const caps = capabilitiesFromInfo(info)
    expect(caps.parallelToolCalling).toBe(true)
  })

  it('reads supportsVision → imageInput', () => {
    const info = MODELS.find((m) => m.id === 'gpt-4o')!
    const caps = capabilitiesFromInfo(info)
    expect(caps.imageInput).toBe(true)
  })

  it('reads supportsReasoning → reasoningTokens', () => {
    const info = MODELS.find((m) => m.id === 'o3')!
    const caps = capabilitiesFromInfo(info)
    expect(caps.reasoningTokens).toBe(true)
  })

  it('honors explicit maxOutputTokens when set', () => {
    const caps = capabilitiesFromInfo({
      id: 'test',
      name: 'Test',
      provider: 'openai',
      contextWindow: 100_000,
      maxOutputTokens: 4096,
      pricing: { inputPer1M: 0, outputPer1M: 0 },
      supportsTools: true,
    })
    expect(caps.maxOutput).toBe(4096)
  })
})

// ─────────────────────────────────────────────────────────────────────
// Provider defaults
// ─────────────────────────────────────────────────────────────────────
describe('provider defaults', () => {
  it('Anthropic enables both prompt caching and usage streaming', () => {
    const caps = capabilitiesForModel('claude-opus-4-1')
    expect(caps.promptCaching).toBe(true)
    expect(caps.usageStreaming).toBe(true)
  })

  it('OpenAI enables prompt caching by default', () => {
    const caps = capabilitiesForModel('gpt-4o')
    expect(caps.promptCaching).toBe(true)
  })

  it('Ollama supports usage streaming (local inference)', () => {
    // Use any known ollama-served model from MODELS, or check defaults.
    // We construct a synthetic ModelInfo to verify the path.
    const caps = capabilitiesFromInfo({
      id: 'llama3',
      name: 'Llama 3',
      provider: 'ollama',
      contextWindow: 8192,
      pricing: { inputPer1M: 0, outputPer1M: 0 },
      supportsTools: true,
    })
    expect(caps.usageStreaming).toBe(true)
    expect(caps.promptCaching).toBe(false)
  })
})

// ─────────────────────────────────────────────────────────────────────
// effectiveInputBudget
// ─────────────────────────────────────────────────────────────────────
describe('effectiveInputBudget', () => {
  it('subtracts output reserve from maxContext', () => {
    const caps: ModelCapabilities = {
      toolCalling: true,
      parallelToolCalling: true,
      reasoningTokens: false,
      promptCaching: false,
      usageStreaming: false,
      imageInput: false,
      maxContext: 200_000,
      maxOutput: 8_000,
    }
    expect(effectiveInputBudget(caps)).toBe(200_000 - 8_000)
  })

  it('subtracts both output reserve and working-state reserve', () => {
    const caps: ModelCapabilities = {
      toolCalling: false,
      parallelToolCalling: false,
      reasoningTokens: false,
      promptCaching: false,
      usageStreaming: false,
      imageInput: false,
      maxContext: 100_000,
      maxOutput: 4_000,
    }
    expect(effectiveInputBudget(caps, { reserveForWorkingState: 2_000 }))
      .toBe(100_000 - 4_000 - 2_000)
  })

  it('clamps to zero when reserves exceed maxContext', () => {
    const caps: ModelCapabilities = {
      toolCalling: false,
      parallelToolCalling: false,
      reasoningTokens: false,
      promptCaching: false,
      usageStreaming: false,
      imageInput: false,
      maxContext: 1_000,
      maxOutput: 8_000,
    }
    expect(effectiveInputBudget(caps)).toBe(0)
  })
})

// ─────────────────────────────────────────────────────────────────────
// allCapabilities
// ─────────────────────────────────────────────────────────────────────
describe('allCapabilities', () => {
  it('returns one entry per registered model', () => {
    const all = allCapabilities()
    expect(all.length).toBeGreaterThanOrEqual(MODELS.length)
    for (const entry of all) {
      expect(entry.model).toBeTruthy()
      expect(entry.maxContext).toBeGreaterThan(0)
      expect(entry.maxOutput).toBeGreaterThan(0)
    }
  })
})

// ─────────────────────────────────────────────────────────────────────
// Provider adapter registry
// ─────────────────────────────────────────────────────────────────────
describe('provider adapter registry', () => {
  beforeEach(() => clearProviderAdapters())
  afterEach(() => clearProviderAdapters())

  function fakeAdapter(providerId: string): ProviderAdapter {
    return {
      providerId: providerId as never,
      toProviderRequest: (input: ProviderRequestInput) => ({ model: input.model }),
      fromProviderStreamChunk: (chunk: unknown): InternalStreamEvent[] => {
        return [{ kind: 'text_delta', text: String(chunk) }]
      },
    }
  }

  it('hasProviderAdapter is false before registration', () => {
    expect(hasProviderAdapter('anthropic')).toBe(false)
  })

  it('registerProviderAdapter adds to the registry', () => {
    registerProviderAdapter(fakeAdapter('anthropic'))
    expect(hasProviderAdapter('anthropic')).toBe(true)
  })

  it('getProviderAdapter returns the registered adapter', () => {
    const a = fakeAdapter('openai')
    registerProviderAdapter(a)
    expect(getProviderAdapter('openai')).toBe(a)
  })

  it('getProviderAdapter throws for unknown provider', () => {
    expect(() => getProviderAdapter('groq')).toThrow(/no provider adapter registered/)
  })

  it('registerProviderAdapter overwrites prior registration', () => {
    const a1 = fakeAdapter('google')
    const a2 = fakeAdapter('google')
    registerProviderAdapter(a1)
    registerProviderAdapter(a2)
    expect(getProviderAdapter('google')).toBe(a2)
  })

  it('clearProviderAdapters empties the registry', () => {
    registerProviderAdapter(fakeAdapter('openai'))
    registerProviderAdapter(fakeAdapter('anthropic'))
    clearProviderAdapters()
    expect(hasProviderAdapter('openai')).toBe(false)
    expect(hasProviderAdapter('anthropic')).toBe(false)
  })
})

// ─────────────────────────────────────────────────────────────────────
// Adapter contract (synthetic end-to-end)
// ─────────────────────────────────────────────────────────────────────
describe('adapter contract: messages → request → stream → events', () => {
  beforeEach(() => clearProviderAdapters())
  afterEach(() => clearProviderAdapters())

  it('a synthetic adapter round-trips a tool-call stream chunk', () => {
    const adapter: ProviderAdapter = {
      providerId: 'openai',
      toProviderRequest: (input) => ({
        model: input.model,
        messages: input.messages,
        max_tokens: input.maxOutputTokens,
      }),
      fromProviderStreamChunk: (chunk): InternalStreamEvent[] => {
        const c = chunk as { type: string; name?: string; id?: string; args?: string }
        if (c.type === 'tool_complete') {
          return [{
            kind: 'tool_call_complete',
            toolCallId: c.id!,
            toolName: c.name!,
            args: c.args ?? '{}',
          }]
        }
        return []
      },
    }
    registerProviderAdapter(adapter)

    const caps = capabilitiesForModel('gpt-4o')
    const req = adapter.toProviderRequest(
      {
        model: 'gpt-4o',
        messages: [{ role: 'user', content: 'hi' }],
        maxOutputTokens: caps.maxOutput,
        enableCaching: true,
      },
      caps,
    )
    expect(req).toMatchObject({ model: 'gpt-4o', max_tokens: 8192 })

    const events = adapter.fromProviderStreamChunk({
      type: 'tool_complete',
      id: 'tc1',
      name: 'bash',
      args: '{"command":"ls"}',
    })
    expect(events).toEqual([
      {
        kind: 'tool_call_complete',
        toolCallId: 'tc1',
        toolName: 'bash',
        args: '{"command":"ls"}',
      },
    ])
  })

  it('a single chunk can fan out into multiple unified events', () => {
    const adapter: ProviderAdapter = {
      providerId: 'anthropic',
      toProviderRequest: () => ({}),
      fromProviderStreamChunk: (chunk): InternalStreamEvent[] => {
        const c = chunk as { text?: string; usage?: { input?: number; output?: number } }
        const out: InternalStreamEvent[] = []
        if (c.text) out.push({ kind: 'text_delta', text: c.text })
        if (c.usage) out.push({ kind: 'usage', usage: { inputTokens: c.usage.input, outputTokens: c.usage.output } })
        return out
      },
    }
    const events = adapter.fromProviderStreamChunk({
      text: 'hello',
      usage: { input: 10, output: 5 },
    })
    expect(events).toHaveLength(2)
    expect(events[0].kind).toBe('text_delta')
    expect(events[1].kind).toBe('usage')
  })

  it('usageStreaming capability determines whether the coordinator wires incremental counters', () => {
    const claudeCaps = capabilitiesForModel('claude-sonnet-4-5')
    const xaiCaps = capabilitiesForModel('grok-4')
    expect(claudeCaps.usageStreaming).toBe(true)
    expect(xaiCaps.usageStreaming).toBe(false)
  })
})
