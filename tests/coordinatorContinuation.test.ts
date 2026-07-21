/**
 * P0-2 regression: long-reply continuation output completeness.
 *
 * Invariant (fi_goal.md §P0-2):
 *   final returned output
 *   = all assistant segments emitted this turn, concatenated in order
 *   = sum of new assistant `content` strings pushed to `messages`
 *
 * Pre-fix: coordinator.ts OVERWROTE finalOutput on each LLM round, so
 * only the LAST segment survived into TurnResult.output — even though
 * messages[] accumulated every segment correctly. This caused hooks,
 * RUN_COMPLETED subscribers, the UI, and parent agents to see only
 * the final fragment after any continuation, length-retry, or multi-
 * iteration tool-using turn.
 */

import { describe, it, expect } from 'vitest'
import { ExecutionEngine } from '../src/core/engine.js'
import type { EngineConfig, Tool } from '../src/core/types.js'

// ── Queue-based fake OpenAI (mirrors runtime3.test.ts harness) ──
// NOTE: this variant REJECTS create() calls that don't have a queued
// stream yet (matches runtime3.test.ts semantics). Tests must push ALL
// streams they expect the engine to consume BEFORE awaiting runTurn().
type Queued = { k: 's'; s: AsyncIterable<unknown> } | { k: 'e'; e: Error }
class FakeOpenAI {
  createCalls = 0
  private q: Queued[] = []
  chat = {
    completions: {
      create: (_p: Record<string, unknown>, o: { signal: AbortSignal }) => {
        this.createCalls++
        const n = this.q[this.createCalls - 1] ?? { k: 'e' as const, e: new Error('parked') }
        return new Promise<AsyncIterable<unknown>>((res, rej) => {
          if (o.signal.aborted) { rej(new Error('aborted')); return }
          o.signal.addEventListener('abort', () => rej(new Error('aborted')), { once: true })
          if (n.k === 's') res(n.s); else rej(n.e)
        })
      },
    },
  }
  push(s: AsyncIterable<unknown>) { this.q.push({ k: 's', s }) }
}

async function* lengthThenStopStream(first: string, second: string): AsyncIterable<unknown> {
  await Promise.resolve()
  yield {
    choices: [{ delta: { content: first }, index: 0, finish_reason: 'length' }],
    usage: { prompt_tokens: 1, completion_tokens: Math.ceil(first.length / 4) },
  }
}
async function* stopStream(text: string): AsyncIterable<unknown> {
  await Promise.resolve()
  yield {
    choices: [{ delta: { content: text }, index: 0, finish_reason: 'stop' }],
    usage: { prompt_tokens: 1, completion_tokens: Math.ceil(text.length / 4) },
  }
}
async function* textThenToolStream(text: string): AsyncIterable<unknown> {
  await Promise.resolve()
  yield {
    choices: [{
      delta: {
        content: text,
        tool_calls: [{
          index: 0,
          id: 'tc_1',
          function: { name: 'Noop', arguments: '{}' },
        }],
      },
      index: 0,
      finish_reason: 'tool_calls',
    }],
    usage: { prompt_tokens: 1, completion_tokens: Math.ceil(text.length / 4) },
  }
}
async function* stopStreamAfterTool(text: string): AsyncIterable<unknown> {
  await Promise.resolve()
  yield {
    choices: [{ delta: { content: text }, index: 0, finish_reason: 'stop' }],
    usage: { prompt_tokens: 1, completion_tokens: Math.ceil(text.length / 4) },
  }
}

function fakeRenderer() {
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
  return r as unknown as ConstructorParameters<typeof ExecutionEngine>[1] & { __calls: typeof calls }
}
function baseConfig(o: Partial<EngineConfig> = {}): EngineConfig {
  return {
    apiKey: 'k',
    model: 'm',
    maxIterations: 10,
    cwd: '/tmp',
    permissionMode: 'auto',
    permissionManager: undefined,
    enabledModules: [],
    ...o,
  }
}
function makeEngine(r: ReturnType<typeof fakeRenderer>, tools: Tool[] = []) {
  const c = new FakeOpenAI()
  const e = new ExecutionEngine(
    baseConfig({ extraTools: tools }),
    r,
    c as unknown as ConstructorParameters<typeof ExecutionEngine>[2],
  )
  return { c, e }
}
const noop = (): Tool => ({
  name: 'Noop',
  definition: {
    type: 'function',
    function: { name: 'Noop', description: '', parameters: { type: 'object', properties: {} } },
  },
  execute: () => Promise.resolve({ content: 'ok', isError: false }),
  metadata: { concurrencySafe: true },
})

// ─────────────────────────────────────────────────────────────────────
// P0-2.1: finish_reason='length' continuation concatenates segments
// ─────────────────────────────────────────────────────────────────────
describe('P0-2.1: length-limited continuation preserves BOTH segments', () => {
  it('result.output === seg1 + seg2 after a length-retry round', async () => {
    const r = fakeRenderer()
    const { c, e } = makeEngine(r)
    const seg1 = 'Part 1 of the answer. '
    const seg2 = 'Part 2 concludes.'
    // Pre-queue BOTH streams — the engine consumes them synchronously
    // in order on the length-retry path.
    c.push(lengthThenStopStream(seg1))
    c.push(stopStream(seg2))
    const result = await e.runTurn('q', [])
    expect(c.createCalls).toBe(2)
    expect(result.result.output).toBe(seg1 + seg2)
    // Invariant: every NEW assistant message in newHistory sums to output.
    const assistantTexts = result.newHistory
      .filter(m => m.role === 'assistant' && typeof m.content === 'string' && m.content.length > 0)
      .map(m => m.content as string)
    expect(assistantTexts.join('')).toBe(seg1 + seg2)
  })
})

// ─────────────────────────────────────────────────────────────────────
// P0-2.2: multi-iteration tool-using turn preserves both texts
// ─────────────────────────────────────────────────────────────────────
describe('P0-2.2: text + tool_call + final text are both preserved', () => {
  it('result.output includes pre-tool and post-tool assistant text', async () => {
    const r = fakeRenderer()
    const { c, e } = makeEngine(r, [noop()])
    const beforeTool = 'Let me check. '
    const afterTool = 'Done — the answer is 42.'
    c.push(textThenToolStream(beforeTool))
    c.push(stopStreamAfterTool(afterTool))
    const result = await e.runTurn('q', [])
    expect(result.result.output).toBe(beforeTool + afterTool)
    // Sanity: a tool call happened.
    expect(result.newHistory.some(m => m.role === 'tool')).toBe(true)
  })
})

// ─────────────────────────────────────────────────────────────────────
// P0-2.3: multiple length-retries (3 segments) all concatenate
// ─────────────────────────────────────────────────────────────────────
describe('P0-2.3: three length-limited segments concatenate', () => {
  it('result.output === seg1 + seg2 + seg3 across MAX_LENGTH_RETRIES', async () => {
    const r = fakeRenderer()
    const { c, e } = makeEngine(r)
    const seg1 = 'Alpha. '
    const seg2 = 'Beta. '
    const seg3 = 'Gamma.'
    c.push(lengthThenStopStream(seg1))
    c.push(lengthThenStopStream(seg2))
    c.push(stopStream(seg3))
    const result = await e.runTurn('q', [])
    expect(result.result.output).toBe(seg1 + seg2 + seg3)
  })
})

// ─────────────────────────────────────────────────────────────────────
// P0-2.4: single-shot turn still works (no regression)
// ─────────────────────────────────────────────────────────────────────
describe('P0-2.4: single-segment turn still returns its text', () => {
  it('result.output is the only segment when no continuation fires', async () => {
    const r = fakeRenderer()
    const { c, e } = makeEngine(r)
    const only = 'just one segment'
    c.push(stopStream(only))
    const result = await e.runTurn('q', [])
    expect(result.result.output).toBe(only)
  })
})
