/**
 * v0.5.2 (C3 — borrowed from codex multi_agents_common.rs):
 * tests for RunScopedRuntimeContext.inheritedConfig.
 *
 * Sub-agent config inheritance contract:
 *   - provider / model / sandboxEnabled are overrideable
 *   - cwd and permissionMode are LOCKED to the parent (security)
 *   - withConfigOverride returns a NEW context (write-once contract)
 *   - serialized form includes inheritedConfig for replay
 */
import { describe, it, expect, beforeEach } from 'vitest'
import {
  InMemoryRunScopedRuntimeContextStore,
  inheritConfig,
  withConfigOverride,
  type InheritedConfig,
} from '../src/core/runtime/runScopedContext.js'

describe('RunScopedRuntimeContext inheritedConfig (C3)', () => {
  let store: InMemoryRunScopedRuntimeContextStore
  let parentConfig: InheritedConfig

  beforeEach(() => {
    store = new InMemoryRunScopedRuntimeContextStore()
    parentConfig = {
      provider: 'openai',
      model: 'gpt-4o',
      cwd: '/tmp/proj',
      permissionMode: 'plan',
      sandboxEnabled: true,
      inheritedFrom: 'engine',
      inheritedAt: 1000,
    }
  })

  it('create() records inheritedConfig on the context', () => {
    const ctx = store.create('run-1', {
      taskKind: 'mutation',
      inheritedConfig: parentConfig,
    })
    expect(ctx.inheritedConfig).toBeDefined()
    expect(ctx.inheritedConfig!.provider).toBe('openai')
    expect(ctx.inheritedConfig!.permissionMode).toBe('plan')
  })

  it('create() without inheritedConfig leaves it undefined (legacy compat)', () => {
    const ctx = store.create('run-2', { taskKind: 'informational' })
    expect(ctx.inheritedConfig).toBeUndefined()
  })

  it('inheritConfig() layers overrides but locks cwd + permissionMode', () => {
    const child = inheritConfig(parentConfig, {
      provider: 'anthropic',
      model: 'claude-sonnet-4-6',
      sandboxEnabled: false,
    })
    expect(child.provider).toBe('anthropic')
    expect(child.model).toBe('claude-sonnet-4-6')
    expect(child.sandboxEnabled).toBe(false)
    // locked
    expect(child.cwd).toBe('/tmp/proj')
    expect(child.permissionMode).toBe('plan')
    // audit
    expect(child.inheritedFrom).toBe('engine')
    expect(child.inheritedAt).toBeGreaterThanOrEqual(1000)
  })

  it('inheritConfig() with no overrides preserves the parent slice semantics', () => {
    const child = inheritConfig(parentConfig, {})
    // inheritedAt is intentionally re-stamped (fresh per inheritance
    // hop), so we compare the other fields.
    expect(child.provider).toBe(parentConfig.provider)
    expect(child.model).toBe(parentConfig.model)
    expect(child.cwd).toBe(parentConfig.cwd)
    expect(child.permissionMode).toBe(parentConfig.permissionMode)
    expect(child.sandboxEnabled).toBe(parentConfig.sandboxEnabled)
    expect(child.inheritedFrom).toBe(parentConfig.inheritedFrom)
  })

  it('withConfigOverride returns a NEW context, not mutating the original', () => {
    const ctx = store.create('run-3', {
      taskKind: 'mutation',
      inheritedConfig: parentConfig,
    })
    const overridden = withConfigOverride(ctx, { provider: 'anthropic' })
    expect(overridden).not.toBe(ctx)
    expect(ctx.inheritedConfig!.provider).toBe('openai')
    expect(overridden.inheritedConfig!.provider).toBe('anthropic')
    // cwd still locked
    expect(overridden.inheritedConfig!.cwd).toBe('/tmp/proj')
  })

  it('withConfigOverride throws when inheritedConfig is missing', () => {
    const ctx = store.create('run-4', { taskKind: 'informational' })
    expect(() => withConfigOverride(ctx, { provider: 'anthropic' })).toThrow(/no inheritedConfig/)
  })

  it('child inheritance chain: parent → child → grandchild', () => {
    const ctx1 = store.create('run-p', {
      taskKind: 'mutation',
      inheritedConfig: parentConfig,
    })
    const ctx2 = store.create('run-c', {
      taskKind: 'mutation',
      inheritedConfig: inheritConfig(ctx1.inheritedConfig!, { provider: 'anthropic' }),
    })
    const ctx3 = store.create('run-g', {
      taskKind: 'mutation',
      inheritedConfig: inheritConfig(ctx2.inheritedConfig!, { sandboxEnabled: false }),
    })
    expect(ctx1.inheritedConfig!.provider).toBe('openai')
    expect(ctx2.inheritedConfig!.provider).toBe('anthropic')
    expect(ctx3.inheritedConfig!.provider).toBe('anthropic')
    expect(ctx3.inheritedConfig!.sandboxEnabled).toBe(false)
    expect(ctx3.inheritedConfig!.permissionMode).toBe('plan') // locked throughout
  })
})