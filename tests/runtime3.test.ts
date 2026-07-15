/**
 * RUNTIME3 behavior tests — three invariants verified end-to-end:
 *   1. consumeStream: reason='user_cancelled' (from engine.abort()) must
 *      NOT surface as "Stream timed out". Only 'stream_timeout' should.
 *   2. Tool call arguments after JSON.parse must be a non-null,
 *      non-array object — null/[]/primitive → tool-result error, no invoke.
 *   3. AgentTool pre-aborted early-return disposes child + cleans listener.
 * Each test <1s; suite <5s. Reuses the queue/stream-mock pattern from
 * tests/runtimeFixes.test.ts.
 */

import { describe, expect, it } from 'vitest'
import { ExecutionEngine } from '../src/core/engine.js'
import { AgentTool } from '../src/tools/agent.js'
import type { EngineConfig, Tool } from '../src/core/types.js'

// ── Queue-based fake OpenAI ──
type Queued = { k: 's'; s: AsyncIterable<unknown> } | { k: 'e'; e: Error }
class FakeOpenAI {
  createCalls: { signal: AbortSignal }[] = []
  private q: Queued[] = []
  chat = { completions: { create: (_p: Record<string, unknown>, o: { signal: AbortSignal }) => {
    this.createCalls.push({ signal: o.signal })
    const n = this.q[this.createCalls.length - 1] ?? { k: 'e' as const, e: new Error('parked') }
    return new Promise<AsyncIterable<unknown>>((res, rej) => {
      if (o.signal.aborted) { rej(new Error('aborted')); return }
      o.signal.addEventListener('abort', () => rej(new Error('aborted')), { once: true })
      if (n.k === 's') res(n.s); else rej(n.e)
    })
  } } }
  push(s: AsyncIterable<unknown>) { this.q.push({ k: 's', s }) }
}

// ── Streams ──
function stalledStream() {
  let release!: () => void
  async function* gen() {
    yield { choices: [{ delta: { content: 'partial' }, index: 0 }], usage: { prompt_tokens: 1, completion_tokens: 1 } }
    await new Promise<void>(r => { release = r })
    yield { choices: [{ delta: {}, index: 0, finish_reason: 'stop' }] }
  }
  return { stream: gen(), release: () => release() }
}
async function* toolCallStream(args: string): AsyncIterable<unknown> {
  await Promise.resolve()
  yield { choices: [{ delta: { tool_calls: [{ index: 0, id: 'tc_1', function: { name: 'Noop', arguments: args } }] }, index: 0, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 1, completion_tokens: 1 } }
}
// Content + finish_reason='stop' → clean terminate. (Empty stream would
// trigger the engine's empty-response retry and hang awaiting another create().)
async function* stopStream(): AsyncIterable<unknown> {
  await Promise.resolve()
  yield { choices: [{ delta: { content: 'done' }, index: 0, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1 } }
}

// ── Helpers ──
function fakeRenderer() {
  const calls: { kind: string; args: unknown[] }[] = []
  const r: Record<string, unknown> = { __calls: calls }
  for (const k of ['banner','info','warn','error','success','startSpinner','stopSpinner','beginAssistantText','endAssistantText','streamToken','toolStart','toolResult','compactStart','compactDone','contextWarning','agentStart','agentDone','agentSummary','agentHeartbeat']) {
    r[k] = (...a: unknown[]) => { calls.push({ kind: k, args: a }) }
  }
  return r as unknown as ConstructorParameters<typeof ExecutionEngine>[1] & { __calls: typeof calls }
}
function baseConfig(o: Partial<EngineConfig> = {}): EngineConfig {
  return { apiKey: 'k', model: 'm', maxIterations: 10, cwd: '/tmp', permissionMode: 'auto', permissionManager: undefined, enabledModules: [], ...o }
}
const tick = () => new Promise(r => setImmediate(r))
function makeEngine(r: ReturnType<typeof fakeRenderer>, tools: Tool[] = []) {
  const c = new FakeOpenAI()
  const e = new ExecutionEngine(baseConfig({ extraTools: tools }), r, c as unknown as ConstructorParameters<typeof ExecutionEngine>[2])
  return { c, e }
}
const noop = (onExec: (i: Record<string, unknown>) => void): Tool => ({
  name: 'Noop',
  definition: { type: 'function', function: { name: 'Noop', description: '', parameters: { type: 'object', properties: {} } } },
  execute: (i) => { onExec(i); return Promise.resolve({ content: 'ok', isError: false }) },
  metadata: { concurrencySafe: true },
})

// ─────────────────────────────────────────────────────────────────────
// 1) user_cancelled ≠ stream_timeout
// ─────────────────────────────────────────────────────────────────────
describe('RUNTIME3-1: user_cancelled ≠ stream_timeout', () => {
  it('engine.abort() mid-stream does not surface "Stream timed out"', async () => {
    const r = fakeRenderer()
    const { c, e } = makeEngine(r)
    const s = stalledStream()
    const t = e.runTurn('q', [])
    c.push(s.stream); await tick()
    e.abort()                     // reason = 'user_cancelled'
    s.release()                   // let for-await observe the abort
    const result = await t
    const streamTimeout = r.__calls.filter(c => c.kind === 'error' && String(c.args[0]).toLowerCase().includes('stream timed out'))
    expect(streamTimeout).toHaveLength(0)
    // Post-fix: the for-await breaks cleanly, the post-loop check is
    // skipped (not 'stream_timeout'), and the stream's second yield
    // terminates the loop with 'stop_sequence'. Pre-fix: would have
    // thrown 'Stream timed out' here.
    expect(result.result.reason).toBe('stop_sequence')
  })
})

// ─────────────────────────────────────────────────────────────────────
// 2) Tool args shape validation
// ─────────────────────────────────────────────────────────────────────
describe('RUNTIME3-2: tool arguments must be a non-null object', () => {
  const SHAPES = [
    ['null literal', 'null',    'null'],
    ['empty array',  '[]',      'array'],
    ['string',       '"foo"',   'string'],
    ['number',       '42',      'number'],
    ['boolean',      'true',    'boolean'],
  ] as const

  for (const [name, args, label] of SHAPES) {
    it(`${name} (args=${args}) → tool skipped + error result + clean stop`, async () => {
      let executed = 0
      const r = fakeRenderer()
      const { c, e } = makeEngine(r, [noop(() => { executed++ })])
      // call 0 → bad-args tool_call (rejected by parse_response)
      // call 1 → stopStream (clean termination; content avoids empty-retry loop)
      c.push(toolCallStream(args)); c.push(stopStream())
      const result = await e.runTurn('q', [])
      expect(executed).toBe(0)
      expect(r.__calls.some(c => c.kind === 'warn' && String(c.args[0]).toLowerCase().includes(label))).toBe(true)
      expect(r.__calls.filter(c => c.kind === 'error')).toHaveLength(0)
      expect(result.result.reason).toBe('stop_sequence')
    })
  }

  it('valid object args reach the tool and return its result', async () => {
    let captured: Record<string, unknown> | null = null
    const { c, e } = makeEngine(fakeRenderer(), [noop((i) => { captured = i })])
    c.push(toolCallStream('{"foo":"bar","n":1}')); c.push(stopStream())
    await e.runTurn('q', [])
    expect(captured).toEqual({ foo: 'bar', n: 1 })
  })
})

// ─────────────────────────────────────────────────────────────────────
// 3) AgentTool pre-aborted early-return
// ─────────────────────────────────────────────────────────────────────
describe('RUNTIME3-3: AgentTool pre-aborted cleanup', () => {
  it('disposes child engine even when parent signal is already aborted', async () => {
    let disposed = 0, ran = 0
    const child = {
      runTurn: () => { ran++; return Promise.resolve({ result: { output: 'never', reason: 'stop_sequence' as const } }) },
      abort: () => undefined,
      dispose: () => { disposed++ },
    }
    const tool = new AgentTool({ factory: () => child, parentConfig: baseConfig({ agentFactory: () => child }), parentRenderer: fakeRenderer() })
    const ac = new AbortController(); ac.abort()  // pre-abort
    const out = await tool.execute({ description: 'sub', prompt: 'p', subagent_type: 'general-purpose' }, { cwd: '/tmp', permissionMode: 'auto', signal: ac.signal })
    expect(out.isError).toBe(true)
    expect(ran).toBe(0)       // pre-aborted → never invoked
    expect(disposed).toBe(1)  // BUT still disposed via finally
  })

  it('detaches abort listener on a clean run (late abort does not fire child.abort)', async () => {
    let lateAbort = false
    const child = {
      runTurn: () => Promise.resolve({ result: { output: 'ok', reason: 'stop_sequence' as const } }),
      abort: () => { lateAbort = true },
      dispose: () => undefined,
    }
    const tool = new AgentTool({ factory: () => child, parentConfig: baseConfig({ agentFactory: () => child }), parentRenderer: fakeRenderer() })
    const ac = new AbortController()
    await tool.execute({ description: 'sub', prompt: 'p', subagent_type: 'general-purpose' }, { cwd: '/tmp', permissionMode: 'auto', signal: ac.signal })
    ac.abort()                 // fires after listener was removed in finally
    expect(lateAbort).toBe(false)
  })
})