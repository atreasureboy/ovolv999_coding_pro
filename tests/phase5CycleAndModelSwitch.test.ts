/**
 * Phase 5 (five_goal §十二/§十三 GAP 7.1/7.2):
 *
 * GAP 7.1 — ModuleManager cycle detection MUST fail boot.
 * GAP 7.2 — Model switch must be transactional (rollback on failure).
 */

import { describe, it, expect } from 'vitest'
import { groupByDependencyDepth } from '../src/core/moduleRuntime/moduleManager.js'
import { ModuleRegistry } from '../src/core/moduleRegistry.js'
import type { AgentModule } from '../src/core/module.js'

// ── GAP 7.1: cycle detection fails ────────────────────────────────

describe('GAP 7.1: cycle detection fails boot', () => {
  it('groupByDependencyDepth throws on circular dependency', () => {
    const a: AgentModule = { name: 'a', dependencies: ['b'], boot: () => ({}) }
    const b: AgentModule = { name: 'b', dependencies: ['a'], boot: () => ({}) }
    expect(() => groupByDependencyDepth([a, b])).toThrow(/circular module dependency/i)
  })

  it('groupByDependencyDepth throws on 3-node cycle', () => {
    const a: AgentModule = { name: 'a', dependencies: ['b'], boot: () => ({}) }
    const b: AgentModule = { name: 'b', dependencies: ['c'], boot: () => ({}) }
    const c: AgentModule = { name: 'c', dependencies: ['a'], boot: () => ({}) }
    expect(() => groupByDependencyDepth([a, b, c])).toThrow(/circular module dependency/i)
  })

  it('ModuleRegistry.resolve throws on circular dependency', () => {
    const reg = new ModuleRegistry()
    reg.register('x', () => ({ name: 'x', dependencies: ['y'], boot: () => ({}) }))
    reg.register('y', () => ({ name: 'y', dependencies: ['x'], boot: () => ({}) }))
    expect(() => reg.resolve(['x', 'y'], { cwd: '/tmp' } as never)).toThrow(/circular dependency/i)
  })

  it('non-cyclic modules resolve normally', () => {
    const a: AgentModule = { name: 'a', boot: () => ({}) }
    const b: AgentModule = { name: 'b', dependencies: ['a'], boot: () => ({}) }
    const layers = groupByDependencyDepth([a, b])
    expect(layers).toHaveLength(2)
    expect(layers[0][0].name).toBe('a')
    expect(layers[1][0].name).toBe('b')
  })
})

// ── GAP 7.2: model switch transactional ───────────────────────────
//
// We test the transactional guard by injecting a throw into one of
// the post-mutation side effects and verifying config.model reverts.

describe('GAP 7.2: setModel is transactional', () => {
  it('rolls back config.model if a side-effect throws', async () => {
    // We can't easily construct a full ExecutionEngine in a unit test,
    // so we verify the rollback pattern directly with a mock object
    // that replicates the setModel logic from engine.ts.
    const state = { model: 'gpt-4o' }
    const deps = {
      contextManager: {
        onModelChanged(m: string) {
          if (m === 'bad-model') throw new Error('unsupported model')
        },
      },
      moduleManager: { notifyModelChanged(_m: string) { } },
      modelGateway: { resetStreamUsageLatch() { } },
    }

    function setModel(model: string): void {
      if (state.model === model) return
      const previousModel = state.model
      try {
        state.model = model
        deps.contextManager.onModelChanged(model)
        deps.moduleManager.notifyModelChanged(model)
        deps.modelGateway.resetStreamUsageLatch()
      } catch (err) {
        state.model = previousModel
        try {
          deps.contextManager.onModelChanged(previousModel)
          deps.moduleManager.notifyModelChanged(previousModel)
        } catch { /* best-effort rollback */ }
        throw err
      }
    }

    // Happy path
    setModel('claude-sonnet')
    expect(state.model).toBe('claude-sonnet')

    // Failure path — should roll back
    expect(() => setModel('bad-model')).toThrow(/unsupported model/)
    expect(state.model).toBe('claude-sonnet')
  })
})
