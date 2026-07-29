import { describe, expect, it } from 'vitest'
import {
  preferredModelRolesForAgent,
  resolveAgentModelAssignment,
} from '../src/core/model/agentModelPolicy.js'
import type { EngineConfig } from '../src/core/types.js'
import { ExecutionEngine } from '../src/core/engine.js'
import { resolveAgentConfig } from '../src/core/agentPresets.js'

function config(profiles: unknown[]): EngineConfig {
  return {
    model: 'frontier-main',
    provider: 'openai',
    apiKey: 'main-secret',
    baseURL: 'https://main.example/v1',
    models: { profiles },
    maxIterations: 20,
    cwd: '/repo',
    permissionMode: 'auto',
  }
}

describe('agent model policy', () => {
  it('maps agent presets to capability roles', () => {
    expect(preferredModelRolesForAgent('general-purpose')).toEqual(['builder', 'worker'])
    expect(preferredModelRolesForAgent('code-reviewer')).toEqual(['reviewer', 'architect'])
    expect(preferredModelRolesForAgent('explore')).toEqual(['utility', 'worker'])
    expect(preferredModelRolesForAgent('plan')).toEqual(['architect', 'planner'])
  })

  it('assigns a cross-provider builder profile and resolves only its env key', () => {
    const assignment = resolveAgentModelAssignment(
      config([
        {
          id: 'architect',
          provider: 'openai',
          model: 'frontier-main',
          roles: ['main', 'architect'],
          capabilities: { reasoning: 1, coding: 0.9 },
        },
        {
          id: 'builder',
          provider: 'minimax',
          model: 'builder-model',
          baseURL: 'https://builder.example/v1',
          apiKeyEnv: 'BUILDER_API_KEY',
          roles: ['builder', 'worker'],
          capabilities: { reasoning: 0.75, coding: 0.95 },
        },
      ]),
      { agentPreset: 'general-purpose', env: { BUILDER_API_KEY: 'builder-secret' } },
    )

    expect(assignment).toMatchObject({
      source: 'role-profile',
      profileId: 'builder',
      role: 'builder',
      provider: 'minimax',
      model: 'builder-model',
      baseURL: 'https://builder.example/v1',
      apiKey: 'builder-secret',
      apiKeyEnv: 'BUILDER_API_KEY',
    })
    expect(assignment.audit).not.toContain('builder-secret')
  })

  it('falls back to the parent transport when a matching profile key is unavailable', () => {
    const assignment = resolveAgentModelAssignment(
      config([{
        id: 'builder',
        provider: 'minimax',
        model: 'builder-model',
        apiKeyEnv: 'MISSING_KEY',
        roles: ['builder'],
      }]),
      { agentPreset: 'general-purpose', env: {} },
    )

    expect(assignment).toMatchObject({
      source: 'parent-fallback',
      model: 'frontier-main',
      apiKey: 'main-secret',
    })
    expect(assignment.reason).toContain('MISSING_KEY')
  })

  it('honors an explicit reviewer role without accepting arbitrary profile ids', () => {
    const assignment = resolveAgentModelAssignment(
      config([
        { id: 'cheap', provider: 'openai', model: 'cheap-model', roles: ['utility'] },
        { id: 'review', provider: 'openai', model: 'review-model', roles: ['reviewer'] },
      ]),
      { agentPreset: 'general-purpose', requestedRole: 'reviewer', env: {} },
    )

    expect(assignment.profileId).toBe('review')
    expect(assignment.role).toBe('reviewer')
  })

  it('keeps cross-provider worker profiles out of the main-agent router', () => {
    const engine = new ExecutionEngine(
      config([
        { id: 'architect', provider: 'openai', model: 'frontier-main', roles: ['main', 'architect'] },
        {
          id: 'builder',
          provider: 'minimax',
          model: 'builder-model',
          apiKeyEnv: 'BUILDER_API_KEY',
          roles: ['builder', 'worker'],
        },
      ]),
      {} as never,
      { chat: { completions: { create: () => Promise.reject(new Error('not called')) } } } as never,
    )

    expect(engine.getModelRouter().listProfiles().map((profile) => profile.id)).toEqual(['architect'])
    engine.dispose()
  })

  it('pins a child engine to its assigned model instead of rerouting it to architect', () => {
    const childConfig = config([
      { id: 'architect', provider: 'openai', model: 'frontier-main', roles: ['main', 'architect'] },
      { id: 'builder', provider: 'openai', model: 'builder-model', roles: ['builder'] },
    ])
    childConfig.model = 'builder-model'
    childConfig.agent = resolveAgentConfig({ preset: 'general-purpose' })

    const engine = new ExecutionEngine(
      childConfig,
      {} as never,
      { chat: { completions: { create: () => Promise.reject(new Error('not called')) } } } as never,
    )

    expect(engine.getModelRouter().listProfiles().map((profile) => profile.model)).toEqual(['builder-model'])
    engine.dispose()
  })
})
