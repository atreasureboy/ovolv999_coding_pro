import { it, expect } from 'vitest'
import { ExecutionEngine } from '../src/core/engine.js'

class FakeOpenAI {
  chat = { completions: { create: async () => (async function* () {
    await Promise.resolve()
    yield { choices: [{ index: 0, delta: { content: 'ok' }, finish_reason: null }] }
    yield { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 5, completion_tokens: 2 } }
  })() } }
}
const CAPS = { reasoning: 0.4, coding: 0.5, contextWindow: 200_000, toolCalling: 0.7, speed: 0.95, cost: 0.95 }
it('dbg vitest /tmp turn (timing)', async () => {
  const e = new ExecutionEngine({
    model: 'haiku', apiKey: 'k', maxIterations: 5, cwd: '/tmp',
    permissionMode: 'auto', permissionManager: undefined, enabledModules: [],
    models: { profiles: [
      { id: 'cheap', provider: 'openai', model: 'haiku', capabilities: CAPS, tier: 'top', roles: ['main'], available: true },
    ], routing: { enabled: true } },
  } as never, (() => {}) as never, new FakeOpenAI() as never)
  const t0 = Date.now()
  await e.runTurn('list the files', [])
  console.log('TURN DONE in', Date.now() - t0, 'ms')
  expect(e.getModel()).toBe('haiku')
}, 60000)
