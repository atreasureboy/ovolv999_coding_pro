/**
 * The stall detector's budget-pressure branch was dead wiring: the
 * coordinator hardcoded `detectStall(elapsedMin, 1)`, so the monitor's
 * budgetPressureFraction threshold could never fire regardless of real
 * context pressure.
 *
 * Regression: a turn whose history actually fills the context window
 * must produce a STALL_DETECTED with kind 'budget-pressure' (the loop
 * then injects a stall_replan control message telling the model to
 * narrow scope).
 */
import { describe, it, expect } from 'vitest'
import OpenAI from 'openai'
import { ExecutionEngine } from '../src/core/engine.js'
import type { OpenAIMessage } from '../src/core/types.js'

function fakeRenderer() {
  return {
    info: () => {}, warn: () => {}, error: () => {},
    success: () => {}, banner: () => {},
    startSpinner: () => {}, stopSpinner: () => {},
    beginAssistantText: () => {}, endAssistantText: () => {},
    streamToken: () => {}, toolStart: () => {}, toolResult: () => {},
    compactStart: () => {}, compactDone: () => {}, contextWarning: () => {},
  } as never
}

function scriptedClient() {
  let summarizations = 0
  return {
    summarizationCount: () => summarizations,
    chat: {
      completions: {
        create: async (params: { stream?: boolean }) => {
          if (params.stream === true) {
            const chunks = [
              { choices: [{ delta: { role: 'assistant' }, index: 0 }] },
              { choices: [{ delta: { content: 'Understood.' }, index: 0 }] },
            ]
            return {
              [Symbol.asyncIterator]: () => {
                let i = 0
                return {
                  next: async () => (i < chunks.length ? { value: chunks[i++], done: false } : { value: undefined as never, done: true }),
                }
              },
            }
          }
          summarizations++
          return { choices: [{ message: { role: 'assistant', content: '<summary>filler compacted</summary>' } }] }
        },
      },
    },
  }
}

function bigHistory(): OpenAIMessage[] {
  // Far beyond the configured window so remainingRatio lands at/below 0.
  const filler = 'x'.repeat(20_000)
  const history: OpenAIMessage[] = []
  for (let i = 0; i < 8; i++) {
    history.push({ role: 'user', content: `FILLER_${i} ${filler}` })
    history.push({ role: 'assistant', content: `ACK_${i} ${filler}` })
  }
  return history
}

describe('stall detection budget pressure wiring', () => {
  it('an over-budget history triggers the budget-pressure verdict', async () => {
    const client = scriptedClient()
    const engine = new ExecutionEngine({
      apiKey: 'test',
      model: 'gpt-4o',
      baseURL: 'https://api.example.com/v1',
      maxIterations: 10,
      cwd: '/tmp',
      permissionMode: 'bypassPermissions',
      enabledModules: [],
      maxContextTokens: 16_000,
      maxOutputTokens: 1_000,
    } as never, fakeRenderer(), client as unknown as OpenAI)
    const stalls: Array<{ kind: string; reason: string }> = []
    const em: unknown = (engine as unknown as { eventEmitter: { on: (t: string, h: (e: never) => void) => void } }).eventEmitter
    ;(em as { on: (t: string, h: (e: { kind: string; reason: string }) => void) => void }).on('STALL_DETECTED', (e) => stalls.push({ kind: e.kind, reason: e.reason }))

    const t = await engine.runTurn('say hello', bigHistory())
    expect(t.result.reason).toBe('stop_sequence')
    expect(stalls.some((s) => s.kind === 'budget-pressure')).toBe(true)
    expect(stalls.find((s) => s.kind === 'budget-pressure')!.reason).toContain('budget remaining')
  })
})
