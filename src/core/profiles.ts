/**
 * Profile Manager
 *
 * Manage multiple configuration profiles (e.g., work vs personal,
 * different API providers, different permission levels).
 */

import { existsSync, readFileSync } from 'fs'
import { atomicWriteSync, preserveCorruptFile } from './atomicWrite.js'
import { join, resolve } from 'path'

// ── Types ───────────────────────────────────────────────────────────────────

export interface Profile {
  /** Unique name */
  name: string
  /** Display name */
  displayName?: string
  /** Description */
  description?: string
  /** Provider configuration */
  provider?: {
    name: string
    model?: string
    apiKeyEnv?: string
    baseUrl?: string
  }
  /** Permission level */
  permissionLevel?: 'strict' | 'normal' | 'permissive'
  /** Model preferences */
  modelPrefs?: {
    temperature?: number
    maxTokens?: number
    systemPrompt?: string
  }
  /** UI preferences */
  uiPrefs?: {
    theme?: string
    showTokens?: boolean
    showCost?: boolean
    vim?: boolean
  }
  /** Environment variable overrides */
  env?: Record<string, string>
  /** Whether this is the active profile */
  active?: boolean
  /** When created */
  createdAt: string
  /** Custom metadata */
  metadata?: Record<string, unknown>
}

export interface ProfileStore {
  profiles: Record<string, Profile>
  activeProfile: string | null
}

// ── Persistence ─────────────────────────────────────────────────────────────

export function getProfilePath(cwd: string): string {
  return join(resolve(cwd), '.ovolv999', 'profiles.json')
}

function isShapedProfileStore(parsed: unknown): parsed is ProfileStore {
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return false
  const store = parsed as ProfileStore
  if (typeof store.profiles !== 'object' || store.profiles === null || Array.isArray(store.profiles)) return false
  if (store.activeProfile !== null && typeof store.activeProfile !== 'string') return false
  return Object.values(store.profiles).every((p) => typeof p === 'object' && p !== null)
}

export function loadProfiles(cwd: string): ProfileStore {
  const path = getProfilePath(cwd)
  if (!existsSync(path)) {
    return { profiles: {}, activeProfile: null }
  }
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'))
    // §profiles store: CRUD is load→mutate→save — a half-written store must
    // not load, or the next create/remove replaces every profile with the
    // empty default.
    if (!isShapedProfileStore(parsed)) throw new Error('profile store shape violation')
    return parsed
  } catch {
    preserveCorruptFile(path)
    return { profiles: {}, activeProfile: null }
  }
}

export function saveProfiles(cwd: string, store: ProfileStore): void {
  atomicWriteSync(getProfilePath(cwd), JSON.stringify(store, null, 2))
}

// ── CRUD ────────────────────────────────────────────────────────────────────

export function createProfile(
  cwd: string,
  name: string,
  config: Partial<Omit<Profile, 'name' | 'createdAt'>> = {},
): Profile {
  const store = loadProfiles(cwd)
  const profile: Profile = {
    name,
    displayName: config.displayName,
    description: config.description,
    provider: config.provider,
    permissionLevel: config.permissionLevel ?? 'normal',
    modelPrefs: config.modelPrefs,
    uiPrefs: config.uiPrefs,
    env: config.env,
    metadata: config.metadata,
    createdAt: new Date().toISOString(),
  }

  store.profiles[name] = profile

  // If first profile, make it active
  if (!store.activeProfile) {
    store.activeProfile = name
  }

  saveProfiles(cwd, store)
  return profile
}

export function removeProfile(cwd: string, name: string): boolean {
  const store = loadProfiles(cwd)
  if (!store.profiles[name]) return false

  delete store.profiles[name]

  // Switch active if needed
  if (store.activeProfile === name) {
    const remaining = Object.keys(store.profiles)
    store.activeProfile = remaining[0] ?? null
  }

  saveProfiles(cwd, store)
  return true
}

export function getProfile(cwd: string, name: string): Profile | null {
  const store = loadProfiles(cwd)
  return store.profiles[name] ?? null
}

export function getActiveProfile(cwd: string): Profile | null {
  const store = loadProfiles(cwd)
  if (!store.activeProfile) return null
  return store.profiles[store.activeProfile] ?? null
}

export function setActiveProfile(cwd: string, name: string): boolean {
  const store = loadProfiles(cwd)
  if (!store.profiles[name]) return false
  store.activeProfile = name
  saveProfiles(cwd, store)
  return true
}

export function listProfiles(cwd: string): Profile[] {
  const store = loadProfiles(cwd)
  return Object.values(store.profiles)
}

export function updateProfile(
  cwd: string,
  name: string,
  updates: Partial<Profile>,
): Profile | null {
  const store = loadProfiles(cwd)
  const profile = store.profiles[name]
  if (!profile) return null

  Object.assign(profile, updates)
  saveProfiles(cwd, store)
  return profile
}

// ── Profile Cloning ─────────────────────────────────────────────────────────

export function cloneProfile(
  cwd: string,
  sourceName: string,
  newName: string,
  overrides: Partial<Profile> = {},
): Profile | null {
  const source = getProfile(cwd, sourceName)
  if (!source) return null

  return createProfile(cwd, newName, {
    displayName: source.displayName,
    description: source.description,
    provider: source.provider ? { ...source.provider } : undefined,
    permissionLevel: source.permissionLevel,
    modelPrefs: source.modelPrefs ? { ...source.modelPrefs } : undefined,
    uiPrefs: source.uiPrefs ? { ...source.uiPrefs } : undefined,
    env: source.env ? { ...source.env } : undefined,
    metadata: source.metadata ? { ...source.metadata } : undefined,
    ...overrides,
  })
}

// ── Profile Export/Import ───────────────────────────────────────────────────

export function exportProfile(cwd: string, name: string): string | null {
  const profile = getProfile(cwd, name)
  if (!profile) return null
  return JSON.stringify(profile, null, 2)
}

export function importProfile(cwd: string, json: string, name?: string): Profile | null {
  try {
    const data = JSON.parse(json) as Profile
    const profileName = name ?? data.name
    if (!profileName) return null
    return createProfile(cwd, profileName, data)
  } catch {
    return null
  }
}

// ── Effective Configuration ─────────────────────────────────────────────────

export interface EffectiveConfig {
  provider: { name: string; model?: string; baseUrl?: string }
  permissionLevel: string
  temperature: number
  maxTokens: number | undefined
  systemPrompt: string | undefined
  env: Record<string, string>
}

const DEFAULTS: EffectiveConfig = {
  provider: { name: 'openai' },
  permissionLevel: 'normal',
  temperature: 0.7,
  maxTokens: undefined,
  systemPrompt: undefined,
  env: {},
}

export function getEffectiveConfig(cwd: string): EffectiveConfig {
  const profile = getActiveProfile(cwd)
  if (!profile) return { ...DEFAULTS }

  return {
    provider: {
      name: profile.provider?.name ?? DEFAULTS.provider.name,
      model: profile.provider?.model,
      baseUrl: profile.provider?.baseUrl,
    },
    permissionLevel: profile.permissionLevel ?? DEFAULTS.permissionLevel,
    temperature: profile.modelPrefs?.temperature ?? DEFAULTS.temperature,
    maxTokens: profile.modelPrefs?.maxTokens,
    systemPrompt: profile.modelPrefs?.systemPrompt,
    env: profile.env ?? {},
  }
}

// ── Built-in Profiles ───────────────────────────────────────────────────────

export const BUILTIN_PROFILES: Array<{ name: string; config: Partial<Profile> }> = [
  {
    name: 'default',
    config: {
      displayName: 'Default',
      description: 'Balanced settings for general development',
      permissionLevel: 'normal',
      modelPrefs: { temperature: 0.7 },
    },
  },
  {
    name: 'strict',
    config: {
      displayName: 'Strict Mode',
      description: 'Maximum safety — all operations require approval',
      permissionLevel: 'strict',
      modelPrefs: { temperature: 0.3 },
    },
  },
  {
    name: 'creative',
    config: {
      displayName: 'Creative Mode',
      description: 'Higher temperature for brainstorming and exploration',
      permissionLevel: 'normal',
      modelPrefs: { temperature: 1.0 },
    },
  },
  {
    name: 'yolo',
    config: {
      displayName: 'YOLO Mode',
      description: 'Minimal confirmations — for trusted environments only',
      permissionLevel: 'permissive',
      modelPrefs: { temperature: 0.7 },
    },
  },
]

export function initializeBuiltinProfiles(cwd: string): Profile[] {
  return BUILTIN_PROFILES.map(({ name, config }) =>
    createProfile(cwd, name, config),
  )
}

// ── Formatting ──────────────────────────────────────────────────────────────

export function formatProfile(profile: Profile): string {
  const lines: string[] = [
    `Profile: ${profile.displayName ?? profile.name}${profile.active ? ' (active)' : ''}`,
  ]
  if (profile.description) lines.push(`  ${profile.description}`)

  if (profile.provider) {
    lines.push(`  Provider: ${profile.provider.name}`)
    if (profile.provider.model) lines.push(`  Model: ${profile.provider.model}`)
    if (profile.provider.baseUrl) lines.push(`  Base URL: ${profile.provider.baseUrl}`)
  }

  if (profile.permissionLevel) {
    lines.push(`  Permission: ${profile.permissionLevel}`)
  }

  if (profile.modelPrefs) {
    if (profile.modelPrefs.temperature !== undefined) {
      lines.push(`  Temperature: ${profile.modelPrefs.temperature}`)
    }
    if (profile.modelPrefs.maxTokens !== undefined) {
      lines.push(`  Max Tokens: ${profile.modelPrefs.maxTokens}`)
    }
  }

  if (profile.uiPrefs) {
    const prefStrs: string[] = []
    if (profile.uiPrefs.theme) prefStrs.push(`theme=${profile.uiPrefs.theme}`)
    if (profile.uiPrefs.vim !== undefined) prefStrs.push(`vim=${profile.uiPrefs.vim}`)
    if (prefStrs.length > 0) lines.push(`  UI: ${prefStrs.join(', ')}`)
  }

  if (profile.env && Object.keys(profile.env).length > 0) {
    lines.push(`  Env vars: ${Object.keys(profile.env).join(', ')}`)
  }

  return lines.join('\n')
}

export function formatProfileList(profiles: Profile[], activeName?: string | null): string {
  if (profiles.length === 0) return 'No profiles configured.'

  const lines: string[] = [`Profiles (${profiles.length}):`]
  for (const p of profiles) {
    const active = p.name === activeName ? ' ← active' : ''
    const display = p.displayName ? ` (${p.displayName})` : ''
    const provider = p.provider ? ` [${p.provider.name}]` : ''
    const perm = p.permissionLevel ? ` {${p.permissionLevel}}` : ''
    lines.push(`  ${p.name}${display}${provider}${perm}${active}`)
  }

  return lines.join('\n')
}

export function formatEffectiveConfig(config: EffectiveConfig): string {
  const lines: string[] = [
    'Effective Configuration:',
    `  Provider: ${config.provider.name}`,
  ]
  if (config.provider.model) lines.push(`  Model: ${config.provider.model}`)
  if (config.provider.baseUrl) lines.push(`  Base URL: ${config.provider.baseUrl}`)
  lines.push(`  Permission: ${config.permissionLevel}`)
  lines.push(`  Temperature: ${config.temperature}`)
  if (config.maxTokens) lines.push(`  Max Tokens: ${config.maxTokens}`)
  if (config.systemPrompt) lines.push(`  System Prompt: (custom)`)
  if (Object.keys(config.env).length > 0) {
    lines.push(`  Env: ${Object.keys(config.env).join(', ')}`)
  }
  return lines.join('\n')
}
