import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, readFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

import { CriticModule } from '../src/modules/critic.js'
// ReflectionModule moved to experimental/ — v0.5.3 Closure P9.
import { loadSettings, saveProjectSettings } from '../src/config/settings.js'
import { getCommand } from '../src/commands/index.js'
import '../src/commands/builtin.js'

// ── Helpers ─────────────────────────────────────────────────────────────────

/** Minimal fake OpenAI client — counts LLM calls instead of actually calling the API. */
function makeMockClient() {
  const calls: Array<{ model: string; messages: unknown[] }> = []
  const chat = {
    completions: {
      create: async (params: { model: string; messages: unknown[] }) => {
        calls.push({ model: params.model, messages: params.messages })
        await Promise.resolve()
        return {
          choices: [
            {
              message: {
                content: 'ok',
              },
            },
          ],
        }
      },
    },
  }
  return { client: { chat } as never, calls }
}

function makeMessages(n: number): never[] {
  const out: never[] = []
  for (let i = 0; i < n; i++) {
    if (i % 2 === 0) {
      out.push({ role: 'assistant', content: 'step ' + i, tool_calls: [] } as never)
    } else {
      out.push({ role: 'tool', content: 'result ' + i } as never)
    }
  }
  return out
}

// ── T1: CriticModule with poor.enabled=true skips LLM call ──────────────────

describe('CriticModule — poor mode guard', () => {
  it('T1: does not call client.create when poor.enabled=true', async () => {
    const { client, calls } = makeMockClient()
    const mod = new CriticModule(client, 'test-model', { poor: { enabled: true } })
    const abort = new AbortController().signal
    const messages = makeMessages(10)
    const result = await mod.onIteration({
      iteration: 10,
      messages,
      abortSignal: abort,
    })
    expect(result).toBeUndefined()
    expect(calls).toHaveLength(0)
  })

  it('T2: calls client.create when poor is disabled (regression — mirrors old behavior)', async () => {
    const { client, calls } = makeMockClient()
    const mod = new CriticModule(client, 'test-model', { planMode: false, poor: { enabled: false } })
    const messages = makeMessages(10)
    const result = await mod.onIteration({
      iteration: 10,
      messages,
      abortSignal: new AbortController().signal,
    })
    expect(calls.length).toBeGreaterThanOrEqual(1)
    expect(calls[0].model).toBe('test-model')
    expect(result).toBeUndefined()
  })

  it('planMode still skips LLM call (existing behavior)', async () => {
    const { client, calls } = makeMockClient()
    const mod = new CriticModule(client, 'test-model', { planMode: true })
    const messages = makeMessages(10)
    await mod.onIteration({
      iteration: 10,
      messages,
      abortSignal: new AbortController().signal,
    })
    expect(calls).toHaveLength(0)
  })
})

// ── T5: /poor command — writes to settings + mutates live config ────────────

describe('/poor slash command', () => {
  let tmpCwd: string

  beforeEach(() => {
    tmpCwd = mkdtempSync(join(tmpdir(), 'ovogo-cwd-'))
  })

  afterEach(() => {
    rmSync(tmpCwd, { recursive: true, force: true })
  })

  it('T5: /poor on writes enabled=true to settings.json and mutates live config', () => {
    const cmd = getCommand('poor')
    expect(cmd).toBeDefined()

    const cfg: { poor?: { enabled: boolean } } = {}
    const fakeEngine = {
      getConfig: () => cfg,
    }
    const ctx = {
      engine: fakeEngine,
      cwd: tmpCwd,
    } as never

    const result = cmd!.handler('on', ctx) as { type: string; value: string }
    expect(result.type).toBe('text')
    expect(result.value).toContain('ON')

    const reloaded = loadSettings(tmpCwd)
    expect(reloaded.poor?.enabled).toBe(true)

    expect(cfg.poor?.enabled).toBe(true)
  })

  it('/poor off writes enabled=false and turns the mode off', () => {
    saveProjectSettings(tmpCwd, { poor: { enabled: true } })
    const cmd = getCommand('poor')!
    const cfg: { poor?: { enabled: boolean } } = { poor: { enabled: true } }
    const fakeEngine = {
      getConfig: () => cfg,
    }
    const result = cmd.handler('off', { engine: fakeEngine, cwd: tmpCwd } as never) as { type: string; value: string }
    expect(result.value).toContain('OFF')
    const reloaded = loadSettings(tmpCwd)
    expect(reloaded.poor?.enabled).toBe(false)
    expect(cfg.poor?.enabled).toBe(false)
  })

  it('/poor with no args shows current state', () => {
    saveProjectSettings(tmpCwd, { poor: { enabled: true } })
    const cmd = getCommand('poor')!
    const cfg: { poor?: { enabled: boolean } } = { poor: { enabled: true } }
    const fakeEngine = {
      getConfig: () => cfg,
    }
    const result = cmd.handler('', { engine: fakeEngine, cwd: tmpCwd } as never) as { type: string; value: string }
    expect(result.value).toContain('ON')
  })

  it('settings.json file is well-formed after /poor on', () => {
    const cmd = getCommand('poor')!
    const cfg: { poor?: { enabled: boolean } } = {}
    const fakeEngine = {
      getConfig: () => cfg,
    }
    void cmd.handler('on', { engine: fakeEngine, cwd: tmpCwd } as never)
    const raw = JSON.parse(readFileSync(join(tmpCwd, '.ovogo', 'settings.json'), 'utf8'))
    expect(raw.poor).toEqual({ enabled: true })
  })
})
