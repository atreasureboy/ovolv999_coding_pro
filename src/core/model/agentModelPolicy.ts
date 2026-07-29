import type { EngineConfig } from '../types.js'
import { resolveModelTier, type ModelTier } from './modelTier.js'

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
  tier: ModelTier
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
  'code-reviewer': ['reviewer', 'worker'],
  explore: ['utility', 'worker'],
  plan: ['planner', 'reviewer'],
  coordinator: ['planner', 'worker'],
}

export class AgentModelAssignmentError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'AgentModelAssignmentError'
  }
}

export function preferredModelRolesForAgent(agentPreset: string): AgentModelRole[] {
  return [...(ROLE_BY_PRESET[agentPreset] ?? ['worker'])]
}

const ARCHITECTURE_PATTERNS: ReadonlyArray<[RegExp, string]> = [
  [/(?:架构).*(?:设计|调整|重构|决策|评审|审计|规划|方案|改造)|(?:设计|调整|重构|决策|评审|审计|规划|方案|改造).*(?:架构)/i, 'architecture decision'],
  [/(?:architecture|architectural).*(?:design|change|refactor|decision|review|audit|plan|migration)|(?:design|change|refactor|decision|review|audit|plan|migration).*(?:architecture|architectural)/i, 'architecture decision'],
  [/(?:跨模块|公共接口|公开接口).{0,24}(?:设计|调整|变更|修改|迁移|重构)|(?:设计|调整|变更|修改|迁移|重构).{0,24}(?:跨模块|公共接口|公开接口)|(?:系统设计|整体改造|全面重构|大规模重构|迁移方案|数据迁移|安全边界|权限模型|一致性协议|分布式设计|根因分析)/i, 'system-wide impact'],
  [/(?:cross[- ]module|public api).{0,48}(?:design|change|modify|refactor|migrate|redesign)|(?:design|change|modify|refactor|migrate|redesign).{0,48}(?:cross[- ]module|public api)|(?:system design|large[- ]scale refactor|migration strategy|data migration|schema migration|security boundary|authorization model|consistency protocol|distributed design|root cause analysis)/i, 'system-wide impact'],
]

export function architectureEscalationReasons(text: string): string[] {
  const normalized = text
    .replace(/\b(?:do not|don't|must not|without)\s+(?:change|modify|redesign|refactor)\s+(?:the\s+)?public api(?:s)?\b/gi, '')
    .replace(/(?:不要|不得|不可|无需)(?:修改|变更|调整|重构)(?:公共接口|公开接口)/g, '')
  return Array.from(new Set(
    ARCHITECTURE_PATTERNS
      .filter(([pattern]) => pattern.test(normalized))
      .map(([, reason]) => reason),
  ))
}

function validRole(value: unknown): value is AgentModelRole {
  return value === 'architect'
    || value === 'builder'
    || value === 'reviewer'
    || value === 'utility'
    || value === 'worker'
    || value === 'planner'
}

function scoreProfile(profile: Record<string, unknown>, roleIndex: number, role: AgentModelRole): number {
  const capabilities = profile.capabilities && typeof profile.capabilities === 'object'
    ? profile.capabilities as Record<string, unknown>
    : {}
  const number = (value: unknown, fallback: number): number =>
    typeof value === 'number' && Number.isFinite(value) ? value : fallback
  const roleWeight = 10 - roleIndex
  if (roleIndex < 0) return -1
  const reasoning = number(capabilities.reasoning, 0.5)
  const coding = number(capabilities.coding, 0.5)
  const toolCalling = number(capabilities.toolCalling, 0.5)
  const speed = number(capabilities.speed, 0.5)
  const cost = number(capabilities.cost, 0.5)
  const quality = role === 'builder'
    ? coding * 3 + reasoning * 2 + toolCalling
    : role === 'reviewer' || role === 'planner' || role === 'architect'
      ? reasoning * 3 + coding * 2 + toolCalling
      : reasoning * 2 + coding * 2 + toolCalling
  return quality * 100 + roleWeight * 5 + speed * 0.05 + cost * 0.02
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
  const requiredTier: ModelTier = options.requestedRole === 'architect' ? 'top' : 'secondary'
  const rawProfiles = config.models?.profiles ?? []
  const unavailableReasons: string[] = []
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
    const tier = resolveModelTier(profile).tier
    if (tier !== requiredTier) {
      const profileLabel = typeof profile.id === 'string' ? profile.id : profile.model
      unavailableReasons.push(
        `${profileLabel} is tier ${tier}, required ${requiredTier}`,
      )
      continue
    }
    const apiKeyEnv = typeof profile.apiKeyEnv === 'string' && /^[A-Z_][A-Z0-9_]*$/.test(profile.apiKeyEnv)
      ? profile.apiKeyEnv
      : undefined
    const apiKey = apiKeyEnv ? env[apiKeyEnv] : config.apiKey
    const provider = typeof profile.provider === 'string'
      ? profile.provider
      : (config.provider ?? 'openai')
    const crossProvider = provider !== (config.provider ?? 'openai')
    if (!apiKey || (crossProvider && !apiKeyEnv)) {
      const profileLabel = typeof profile.id === 'string' ? profile.id : profile.model
      unavailableReasons.push(
        apiKeyEnv
          ? `${apiKeyEnv} is not configured`
          : `${profileLabel} requires its own apiKeyEnv for provider ${provider}`,
      )
      continue
    }
    candidates.push({
      profile,
      role: roles[roleIndex],
      score: scoreProfile(profile, roleIndex, roles[roleIndex]),
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
      tier: requiredTier,
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
  if (rawProfiles.length > 0) {
    const detail = unavailableReasons.length > 0
      ? Array.from(new Set(unavailableReasons)).join('; ')
      : `no configured profile matched roles ${roles.join(', ')}`
    throw new AgentModelAssignmentError(
      `No eligible ${role} sub-agent model: ${detail}. Configure a ${requiredTier} models.profiles entry instead of falling back to another tier.`,
    )
  }
  const reason = `legacy single-model configuration has no role profiles for ${roles.join(', ')}`
  return {
    source: 'parent-fallback',
    profileId: 'parent',
    role,
    tier: 'top',
    provider: config.provider ?? 'openai',
    model: config.model,
    baseURL: config.baseURL,
    apiKey: config.apiKey,
    reason,
    audit: `parent (${config.provider ?? 'openai'}/${config.model})`,
  }
}
