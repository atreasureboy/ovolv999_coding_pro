import { describe, it, expect } from 'vitest'
import {
  detectProviderFromModel,
  detectProviderFromBaseURL,
  detectProviderFromEnv,
  detectProvider,
  getModelInfo,
  getContextWindow,
  getModelPricing,
  modelSupports,
  getProvider,
  listProviders,
  getProviderBaseURL,
  getProviderAPIKeyEnv,
  PROVIDERS,
  MODELS,
} from '../src/core/providers.js'

describe('detectProviderFromModel', () => {
  it('detects OpenAI models', () => {
    expect(detectProviderFromModel('gpt-4o')).toBe('openai')
    expect(detectProviderFromModel('gpt-4o-mini')).toBe('openai')
    expect(detectProviderFromModel('o1')).toBe('openai')
    expect(detectProviderFromModel('o3-mini')).toBe('openai')
    expect(detectProviderFromModel('o4-mini')).toBe('openai')
  })

  it('detects Anthropic models', () => {
    expect(detectProviderFromModel('claude-opus-4-1')).toBe('anthropic')
    expect(detectProviderFromModel('claude-sonnet-4-5')).toBe('anthropic')
    expect(detectProviderFromModel('claude-3-5-sonnet-latest')).toBe('anthropic')
  })

  it('detects Google models', () => {
    expect(detectProviderFromModel('gemini-2.5-pro')).toBe('google')
    expect(detectProviderFromModel('gemini-2.0-flash')).toBe('google')
  })

  it('detects xAI models', () => {
    expect(detectProviderFromModel('grok-4')).toBe('xai')
    expect(detectProviderFromModel('grok-code-fast-1')).toBe('xai')
  })

  it('detects DeepSeek models', () => {
    expect(detectProviderFromModel('deepseek-chat')).toBe('deepseek')
    expect(detectProviderFromModel('deepseek-reasoner')).toBe('deepseek')
  })

  it('detects Groq models', () => {
    expect(detectProviderFromModel('llama-3.3-70b-versatile')).toBe('groq')
  })

  it('detects Mistral models', () => {
    expect(detectProviderFromModel('mistral-large-latest')).toBe('mistral')
    expect(detectProviderFromModel('codestral-latest')).toBe('mistral')
  })

  it('detects Cohere models', () => {
    expect(detectProviderFromModel('command-r-plus')).toBe('cohere')
  })

  it('returns unknown for unrecognized', () => {
    expect(detectProviderFromModel('some-unknown-model')).toBe('unknown')
  })

  it('handles provider-prefixed models', () => {
    expect(detectProviderFromModel('anthropic/claude-3')).toBe('anthropic')
    expect(detectProviderFromModel('openrouter/meta-llama/llama-3')).toBe('openrouter')
  })
})

describe('detectProviderFromBaseURL', () => {
  it('detects OpenAI', () => {
    expect(detectProviderFromBaseURL('https://api.openai.com/v1')).toBe('openai')
  })

  it('detects Anthropic', () => {
    expect(detectProviderFromBaseURL('https://api.anthropic.com/v1')).toBe('anthropic')
  })

  it('detects Google', () => {
    expect(detectProviderFromBaseURL('https://generativelanguage.googleapis.com/v1beta')).toBe('google')
  })

  it('detects xAI', () => {
    expect(detectProviderFromBaseURL('https://api.x.ai/v1')).toBe('xai')
  })

  it('detects OpenRouter', () => {
    expect(detectProviderFromBaseURL('https://openrouter.ai/api/v1')).toBe('openrouter')
  })

  it('detects Groq', () => {
    expect(detectProviderFromBaseURL('https://api.groq.com/openai/v1')).toBe('groq')
  })

  it('detects Ollama', () => {
    expect(detectProviderFromBaseURL('http://localhost:11434/v1')).toBe('ollama')
  })

  it('detects DeepSeek', () => {
    expect(detectProviderFromBaseURL('https://api.deepseek.com/v1')).toBe('deepseek')
  })

  it('returns null for unknown', () => {
    expect(detectProviderFromBaseURL('https://custom-api.example.com')).toBeNull()
  })

  it('returns null for undefined', () => {
    expect(detectProviderFromBaseURL(undefined)).toBeNull()
  })
})

describe('detectProviderFromEnv', () => {
  it('returns first matching provider', () => {
    const env = { OPENAI_API_KEY: 'sk-xxx' }
    expect(detectProviderFromEnv(env)).toBe('openai')
  })

  it('checks multiple providers', () => {
    const env = { ANTHROPIC_API_KEY: 'sk-ant-xxx' }
    expect(detectProviderFromEnv(env)).toBe('anthropic')
  })

  it('returns null when no keys present', () => {
    expect(detectProviderFromEnv({})).toBeNull()
  })
})

describe('detectProvider (combined)', () => {
  it('prioritizes model match', () => {
    const result = detectProvider({ model: 'claude-3', baseURL: 'https://api.openai.com/v1' })
    expect(result).toBe('anthropic')
  })

  it('falls back to baseURL', () => {
    const result = detectProvider({ model: 'custom-model', baseURL: 'https://api.x.ai/v1' })
    expect(result).toBe('xai')
  })

  it('falls back to env', () => {
    const result = detectProvider({
      model: 'unknown',
      env: { GROQ_API_KEY: 'gsk_xxx' },
    })
    expect(result).toBe('groq')
  })

  it('returns unknown when nothing matches', () => {
    // Pass empty env to avoid picking up real process.env keys
    expect(detectProvider({ env: {} })).toBe('unknown')
  })
})

describe('getModelInfo', () => {
  it('returns info for known model', () => {
    const info = getModelInfo('gpt-4o')
    expect(info).not.toBeNull()
    expect(info!.name).toBe('GPT-4o')
    expect(info!.provider).toBe('openai')
    expect(info!.contextWindow).toBe(128_000)
  })

  it('returns info for claude', () => {
    const info = getModelInfo('claude-sonnet-4-5')
    expect(info).not.toBeNull()
    expect(info!.provider).toBe('anthropic')
  })

  it('returns info for grok', () => {
    const info = getModelInfo('grok-4')
    expect(info).not.toBeNull()
    expect(info!.provider).toBe('xai')
  })

  it('returns null for unknown model', () => {
    expect(getModelInfo('nonexistent-model')).toBeNull()
  })

  it('handles provider-prefixed model names', () => {
    const info = getModelInfo('anthropic/claude-sonnet-4-5')
    expect(info).not.toBeNull()
    expect(info!.provider).toBe('anthropic')
  })
})

describe('getContextWindow', () => {
  it('returns known context window', () => {
    expect(getContextWindow('gpt-4o')).toBe(128_000)
    expect(getContextWindow('claude-opus-4-1')).toBe(200_000)
    expect(getContextWindow('gemini-2.5-pro')).toBe(1_048_576)
  })

  it('returns 128k default for unknown', () => {
    expect(getContextWindow('unknown-model')).toBe(128_000)
  })
})

describe('getModelPricing', () => {
  it('returns pricing for known model', () => {
    const pricing = getModelPricing('gpt-4o')
    expect(pricing.inputPer1M).toBe(2.5)
    expect(pricing.outputPer1M).toBe(10)
  })

  it('returns zero pricing for unknown', () => {
    const pricing = getModelPricing('unknown-model')
    expect(pricing.inputPer1M).toBe(0)
    expect(pricing.outputPer1M).toBe(0)
  })
})

describe('modelSupports', () => {
  it('checks vision support', () => {
    expect(modelSupports('gpt-4o', 'vision')).toBe(true)
    expect(modelSupports('o1-mini', 'vision')).toBe(false)
  })

  it('checks tool support', () => {
    expect(modelSupports('gpt-4o', 'tools')).toBe(true)
    expect(modelSupports('o1-mini', 'tools')).toBe(false)
  })

  it('checks reasoning support', () => {
    expect(modelSupports('o1', 'reasoning')).toBe(true)
    expect(modelSupports('gpt-4o', 'reasoning')).toBe(false)
  })

  it('defaults to tools=true for unknown models', () => {
    expect(modelSupports('unknown', 'tools')).toBe(true)
  })
})

describe('getProvider', () => {
  it('returns provider info by ID', () => {
    const p = getProvider('openai')
    expect(p.name).toBe('OpenAI')
    expect(p.openAICompatible).toBe(true)
  })

  it('returns unknown provider for invalid ID', () => {
    const p = getProvider('unknown' as never)
    expect(p.id).toBe('unknown')
  })
})

describe('listProviders', () => {
  it('returns all providers except unknown', () => {
    const list = listProviders()
    expect(list).toContain('openai')
    expect(list).toContain('anthropic')
    expect(list).toContain('google')
    expect(list).toContain('xai')
    expect(list).not.toContain('unknown')
  })
})

describe('getProviderBaseURL', () => {
  it('returns URL for known provider', () => {
    expect(getProviderBaseURL('openai')).toBe('https://api.openai.com/v1')
    expect(getProviderBaseURL('anthropic')).toBe('https://api.anthropic.com/v1')
  })

  it('returns null for unknown provider', () => {
    expect(getProviderBaseURL('unknown')).toBeNull()
  })
})

describe('getProviderAPIKeyEnv', () => {
  it('returns env var name', () => {
    expect(getProviderAPIKeyEnv('openai')).toBe('OPENAI_API_KEY')
    expect(getProviderAPIKeyEnv('anthropic')).toBe('ANTHROPIC_API_KEY')
    expect(getProviderAPIKeyEnv('xai')).toBe('XAI_API_KEY')
  })

  it('returns null for provider without env var', () => {
    expect(getProviderAPIKeyEnv('ollama')).toBeNull()
  })
})

describe('MODELS database integrity', () => {
  it('all models have unique IDs', () => {
    const ids = MODELS.map(m => m.id)
    const unique = new Set(ids)
    expect(unique.size).toBe(ids.length)
  })

  it('all models have required fields', () => {
    for (const m of MODELS) {
      expect(m.id).toBeTruthy()
      expect(m.name).toBeTruthy()
      expect(m.provider).toBeTruthy()
      expect(m.contextWindow).toBeGreaterThan(0)
      expect(m.pricing.inputPer1M).toBeGreaterThanOrEqual(0)
      expect(m.pricing.outputPer1M).toBeGreaterThanOrEqual(0)
    }
  })

  it('all model providers exist in PROVIDERS registry', () => {
    for (const m of MODELS) {
      expect(PROVIDERS[m.provider]).toBeDefined()
    }
  })
})

describe('PROVIDERS registry integrity', () => {
  it('all providers have openAICompatible flag', () => {
    for (const p of Object.values(PROVIDERS)) {
      expect(typeof p.openAICompatible).toBe('boolean')
    }
  })

  it('OpenAI-compatible providers have baseURL', () => {
    for (const p of Object.values(PROVIDERS)) {
      if (p.id === 'unknown') continue
      if (p.openAICompatible) {
        expect(p.baseURL).toBeTruthy()
      }
    }
  })
})
