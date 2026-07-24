/**
 * ProviderRuntimeBinding (v0.3.1, te_goal §三.1.2).
 *
 * A binding is the resolved, runtime form of a ModelProfile: it carries
 * the profile id, the active transport, the model name, the endpoint,
 * the API-key ref, the adapter instance, and the typed capabilities.
 * Without this, profile→model is the only identity the runtime knows,
 * which forces cross-provider switching to masquerade as a string
 * rename. With this binding object, the Router's choice can be
 * represented consistently across Engine / ContextManager / Gateway.
 *
 * The current implementation is "single-transport mode": all profiles
 * must target the same provider as the engine. The ModelRuntimeManager
 * rejects cross-provider profiles at config-validation time so the
 * runtime never has to swap transports. te_goal.md §三.1.2 explicitly
 * allows this fallback ("配置验证阶段拒绝不同 Provider 的 profile").
 */
import type { ProviderAdapter } from './providerAdapter.js'
import type { ModelCapabilities } from './modelRouter.js'

export interface ProviderRuntimeBinding {
  /** Profile id (e.g. 'main', 'cheap') — stable across re-routes. */
  profileId: string
  /** Active provider id (e.g. 'openai', 'minimax', 'openai-compatible'). */
  provider: string
  /** Concrete model name (e.g. 'gpt-4o', 'MiniMax-M3'). */
  model: string
  /** Endpoint baseURL — defaults to whatever the adapter was constructed with. */
  baseURL?: string
  /** Env-var reference for the API key, e.g. 'OPENAI_API_KEY'. */
  apiKeyRef?: string
  /** Adapter instance this binding uses. */
  adapter: ProviderAdapter
  /** Capabilities mirrored from the profile (for quick lookup). */
  capabilities: ModelCapabilities
  /** Roles this profile can serve. */
  roles: string[]
}