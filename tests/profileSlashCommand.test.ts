/**
 * v0.4.1 WS4 — /exec-profile slash command contract.
 *
 * Named exec-profile because /profile belongs to the legacy config-profiles
 * system and /effort is the reasoning-effort axis. Mirrors the /model
 * contract: no args shows state + the full profile catalog; a name sets a
 * STICKY override via the engine seam; 'auto' clears it; garbage is
 * rejected without touching the engine.
 */
import { describe, expect, it } from 'vitest'
import {
  dispatchSlashCommand,
  type SlashCommandContext,
  type SlashCommandResult,
} from '../src/commands/index.js'
// Side-effect import — registers every built-in /command (including /profile).
import '../src/commands/builtin.js'
import type { ExecutionProfile } from '../src/core/effort.js'

class StubEngine {
  override: ExecutionProfile | null = null
  setCalls: Array<ExecutionProfile | null> = []
  getExecutionProfileOverride(): ExecutionProfile | null {
    return this.override
  }
  setExecutionProfileOverride(profile: ExecutionProfile | null): void {
    this.setCalls.push(profile)
    this.override = profile
  }
}

function ctxFor(engine: StubEngine): SlashCommandContext {
  return {
    engine: engine as unknown as SlashCommandContext['engine'],
    renderer: {} as SlashCommandContext['renderer'],
    history: [],
    cwd: '/repo',
    setHistory: () => undefined,
    runPrompt: () => undefined,
  }
}

async function runProfile(engine: StubEngine, args: string): Promise<SlashCommandResult | null> {
  return dispatchSlashCommand(`/exec-profile ${args}`.trim(), ctxFor(engine))
}

function textOf(result: SlashCommandResult | null): string {
  if (!result || result.type !== 'text') throw new Error('expected text result, got ' + JSON.stringify(result))
  return result.value
}

describe('/exec-profile slash command', () => {
  it('no args shows auto state and the full catalog with real specs', async () => {
    const engine = new StubEngine()
    const out = textOf(await runProfile(engine, ''))
    expect(out).toContain('auto')
    expect(out).toContain('fast')
    expect(out).toContain('standard')
    expect(out).toContain('deep')
    expect(out).toContain('autonomous')
    // Catalog must expose the control surface, not just names.
    expect(out).toContain('max iterations: 30')
    expect(out).toContain('hidden tools: Agent, TaskPlan')
    expect(engine.setCalls).toHaveLength(0)
  })

  it('reflects an existing sticky override', async () => {
    const engine = new StubEngine()
    engine.override = 'deep'
    const out = textOf(await runProfile(engine, ''))
    expect(out).toContain('deep')
    expect(out).toContain('sticky override')
  })

  it('sets a sticky override by name', async () => {
    const engine = new StubEngine()
    const out = textOf(await runProfile(engine, 'fast'))
    expect(out).toContain('fast')
    expect(engine.setCalls).toEqual(['fast'])
    expect(engine.override).toBe('fast')
  })

  it("'auto' and 'clear' both clear the override", async () => {
    const engine = new StubEngine()
    engine.override = 'deep'
    await runProfile(engine, 'auto')
    expect(engine.setCalls).toEqual([null])
    expect(engine.override).toBeNull()

    engine.override = 'fast'
    await runProfile(engine, 'clear')
    expect(engine.setCalls).toEqual([null, null])
    expect(engine.override).toBeNull()
  })

  it('rejects unknown profiles without touching the engine', async () => {
    const engine = new StubEngine()
    const out = textOf(await runProfile(engine, 'turbo'))
    expect(out).toContain('Unknown profile')
    expect(engine.setCalls).toHaveLength(0)
    expect(engine.override).toBeNull()
  })
})
