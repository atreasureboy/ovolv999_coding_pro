/**
 * v0.3.1 ModelRuntimeManager (te_goal §三.1.2).
 *
 * Verifies:
 *   - validateProfiles accepts same-provider profiles
 *   - validateProfiles rejects cross-provider profiles that target a
 *     different known runtime provider
 *   - validateProfiles rejects duplicate profile ids and model names
 *   - resolveBindings returns one ProviderRuntimeBinding per profile
 *   - BindingRegistry exposes list/get/resolveModelToProfile
 */
import { describe, it, expect } from 'vitest'
import {
  validateProfiles,
  resolveBindings,
  resolveBinding,
  BindingRegistry,
  ProfileValidationError,
  RUNTIME_KNOWN_PROVIDERS,
} from '../src/core/model/modelRuntimeManager.js'
import type { ModelProfile } from '../src/core/model/modelRouter.js'

const fakeAdapter = { providerId: 'openai', streamUsageSupported: false } as never

const p = (id: string, model: string, provider: string): ModelProfile => ({
  id, provider, model, available: true,
  capabilities: { reasoning: 0.5, coding: 0.5, contextWindow: 128_000, toolCalling: 0.7, speed: 0.5, cost: 0.5 },
  roles: ['main'],
})

describe('ModelRuntimeManager v0.3.1', () => {
  it('accepts profiles matching the active provider', () => {
    expect(() => validateProfiles({
      activeProvider: 'openai',
      profiles: [p('main', 'gpt-4o', 'openai'), p('cheap', 'gpt-4o-mini', 'openai')],
    })).not.toThrow()
  })

  it('rejects cross-provider profiles that target another known runtime provider', () => {
    expect(() => validateProfiles({
      activeProvider: 'openai',
      profiles: [p('main', 'gpt-4o', 'openai'), p('claude', 'claude-sonnet', 'anthropic')],
    })).toThrow(ProfileValidationError)
  })

  it('rejects duplicate profile ids', () => {
    expect(() => validateProfiles({
      activeProvider: 'openai',
      profiles: [p('main', 'a', 'openai'), p('main', 'b', 'openai')],
    })).toThrow(ProfileValidationError)
  })

  it('rejects duplicate model names', () => {
    expect(() => validateProfiles({
      activeProvider: 'openai',
      profiles: [p('a', 'gpt-4o', 'openai'), p('b', 'gpt-4o', 'openai')],
    })).toThrow(ProfileValidationError)
  })

  it('exposes the offending profile ids on ProfileValidationError', () => {
    try {
      validateProfiles({
        activeProvider: 'openai',
        profiles: [p('claude', 'claude-sonnet', 'anthropic'), p('gemini', 'gemini-pro', 'google')],
      })
      throw new Error('should have thrown')
    } catch (err) {
      expect(err).toBeInstanceOf(ProfileValidationError)
      const e = err as ProfileValidationError
      expect(e.offendingProfileIds).toContain('claude')
    }
  })

  it('allows minimax as a runtime provider (not in providers.ts but in RUNTIME_KNOWN_PROVIDERS)', () => {
    expect(RUNTIME_KNOWN_PROVIDERS.has('minimax')).toBe(true)
    expect(() => validateProfiles({
      activeProvider: 'minimax',
      profiles: [p('main', 'MiniMax-M3', 'minimax')],
    })).not.toThrow()
  })

  it('resolveBindings returns one binding per profile sharing the adapter', () => {
    const bindings = resolveBindings({
      activeProvider: 'openai',
      baseURL: 'https://api.openai.com/v1',
      apiKeyRef: 'OPENAI_API_KEY',
      adapter: fakeAdapter,
      profiles: [p('main', 'gpt-4o', 'openai'), p('cheap', 'mini', 'openai')],
    })
    expect(bindings.length).toBe(2)
    expect(bindings[0].profileId).toBe('main')
    expect(bindings[0].adapter).toBe(fakeAdapter)
    expect(bindings[0].baseURL).toBe('https://api.openai.com/v1')
    expect(bindings[1].profileId).toBe('cheap')
  })

  it('resolveBinding carries every typed field', () => {
    const b = resolveBinding({
      activeProvider: 'openai',
      baseURL: 'https://x',
      apiKeyRef: 'OPENAI_API_KEY',
      adapter: fakeAdapter,
      profile: p('main', 'gpt-4o', 'openai'),
    })
    expect(b.profileId).toBe('main')
    expect(b.provider).toBe('openai')
    expect(b.model).toBe('gpt-4o')
    expect(b.baseURL).toBe('https://x')
    expect(b.apiKeyRef).toBe('OPENAI_API_KEY')
    expect(b.capabilities.contextWindow).toBe(128_000)
  })

  it('BindingRegistry resolves by id and by model name', () => {
    const b1 = resolveBinding({
      activeProvider: 'openai', adapter: fakeAdapter,
      profile: p('main', 'gpt-4o', 'openai'),
    })
    const b2 = resolveBinding({
      activeProvider: 'openai', adapter: fakeAdapter,
      profile: p('cheap', 'mini', 'openai'),
    })
    const reg = new BindingRegistry([b1, b2])
    expect(reg.list().length).toBe(2)
    expect(reg.get('main')?.model).toBe('gpt-4o')
    expect(reg.resolveModelToProfile('mini')?.profileId).toBe('cheap')
    expect(reg.resolveModelToProfile('unknown')).toBeUndefined()
  })
})