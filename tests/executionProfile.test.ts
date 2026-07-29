/**
 * v0.4.1 WS4 — ExecutionProfile (renamed from the v0.4.0 dead-code
 * "ExecutionGear", now wired).
 *
 * Coverage:
 *   1. detectExecutionProfile classification table
 *   2. EXECUTION_PROFILES specs — including the gate that `standard`
 *      is byte-for-byte the pre-v0.4.1 default (zero behavior change)
 *   3. resolveExecutionProfile precedence (override > intent > detected > default)
 *   4. ModuleManager.boot({only}) — per-turn gating without mutating the
 *      constructed module list (so the next full boot restores everything)
 *   5. ToolPolicy excludedTools — hidden from definitions AND blocked at
 *      execution time (defense in depth)
 *   6. Engine-level e2e: a `fast` turn boots no Critic/Reflection, hides
 *      Agent/TaskPlan, and blocks a fabricated TaskPlan call with the
 *      profile error — verified through the real coordinator via the
 *      engine DI seam (fake client, no network).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  EXECUTION_PROFILES,
  isExecutionProfile,
  detectExecutionProfile,
  resolveExecutionProfile,
} from '../src/core/effort.js'
import type { ExecutionProfile } from '../src/core/effort.js'
import { ModuleManager } from '../src/core/moduleRuntime/moduleManager.js'
import { ToolPolicy } from '../src/core/toolRuntime/toolPolicy.js'
import { ExecutionEngine } from '../src/core/engine.js'
import type { AgentModule } from '../src/core/module.js'
import type { EngineConfig, Tool } from '../src/core/types.js'
import type { Renderer } from '../src/ui/renderer.js'
import type { RunEvent } from '../src/core/runtime/events.js'
import { SemanticMemory } from '../src/core/semanticMemory.js'
import { EpisodicMemory } from '../src/core/episodicMemory.js'

// ── 1. detection table ────────────────────────────────────────────────────────

describe('detectExecutionProfile', () => {
  it('classifies Q&A as fast, fixes as standard, refactors as deep', () => {
    expect(detectExecutionProfile('what is the time?')).toBe('fast')
    expect(detectExecutionProfile('explain how this function works')).toBe('fast')
    expect(detectExecutionProfile('fix the bug in src/add.ts')).toBe('standard')
    expect(detectExecutionProfile('refactor the entire multi-file architecture')).toBe('deep')
    expect(detectExecutionProfile('migrate the database schema end-to-end')).toBe('deep')
  })

  it('loop entry is autonomous', () => {
    expect(detectExecutionProfile('anything at all', true)).toBe('autonomous')
  })

  it('empty prompt is fast', () => {
    expect(detectExecutionProfile('   ')).toBe('fast')
  })
})

describe('detectExecutionProfile multilingual complexity', () => {
  it.each([
    '全面重构认证与会话模块',
    '跨模块迁移公共接口并调整整体架构',
    '对这个仓库进行深度审计和根因分析',
    '整体改造 the runtime across multiple directories',
    'perform a root-cause analysis and cross-module migration',
  ])('routes complex task to deep: %s', (prompt) => {
    expect(detectExecutionProfile(prompt)).toBe('deep')
  })
})

// ── 2. profile specs ──────────────────────────────────────────────────────────

describe('EXECUTION_PROFILES', () => {
  it('fast: no critic/reflection, no sub-agent/task-plan tools, capped iterations', () => {
    const fast = EXECUTION_PROFILES.fast
    expect(fast.modules).toEqual(['memory', 'workspace'])
    expect(fast.modules).not.toContain('critic')
    expect(fast.modules).not.toContain('reflection')
    expect(fast.excludedTools).toContain('Agent')
    expect(fast.excludedTools).toContain('TaskPlan')
    expect(fast.maxIterations).toBe(30)
  })

  it('standard is EXACTLY the pre-v0.4.1 default (zero-change gate)', () => {
    const standard = EXECUTION_PROFILES.standard
    // The v0.4.0 default module set, verbatim.
    expect(standard.modules).toEqual(['memory', 'critic', 'workspace', 'reflection'])
    // No caps, no tool exclusions — a standard turn behaves like v0.4.0.
    expect(standard.maxIterations).toBeUndefined()
    expect(standard.maxOutputTokens).toBeUndefined()
    expect(standard.excludedTools ?? []).toEqual([])
  })

  it('deep raises iteration and output budgets', () => {
    const deep = EXECUTION_PROFILES.deep
    expect(deep.maxIterations).toBe(300)
    expect(deep.maxOutputTokens).toBeGreaterThan(0)
  })

  it('every profile has a description; autonomous is documented', () => {
    for (const p of ['fast', 'standard', 'deep', 'autonomous'] as const) {
      expect(EXECUTION_PROFILES[p].description.length).toBeGreaterThan(10)
    }
  })

  it('isExecutionProfile validates the four names only', () => {
    expect(isExecutionProfile('fast')).toBe(true)
    expect(isExecutionProfile('autonomous')).toBe(true)
    expect(isExecutionProfile('turbo')).toBe(false)
    expect(isExecutionProfile('')).toBe(false)
  })
})

// ── 3. resolution precedence ─────────────────────────────────────────────────

describe('resolveExecutionProfile', () => {
  it('sticky override wins over everything', () => {
    const r = resolveExecutionProfile('refactor the multi-file architecture', { kind: 'informational' }, 'deep')
    expect(r).toEqual({ profile: 'deep', source: 'override' })
  })

  it('complexity escalation wins over informational intent', () => {
    const r = resolveExecutionProfile('explain the migration strategy', { kind: 'informational' })
    expect(r).toEqual({ profile: 'deep', source: 'detected' })
  })

  it('mutation intent + complex regex escalates to deep (detected)', () => {
    const r = resolveExecutionProfile('refactor the entire multi-file architecture', { kind: 'mutation' })
    expect(r).toEqual({ profile: 'deep', source: 'detected' })
  })

  it('mutation intent + ordinary fix stays standard (default)', () => {
    const r = resolveExecutionProfile('fix the bug in src/add.ts', { kind: 'mutation' })
    expect(r).toEqual({ profile: 'standard', source: 'default' })
  })

  it('no intent + question-shaped text is fast (detected)', () => {
    const r = resolveExecutionProfile('what does this do?', null)
    expect(r).toEqual({ profile: 'fast', source: 'detected' })
  })
})

// ── 4. ModuleManager per-turn gating ─────────────────────────────────────────

function stubModule(name: string, bootLog: string[]): AgentModule {
  return {
    name,
    async boot() {
      bootLog.push(name)
      return { systemPromptSections: [`[${name}]`], tools: [] }
    },
    async onIteration() { bootLog.push(`${name}:iter`) },
  }
}

function silentRenderer(): Renderer {
  return new Proxy({}, { get: () => () => undefined }) as unknown as Renderer
}

describe('ModuleManager.boot({only}) — per-turn gating', () => {
  it('boots only the listed modules; iteration hooks see only them', async () => {
    const log: string[] = []
    const mm = new ModuleManager({
      modules: [stubModule('memory', log), stubModule('critic', log), stubModule('workspace', log)],
      renderer: silentRenderer(),
    })

    await mm.boot({ cwd: '/x', config: {} as never, userMessage: 'hi' }, { only: ['memory', 'workspace'] })
    expect(log).toEqual(['memory', 'workspace'])
    expect(mm.moduleNames).toEqual(['memory', 'workspace'])

    await mm.runIteration({ iteration: 1, messages: [], abortSignal: new AbortController().signal })
    expect(log.filter(l => l.endsWith(':iter'))).toEqual(['memory:iter', 'workspace:iter'])
  })

  it('a subsequent FULL boot restores the complete constructed set', async () => {
    const log: string[] = []
    const mm = new ModuleManager({
      modules: [stubModule('memory', log), stubModule('critic', log), stubModule('reflection', log)],
      renderer: silentRenderer(),
    })
    await mm.boot({ cwd: '/x', config: {} as never, userMessage: 'hi' }, { only: ['memory'] })
    expect(mm.moduleNames).toEqual(['memory'])

    log.length = 0
    await mm.boot({ cwd: '/x', config: {} as never, userMessage: 'hi' })
    expect(log).toEqual(['memory', 'critic', 'reflection'])
    expect(mm.moduleNames).toEqual(['memory', 'critic', 'reflection'])
  })

  it('gated boot does NOT permanently drop a failing best-effort module from the full set', async () => {
    const log: string[] = []
    const bad: AgentModule = {
      name: 'critic',
      criticality: 'best_effort',
      async boot() { throw new Error('boom') },
    } as unknown as AgentModule
    const mm = new ModuleManager({
      modules: [stubModule('memory', log), bad],
      renderer: silentRenderer(),
    })
    await mm.boot({ cwd: '/x', config: {} as never, userMessage: 'hi' }, { only: ['memory', 'critic'] })
    expect(mm.moduleNames).toEqual(['memory']) // scoped view dropped it for THIS turn

    // Next turn asks for it again — the constructed list still has it.
    log.length = 0
    await mm.boot({ cwd: '/x', config: {} as never, userMessage: 'hi' }, { only: ['memory', 'critic'] })
    expect(log).toContain('memory')
  })
})

// ── 5. ToolPolicy excludedTools ──────────────────────────────────────────────

function stubTool(name: string, readOnly = false): Tool {
  return {
    name,
    metadata: { readOnly, claims: () => [] },
    definition: { type: 'function', function: { name, description: '', parameters: { type: 'object', properties: {} } } },
    async execute() { return { content: '', isError: false } },
  } as unknown as Tool
}

describe('ToolPolicy excludedTools (profile tool gate)', () => {
  const tools = [
    stubTool('Read', true),
    stubTool('Agent'),
    stubTool('TaskPlan'),
    stubTool('Bash'),
    stubTool('Edit'),
    stubTool('Write'),
  ]
  const policy = new ToolPolicy({})

  it('hides excluded tools from the definitions sent to the model', () => {
    const defs = policy.getExposedDefinitions(tools, false, ['Agent', 'TaskPlan'])
    const names = defs.map(d => d.function.name)
    expect(names).toContain('Read')
    expect(names).toContain('Bash')
    expect(names).not.toContain('Agent')
    expect(names).not.toContain('TaskPlan')
  })

  it('blocks a fabricated excluded-tool call at execution time', () => {
    const err = policy.checkExecutionAllowed(tools, 'TaskPlan', false, ['Agent', 'TaskPlan'])
    expect(err).toContain('execution profile')
    expect(policy.checkExecutionAllowed(tools, 'Read', false, ['Agent', 'TaskPlan'])).toBeNull()
  })

  it('no exclusions → identical behavior to v0.4.0', () => {
    expect(policy.getExposedDefinitions(tools, false).map(d => d.function.name)).toHaveLength(6)
    expect(policy.checkExecutionAllowed(tools, 'Agent', false)).toBeNull()
  })

  it.each(['informational', 'analysis'] as const)('%s intent exposes and executes read-only tools only', (intent) => {
    const names = policy.getExposedDefinitions(tools, false, undefined, intent).map(d => d.function.name)
    expect(names).toEqual(['Read'])
    expect(policy.checkExecutionAllowed(tools, 'Read', false, undefined, intent)).toBeNull()
    expect(policy.checkExecutionAllowed(tools, 'Edit', false, undefined, intent)).toContain('read-only')
    expect(policy.checkExecutionAllowed(tools, 'Write', false, undefined, intent)).toContain('read-only')
    expect(policy.checkExecutionAllowed(tools, 'Bash', false, undefined, intent)).toContain('read-only')
  })

  it('mutation intent preserves writable tools', () => {
    const names = policy.getExposedDefinitions(tools, false, undefined, 'mutation').map(d => d.function.name)
    expect(names).toContain('Edit')
    expect(names).toContain('Write')
    expect(names).toContain('Bash')
    expect(policy.checkExecutionAllowed(tools, 'Edit', false, undefined, 'mutation')).toBeNull()
  })
})

// ── 6. engine-level per-turn gating e2e ───────────────────────────────────────

type Queued = { k: 's'; s: AsyncIterable<unknown> } | { k: 'e'; e: Error }
class FakeOpenAI {
  createCalls = 0
  private q: Queued[] = []
  chat = { completions: { create: (_p: Record<string, unknown>, o: { signal: AbortSignal }) => {
    this.createCalls++
    const n = this.q[this.createCalls - 1] ?? { k: 'e' as const, e: new Error('parked') }
    return new Promise<AsyncIterable<unknown>>((res, rej) => {
      if (o.signal.aborted) { rej(new Error('aborted')); return }
      o.signal.addEventListener('abort', () => rej(new Error('aborted')), { once: true })
      if (n.k === 's') res(n.s); else rej(n.e)
    })
  } } }
  push(s: AsyncIterable<unknown>) { this.q.push({ k: 's', s }) }
}

function stopStream(text: string): AsyncIterable<unknown> {
  return (async function* () {
    await Promise.resolve()
    yield { choices: [{ index: 0, delta: { content: text }, finish_reason: null }] }
    yield { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 5 } }
  })()
}

function toolCallStream(id: string, name: string, args: Record<string, unknown>): AsyncIterable<unknown> {
  return (async function* () {
    await Promise.resolve()
    yield {
      choices: [{
        index: 0,
        delta: { tool_calls: [{ index: 0, id, function: { name, arguments: JSON.stringify(args) } }] },
        finish_reason: null,
      }],
    }
    yield { choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] }
  })()
}

function fakeRenderer(): Renderer {
  const r: Record<string, (...args: unknown[]) => void> = {}
  for (const k of ['banner', 'raw', 'info', 'warn', 'error', 'success', 'startSpinner', 'stopSpinner', 'beginAssistantText', 'endAssistantText', 'streamToken', 'streamReasoning', 'assistantMessage', 'userMessage', 'toolCall', 'toolStart', 'toolResult', 'compactStart', 'compactDone', 'contextWarning', 'cost', 'compactionNotice', 'turnEnd', 'planModeHeader', 'agentStart', 'agentDone', 'agentSummary', 'agentHeartbeat']) r[k] = () => {}
  return r as unknown as Renderer
}

describe('ExecutionEngine per-turn profile gating (fake client e2e)', () => {
  let workDir: string
  let sessionDir: string
  let fakeClient: FakeOpenAI

  beforeEach(() => {
    workDir = mkdtempSync(join(tmpdir(), 'prof-eval-'))
    sessionDir = mkdtempSync(join(tmpdir(), 'prof-session-'))
    fakeClient = new FakeOpenAI()
  })
  afterEach(() => {
    try { rmSync(workDir, { recursive: true, force: true }) } catch { /* best-effort */ }
    try { rmSync(sessionDir, { recursive: true, force: true }) } catch { /* best-effort */ }
  })

  function makeEngine(): ExecutionEngine {
    const config: EngineConfig = {
      model: 'gpt-4o',
      apiKey: 'test-key',
      cwd: workDir,
      maxIterations: 20,
      permissionMode: 'auto',
      sessionDir,
      semanticMemory: new SemanticMemory(join(workDir, 'sem')),
      episodicMemory: new EpisodicMemory(join(workDir, 'ep')),
      enabledModules: ['memory', 'critic', 'workspace', 'reflection'],
    }
    return new ExecutionEngine(config, fakeRenderer(), fakeClient as unknown as never)
  }

  it('fast override: PROFILE_RESOLVED carries the gated module set, no critic/reflection', async () => {
    fakeClient.push(stopStream('4'))
    const engine = makeEngine()
    engine.setExecutionProfileOverride('fast')

    const events: RunEvent[] = []
    engine.getEventEmitter().on('PROFILE_RESOLVED' as never, (e: RunEvent) => events.push(e))

    const { outcome } = await engine.runTurn('what is 2+2?', [])
    expect(outcome.completion.status).toBe('completed')

    const resolved = events.find(e => e.type === 'PROFILE_RESOLVED') as
      { type: 'PROFILE_RESOLVED'; profile: ExecutionProfile; source: string; modules: string[] } | undefined
    expect(resolved).toBeTruthy()
    expect(resolved!.profile).toBe('fast')
    expect(resolved!.source).toBe('override')
    expect(resolved!.modules).not.toContain('critic')
    expect(resolved!.modules).not.toContain('reflection')
    expect(resolved!.modules).toContain('memory')
    expect(resolved!.modules).toContain('workspace')
    engine.dispose()
  })

  it('no override, informational question: resolves fast by intent', async () => {
    fakeClient.push(stopStream('because'))
    const engine = makeEngine()
    const events: RunEvent[] = []
    engine.getEventEmitter().on('PROFILE_RESOLVED' as never, (e: RunEvent) => events.push(e))
    await engine.runTurn('why is the sky blue?', [])
    const resolved = events.find(e => e.type === 'PROFILE_RESOLVED') as
      { type: 'PROFILE_RESOLVED'; profile: ExecutionProfile; source: string } | undefined
    expect(resolved).toBeTruthy()
    expect(resolved!.profile).toBe('fast')
    expect(resolved!.source).toBe('intent')
    engine.dispose()
  })

  it('fast profile blocks a fabricated TaskPlan call with the profile error', async () => {
    // First model turn fabricates a TaskPlan call; second stops.
    fakeClient.push(toolCallStream('call_1', 'TaskPlan', { action: 'add', title: 'x' }))
    fakeClient.push(stopStream('done'))
    const engine = makeEngine()
    engine.setExecutionProfileOverride('fast')

    const { newHistory } = await engine.runTurn('plan something', [])
    const toolResults = newHistory.filter(m => m.role === 'tool')
    expect(toolResults.length).toBeGreaterThan(0)
    const blocked = toolResults.some(m =>
      String(m.content).includes('execution profile') || String(m.content).includes('read-only analysis task'))
    expect(blocked).toBe(true)
    engine.dispose()
  })

  it('informational turn blocks a fabricated Write call before workspace mutation', async () => {
    fakeClient.push(toolCallStream('call_write', 'Write', { file_path: '/tmp/must-not-write', content: 'x' }))
    fakeClient.push(stopStream('done'))
    const engine = makeEngine()
    const { newHistory } = await engine.runTurn('what is this project?', [])
    const toolResults = newHistory.filter(m => m.role === 'tool')
    expect(toolResults.some(m => String(m.content).includes('read-only informational task'))).toBe(true)
    engine.dispose()
  })

  it('standard (no override) keeps the full module set — v0.4.0 behavior unchanged', async () => {
    fakeClient.push(stopStream('ok'))
    const engine = makeEngine()
    const events: RunEvent[] = []
    engine.getEventEmitter().on('PROFILE_RESOLVED' as never, (e: RunEvent) => events.push(e))
    // Mutation-shaped prompt → not informational → standard default.
    await engine.runTurn('fix the build', [])
    const resolved = events.find(e => e.type === 'PROFILE_RESOLVED') as
      { type: 'PROFILE_RESOLVED'; profile: ExecutionProfile; modules: string[] } | undefined
    expect(resolved).toBeTruthy()
    expect(resolved!.profile).toBe('standard')
    expect(resolved!.modules).toEqual(expect.arrayContaining(['memory', 'critic', 'workspace', 'reflection']))
    engine.dispose()
  })
})
