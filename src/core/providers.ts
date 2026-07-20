/**
 * LLM Provider Registry — model metadata, pricing, and auto-detection.
 *
 * Supports multiple providers (OpenAI, Anthropic, Google, xAI, etc.)
 * with auto-detection from model names and baseURL patterns.
 *
 * Most providers (xAI, OpenRouter, Together, Groq, Ollama) use the
 * OpenAI-compatible API — they only need a different baseURL. This
 * module provides the metadata (context windows, pricing) so the
 * cost tracker and context calculator work across providers.
 *
 * Inspired by Claude Code's provider abstraction.
 */

// ── Types ───────────────────────────────────────────────────────────────────

export type ProviderId =
  | 'openai'
  | 'anthropic'
  | 'google'
  | 'xai'        // Grok
  | 'openrouter'
  | 'together'
  | 'groq'
  | 'deepseek'
  | 'ollama'     // local
  | 'mistral'
  | 'cohere'
  | 'perplexity'
  | 'unknown'

export interface ModelInfo {
  /** Model identifier as used in the API */
  id: string
  /** Human-readable name */
  name: string
  /** Provider */
  provider: ProviderId
  /** Max context window in tokens */
  contextWindow: number
  /** Max output tokens (0 = use provider default) */
  maxOutputTokens?: number
  /** Pricing per 1M tokens in USD */
  pricing: {
    inputPer1M: number
    outputPer1M: number
  }
  /** Whether the model supports vision/multimodal */
  supportsVision?: boolean
  /** Whether the model supports tool/function calling */
  supportsTools?: boolean
  /** Whether the model supports parallel tool calls */
  supportsParallelTools?: boolean
  /** Whether the model exposes reasoning/thinking tokens */
  supportsReasoning?: boolean
}

export interface ProviderInfo {
  id: ProviderId
  name: string
  /** Default API base URL */
  baseURL?: string
  /** Environment variable for API key */
  apiKeyEnv?: string
  /** Whether the API is OpenAI-compatible */
  openAICompatible: boolean
  /** Known models (subset — real list comes from the API) */
  models?: string[]
}

// ── Provider Registry ───────────────────────────────────────────────────────

export const PROVIDERS: Record<ProviderId, ProviderInfo> = {
  openai: {
    id: 'openai',
    name: 'OpenAI',
    baseURL: 'https://api.openai.com/v1',
    apiKeyEnv: 'OPENAI_API_KEY',
    openAICompatible: true,
  },
  anthropic: {
    id: 'anthropic',
    name: 'Anthropic',
    baseURL: 'https://api.anthropic.com/v1',
    apiKeyEnv: 'ANTHROPIC_API_KEY',
    openAICompatible: false,
    models: ['claude-opus-4-1', 'claude-sonnet-4-5', 'claude-haiku-4-5', 'claude-3-5-sonnet-latest'],
  },
  google: {
    id: 'google',
    name: 'Google AI',
    baseURL: 'https://generativelanguage.googleapis.com/v1beta',
    apiKeyEnv: 'GOOGLE_API_KEY',
    openAICompatible: false,
    models: ['gemini-2.5-pro', 'gemini-2.5-flash', 'gemini-2.0-flash'],
  },
  xai: {
    id: 'xai',
    name: 'xAI (Grok)',
    baseURL: 'https://api.x.ai/v1',
    apiKeyEnv: 'XAI_API_KEY',
    openAICompatible: true,
    models: ['grok-4', 'grok-4-fast', 'grok-2-1212', 'grok-code-fast-1'],
  },
  openrouter: {
    id: 'openrouter',
    name: 'OpenRouter',
    baseURL: 'https://openrouter.ai/api/v1',
    apiKeyEnv: 'OPENROUTER_API_KEY',
    openAICompatible: true,
  },
  together: {
    id: 'together',
    name: 'Together AI',
    baseURL: 'https://api.together.xyz/v1',
    apiKeyEnv: 'TOGETHER_API_KEY',
    openAICompatible: true,
  },
  groq: {
    id: 'groq',
    name: 'Groq',
    baseURL: 'https://api.groq.com/openai/v1',
    apiKeyEnv: 'GROQ_API_KEY',
    openAICompatible: true,
    models: ['llama-3.3-70b-versatile', 'mixtral-8x7b-32768'],
  },
  deepseek: {
    id: 'deepseek',
    name: 'DeepSeek',
    baseURL: 'https://api.deepseek.com/v1',
    apiKeyEnv: 'DEEPSEEK_API_KEY',
    openAICompatible: true,
    models: ['deepseek-chat', 'deepseek-reasoner'],
  },
  ollama: {
    id: 'ollama',
    name: 'Ollama (local)',
    baseURL: 'http://localhost:11434/v1',
    openAICompatible: true,
  },
  mistral: {
    id: 'mistral',
    name: 'Mistral AI',
    baseURL: 'https://api.mistral.ai/v1',
    apiKeyEnv: 'MISTRAL_API_KEY',
    openAICompatible: true,
  },
  cohere: {
    id: 'cohere',
    name: 'Cohere',
    baseURL: 'https://api.cohere.ai/v1',
    apiKeyEnv: 'COHERE_API_KEY',
    openAICompatible: true,
  },
  perplexity: {
    id: 'perplexity',
    name: 'Perplexity',
    baseURL: 'https://api.perplexity.ai',
    apiKeyEnv: 'PPLX_API_KEY',
    openAICompatible: true,
  },
  unknown: {
    id: 'unknown',
    name: 'Unknown',
    openAICompatible: true,
  },
}

// ── Model Database ──────────────────────────────────────────────────────────

export const MODELS: ModelInfo[] = [
  // ── OpenAI ────────────────────────────────────────────────────────────────
  {
    id: 'gpt-4o', name: 'GPT-4o', provider: 'openai',
    contextWindow: 128_000, supportsVision: true, supportsTools: true, supportsParallelTools: true,
    pricing: { inputPer1M: 2.5, outputPer1M: 10 },
  },
  {
    id: 'gpt-4o-mini', name: 'GPT-4o mini', provider: 'openai',
    contextWindow: 128_000, supportsVision: true, supportsTools: true, supportsParallelTools: true,
    pricing: { inputPer1M: 0.15, outputPer1M: 0.6 },
  },
  {
    id: 'o1', name: 'o1', provider: 'openai',
    contextWindow: 200_000, supportsVision: true, supportsTools: true, supportsReasoning: true,
    pricing: { inputPer1M: 15, outputPer1M: 60 },
  },
  {
    id: 'o1-mini', name: 'o1 mini', provider: 'openai',
    contextWindow: 128_000, supportsReasoning: true,
    pricing: { inputPer1M: 3, outputPer1M: 12 },
  },
  {
    id: 'o3', name: 'o3', provider: 'openai',
    contextWindow: 200_000, supportsVision: true, supportsTools: true, supportsReasoning: true,
    pricing: { inputPer1M: 10, outputPer1M: 40 },
  },
  {
    id: 'o3-mini', name: 'o3 mini', provider: 'openai',
    contextWindow: 200_000, supportsTools: true, supportsReasoning: true,
    pricing: { inputPer1M: 1.1, outputPer1M: 4.4 },
  },
  {
    id: 'o4-mini', name: 'o4 mini', provider: 'openai',
    contextWindow: 200_000, supportsVision: true, supportsTools: true, supportsReasoning: true,
    pricing: { inputPer1M: 1.1, outputPer1M: 4.4 },
  },

  // ── Anthropic ─────────────────────────────────────────────────────────────
  {
    id: 'claude-opus-4-1', name: 'Claude Opus 4.1', provider: 'anthropic',
    contextWindow: 200_000, supportsVision: true, supportsTools: true,
    pricing: { inputPer1M: 15, outputPer1M: 75 },
  },
  {
    id: 'claude-sonnet-4-5', name: 'Claude Sonnet 4.5', provider: 'anthropic',
    contextWindow: 200_000, supportsVision: true, supportsTools: true,
    pricing: { inputPer1M: 3, outputPer1M: 15 },
  },
  {
    id: 'claude-haiku-4-5', name: 'Claude Haiku 4.5', provider: 'anthropic',
    contextWindow: 200_000, supportsVision: true, supportsTools: true,
    pricing: { inputPer1M: 1, outputPer1M: 5 },
  },
  {
    id: 'claude-3-5-sonnet-latest', name: 'Claude 3.5 Sonnet', provider: 'anthropic',
    contextWindow: 200_000, supportsVision: true, supportsTools: true,
    pricing: { inputPer1M: 3, outputPer1M: 15 },
  },

  // ── Google ────────────────────────────────────────────────────────────────
  {
    id: 'gemini-2.5-pro', name: 'Gemini 2.5 Pro', provider: 'google',
    contextWindow: 1_048_576, supportsVision: true, supportsTools: true, supportsReasoning: true,
    pricing: { inputPer1M: 1.25, outputPer1M: 10 },
  },
  {
    id: 'gemini-2.5-flash', name: 'Gemini 2.5 Flash', provider: 'google',
    contextWindow: 1_048_576, supportsVision: true, supportsTools: true, supportsReasoning: true,
    pricing: { inputPer1M: 0.3, outputPer1M: 2.5 },
  },
  {
    id: 'gemini-2.0-flash', name: 'Gemini 2.0 Flash', provider: 'google',
    contextWindow: 1_048_576, supportsVision: true, supportsTools: true,
    pricing: { inputPer1M: 0.1, outputPer1M: 0.4 },
  },

  // ── xAI (Grok) ────────────────────────────────────────────────────────────
  {
    id: 'grok-4', name: 'Grok 4', provider: 'xai',
    contextWindow: 256_000, supportsTools: true,
    pricing: { inputPer1M: 3, outputPer1M: 15 },
  },
  {
    id: 'grok-4-fast', name: 'Grok 4 Fast', provider: 'xai',
    contextWindow: 100_000, supportsTools: true,
    pricing: { inputPer1M: 0.2, outputPer1M: 0.5 },
  },
  {
    id: 'grok-code-fast-1', name: 'Grok Code Fast 1', provider: 'xai',
    contextWindow: 256_000, supportsTools: true,
    pricing: { inputPer1M: 0.2, outputPer1M: 1.5 },
  },
  {
    id: 'grok-2-1212', name: 'Grok 2 (1212)', provider: 'xai',
    contextWindow: 131_072, supportsVision: true, supportsTools: true,
    pricing: { inputPer1M: 2, outputPer1M: 10 },
  },

  // ── DeepSeek ──────────────────────────────────────────────────────────────
  {
    id: 'deepseek-chat', name: 'DeepSeek V3', provider: 'deepseek',
    contextWindow: 64_000, supportsTools: true,
    pricing: { inputPer1M: 0.27, outputPer1M: 1.1 },
  },
  {
    id: 'deepseek-reasoner', name: 'DeepSeek R1', provider: 'deepseek',
    contextWindow: 64_000, supportsReasoning: true,
    pricing: { inputPer1M: 0.55, outputPer1M: 2.19 },
  },

  // ── Groq (fast inference) ─────────────────────────────────────────────────
  {
    id: 'llama-3.3-70b-versatile', name: 'Llama 3.3 70B', provider: 'groq',
    contextWindow: 128_000, supportsTools: true,
    pricing: { inputPer1M: 0.59, outputPer1M: 0.79 },
  },
]

// Build a quick lookup index
const MODEL_INDEX = new Map<string, ModelInfo>()
for (const m of MODELS) MODEL_INDEX.set(m.id, m)

// ── Detection ───────────────────────────────────────────────────────────────

/**
 * Detect provider from model name.
 * Falls back to 'unknown' if no pattern matches.
 */
export function detectProviderFromModel(model: string): ProviderId {
  const m = model.toLowerCase()

  // Anthropic
  if (m.includes('claude') || m.startsWith('anthropic/')) return 'anthropic'

  // Google
  if (m.includes('gemini') || m.startsWith('google/')) return 'google'

  // xAI
  if (m.includes('grok') || m.startsWith('xai/')) return 'xai'

  // DeepSeek
  if (m.includes('deepseek') || m.startsWith('deepseek/')) return 'deepseek'

  // Groq models (often prefixed)
  if (m.startsWith('llama-') || m.startsWith('mixtral-') || m.startsWith('groq/')) return 'groq'

  // OpenRouter uses provider/model format
  if (m.startsWith('openrouter/')) return 'openrouter'

  // Mistral
  if (m.includes('mistral') || m.includes('codestral') || m.includes('magistral')) return 'mistral'

  // Cohere
  if (m.includes('command-r') || m.includes('command-a')) return 'cohere'

  // Perplexity
  if (m.startsWith('llama-') && m.includes('instruct') || m.startsWith('perplexity/')) return 'perplexity'

  // OpenAI (gpt-*, o1-*, o3-*, o4-*, text-*, davinci-*)
  if (m.startsWith('gpt') || m.startsWith('o1') || m.startsWith('o3') || m.startsWith('o4') ||
      m.startsWith('text-') || m.startsWith('davinci') || m.startsWith('chatgpt')) {
    return 'openai'
  }

  // Check exact model database
  const info = MODEL_INDEX.get(model)
  if (info) return info.provider

  return 'unknown'
}

/**
 * Detect provider from baseURL.
 */
export function detectProviderFromBaseURL(baseURL?: string): ProviderId | null {
  if (!baseURL) return null
  const url = baseURL.toLowerCase()

  if (url.includes('api.openai.com')) return 'openai'
  if (url.includes('api.anthropic.com')) return 'anthropic'
  if (url.includes('generativelanguage.googleapis.com') || url.includes('gemini')) return 'google'
  if (url.includes('api.x.ai') || url.includes('xai')) return 'xai'
  if (url.includes('openrouter.ai')) return 'openrouter'
  if (url.includes('api.together.xyz')) return 'together'
  if (url.includes('api.groq.com') || url.includes('groq')) return 'groq'
  if (url.includes('api.deepseek.com') || url.includes('deepseek')) return 'deepseek'
  if (url.includes('localhost:11434') || url.includes('ollama')) return 'ollama'
  if (url.includes('api.mistral.ai')) return 'mistral'
  if (url.includes('api.cohere.ai') || url.includes('cohere')) return 'cohere'
  if (url.includes('api.perplexity.ai') || url.includes('perplexity')) return 'perplexity'

  return null
}

/**
 * Detect provider from environment variables.
 * Returns the first provider whose API key env var is set.
 */
export function detectProviderFromEnv(env: NodeJS.ProcessEnv = process.env): ProviderId | null {
  for (const provider of Object.values(PROVIDERS)) {
    if (provider.apiKeyEnv && env[provider.apiKeyEnv]) {
      return provider.id
    }
  }
  return null
}

/**
 * Best-effort provider detection from multiple signals.
 * Priority: explicit model match > model pattern > baseURL > env.
 */
export function detectProvider(input: {
  model?: string
  baseURL?: string
  env?: NodeJS.ProcessEnv
}): ProviderId {
  if (input.model) {
    const fromModel = detectProviderFromModel(input.model)
    if (fromModel !== 'unknown') return fromModel
  }

  const fromURL = detectProviderFromBaseURL(input.baseURL)
  if (fromURL) return fromURL

  const fromEnv = detectProviderFromEnv(input.env)
  if (fromEnv) return fromEnv

  return 'unknown'
}

// ── Lookup ──────────────────────────────────────────────────────────────────

/**
 * Get model info from the database.
 * Returns null for unknown models.
 */
export function getModelInfo(model: string): ModelInfo | null {
  // Exact match
  const exact = MODEL_INDEX.get(model)
  if (exact) return exact

  // Try provider-prefixed (e.g. "anthropic/claude-..." → "claude-...")
  const slashIdx = model.indexOf('/')
  if (slashIdx > 0) {
    const withoutPrefix = model.slice(slashIdx + 1)
    const found = MODEL_INDEX.get(withoutPrefix)
    if (found) return found
  }

  return null
}

/**
 * Get context window size for a model.
 * Falls back to 128k for unknown models.
 */
export function getContextWindow(model: string): number {
  const info = getModelInfo(model)
  return info?.contextWindow ?? 128_000
}

/**
 * Get pricing for a model.
 * Returns zero pricing for unknown models.
 */
export function getModelPricing(model: string): { inputPer1M: number; outputPer1M: number } {
  const info = getModelInfo(model)
  return info?.pricing ?? { inputPer1M: 0, outputPer1M: 0 }
}

/**
 * Check if a model supports a given capability.
 */
export function modelSupports(model: string, capability: 'vision' | 'tools' | 'parallelTools' | 'reasoning'): boolean {
  const info = getModelInfo(model)
  if (!info) return capability === 'tools' // assume tools support by default
  switch (capability) {
    case 'vision': return info.supportsVision ?? false
    case 'tools': return info.supportsTools ?? false
    case 'parallelTools': return info.supportsParallelTools ?? false
    case 'reasoning': return info.supportsReasoning ?? false
  }
}

/**
 * Get provider info by ID.
 */
export function getProvider(id: ProviderId): ProviderInfo {
  return PROVIDERS[id] ?? PROVIDERS.unknown
}

/**
 * List all known provider IDs.
 */
export function listProviders(): ProviderId[] {
  return Object.keys(PROVIDERS).filter(k => k !== 'unknown') as ProviderId[]
}

/**
 * Get the appropriate base URL for a provider.
 * Returns null for providers without a known default.
 */
export function getProviderBaseURL(provider: ProviderId): string | null {
  return PROVIDERS[provider]?.baseURL ?? null
}

/**
 * Get the API key environment variable name for a provider.
 */
export function getProviderAPIKeyEnv(provider: ProviderId): string | null {
  return PROVIDERS[provider]?.apiKeyEnv ?? null
}
