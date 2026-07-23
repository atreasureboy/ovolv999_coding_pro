/**
 * P0-1 regression: transactional model switch.
 *
 * Invariant (fi_goal.md §P0-1): a model switch must be a complete
 * transaction — every subsystem that captured state derived from the
 * old model must observe the new model on the next call. No component
 * may keep divergent state.
 *
 * Pre-fix: engine.setModel(model) only mutated `config.model`, leaving
 *   - ContextManager.deps.model + resolvedContextWindow cache stale,
 *   - CriticModule/ReflectionModule private `model` stale,
 *   - ModelGateway._streamUsageSupported latch never reset.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'

import { ExecutionEngine } from '../src/core/engine.js'
import { ContextManager } from '../src/core/context/contextManager.js'
import { ModuleManager, groupByDependencyDepth } from '../src/core/moduleRuntime/moduleManager.js'
import { ModelGateway } from '../src/core/model/modelGateway.js'
import { createProviderAdapter } from '../src/core/model/providerAdapter.js'
import { CriticModule } from '../src/modules/critic.js'
import { ReflectionModule } from '../src/modules/reflection.js'
import { SemanticMemory } from '../src/core/semanticMemory.js'
import { resolveContextWindow } from '../src/core/compact.js'
import type { AgentModule } from '../src/core/module.js'
import type { EngineConfig } from '../src/core/types.js'
import type { Renderer } from '../src/ui/renderer.js'

function fakeRenderer(): Renderer & { __calls: { kind: string; args: unknown[] }[] } {
  const calls: { kind: string; args: unknown[] }[] = []
  const r: Record<string, unknown> = { __calls: calls }
  for (const k of [
    'banner', 'info', 'warn', 'error', 'success',
    'startSpinner', 'stopSpinner',
    'beginAssistantText', 'endAssistantText', 'streamToken',
    'toolStart', 'toolResult',
    'compactStart', 'compactDone', 'contextWarning',
    'agentStart', 'agentDone', 'agentSummary', 'agentHeartbeat',
  ]) {
    r[k] = (...a: unknown[]) => { calls.push({ kind: k, args: a }) }
  }
  return r as unknown as Renderer & { __calls: typeof calls }
}

function baseConfig(o: Partial<EngineConfig> = {}): EngineConfig {
  return {
    apiKey: 'k',
    model: 'gpt-4o',
    maxIterations: 10,
    cwd: '/tmp',
    permissionMode: 'auto',
    permissionManager: undefined,
    enabledModules: [],
    ...o,
  }
}

function fakeClient(): unknown {
  const chat = {
    completions: {
      create: async () => {
        await Promise.resolve()
        return { choices: [{ message: { content: 'ok' } }] }
      },
    },
  }
  return { chat }
}

let tmpRoot = ''
beforeEach(() => { tmpRoot = mkdtempSync(`${tmpdir()}/p0-1-`) })
afterEach(() => { rmSync(tmpRoot, { recursive: true, force: true }) })

// ─────────────────────────────────────────────────────────────────────
// P0-1.A: ContextManager invalidates cached contextWindow
// ─────────────────────────────────────────────────────────────────────
describe('P0-1.A: ContextManager.onModelChanged invalidates caches', () => {
  it('contextWindow matches the new model after onModelChanged', () => {
    const r = fakeRenderer()
    const cm = new ContextManager({
      client: fakeClient() as never,
      model: 'gpt-4o',
      renderer: r,
    })
    const before = cm.contextWindow
    expect(before).toBe(resolveContextWindow('gpt-4o'))
    // Switch to a model with a different context window.
    cm.onModelChanged('gpt-4')
    const after = cm.contextWindow
    expect(after).toBe(resolveContextWindow('gpt-4'))
    expect(after).not.toBe(before)
  })

  it('deps.model is replaced (not just the cache cleared)', () => {
    const r = fakeRenderer()
    const cm = new ContextManager({
      client: fakeClient() as never,
      model: 'gpt-4o',
      renderer: r,
    })
    // Touch contextWindow so the cache is populated for the OLD model.
    void cm.contextWindow
    cm.onModelChanged('claude-sonnet-4-5')
    // The deps field is private — reach through with the same pattern
    // used in tests/runtimeFixes.test.ts.
    const deps = (cm as unknown as { deps: { model: string } }).deps
    expect(deps.model).toBe('claude-sonnet-4-5')
    // Cache was invalidated — re-read returns the new model's window.
    expect(cm.contextWindow).toBe(resolveContextWindow('claude-sonnet-4-5'))
  })

  it('onModelChanged is a no-op when the model is unchanged', () => {
    const r = fakeRenderer()
    const cm = new ContextManager({
      client: fakeClient() as never,
      model: 'gpt-4o',
      renderer: r,
    })
    const before = cm.contextWindow
    cm.onModelChanged('gpt-4o')
    expect(cm.contextWindow).toBe(before)
  })
})

// ─────────────────────────────────────────────────────────────────────
// P0-1.B: CriticModule and ReflectionModule pick up the new model
// ─────────────────────────────────────────────────────────────────────
describe('P0-1.B: modules observe onModelChanged', () => {
  it('CriticModule serves the new model on the next iteration LLM call', async () => {
    const calls: { model: string }[] = []
    const client = {
      chat: {
        completions: {
          create: async (p: { model: string }) => {
            calls.push({ model: p.model })
            await Promise.resolve()
            return { choices: [{ message: { content: 'ok' } }] }
          },
        },
      },
    } as never
    const critic = new CriticModule(client, 'original-model', {})
    expect(critic['model']).toBe('original-model')
    critic.onModelChanged('switched-model')
    expect(critic['model']).toBe('switched-model')
    // Drive one iteration at the critic cadence to confirm the LLM
    // request body now contains the new model. We need iteration large
    // enough to clear CRITIC_MIN_ITERATIONS and divisible by
    // CRITIC_INTERVAL.
    const messages = Array.from({ length: 6 }, (_, i) =>
      i % 2 === 0
        ? { role: 'assistant' as const, content: `step ${i}`, tool_calls: [] }
        : { role: 'tool' as const, content: `result ${i}` },
    )
    await critic.onIteration({
      iteration: 100,
      messages,
      abortSignal: new AbortController().signal,
    })
    expect(calls.length).toBeGreaterThan(0)
    expect(calls.every(c => c.model === 'switched-model')).toBe(true)
  })

  it('ReflectionModule serves the new model on the next onComplete call', async () => {
    const calls: { model: string }[] = []
    const client = {
      chat: {
        completions: {
          create: async (p: { model: string }) => {
            calls.push({ model: p.model })
            await Promise.resolve()
            return { choices: [{ message: { content: 'LESSON: x' } }] }
          },
        },
      },
    } as never
    const sem = new SemanticMemory(tmpRoot)
    const reflection = new ReflectionModule(client, 'original-model', sem, {})
    expect(reflection['model']).toBe('original-model')
    reflection.onModelChanged('switched-model')
    expect(reflection['model']).toBe('switched-model')
    await reflection.onComplete?.({
      cwd: tmpRoot,
      turnResult: { stopped: true, reason: 'stop_sequence', output: 'done' },
      // Reflection skips runs with <3 tool messages; provide 3 so the
      // knowledge-extraction LLM call actually fires.
      messages: [
        { role: 'user', content: 'q' },
        { role: 'assistant', content: 'a', tool_calls: [{ id: '1', type: 'function', function: { name: 'T', arguments: '{}' } }] },
        { role: 'tool', content: 'r1', tool_call_id: '1' },
        { role: 'assistant', content: 'b', tool_calls: [{ id: '2', type: 'function', function: { name: 'T', arguments: '{}' } }] },
        { role: 'tool', content: 'r2', tool_call_id: '2' },
        { role: 'assistant', content: 'c', tool_calls: [{ id: '3', type: 'function', function: { name: 'T', arguments: '{}' } }] },
        { role: 'tool', content: 'r3', tool_call_id: '3' },
      ],
    })
    expect(calls.length).toBeGreaterThan(0)
    expect(calls.every(c => c.model === 'switched-model')).toBe(true)
  })

  it('ModuleManager.notifyModelChanged fans out to all modules (best-effort)', () => {
    const seen: string[] = []
    const m1: AgentModule = {
      name: 'm1',
      onModelChanged: (m) => { seen.push(`m1:${m}`) },
      boot: () => ({}),
    }
    const m2: AgentModule = {
      name: 'm2',
      onModelChanged: (m) => { seen.push(`m2:${m}`) },
      boot: () => ({}),
    }
    // m3 omits onModelChanged — must be silently skipped, not throw.
    const m3: AgentModule = { name: 'm3', boot: () => ({}) }
    const r = fakeRenderer()
    const mgr = new ModuleManager({ modules: [m1, m2, m3], renderer: r })
    mgr.notifyModelChanged('new-model')
    expect(seen).toEqual(['m1:new-model', 'm2:new-model'])
  })

  it('ModuleManager.notifyModelChanged isolates a throwing onModelChanged hook', () => {
    const r = fakeRenderer()
    const good: AgentModule = {
      name: 'good',
      onModelChanged: (m) => { void m },
      boot: () => ({}),
    }
    const bad: AgentModule = {
      name: 'bad',
      onModelChanged: () => { throw new Error('boom') },
      boot: () => ({}),
    }
    const mgr = new ModuleManager({ modules: [bad, good], renderer: r })
    expect(() => mgr.notifyModelChanged('new-model')).not.toThrow()
    // The throwing module's failure is recorded via renderer.warn.
    const warns = r.__calls.filter(c => c.kind === 'warn' && String(c.args[0]).includes('bad'))
    expect(warns.length).toBe(1)
  })
})

// ─────────────────────────────────────────────────────────────────────
// P0-1.C: ModelGateway.resetStreamUsageLatch
// ─────────────────────────────────────────────────────────────────────
describe('P0-1.C: ModelGateway.resetStreamUsageLatch', () => {
  it('a latched-false state returns to true after resetStreamUsageLatch', () => {
    const r = fakeRenderer()
    const gw = new ModelGateway({ adapter: createProviderAdapter({ client: fakeClient() as never }), renderer: r })
    expect(gw.streamUsageSupported).toBe(true)
    gw.markStreamUsageUnsupported()
    expect(gw.streamUsageSupported).toBe(false)
    gw.resetStreamUsageLatch()
    expect(gw.streamUsageSupported).toBe(true)
  })
})

// ─────────────────────────────────────────────────────────────────────
// P0-1.D: end-to-end ExecutionEngine.setModel fans out to all subsystems
// ─────────────────────────────────────────────────────────────────────
describe('P0-1.D: ExecutionEngine.setModel is transactional end-to-end', () => {
  it('after setModel(X), every subsystem observes X', () => {
    const r = fakeRenderer()
    const e = new ExecutionEngine(
      baseConfig({ model: 'gpt-4o' }),
      r,
      fakeClient() as never,
    )
    // Pre-condition: original model captured everywhere.
    const cm = (e as unknown as { contextManager: ContextManager }).contextManager
    expect(cm.contextWindow).toBe(resolveContextWindow('gpt-4o'))
    const gw = (e as unknown as { modelGateway: ModelGateway }).modelGateway
    gw.markStreamUsageUnsupported()
    expect(gw.streamUsageSupported).toBe(false)

    // Switch.
    e.setModel('gpt-4')
    // Config itself.
    expect(e.getModel()).toBe('gpt-4')
    // ContextManager.
    expect(cm.contextWindow).toBe(resolveContextWindow('gpt-4'))
    expect((cm as unknown as { deps: { model: string } }).deps.model).toBe('gpt-4')
    // ModelGateway latch reset.
    expect(gw.streamUsageSupported).toBe(true)
  })

  it('setModel is a no-op when the new model equals the current model', () => {
    const r = fakeRenderer()
    const e = new ExecutionEngine(
      baseConfig({ model: 'gpt-4o' }),
      r,
      fakeClient() as never,
    )
    const cm = (e as unknown as { contextManager: ContextManager }).contextManager
    const beforeWindow = cm.contextWindow
    e.setModel('gpt-4o') // same model
    expect(cm.contextWindow).toBe(beforeWindow)
    expect(e.getModel()).toBe('gpt-4o')
  })
})

// ─────────────────────────────────────────────────────────────────────
// P0-7: topological boot layering + criticality policy
// ─────────────────────────────────────────────────────────────────────
describe('P0-7.A: groupByDependencyDepth', () => {
  it('places independent modules in layer 0', () => {
    const a: AgentModule = { name: 'a', boot: () => ({}) }
    const b: AgentModule = { name: 'b', boot: () => ({}) }
    const layers = groupByDependencyDepth([a, b])
    expect(layers).toHaveLength(1)
    expect(layers[0].map(m => m.name).sort()).toEqual(['a', 'b'])
  })

  it('places a dependent module strictly after its dependency', () => {
    const base: AgentModule = { name: 'base', boot: () => ({}) }
    const dependent: AgentModule = {
      name: 'dep',
      dependencies: ['base'],
      boot: () => ({}),
    }
    const layers = groupByDependencyDepth([dependent, base]) // dependent listed first
    expect(layers).toHaveLength(2)
    expect(layers[0].map(m => m.name)).toEqual(['base'])
    expect(layers[1].map(m => m.name)).toEqual(['dep'])
  })

  it('forms a 3-layer chain for grandchild dependencies', () => {
    const a: AgentModule = { name: 'a', boot: () => ({}) }
    const b: AgentModule = { name: 'b', dependencies: ['a'], boot: () => ({}) }
    const c: AgentModule = { name: 'c', dependencies: ['b'], boot: () => ({}) }
    const layers = groupByDependencyDepth([c, b, a])
    expect(layers.map(l => l.map(m => m.name))).toEqual([['a'], ['b'], ['c']])
  })

  it('co-pays sibling dependencies into the same layer', () => {
    const a: AgentModule = { name: 'a', boot: () => ({}) }
    const b1: AgentModule = { name: 'b1', dependencies: ['a'], boot: () => ({}) }
    const b2: AgentModule = { name: 'b2', dependencies: ['a'], boot: () => ({}) }
    const layers = groupByDependencyDepth([a, b1, b2])
    expect(layers).toHaveLength(2)
    expect(layers[0].map(m => m.name)).toEqual(['a'])
    expect(layers[1].map(m => m.name).sort()).toEqual(['b1', 'b2'])
  })

  it('cyclic modules cause groupByDependencyDepth to throw (five_goal §十二 P2-1)', () => {
    const a: AgentModule = { name: 'a', dependencies: ['b'], boot: () => ({}) }
    const b: AgentModule = { name: 'b', dependencies: ['a'], boot: () => ({}) }
    // Cyclic dependencies must fail — not be silently booted.
    expect(() => groupByDependencyDepth([a, b])).toThrow(/circular module dependency/i)
  })
})

describe('P0-7.B: ModuleManager.boot respects topological order', () => {
  it('a dependent boots strictly after its dependency (no race)', async () => {
    // We assert ordering by recording boot timestamps. A buggy flat
    // Promise.all could resolve them in any order on a fast machine;
    // a layered boot guarantees the dependency resolves first.
    const events: string[] = []
    const base: AgentModule = {
      name: 'base',
      boot: async () => {
        await Promise.resolve()
        events.push('base-booted')
        return {}
      },
    }
    const dependent: AgentModule = {
      name: 'dep',
      dependencies: ['base'],
      boot: () => {
        events.push('dep-booted')
        return {}
      },
    }
    const r = fakeRenderer()
    const mgr = new ModuleManager({ modules: [dependent, base], renderer: r })
    await mgr.boot({ cwd: '/tmp', config: baseConfig() })
    expect(events).toEqual(['base-booted', 'dep-booted'])
  })
})

describe('P0-7.C: ModuleManager.boot respects criticality', () => {
  it('critical boot failure aborts the runtime (throws)', async () => {
    const critical: AgentModule = {
      name: 'critical-mod',
      criticality: 'critical',
      boot: () => { throw new Error('critical boom') },
    }
    const r = fakeRenderer()
    const mgr = new ModuleManager({ modules: [critical], renderer: r })
    await expect(mgr.boot({ cwd: '/tmp', config: baseConfig() })).rejects.toThrow(/critical-mod/)
  })

  it('best_effort boot failure is isolated; module is dropped from subsequent hooks', async () => {
    let onCompleteFired = false
    const bestEffort: AgentModule = {
      name: 'optional-mod',
      criticality: 'best_effort',
      boot: () => { throw new Error('best-effort boom') },
      onComplete: () => { onCompleteFired = true },
    }
    const healthy: AgentModule = {
      name: 'healthy-mod',
      boot: () => ({}),
    }
    const r = fakeRenderer()
    const mgr = new ModuleManager({ modules: [bestEffort, healthy], renderer: r })
    await expect(mgr.boot({ cwd: '/tmp', config: baseConfig() })).resolves.toBeDefined()
    // The best-effort module is dropped from the modules array — its
    // onComplete must NOT fire on runComplete.
    await mgr.runComplete({
      cwd: '/tmp',
      turnResult: { stopped: true, reason: 'stop_sequence', output: '' },
      messages: [],
    })
    expect(onCompleteFired).toBe(false)
    // The healthy module is still wired.
    expect(mgr.moduleNames).toEqual(['healthy-mod'])
    // The renderer warned about the dropped module.
    const warns = r.__calls.filter(c => c.kind === 'warn' && String(c.args[0]).includes('optional-mod'))
    expect(warns.length).toBe(1)
  })

  it('omitted criticality defaults to critical (backwards compat)', async () => {
    const legacy: AgentModule = {
      name: 'legacy-mod',
      // no criticality field — must be treated as critical
      boot: () => { throw new Error('legacy boom') },
    }
    const r = fakeRenderer()
    const mgr = new ModuleManager({ modules: [legacy], renderer: r })
    await expect(mgr.boot({ cwd: '/tmp', config: baseConfig() })).rejects.toThrow(/legacy-mod/)
  })
})
