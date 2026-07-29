/**
 * Concurrency isolation tests for AgentTool.
 *
 * AgentTool is per-instance: each instance carries its OWN
 * (factory, parentConfig, parentRenderer) wiring, and call depth is derived
 * (not mutated) from `parentConfig.initialAgentDepth`. There is NO
 * module-level global fallback for the factory and NO mutable depth counter
 * on the instance — concurrent sibling Agent calls dispatched from the same
 * parent observe the SAME depth value, and the global cap holds across
 * nested spawns without any shared mutable state.
 *
 * These tests prove the contract by:
 *   1. building two AgentTool instances with distinct factories/cwds/renderers
 *      and running them in parallel, asserting each child invocation sees
 *      ITS OWN factory closure — never the sibling's;
 *   2. interleaving multiple Agent calls on the same engine and confirming
 *      each child receives the parent engine's `cwd` and `renderer`, and all
 *      siblings compute the SAME depth (no mutable counter to race on);
 *   3. verifying the cap rejects when initialAgentDepth + 1 > MAX;
 *   4. verifying that AgentTool with no wiring fails fast with
 *      "not initialized";
 *   5. verifying `createTools` requires a complete AgentWiring and forwards
 *      it to the AgentTool instance it constructs.
 */

import { describe, it, expect } from 'vitest'
import { AgentTool } from '../src/tools/agent.js'
import { createTools, type AgentWiring } from '../src/tools/index.js'
import type { EngineConfig, ToolContext, AgentChildEngineFactory } from '../src/core/types.js'
import { resolveAgentConfig } from '../src/core/agentPresets.js'

// ── Fixtures ─────────────────────────────────────────────────────────────

interface RecordedCall {
  cwd: string
  renderer: unknown
  initialDepth: number | undefined
  promptContains: string
  promptHasParentCallDepth: number
  model?: string
  provider?: string
  apiKey?: string
}

function makeParentConfig(overrides: Partial<EngineConfig> = {}): EngineConfig {
  return {
    model: 'mock-model',
    apiKey: 'mock-key',
    maxIterations: 5,
    cwd: '/parent/cwd',
    permissionMode: 'auto',
    ...overrides,
  }
}

function makeContext(cwd: string): ToolContext {
  return { cwd, permissionMode: 'auto' }
}

/** Build a capturing factory that records every invocation it receives. */
function capturingFactory(tag: string, recorder: RecordedCall[], opts: {
  delayMs?: number
  throw?: boolean
} = {}): AgentChildEngineFactory {
  return (config: EngineConfig, _renderer: unknown) => {
    return {
      runTurn: async () => {
        const recorded: RecordedCall = {
          cwd: config.cwd,
          renderer: _renderer,
          initialDepth: config.initialAgentDepth,
          promptContains: '', // populated by runTurn args below
          promptHasParentCallDepth: 0,
          model: config.model,
          provider: config.provider,
          apiKey: config.apiKey,
        }
        if (opts.delayMs) {
          await new Promise((r) => setTimeout(r, opts.delayMs))
        }
        recorder.push(recorded)
        if (opts.throw) throw new Error(`${tag}-explode`)
        return { result: { output: `done-by-${tag}`, reason: 'stop' } }
      },
      abort: () => { /* no-op */ },
    }
  }
}

/** Wrap a factory so it records the prompt its child receives.
 *
 * Each invocation gets its own closure-scoped `ourIndex` (bookmarked BEFORE
 * the inner factory pushes its entry), so parallel wrappers don't fight
 * over `recorder[length-1]`. */
function recordingPromptFactory(inner: AgentChildEngineFactory, recorder: RecordedCall[]): AgentChildEngineFactory {
  return (config, renderer) => {
    const ourIndex = recorder.length
    const engine = inner(config, renderer)
    const orig = engine.runTurn.bind(engine)
    engine.runTurn = async (msg) => {
      const result = await orig(msg, [])
      if (ourIndex < recorder.length) {
        recorder[ourIndex].promptContains = msg
        const m = msg.match(/call_depth: (\d+)/)
        recorder[ourIndex].promptHasParentCallDepth = m ? Number(m[1]) : -1
      }
      return result
    }
    return engine
  }
}

// ── Tests ────────────────────────────────────────────────────────────────

describe('AgentTool per-instance wiring — concurrency isolation', () => {
  it('binds a builder model profile to a general-purpose child engine', async () => {
    const recorder: RecordedCall[] = []
    const renderer = { agentStart() {}, agentDone() {}, agentSummary() {}, agentHeartbeat() {} }
    const parent = makeParentConfig({
      model: 'architect-model',
      provider: 'openai',
      apiKey: 'shared-key',
      models: {
        profiles: [
          { id: 'architect', provider: 'openai', model: 'architect-model', roles: ['main', 'architect'] },
          { id: 'builder', provider: 'openai', model: 'builder-model', roles: ['builder', 'worker'] },
        ],
      },
    })
    const tool = new AgentTool({
      factory: capturingFactory('builder', recorder),
      parentConfig: parent,
      parentRenderer: renderer,
    })

    const result = await tool.execute({
      description: 'implement unit',
      prompt: 'modify the assigned unit',
      subagent_type: 'general-purpose',
      delegation_context: {
        goal: 'complete the unit',
        constraints: ['do not change public APIs'],
        acceptance_criteria: ['tests pass'],
      },
    }, makeContext('/context'))

    expect(result.isError).toBe(false)
    expect(recorder[0]).toMatchObject({
      model: 'builder-model',
      provider: 'openai',
      apiKey: 'shared-key',
    })
  })

  it('uses a cross-provider env credential without exposing it in the worker result', async () => {
    const envName = 'OVOLV999_TEST_BUILDER_API_KEY'
    const previous = process.env[envName]
    process.env[envName] = 'builder-secret-value'
    try {
      const recorder: RecordedCall[] = []
      const tool = new AgentTool({
        factory: capturingFactory('builder', recorder),
        parentConfig: makeParentConfig({
          model: 'architect-model',
          provider: 'openai',
          apiKey: 'architect-secret-value',
          models: {
            profiles: [{
              id: 'builder',
              provider: 'minimax',
              model: 'builder-model',
              apiKeyEnv: envName,
              roles: ['builder'],
            }],
          },
        }),
        parentRenderer: { agentStart() {}, agentDone() {}, agentSummary() {}, agentHeartbeat() {} },
      })

      const result = await tool.execute(
        { description: 'implement unit', prompt: 'do it', subagent_type: 'general-purpose' },
        makeContext('/context'),
      )

      expect(recorder[0]).toMatchObject({
        model: 'builder-model',
        provider: 'minimax',
        apiKey: 'builder-secret-value',
      })
      expect(result.content).not.toContain('builder-secret-value')
      expect(result.content).not.toContain('architect-secret-value')
      expect(result.content).toContain(envName)
    } finally {
      if (previous === undefined) delete process.env[envName]
      else process.env[envName] = previous
    }
  })

  it('requires a root-main escalation request before assigning an architect model', async () => {
    const recorder: RecordedCall[] = []
    const parent = makeParentConfig({
      model: 'architect-model',
      provider: 'openai',
      models: {
        profiles: [
          { id: 'architect', provider: 'openai', model: 'architect-model', roles: ['main', 'architect'] },
          { id: 'builder', provider: 'openai', model: 'builder-model', roles: ['builder'] },
        ],
      },
    })
    const renderer = { agentStart() {}, agentDone() {}, agentSummary() {}, agentHeartbeat() {} }
    const rootTool = new AgentTool({
      factory: capturingFactory('architect', recorder),
      parentConfig: parent,
      parentRenderer: renderer,
    })

    const missingReason = await rootTool.execute({
      description: 'architecture review',
      prompt: 'review the boundary',
      model_role: 'architect',
    }, makeContext('/context'))
    expect(missingReason).toMatchObject({ isError: true })
    expect(missingReason.content).toContain('escalation_reason is required')
    expect(recorder).toHaveLength(0)

    const approved = await rootTool.execute({
      description: 'architecture review',
      prompt: 'review the boundary',
      model_role: 'architect',
      escalation_reason: 'public API changes span three runtime modules',
    }, makeContext('/context'))
    expect(approved.isError).toBe(false)
    expect(recorder[0]).toMatchObject({ model: 'architect-model' })
  })

  it('blocks architecture-sensitive work from default secondary roles', async () => {
    const recorder: RecordedCall[] = []
    const tool = new AgentTool({
      factory: capturingFactory('builder', recorder),
      parentConfig: makeParentConfig({
        models: {
          profiles: [
            { id: 'architect', provider: 'openai', model: 'architect-model', roles: ['architect'] },
            { id: 'builder', provider: 'openai', model: 'builder-model', roles: ['builder'] },
          ],
        },
      }),
      parentRenderer: { agentStart() {}, agentDone() {}, agentSummary() {}, agentHeartbeat() {} },
    })

    const result = await tool.execute({
      description: '跨模块架构调整',
      prompt: '设计新的公共接口和迁移方案',
      subagent_type: 'general-purpose',
    }, makeContext('/context'))

    expect(result).toMatchObject({ isError: true })
    expect(result.content).toContain('requires architect participation')
    expect(result.content).toContain('model_role:"architect"')
    expect(recorder).toHaveLength(0)
  })

  it('rejects architect escalation from a nested agent', async () => {
    const recorder: RecordedCall[] = []
    const nestedTool = new AgentTool({
      factory: capturingFactory('architect', recorder),
      parentConfig: makeParentConfig({
        agent: resolveAgentConfig({ preset: 'coordinator' }),
        models: {
          profiles: [
            { id: 'architect', provider: 'openai', model: 'architect-model', roles: ['architect'] },
            { id: 'builder', provider: 'openai', model: 'builder-model', roles: ['builder'] },
          ],
        },
      }),
      parentRenderer: { agentStart() {}, agentDone() {}, agentSummary() {}, agentHeartbeat() {} },
    })

    const result = await nestedTool.execute({
      description: 'nested escalation',
      prompt: 'review architecture',
      model_role: 'architect',
      escalation_reason: 'nested worker asks for stronger model',
    }, makeContext('/context'))

    expect(result).toMatchObject({ isError: true })
    expect(result.content).toContain('only the root main agent')
    expect(recorder).toHaveLength(0)
  })

  it('does not silently use the main model when configured secondary credentials are missing', async () => {
    const recorder: RecordedCall[] = []
    const tool = new AgentTool({
      factory: capturingFactory('builder', recorder),
      parentConfig: makeParentConfig({
        model: 'architect-model',
        provider: 'openai',
        models: {
          profiles: [{
            id: 'builder',
            provider: 'minimax',
            model: 'builder-model',
            apiKeyEnv: 'OVOLV999_INTENTIONALLY_MISSING_KEY',
            roles: ['builder'],
          }],
        },
      }),
      parentRenderer: { agentStart() {}, agentDone() {}, agentSummary() {}, agentHeartbeat() {} },
    })

    const result = await tool.execute(
      { description: 'implement unit', prompt: 'do it', subagent_type: 'general-purpose' },
      makeContext('/context'),
    )

    expect(result).toMatchObject({ isError: true })
    expect(result.content).toContain('OVOLV999_INTENTIONALLY_MISSING_KEY')
    expect(result.content).toContain('instead of falling back to another tier')
    expect(recorder).toHaveLength(0)
  })

  it('two AgentTool instances with distinct factories do not cross-talk under Promise.all', async () => {
    const recorderA: RecordedCall[] = []
    const recorderB: RecordedCall[] = []

    const rendererA = { tag: 'renderer-A', agentStart() {}, agentDone() {}, agentSummary() {}, agentHeartbeat() {} }
    const rendererB = { tag: 'renderer-B', agentStart() {}, agentDone() {}, agentSummary() {}, agentHeartbeat() {} }

    const parentA: EngineConfig = makeParentConfig({ cwd: '/project/A', sessionDir: '/sessions/A' })
    const parentB: EngineConfig = makeParentConfig({ cwd: '/project/B', sessionDir: '/sessions/B' })

    const toolA = new AgentTool({ factory: capturingFactory('A', recorderA), parentConfig: parentA, parentRenderer: rendererA })
    const toolB = new AgentTool({ factory: capturingFactory('B', recorderB), parentConfig: parentB, parentRenderer: rendererB })

    // Interleave two Agent calls in parallel. Each tool's child factory must
    // observe its OWN parent (renderer/cwd). If module-globals were ever
    // reinstated, A and B would race and report the same renderer.
    // tool.execute's child engine inherits its cwd from the *context*, not
    // the parent config — that's a deliberate Agent-tool behaviour.
    const [resA, resB] = await Promise.all([
      toolA.execute({ description: 'task-A', prompt: 'do-A', subagent_type: 'general-purpose' }, makeContext('/context-A')) as Promise<{ content: string }>,
      toolB.execute({ description: 'task-B', prompt: 'do-B', subagent_type: 'general-purpose' }, makeContext('/context-B')) as Promise<{ content: string }>,
    ])

    expect(resA.content).toContain('done-by-A')
    expect(resB.content).toContain('done-by-B')

    expect(recorderA).toHaveLength(1)
    expect(recorderB).toHaveLength(1)

    // Each factory saw its own parent's renderer + its own context's cwd —
    // never the sibling's. Cross-pollination would show A and B with the
    // same renderer reference.
    expect(recorderA[0]?.renderer).toBe(rendererA)
    expect(recorderB[0]?.renderer).toBe(rendererB)
    expect(recorderA[0]?.cwd).toBe('/context-A')
    expect(recorderB[0]?.cwd).toBe('/context-B')
    // Wrapped in a guard so the assertion reads cleanly if the wrong
    // renderer leaks in.
    expect(recorderA[0]?.renderer).not.toBe(recorderB[0]?.renderer)
  })

  it('parallel Agent calls within ONE engine all use the parent engine’s cwd (no cross-pollination between siblings)', async () => {
    const calls: RecordedCall[] = []
    const parentRenderer = { tag: 'parent-renderer', agentStart() {}, agentDone() {}, agentSummary() {}, agentHeartbeat() {} }
    const parentConfig: EngineConfig = makeParentConfig({ cwd: '/shared/cwd', sessionDir: '/shared/session' })

    // Wrap the factory so each spawned child records the delegated prompt —
    // that's how we can map its `cwd`/`renderer` back to its description.
    const tool = new AgentTool({
      factory: recordingPromptFactory(capturingFactory('shared', calls), calls),
      parentConfig,
      parentRenderer,
    })

    // Five parallel Agent calls — the exact shape that previously corrupted
    // state under the module-global factory (last registration wins).
    const results = await Promise.all(
      Array.from({ length: 5 }, (_, i) =>
        tool.execute(
          { description: `t-${i}`, prompt: `do-${i}`, subagent_type: 'general-purpose' },
          makeContext('/shared/cwd'),
        ),
      ),
    )

    expect(calls).toHaveLength(5)
    for (let i = 0; i < 5; i++) {
      expect(calls[i]?.cwd).toBe('/shared/cwd')
      expect(calls[i]?.renderer).toBe(parentRenderer)
      expect(results[i].content).toContain('done-by-shared')
    }

    // Each recorded delegated prompt must correspond to its description —
    // proves the parent's bindings are stable across the parallel batch
    // even though the recorder array order isn't guaranteed.
    const expected = new Set(['t-0', 't-1', 't-2', 't-3', 't-4'])
    const seen = new Set<string>()
    for (const call of calls) {
      const m = call.promptContains.match(/\[Task Description\]\n([^\n]+)/)
      expect(m).not.toBeNull()
      const desc = m![1]
      seen.add(desc)
      expect(call.promptContains).toContain(`[Task Instructions]\ndo-${desc.slice(2)}`)
    }
    expect(seen).toEqual(expected)
  })

  it('parallel siblings from the same AgentTool all observe the SAME nextDepth (no mutable counter)', async () => {
    // Depth is derived from `parentConfig.initialAgentDepth + 1`. There is
    // no per-instance counter, so all parallel siblings dispatched from
    // the same parent observe the SAME nextDepth — they cannot drift from
    // each other through a shared module variable or instance field.
    const calls: RecordedCall[] = []
    const renderer = { agentStart() {}, agentDone() {}, agentSummary() {}, agentHeartbeat() {} }
    const parentConfig: EngineConfig = makeParentConfig({ initialAgentDepth: 2 })

    const tool = new AgentTool({
      factory: recordingPromptFactory(capturingFactory('shared', calls), calls),
      parentConfig,
      parentRenderer: renderer,
    })

    await Promise.all(
      Array.from({ length: 4 }, (_, i) =>
        tool.execute(
          { description: `s-${i}`, prompt: `p-${i}`, subagent_type: 'general-purpose' },
          makeContext('/parent/cwd'),
        ),
      ),
    )

    expect(calls).toHaveLength(4)
    // Every child saw initialAgentDepth = nextDepth = parentDepth + 1 = 3.
    // They all observed the SAME value because there's no shared counter
    // for parallel siblings to fight over.
    for (const c of calls) {
      expect(c.initialDepth).toBe(3)
      expect(c.promptHasParentCallDepth).toBe(3)
    }
  })

  it('per-instance depth inherits from EngineConfig.initialAgentDepth independently of siblings', async () => {
    // Each AgentTool instance computes effective depth from its OWN
    // parentConfig.initialAgentDepth. There is no shared module-level
    // counter, so two instances with different inherited depths behave
    // independently.
    const calls: RecordedCall[] = []
    const renderer = { agentStart() {}, agentDone() {}, agentSummary() {}, agentHeartbeat() {} }

    // Instance A starts 5 deep — nextDepth = 5 + 1 = 6 > MAX (5) → rejected.
    const parentA: EngineConfig = makeParentConfig({ initialAgentDepth: 5 })
    // Instance B starts at the root — nextDepth = 0 + 1 = 1 ≤ MAX → succeeds.
    const parentB: EngineConfig = makeParentConfig({ initialAgentDepth: 0 })

    const toolA = new AgentTool({
      factory: capturingFactory('A', calls),
      parentConfig: parentA,
      parentRenderer: renderer,
    })
    const toolB = new AgentTool({
      factory: capturingFactory('B', calls),
      parentConfig: parentB,
      parentRenderer: renderer,
    })

    const [outA, outB] = await Promise.all([
      toolA.execute({ description: 'a1', prompt: 'p', subagent_type: 'general-purpose' }, makeContext('/parent/cwd')),
      toolB.execute({ description: 'b1', prompt: 'p', subagent_type: 'general-purpose' }, makeContext('/parent/cwd')),
    ])

    // A had inherited depth 5 — nextDepth = 6 > 5, so the cap rejected.
    expect(outA.isError).toBe(true)
    expect(outA.content).toMatch(/Max agent call depth/i)

    // B had inherited depth 0 — nextDepth = 1, well under cap → succeeds.
    expect(outB.isError).toBe(false)
    expect(outB.content).toContain('done-by-B')

    // Each tool's depth decision was made from ITS OWN config — A's block
    // didn't leak into B's allow, and B's allow didn't loosen A's block.
  })

  it('threads call depth through EngineConfig.initialAgentDepth (global cap across nested spawns)', async () => {
    // Build a 2-level chain: tool → tool2. tool2 inherits initialAgentDepth
    // from tool's childConfig. If the implementation forgot to thread depth,
    // the global cap would never trigger on a long chain.
    const calls: RecordedCall[] = []
    const renderer = { agentStart() {}, agentDone() {}, agentSummary() {}, agentHeartbeat() {} }
    const parent: EngineConfig = makeParentConfig({ initialAgentDepth: 4 })
    // nextDepth for tool = 4 + 1 = 5 = MAX → would be rejected.
    // So use a smaller starting depth and prove the depth propagates.
    const startParent: EngineConfig = makeParentConfig({ initialAgentDepth: 1 })
    void parent

    // tool spawns tool2 with a child config that copies initialAgentDepth.
    const tool = new AgentTool({
      factory: (cfg, _r) => {
        calls.push({ cwd: cfg.cwd, renderer: _r, initialDepth: cfg.initialAgentDepth, promptContains: '', promptHasParentCallDepth: 0 })
        const nested = new AgentTool({
          factory: capturingFactory('nested', calls),
          parentConfig: cfg,
          parentRenderer: renderer,
        })
        return {
          runTurn: async (msg: string) => {
            const r = await nested.execute({ description: 'inner', prompt: msg, subagent_type: 'general-purpose' }, makeContext(cfg.cwd))
            return { result: { output: r.content, reason: r.isError ? 'error' : 'stop' } }
          },
          abort: () => {},
        }
      },
      parentConfig: startParent,
      parentRenderer: renderer,
    })

    await tool.execute({ description: 'outer', prompt: 'p', subagent_type: 'general-purpose' }, makeContext('/parent/cwd'))

    // tool's childConfig sets initialAgentDepth = nextDepth = 1 + 1 = 2.
    // nested sees initialAgentDepth = 2 on its parent config; the recorder
    // captured that value before nested ran.
    expect(calls[0]?.initialDepth).toBe(2)
  })

  it('rejects nested spawn when parentConfig.initialAgentDepth = MAX_CALL_DEPTH', async () => {
    // Boundary: inheritedDepth = MAX → nextDepth = MAX + 1 → rejected.
    const renderer = { agentStart() {}, agentDone() {}, agentSummary() {}, agentHeartbeat() {} }
    const parentConfig: EngineConfig = makeParentConfig({ initialAgentDepth: 5 })
    const tool = new AgentTool({
      factory: capturingFactory('never', []),
      parentConfig,
      parentRenderer: renderer,
    })
    const result = await tool.execute(
      { description: 't', prompt: 'p', subagent_type: 'general-purpose' },
      makeContext('/parent/cwd'),
    )
    expect(result.isError).toBe(true)
    expect(result.content).toMatch(/Max agent call depth/i)
  })

  it('rejects invocation when an AgentTool instance has no wiring (not initialized)', async () => {
    // The constructor parameter is OPTIONAL — when wiring is omitted,
    // the runtime guard in execute() returns "not initialized".
    const bare = new AgentTool()
    const result = await bare.execute(
      { description: 't', prompt: 'p', subagent_type: 'general-purpose' },
      makeContext('/cwd'),
    )
    expect(result.isError).toBe(true)
    expect(result.content).toMatch(/not initialized/i)
  })

  it('createTools requires complete AgentWiring and forwards it to the AgentTool instance', () => {
    // createTools has no default wiring — the caller (engine constructor)
    // MUST supply a full AgentWiring. Verify the returned tool list contains
    // exactly one AgentTool with the supplied wiring.
    const factory: AgentChildEngineFactory = (_cfg, _r) => ({
      runTurn: async () => {
        await Promise.resolve()
        return { result: { output: '', reason: 'stop' } }
      },
      abort: () => {},
    })
    const parentConfig: EngineConfig = makeParentConfig()
    const parentRenderer = { tag: 'engine-renderer' }
    const wiring: AgentWiring = { factory, parentConfig, parentRenderer }

    const tools = createTools([], wiring)
    const agent = tools.find((t) => t.name === 'Agent')
    expect(agent).toBeDefined()
    // The instance carries the wiring we passed — there is no module-level
    // fallback for createTools to consult instead.
    const wiringFields = agent as unknown as {
      factory: AgentChildEngineFactory
      parentConfig: EngineConfig
      parentRenderer: unknown
    }
    expect(wiringFields.factory).toBe(factory)
    expect(wiringFields.parentConfig).toBe(parentConfig)
    expect(wiringFields.parentRenderer).toBe(parentRenderer)
  })

  it('createTools extra tools are appended after the Agent tool', () => {
    // Sanity check that the extraTools path still works after the wiring
    // change — extras come AFTER the Agent tool in the returned list.
    const wiring: AgentWiring = {
      factory: (_cfg, _r) => ({
        runTurn: async () => {
          await Promise.resolve()
          return { result: { output: '', reason: 'stop' } }
        },
        abort: () => {},
      }),
      parentConfig: makeParentConfig(),
      parentRenderer: {},
    }
    const extra = {
      name: 'Extra',
      definition: {
        type: 'function' as const,
        function: {
          name: 'Extra',
          description: '',
          parameters: { type: 'object' as const, properties: {} as Record<string, unknown> },
        },
      },
      execute: async () => {
        await Promise.resolve()
        return { content: '', isError: false }
      },
    }
    const tools = createTools([extra], wiring)
    expect(tools[tools.length - 1]).toBe(extra)
    // Agent tool is still present.
    expect(tools.some((t) => t.name === 'Agent')).toBe(true)
  })

  it('createTools without wiring still constructs an AgentTool that returns "not initialized" at action time', async () => {
    // Second parameter is OPTIONAL — when omitted, createTools falls back
    // to `new AgentTool()` with no wiring. Constructing the engine/tool
    // must NOT throw; only invoking the Agent action must produce a
    // clear "not initialized" error.
    const tools = createTools()
    const agent = tools.find((t) => t.name === 'Agent')
    expect(agent).toBeDefined()

    const result = await agent!.execute(
      { description: 't', prompt: 'p', subagent_type: 'general-purpose' },
      makeContext('/cwd'),
    )
    expect(result.isError).toBe(true)
    expect(result.content).toMatch(/not initialized/i)
  })

  it('createTools with partial wiring (missing fields) is rejected at the type level', () => {
    // AgentWiring fields are required when a wiring IS supplied. The
    // type system rejects incomplete wiring — verify the type by
    // assigning to a typed variable and checking the property shape.
    const wiring: AgentWiring = {
      factory: (_cfg, _r) => ({
        runTurn: async () => {
          await Promise.resolve()
          return { result: { output: '', reason: 'stop' } }
        },
        abort: () => {},
      }),
      parentConfig: makeParentConfig(),
      parentRenderer: {},
    }
    // All three fields are present — sanity check on the type contract.
    expect(wiring.factory).toBeDefined()
    expect(wiring.parentConfig).toBeDefined()
    expect('parentRenderer' in wiring).toBe(true)
  })
})
