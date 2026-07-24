/**
 * ModelRuntimeManager (v0.3.1, te_goal §三.1.2).
 *
 * Owns the resolution of ModelProfile → ProviderRuntimeBinding and
 * validates that profiles are consistent with the active transport.
 * The current code is "single-transport mode" — only one provider
 * client is constructed at engine boot and every profile must target
 * that provider. This is te_goal's explicit fallback when the engine
 * does NOT implement cross-Provider Client management: "在配置验证
 * 阶段拒绝不同 Provider 的 profile".
 *
 * Functions:
 *   - validateProfiles(activeProvider, profiles)
 *       Throws if any profile declares a provider other than the active one.
 *   - resolveBindings(activeProvider, baseURL, apiKeyRef, adapter, profiles)
 *       Returns a binding per profile. Adapter is shared (same transport).
 *   - resolveBinding(activeProvider, baseURL, apiKeyRef, adapter, profile)
 *       One-shot helper for tests + the single-profile path.
 */
import type { ProviderAdapter } from './providerAdapter.js'
import type { ModelProfile } from './modelRouter.js'
import type { ProviderRuntimeBinding } from './providerRuntimeBinding.js'

/**
 * Provider ids that the runtime can route to in single-transport mode.
 * This is intentionally a hard list (not the union from providers.ts)
 * because runtime policy diverges from provider metadata:
 *   - 'minimax' is not in providers.ts but is a runtime-eligible
 *     OpenAI-compatible provider (CLI resolves it from baseURL).
 *   - 'openai-compatible' is the generic placeholder the adapter
 *     factory returns when nothing matches.
 */
export const RUNTIME_KNOWN_PROVIDERS = new Set<string>([
  'openai',
  'minimax',
  'openai-compatible',
])

export class ProfileValidationError extends Error {
  readonly offendingProfileIds: string[]
  constructor(message: string, offendingProfileIds: string[]) {
    super(message)
    this.name = 'ProfileValidationError'
    this.offendingProfileIds = offendingProfileIds
  }
}

export interface ValidateProfilesOptions {
  /** The active provider id (EngineConfig.provider). */
  activeProvider: string
  /** Profiles to validate. */
  profiles: ModelProfile[]
}

/**
 * Validate profiles against the active transport.
 *
 * Throws ProfileValidationError listing offending profiles when:
 *   - any profile declares a provider that differs from activeProvider
 *     (te_goal §三.1.2 strict rule: "拒绝不同 Provider 的 profile")
 *   - any two profiles share the same id OR the same model name
 *     (would collapse health stats / ambiguity).
 *
 * Profiles that omit provider are allowed (treated as matching
 * activeProvider) for back-compat with the existing config shape.
 */
export function validateProfiles(opts: ValidateProfilesOptions): void {
  const { activeProvider, profiles } = opts
  const seenIds = new Set<string>()
  const seenModels = new Set<string>()
  const offending: string[] = []
  for (const p of profiles) {
    if (seenIds.has(p.id)) offending.push(p.id)
    else seenIds.add(p.id)
    if (seenModels.has(p.model)) offending.push(p.model)
    else seenModels.add(p.model)
    // Cross-provider rejection: any declared provider that differs
    // from activeProvider is a misconfiguration in single-transport
    // mode. We allow the active provider AND profiles that omit
    // provider (legacy shape) but reject everything else — including
    // non-runtime providers like anthropic/google that the runtime
    // could not serve even if it tried.
    if (p.provider && p.provider !== activeProvider) {
      offending.push(p.id)
    }
  }
  if (offending.length > 0) {
    throw new ProfileValidationError(
      `Profile validation failed: profiles [${Array.from(new Set(offending)).join(', ')}] ` +
      `are inconsistent with active provider "${activeProvider}". ` +
      `This engine runs in single-transport mode; either change config.models.profiles ` +
      `to target "${activeProvider}", or restart with --provider <that provider>.`,
      Array.from(new Set(offending)),
    )
  }
}

export interface ResolveBindingsOptions {
  activeProvider: string
  baseURL?: string
  apiKeyRef?: string
  adapter: ProviderAdapter
  profiles: ModelProfile[]
}

export function resolveBindings(opts: ResolveBindingsOptions): ProviderRuntimeBinding[] {
  return opts.profiles.map((p) => resolveBinding({
    activeProvider: opts.activeProvider,
    baseURL: opts.baseURL,
    apiKeyRef: opts.apiKeyRef,
    adapter: opts.adapter,
    profile: p,
  }))
}

export function resolveBinding(opts: {
  activeProvider: string
  baseURL?: string
  apiKeyRef?: string
  adapter: ProviderAdapter
  profile: ModelProfile
}): ProviderRuntimeBinding {
  return {
    profileId: opts.profile.id,
    provider: opts.activeProvider,
    model: opts.profile.model,
    baseURL: opts.baseURL,
    apiKeyRef: opts.apiKeyRef,
    adapter: opts.adapter,
    capabilities: opts.profile.capabilities,
    roles: opts.profile.roles,
  }
}

/**
 * A tiny registry of current bindings. The Engine consults this for
 * Router health attribution and for /models output. It is intentionally
 * read-only from the outside — bindings change only when profiles or
 * the active provider change, both of which require engine restart.
 */
export class BindingRegistry {
  private readonly map = new Map<string, ProviderRuntimeBinding>()
  constructor(initial: ProviderRuntimeBinding[] = []) {
    for (const b of initial) this.map.set(b.profileId, b)
  }
  list(): ProviderRuntimeBinding[] {
    return [...this.map.values()]
  }
  get(profileId: string): ProviderRuntimeBinding | undefined {
    return this.map.get(profileId)
  }
  resolveModelToProfile(model: string): ProviderRuntimeBinding | undefined {
    for (const b of this.map.values()) if (b.model === model) return b
    return undefined
  }
}