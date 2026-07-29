import type { EngineConfig } from '../types.js'

export type AgentModelRole =
  | 'architect'
  | 'builder'
  | 'reviewer'
  | 'utility'
  | 'worker'
  | 'planner'

export interface AgentModelAssignment {
  source: 'role-profile' | 'parent-fallback'
  profileId: string
  role: AgentModelRole
  provider: string
  model: string
  baseURL?: string
  apiKey: string
  apiKeyEnv?: string
  reason: string
  audit: string
}

const ROLE_BY_PRESET: Readonly<Record<string, AgentModelRole[]>> = {
  'general-purpose': ['builder', 'worker'],
  'code-reviewer': ['reviewer', 'architect'],
  explore: ['utility', 'worker'],
  plan: ['architect', 'planner'],
  coordinator: ['architect'],
}

export function preferredModelRolesForAgent(agentPreset: string): AgentModelRole[] {
  return [...(ROLE_BY_PRESET[agentPreset] ?? ['worker'])]
}

function validRole(value: unknown): value is AgentModelRole {
  return value === 'architect'
    || value === 'builder'
    || value === 'reviewer'
    || value === 'utility'
    || value === 'worker'
    || value === 'planner'
}

function scoreProfile(profile: Record<string, unknown>, roleIndex: number): number {
  const capabilities = profile.capabilities && typeof profile.capabilities === 'object'
    ? profile.capabilities as Record<string, unknown>
    : {}
  const number = (value: unknown, fallback: number): number =>
    typeof value === 'number' && Number.isFinite(value) ? value : fallback
  const roleWeight = 10 - roleIndex
  if (roleIndex < 0) return -1
  if (roleIndex === 0 && (profile.roles as unknown[])?.includes('architect')) {
    return roleWeight + number(capabilities.reasoning, 0.5) * 2
  }
  return roleWeight
    + number(capabilities.coding, 0.5)
    + number(capabilities.reasoning, 0.5)
    + number(capabilities.cost, 0.5) * 0.25
}

export function resolveAgentModelAssignment(
  config: EngineConfig,
  options: {
    agentPreset: string
    requestedRole?: AgentModelRole
    env?: Readonly<Record<string, string | undefined>>
  },
): AgentModelAssignment {
  const env = options.env ?? process.env
  const roles = options.requestedRole
    ? [options.requestedRole]
    : preferredModelRolesForAgent(options.agentPreset)
  const rawProfiles = config.models?.profiles ?? []
  const unavailableKeys: string[] = []
  const candidates: Array<{
    profile: Record<string, unknown>
    role: AgentModelRole
    score: number
    apiKey: string
    apiKeyEnv?: string
  }> = []

  for (const raw of rawProfiles) {
    if (!raw || typeof raw !== 'object') continue
    const profile = raw as Record<string, unknown>
    if (profile.available === false || typeof profile.model !== 'string' || !profile.model) continue
    const profileRoles = Array.isArray(profile.roles)
      ? profile.roles.filter((role): role is string => typeof role === 'string')
      : []
    const roleIndex = roles.findIndex((role) => profileRoles.includes(role))
    if (roleIndex < 0) continue
    const apiKeyEnv = typeof profile.apiKeyEnv === 'string' && /^[A-Z_][A-Z0-9_]*$/.test(profile.apiKeyEnv)
      ? profile.apiKeyEnv
      : undefined
    const apiKey = apiKeyEnv ? env[apiKeyEnv] : config.apiKey
    const provider = typeof profile.provider === 'string'
      ? profile.provider
      : (config.provider ?? 'openai')
    const crossProvider = provider !== (config.provider ?? 'openai')
    if (!apiKey || (crossProvider && !apiKeyEnv)) {
      if (apiKeyEnv) unavailableKeys.push(apiKeyEnv)
      continue
    }
    candidates.push({
      profile,
      role: roles[roleIndex],
      score: scoreProfile(profile, roleIndex),
      apiKey,
      apiKeyEnv,
    })
  }

  candidates.sort((a, b) => b.score - a.score)
  const selected = candidates[0]
  if (selected) {
    const profileId = typeof selected.profile.id === 'string'
      ? selected.profile.id
      : String(selected.profile.model)
    const provider = typeof selected.profile.provider === 'string'
      ? selected.profile.provider
      : (config.provider ?? 'openai')
    const baseURL = typeof selected.profile.baseURL === 'string'
      ? selected.profile.baseURL
      : config.baseURL
    return {
      source: 'role-profile',
      profileId,
      role: selected.role,
      provider,
      model: String(selected.profile.model),
      baseURL,
      apiKey: selected.apiKey,
      apiKeyEnv: selected.apiKeyEnv,
      reason: `matched role ${selected.role}`,
      audit: `${profileId} (${provider}/${String(selected.profile.model)}) via ${selected.apiKeyEnv ?? 'parent credential'}`,
    }
  }

  const role = roles[0] && validRole(roles[0]) ? roles[0] : 'worker'
  const reason = unavailableKeys.length > 0
    ? `matching profile unavailable because ${Array.from(new Set(unavailableKeys)).join(', ')} is not configured`
    : `no available profile matched roles ${roles.join(', ')}`
  return {
    source: 'parent-fallback',
    profileId: 'parent',
    role,
    provider: config.provider ?? 'openai',
    model: config.model,
    baseURL: config.baseURL,
    apiKey: config.apiKey,
    reason,
    audit: `parent (${config.provider ?? 'openai'}/${config.model})`,
  }
}
