import { describe, it, expect } from 'vitest'
import {
  AGENT_PRESETS,
  PRESET_NAMES,
  resolveAgentConfig,
  deriveModuleNames,
  applyAgentToConfig,
  type AgentConfig,
} from '../src/core/agentPresets.js'
import type { EngineConfig } from '../src/core/types.js'

// ── resolveAgentConfig ──────────────────────────────────────────────────────

describe('resolveAgentConfig', () => {
  it('resolves preset by name', () => {
    const config = resolveAgentConfig({ preset: 'explore' })
    expect(config.identity.planMode).toBe(true)
    expect(config.tools).toContain('Read')
    expect(config.maxIterations).toBe(40)
  })

  it('returns custom config as-is', () => {
    const custom: AgentConfig = {
      identity: { systemPrompt: () => 'custom prompt' },
      maxIterations: 99,
    }
    const config = resolveAgentConfig({ config: custom })
    expect(config.maxIterations).toBe(99)
    expect(config.identity.systemPrompt('')).toBe('custom prompt')
  })

  it('throws on unknown preset (prevents typos)', () => {
    expect(() => resolveAgentConfig({ preset: 'nonexistent' })).toThrow(/Unknown agent preset/)
  })

  it('falls back to general-purpose when nothing specified', () => {
    const config = resolveAgentConfig({})
    expect(config.identity.systemPrompt).toBe(AGENT_PRESETS['general-purpose'].identity.systemPrompt)
    expect(config.maxIterations).toBe(AGENT_PRESETS['general-purpose'].maxIterations)
  })

  it('custom config takes priority over preset', () => {
    const custom: AgentConfig = {
      identity: { systemPrompt: () => 'mine' },
    }
    const config = resolveAgentConfig({ preset: 'explore', config: custom })
    expect(config.identity.systemPrompt('')).toBe('mine')
  })
})

// ── AGENT_PRESETS ───────────────────────────────────────────────────────────

describe('AGENT_PRESETS', () => {
  it('has 4 built-in presets', () => {
    expect(PRESET_NAMES).toEqual(
      expect.arrayContaining(['explore', 'plan', 'code-reviewer', 'general-purpose']),
    )
    expect(PRESET_NAMES).toHaveLength(4)
  })

  it('explore preset is read-only', () => {
    const c = AGENT_PRESETS['explore']
    expect(c.identity.planMode).toBe(true)
    expect(c.tools).not.toContain('Write')
    expect(c.tools).not.toContain('Bash')
  })

  it('plan preset is read-only', () => {
    const c = AGENT_PRESETS['plan']
    expect(c.identity.planMode).toBe(true)
  })

  it('code-reviewer preset is read-only with minimal tools', () => {
    const c = AGENT_PRESETS['code-reviewer']
    expect(c.identity.planMode).toBe(true)
    expect(c.tools).toEqual(['Read', 'Glob', 'Grep', 'WebFetch', 'WebSearch'])
  })

  it('general-purpose preset has modules enabled', () => {
    const c = AGENT_PRESETS['general-purpose']
    expect(c.identity.planMode).toBeUndefined()
    expect(c.modules?.memory?.enabled).toBe(true)
    expect(c.modules?.workspace?.enabled).toBe(true)
  })

  it('all presets have systemPrompt builders', () => {
    for (const [, preset] of Object.entries(AGENT_PRESETS)) {
      expect(typeof preset.identity.systemPrompt).toBe('function')
      const prompt = preset.identity.systemPrompt('/test/dir')
      expect(prompt).toContain('/test/dir')
      expect(prompt.length).toBeGreaterThan(20)
    }
  })

  it('all presets have maxIterations', () => {
    for (const [, preset] of Object.entries(AGENT_PRESETS)) {
      expect(preset.maxIterations).toBeGreaterThan(0)
      expect(preset.maxIterations).toBeLessThanOrEqual(200)
    }
  })
})

// ── deriveModuleNames ───────────────────────────────────────────────────────

describe('deriveModuleNames', () => {
  it('returns undefined for undefined modules', () => {
    expect(deriveModuleNames(undefined)).toBeUndefined()
  })

  it('returns empty array for empty modules', () => {
    expect(deriveModuleNames({})).toEqual([])
  })

  it('extracts enabled module names', () => {
    const names = deriveModuleNames({
      memory: { enabled: true },
      workspace: { enabled: true },
    })
    expect(names).toEqual(expect.arrayContaining(['memory', 'workspace']))
    expect(names).toHaveLength(2)
  })

  it('skips modules that are not enabled', () => {
    const names = deriveModuleNames({
      memory: { enabled: true },
      critic: { enabled: true },
    })
    expect(names).toContain('memory')
    expect(names).toContain('critic')
  })
})

// ── applyAgentToConfig ──────────────────────────────────────────────────────

describe('applyAgentToConfig', () => {
  const baseConfig: EngineConfig = {
    model: 'test-model',
    apiKey: 'test-key',
    maxIterations: 30,
    cwd: '/test',
    permissionMode: 'auto',
  }

  it('returns config unchanged when no agent', () => {
    const result = applyAgentToConfig(baseConfig)
    expect(result).toBe(baseConfig)
  })

  it('merges agent identity into config', () => {
    const config: EngineConfig = {
      ...baseConfig,
      agent: {
        identity: {
          systemPrompt: (cwd: string) => `Custom prompt for ${cwd}`,
          planMode: true,
        },
        maxIterations: 50,
      },
    }
    const result = applyAgentToConfig(config)
    expect(result.systemPrompt).toBe('Custom prompt for /test')
    expect(result.planMode).toBe(true)
    expect(result.maxIterations).toBe(50)
  })

  it('merges agent modules into enabledModules', () => {
    const config: EngineConfig = {
      ...baseConfig,
      agent: {
        identity: { systemPrompt: () => 'test' },
        modules: {
          memory: { enabled: true },
          reflection: { enabled: true },
        },
      },
    }
    const result = applyAgentToConfig(config)
    expect(result.enabledModules).toEqual(
      expect.arrayContaining(['memory', 'reflection']),
    )
  })

  it('preserves base config fields not overridden by agent', () => {
    const config: EngineConfig = {
      ...baseConfig,
      agent: {
        identity: { systemPrompt: () => 'test' },
      },
    }
    const result = applyAgentToConfig(config)
    expect(result.model).toBe('test-model')
    expect(result.apiKey).toBe('test-key')
    expect(result.cwd).toBe('/test')
  })
})
