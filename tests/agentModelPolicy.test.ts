import { describe, expect, it } from 'vitest'
import {
  architectureEscalationReasons,
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
    expect(preferredModelRolesForAgent('code-reviewer')).toEqual(['reviewer', 'worker'])
    expect(preferredModelRolesForAgent('explore')).toEqual(['utility', 'worker'])
    expect(preferredModelRolesForAgent('plan')).toEqual(['planner', 'reviewer'])
    expect(preferredModelRolesForAgent('coordinator')).toEqual(['planner', 'worker'])
  })

  it('detects architecture-sensitive delegations in Chinese and English', () => {
    expect(architectureEscalationReasons('设计跨模块公共接口并调整整体架构')).not.toEqual([])
    expect(architectureEscalationReasons('Plan a schema migration and security boundary')).not.toEqual([])
    expect(architectureEscalationReasons('读取 src/core/engine.ts 并总结内容')).toEqual([])
    expect(architectureEscalationReasons('Implement the already-specified parser helper')).toEqual([])
    expect(architectureEscalationReasons('Implement the helper without changing public APIs')).toEqual([])
  })

  it('assigns a cross-provider builder profile and resolves only its env key', () => {
    const assignment = resolveAgentModelAssignment(
      config([
        {
          id: 'architect',
          tier: 'top',
          provider: 'openai',
          model: 'frontier-main',
          roles: ['main', 'architect'],
          capabilities: { reasoning: 1, coding: 0.9 },
        },
        {
          id: 'builder',
          tier: 'secondary',
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
      tier: 'secondary',
      provider: 'minimax',
      model: 'builder-model',
      baseURL: 'https://builder.example/v1',
      apiKey: 'builder-secret',
      apiKeyEnv: 'BUILDER_API_KEY',
    })
    expect(assignment.audit).not.toContain('builder-secret')
  })

  it('fails closed instead of using the main model when a secondary key is unavailable', () => {
    expect(() => resolveAgentModelAssignment(
      config([{
        id: 'builder',
        tier: 'secondary',
        provider: 'minimax',
        model: 'builder-model',
        apiKeyEnv: 'MISSING_KEY',
        roles: ['builder'],
      }]),
      { agentPreset: 'general-purpose', env: {} },
    )).toThrow(/MISSING_KEY.*secondary.*another tier/s)
  })

  it('keeps legacy single-model installs compatible when no profiles exist', () => {
    const assignment = resolveAgentModelAssignment(config([]), {
      agentPreset: 'general-purpose',
      env: {},
    })

    expect(assignment).toMatchObject({
      source: 'parent-fallback',
      model: 'frontier-main',
      apiKey: 'main-secret',
    })
  })

  it('does not select an architect profile for any default child preset', () => {
    const profiles = [
      { id: 'architect', tier: 'top', provider: 'openai', model: 'frontier-main', roles: ['main', 'architect'] },
      { id: 'builder', tier: 'secondary', provider: 'openai', model: 'builder-model', roles: ['builder', 'worker'] },
      { id: 'reviewer', tier: 'secondary', provider: 'openai', model: 'review-model', roles: ['reviewer', 'planner'] },
      { id: 'utility', tier: 'secondary', provider: 'openai', model: 'utility-model', roles: ['utility'] },
    ]
    for (const preset of ['general-purpose', 'code-reviewer', 'explore', 'plan', 'coordinator']) {
      expect(resolveAgentModelAssignment(config(profiles), {
        agentPreset: preset,
        env: {},
      }).role).not.toBe('architect')
    }
  })

  it('uses configured tier as truth even when legacy roles conflict', () => {
    const profiles = [
      {
        id: 'top-builder',
        tier: 'top',
        provider: 'openai',
        model: 'top-model',
        roles: ['builder', 'architect'],
      },
      {
        id: 'secondary-main-builder',
        tier: 'secondary',
        provider: 'openai',
        model: 'secondary-model',
        roles: ['main', 'builder'],
      },
    ]

    const child = resolveAgentModelAssignment(config(profiles), {
      agentPreset: 'general-purpose',
      env: {},
    })
    expect(child).toMatchObject({
      profileId: 'secondary-main-builder',
      tier: 'secondary',
    })

    const engine = new ExecutionEngine(
      config(profiles),
      {} as never,
      { chat: { completions: { create: () => Promise.reject(new Error('not called')) } } } as never,
    )
    expect(engine.getModelRouter().listProfiles().map((profile) => profile.id)).toEqual(['top-builder'])
    engine.dispose()
  })

  it('uses only a configured top profile for an architect request', () => {
    const assignment = resolveAgentModelAssignment(
      config([
        {
          id: 'top-architect',
          tier: 'top',
          provider: 'openai',
          model: 'frontier-model',
          roles: ['architect'],
        },
        {
          id: 'secondary-architect',
          tier: 'secondary',
          provider: 'openai',
          model: 'worker-model',
          roles: ['architect'],
        },
      ]),
      {
        agentPreset: 'general-purpose',
        requestedRole: 'architect',
        env: {},
      },
    )

    expect(assignment).toMatchObject({
      profileId: 'top-architect',
      role: 'architect',
      tier: 'top',
      model: 'frontier-model',
    })
  })

  it('fails closed when configured profiles contain no available top model', () => {
    expect(() => new ExecutionEngine(
      config([
        {
          id: 'secondary-main',
          tier: 'secondary',
          provider: 'openai',
          model: 'worker-model',
          roles: ['main', 'builder'],
        },
      ]),
      {} as never,
      { chat: { completions: { create: () => Promise.reject(new Error('not called')) } } } as never,
    )).toThrow(/No available top model profile.*tier.*top/s)
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

  it('prioritizes role quality over a cheaper lower-capability profile', () => {
    const assignment = resolveAgentModelAssignment(
      config([
        {
          id: 'cheap-builder',
          tier: 'secondary',
          provider: 'openai',
          model: 'cheap-model',
          roles: ['builder'],
          capabilities: { coding: 0.6, reasoning: 0.5, toolCalling: 0.6, cost: 1, speed: 1 },
        },
        {
          id: 'quality-builder',
          tier: 'secondary',
          provider: 'openai',
          model: 'quality-model',
          roles: ['builder'],
          capabilities: { coding: 0.95, reasoning: 0.85, toolCalling: 0.9, cost: 0.1, speed: 0.4 },
        },
      ]),
      { agentPreset: 'general-purpose', env: {} },
    )

    expect(assignment.profileId).toBe('quality-builder')
  })

  it('chooses a substantially stronger secondary fallback role over a weak preferred role', () => {
    const assignment = resolveAgentModelAssignment(
      config([
        {
          id: 'weak-builder',
          tier: 'secondary',
          provider: 'openai',
          model: 'weak-builder-model',
          roles: ['builder'],
          capabilities: { coding: 0.2, reasoning: 0.2, toolCalling: 0.2 },
        },
        {
          id: 'strong-worker',
          tier: 'secondary',
          provider: 'openai',
          model: 'strong-worker-model',
          roles: ['worker'],
          capabilities: { coding: 0.95, reasoning: 0.9, toolCalling: 0.9 },
        },
      ]),
      { agentPreset: 'general-purpose', env: {} },
    )

    expect(assignment.profileId).toBe('strong-worker')
    expect(assignment.role).toBe('worker')
  })

  it('keeps cross-provider worker profiles out of the main-agent router', () => {
    const engine = new ExecutionEngine(
      config([
        { id: 'architect', tier: 'top', provider: 'openai', model: 'frontier-main', roles: ['main', 'architect'] },
        {
          id: 'builder',
          tier: 'secondary',
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
      { id: 'architect', tier: 'top', provider: 'openai', model: 'frontier-main', roles: ['main', 'architect'] },
      { id: 'builder', tier: 'secondary', provider: 'openai', model: 'builder-model', roles: ['builder'] },
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
