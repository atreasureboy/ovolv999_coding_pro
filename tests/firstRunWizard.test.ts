/**
 * v0.4.1 WS2 — first-run wizard behavior:
 *  - EOF never hangs (pre-WS2 a closed stdin left rl.question pending
 *    forever — `ovolv999 init < /dev/null` froze instead of exiting);
 *  - the three detection paths (Claude reuse / env key / manual) save the
 *    right provider config.
 *
 * hermetic: os.homedir is pointed at a throwaway dir (so neither the real
 * ~/.claude/settings.json nor the real ~/.ovogo is touched) and
 * saveGlobalProvider is a spy.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { PassThrough } from 'stream'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

const refs = vi.hoisted(() => ({ home: '' }))

vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('os')>()
  return { ...actual, homedir: (): string => refs.home || actual.homedir() }
})

vi.mock('../src/config/settings.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/config/settings.js')>()
  return { ...actual, saveGlobalProvider: vi.fn() }
})

import { runFirstRunWizard } from '../src/config/wizard.js'
import { saveGlobalProvider } from '../src/config/settings.js'

const ENV_KEYS = ['OPENAI_API_KEY', 'OPENAI_BASE_URL', 'ANTHROPIC_BASE_URL', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_API_KEY', 'ANTHROPIC_MODEL']

function feed(input: string): { done: ReturnType<typeof runFirstRunWizard>; output: () => string } {
  const stdin = new PassThrough()
  const stdout = new PassThrough()
  const chunks: string[] = []
  stdout.on('data', (d: Buffer) => chunks.push(d.toString()))
  stdin.write(input)
  stdin.end() // EOF after the scripted answers — the wizard must drain and exit
  const done = runFirstRunWizard({ input: stdin, output: stdout })
  return { done, output: () => chunks.join('') }
}

describe('runFirstRunWizard (v0.4.1 WS2)', () => {
  let savedEnv: Record<string, string | undefined>

  beforeEach(() => {
    refs.home = mkdtempSync(join(tmpdir(), 'wiz-home-'))
    savedEnv = {}
    for (const k of ENV_KEYS) { savedEnv[k] = process.env[k]; delete process.env[k] }
    vi.mocked(saveGlobalProvider).mockClear()
  })
  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (savedEnv[k] === undefined) delete process.env[k]
      else process.env[k] = savedEnv[k]
    }
    try { rmSync(refs.home, { recursive: true, force: true }) } catch { /* best-effort */ }
  })

  it('EOF regression: closed stdin settles with defaults instead of hanging', async () => {
    const { done, output } = feed('') // no answers at all — pure EOF
    const HANG = Symbol('hang')
    const winner = await Promise.race([
      done,
      new Promise((r) => setTimeout(() => r(HANG), 3000)),
    ])
    expect(winner).not.toBe(HANG) // pre-WS2 this raced to the timeout, always
    expect((winner as { configured: boolean }).configured).toBe(false)
    // The manual path's API-key gate is what converts EOF into a clean exit.
    expect(output()).toContain('API key is required')
  })

  it('manual flow: preset + key + blank defaults → openai provider saved', async () => {
    const { done } = feed('1\nsk-test-123\n\n\n') // choice, key, baseURL='', model=''
    const result = await done
    expect(result.configured).toBe(true)
    expect(saveGlobalProvider).toHaveBeenCalledExactlyOnceWith({
      provider: 'openai',
      apiKey: 'sk-test-123',
      baseURL: undefined,
      model: 'gpt-4o',
    })
  })

  it('closes its readline after successful setup without waiting for stdin EOF', async () => {
    const stdin = new PassThrough()
    const stdout = new PassThrough()
    const baselineDataListeners = stdin.listenerCount('data')
    const done = runFirstRunWizard({ input: stdin, output: stdout })
    stdin.write('1\nsk-live\n\n\n')
    await expect(done).resolves.toMatchObject({ configured: true })
    expect(stdin.listenerCount('data')).toBe(baselineDataListeners)
    expect(stdin.listenerCount('readable')).toBe(0)
  })

  it('detected OPENAI_API_KEY: one Y + model default → openai provider saved', async () => {
    process.env.OPENAI_API_KEY = 'sk-env-x'
    const { done } = feed('Y\n\n') // "Use OpenAI with it?" Y, model default
    const result = await done
    expect(result.configured).toBe(true)
    expect(saveGlobalProvider).toHaveBeenCalledExactlyOnceWith({
      provider: 'openai',
      apiKey: 'sk-env-x',
      baseURL: undefined,
      model: 'gpt-4o',
    })
  })

  it('Claude MiniMax config reuse → minimax provider with the /anthropic → /v1 rewrite', async () => {
    mkdirSync(join(refs.home, '.claude'), { recursive: true })
    writeFileSync(join(refs.home, '.claude', 'settings.json'), JSON.stringify({
      env: {
        ANTHROPIC_BASE_URL: 'https://api.minimax.io/anthropic',
        ANTHROPIC_AUTH_TOKEN: 'mm-tok',
        ANTHROPIC_MODEL: 'MiniMax-M3[1m]',
      },
    }))
    const { done } = feed('Y\n') // reuse, zero further questions
    const result = await done
    expect(result.configured).toBe(true)
    expect(saveGlobalProvider).toHaveBeenCalledExactlyOnceWith({
      provider: 'minimax',
      apiKey: 'mm-tok',
      baseURL: 'https://api.minimax.io/v1',
      model: 'MiniMax-M3', // context-variant suffix stripped
    })
  })
})
