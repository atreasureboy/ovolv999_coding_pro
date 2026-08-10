export type ModelTier = 'top' | 'secondary'

export interface ModelTierResolution {
  tier: ModelTier
  inferred: boolean
}

export interface ConfiguredModelTierProfile {
  id: string
  provider: string
  model: string
  tier: ModelTier
  tierInferred: boolean
  roles: string[]
  available: boolean
  baseURL?: string
  apiKeyEnv?: string
  capabilities: Record<string, number>
}

export function resolveModelTier(profile: { tier?: string; roles?: unknown }): ModelTierResolution {
  if (profile.tier === 'top' || profile.tier === 'secondary') {
    return { tier: profile.tier, inferred: false }
  }
  const roles = Array.isArray(profile.roles)
    ? profile.roles.filter((role): role is string => typeof role === 'string')
    : []
  return {
    tier: roles.includes('main') || roles.includes('architect') ? 'top' : 'secondary',
    inferred: true,
  }
}

/** CLI-only: used by `/model list` in builtin.ts. Not consumed by the runtime engine. */
export function listConfiguredModelTierProfiles(
  rawProfiles: unknown,
  defaultProvider: string,
): ConfiguredModelTierProfile[] {
  if (!Array.isArray(rawProfiles)) return []
  return rawProfiles.flatMap((raw) => {
    if (!raw || typeof raw !== 'object') return []
    const profile = raw as Record<string, unknown>
    if (typeof profile.model !== 'string' || !profile.model) return []
    const resolution = resolveModelTier(profile)
    const rawCapabilities = profile.capabilities && typeof profile.capabilities === 'object'
      ? profile.capabilities as Record<string, unknown>
      : {}
    const capabilities = Object.fromEntries(
      Object.entries(rawCapabilities)
        .filter((entry): entry is [string, number] =>
          typeof entry[1] === 'number' && Number.isFinite(entry[1]),
        ),
    )
    return [{
      id: typeof profile.id === 'string' && profile.id ? profile.id : profile.model,
      provider: typeof profile.provider === 'string' && profile.provider
        ? profile.provider
        : defaultProvider,
      model: profile.model,
      tier: resolution.tier,
      tierInferred: resolution.inferred,
      roles: Array.isArray(profile.roles)
        ? profile.roles.filter((role): role is string => typeof role === 'string')
        : [],
      available: profile.available !== false,
      baseURL: typeof profile.baseURL === 'string' ? profile.baseURL : undefined,
      apiKeyEnv: typeof profile.apiKeyEnv === 'string' ? profile.apiKeyEnv : undefined,
      capabilities,
    }]
  })
}
