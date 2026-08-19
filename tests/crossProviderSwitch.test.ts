import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { ExecutionEngine } from '../src/core/engine.js'
import type { EngineConfig } from '../src/core/types.js'
import type { Renderer } from '../src/ui/renderer.js'

/**
 * Round 35 (borrowed from opencode's per-provider adapter model): the
 * engine can rebind its transport at runtime when the user selects a
 * profile that targets a DIFFERENT provider — no restart required.
 */

class FakeOpenAI {
  apiKey = 'seed-key'
  baseURL = 'https://api.openai.com/v1'
  chat = { completions: { create: async () => ({ choices: [] }) } }
}

function fakeRenderer(): Renderer {
  const r: Record<string, (...args: unknown[]) => void> = {}
  for (const k of ['banner', 'raw', 'info', 'warn', 'error', 'success', 'startSpinner', 'stopSpinner', 'beginAssistantText', 'endAssistantText', 'streamToken', 'streamReasoning', 'assistantMessage', 'userMessage', 'toolCall', 'toolStart', 'toolResult', 'compactStart', 'compactDone', 'contextWarning', 'cost', 'compactionNotice', 'turnEnd', 'planModeHeader', 'agentStart', 'agentDone', 'agentSummary', 'agentHeartbeat']) r[k] = () => {}
  return r as unknown as Renderer
}

const CAPS = { reasoning: 0.8, coding: 0.8, contextWindow: 128_000, toolCalling: 0.8, speed: 0.7, cost: 0.5 }

function makeEngine(models: EngineConfig['models']): { e: ExecutionEngine; fake: FakeOpenAI } {
  const fake = new FakeOpenAI()
  const cfg: EngineConfig = {
    model: 'gpt-x', apiKey: 'k', maxIterations: 5, cwd: '/tmp',
    permissionMode: 'auto', enabledModules: [],
    provider: 'openai',
    models,
  }
  return { e: new ExecutionEngine(cfg, fakeRenderer(), fake as unknown as never), fake }
}

const KEY_ENV = 'OVOGO_TEST_CROSS_KEY'
const oldEnv = process.env[KEY_ENV]

beforeEach(() => {
  process.env[KEY_ENV] = 'sk-cross-test'
})

afterEach(() => {
  if (oldEnv === undefined) delete process.env[KEY_ENV]
  else process.env[KEY_ENV] = oldEnv
})

describe('cross-provider runtime switching', () => {
  it('rebinds transport when switching to a different-provider profile', () => {
    const { e } = makeEngine({
      profiles: [
        { id: 'main', provider: 'openai', model: 'gpt-x', tier: 'top', capabilities: CAPS, roles: ['main'], available: true },
        {
          id: 'deep', provider: 'deepseek', model: 'deepseek-chat', tier: 'top',
          capabilities: CAPS, roles: ['main'], available: true,
          apiKeyEnv: KEY_ENV, baseURL: 'https://api.deepseek.com/v1',
        },
      ],
      routing: { enabled: false },
    })

    expect(e.getProvider()).toBe('openai')
    e.setModelByUser('deep')

    expect(e.getProvider()).toBe('deepseek')
    expect(e.getModel()).toBe('deepseek-chat')
    // The live client now points at the new endpoint.
    expect(String(e.getClient().baseURL)).toContain('api.deepseek.com')
  })

  it('rejects the switch (with an actionable message) when the key is missing', () => {
    delete process.env[KEY_ENV]
    const { e } = makeEngine({
      profiles: [
        { id: 'main', provider: 'openai', model: 'gpt-x', tier: 'top', capabilities: CAPS, roles: ['main'], available: true },
        {
          id: 'deep', provider: 'deepseek', model: 'deepseek-chat', tier: 'top',
          capabilities: CAPS, roles: ['main'], available: true,
          apiKeyEnv: KEY_ENV, baseURL: 'https://api.deepseek.com/v1',
        },
      ],
      routing: { enabled: false },
    })

    expect(() => e.setModelByUser('deep')).toThrow(/API key/)
    expect(() => e.setModelByUser('deep')).toThrow(KEY_ENV)
    // Engine stays on the old transport.
    expect(e.getProvider()).toBe('openai')
    expect(e.getModel()).toBe('gpt-x')
  })

  it('same-provider switches are unaffected (no rebind)', () => {
    const { e } = makeEngine({
      profiles: [
        { id: 'main', provider: 'openai', model: 'gpt-x', tier: 'top', capabilities: CAPS, roles: ['main'], available: true },
        { id: 'alt', provider: 'openai', model: 'gpt-y', tier: 'top', capabilities: CAPS, roles: ['main'], available: true },
      ],
      routing: { enabled: false },
    })
    e.setModelByUser('alt')
    expect(e.getModel()).toBe('gpt-y')
    expect(e.getProvider()).toBe('openai')
  })

  it('falls back to the provider registry env var when apiKeyEnv is omitted', () => {
    // deepseek's registry default is DEEPSEEK_API_KEY.
    process.env.DEEPSEEK_API_KEY = 'sk-registry-default'
    try {
      const { e } = makeEngine({
        profiles: [
          { id: 'main', provider: 'openai', model: 'gpt-x', tier: 'top', capabilities: CAPS, roles: ['main'], available: true },
          { id: 'deep', provider: 'deepseek', model: 'deepseek-chat', tier: 'top', capabilities: CAPS, roles: ['main'], available: true },
        ],
        routing: { enabled: false },
      })
      e.setModelByUser('deep')
      expect(e.getProvider()).toBe('deepseek')
    } finally {
      delete process.env.DEEPSEEK_API_KEY
    }
  })
})
