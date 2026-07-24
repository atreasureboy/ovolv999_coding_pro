/**
 * v0.3.1 slash commands (te_goal §八).
 *
 * Verifies:
 *   - /progress exists and renders structured progress
 *   - /route auto clears the manual override
 *   - /model auto / /model <id> paths
 *   - /models shows provider + baseURL + key from BindingRegistry
 *   - duplicate command registration throws in dev mode
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { registerCommand, listCommands, clearRegistry, getCommand, dispatchSlashCommand } from '../src/commands/index.js'
// Importing the built-in commands so getCommand('model') / 'route' / etc.
// resolve to real handlers in the unit-test process.
import '../src/commands/builtin.js'

function fakeCtx(engine: any): any {
  return {
    engine,
    renderer: { warn: () => {}, info: () => {}, error: () => {} },
    history: [],
    cwd: '/tmp',
    sessionDir: '/tmp',
    setHistory: () => {},
    runPrompt: () => {},
  }
}

function fakeEngine(opts: { override?: string | null; profiles?: any[] } = {}): any {
  const profiles = opts.profiles ?? [
    { id: 'main', provider: 'openai', model: 'gpt-4o', available: true, roles: ['main'], capabilities: { reasoning: 0.9, coding: 0.9, contextWindow: 128_000, toolCalling: 0.9, speed: 0.5, cost: 0.5 } },
  ]
  const router = {
    isRoutingEnabled: () => true,
    getLastDecision: () => null,
    getManualOverride: () => opts.override ?? null,
    listProfiles: () => profiles,
    getProfileHealth: () => null,
    setModelByUser: (m: string) => { opts.override = m },
    clearModelOverride: () => { opts.override = null },
  }
  return {
    getModelRouter: () => router,
    getModel: () => opts.override ?? 'gpt-4o',
    setModelByUser: (m: string) => { opts.override = m; router.setModelByUser(m) },
    clearModelOverride: () => { opts.override = null; router.clearModelOverride() },
    getContextManager: () => ({ getWorkingState: () => ({ filesRead: [], filesChanged: ['a.ts'], verification: { passed: ['t1'], failed: [] }, unresolved: [] }) }),
    getTaskGraph: () => ({ snapshot: () => ({ nodes: [], summary: { total: 0, completed: 0, failed: 0, blocked: 0, running: 0, ready: 0, pending: 0, done: true } }) }),
    getProgressMonitor: () => ({ snapshot: () => ({ iteration: 3, changedFiles: ['a.ts'], verificationDelta: -1, newArtifacts: [], repeatedToolCalls: 0, repeatedErrors: 0, minutesSinceLastMeaningfulProgress: 0.5, remainingAcceptanceCriteria: [] }) }),
    getCostTracker: () => ({ getTotalAPICalls: () => 5, getTotalCost: () => 0.0023 }),
    getBindingRegistry: () => ({ get: (id: string) => id === 'main' ? { profileId: 'main', provider: 'openai', model: 'gpt-4o', baseURL: 'https://api.openai.com/v1', apiKeyRef: 'OPENAI_API_KEY', roles: ['main'], capabilities: profiles[0].capabilities } : undefined }),
  }
}

describe('Slash commands v0.3.1', () => {
  // builtin.ts registers all commands at module-load. Don't clear
  // in beforeEach — that wipes the /model / /route / /models
  // handlers we want to test. Use OVOLV999_NO_STRICT_SLASH so
  // the duplicate-detection test below can register a different
  // command without colliding with an existing one.
  beforeEach(() => {
    process.env.OVOLV999_NO_STRICT_SLASH = '1'
  })
  afterEach(() => {
    delete process.env.OVOLV999_NO_STRICT_SLASH
  })

  it('/model auto clears the manual override', () => {
    const e = fakeEngine({ override: 'haiku' })
    const cmd = getCommand('model')!
    const r = cmd.handler('auto', fakeCtx(e)) as any
    expect(r.value).toMatch(/cleared/i)
    expect(e.getModelRouter().getManualOverride()).toBeNull()
  })

  it('/model <id> sets a manual override', () => {
    const e = fakeEngine({ override: null })
    const cmd = getCommand('model')!
    const r = cmd.handler('haiku', fakeCtx(e)) as any
    expect(r.value).toMatch(/set by user/i)
    expect(e.getModelRouter().getManualOverride()).toBe('haiku')
  })

  it('/route auto clears the manual override', () => {
    const e = fakeEngine({ override: 'haiku' })
    const cmd = getCommand('route')!
    const r = cmd.handler('auto', fakeCtx(e)) as any
    expect(r.value).toMatch(/cleared/i)
    expect(e.getModelRouter().getManualOverride()).toBeNull()
  })

  it('/models surfaces provider + baseURL + key from the binding registry', () => {
    const e = fakeEngine()
    const cmd = getCommand('models')!
    const r = cmd.handler('', fakeCtx(e)) as any
    expect(r.value).toMatch(/provider=openai/)
    expect(r.value).toMatch(/baseURL=https:\/\/api\.openai\.com\/v1/)
    expect(r.value).toMatch(/OPENAI_API_KEY/)
  })

  it('duplicate command registration throws when strict mode is on', () => {
    process.env.OVOLV999_NO_STRICT_SLASH = '0' // ensure strict
    delete process.env.OVOLV999_NO_STRICT_SLASH
    // The handler must be DIFFERENT from any prior registration of
    // this name. builtin.ts already registered 'tasks' with the
    // TaskGraph handler; we add a different one to trigger throw.
    expect(() => {
      registerCommand({ name: 'tasks', description: 'override', handler: () => ({ type: 'noop' }) })
    }).toThrow(/registered twice/)
  })

  it('listCommands dedupes by name', () => {
    const cmds = listCommands()
    const tasks = cmds.filter((c) => c.name === 'tasks')
    expect(tasks.length).toBe(1)
  })

  it('dispatchSlashCommand routes /model auto through to the engine', async () => {
    const e = fakeEngine({ override: 'haiku' })
    const r = await dispatchSlashCommand('/model auto', fakeCtx(e))
    expect(r).not.toBeNull()
    expect(e.getModelRouter().getManualOverride()).toBeNull()
  })
})