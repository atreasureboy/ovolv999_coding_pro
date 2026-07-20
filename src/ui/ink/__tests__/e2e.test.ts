/**
 * End-to-end integration test: ExecutionEngine → InkRenderer → UIStore.
 *
 * This is the "full pipeline" test — instead of mocking the renderer, we
 * use the real InkRenderer + UIStore (the same pair used in --ink mode)
 * and inject a FakeOpenAI client to control LLM responses.
 *
 * Verifies that:
 * 1. Streaming text flows through InkRenderer → UIStore
 * 2. Tool calls trigger toolStart/toolResult in the store
 * 3. Banner display works
 * 4. Spinner lifecycle is correct
 * 5. Multi-iteration turns (tool → text) work end-to-end
 */

import { describe, it, expect } from 'vitest'
import { ExecutionEngine } from '../../../core/engine.js'
import type { EngineConfig, Tool } from '../../../core/types.js'
import { UIStore } from '../store.js'
import { InkRenderer } from '../inkRenderer.js'

// ── Queue-based fake OpenAI (adapted from runtime3.test.ts) ──────────────────

type Queued = { k: 's'; s: AsyncIterable<unknown> } | { k: 'e'; e: Error }

class FakeOpenAI {
  createCalls: { params: Record<string, unknown>; signal: AbortSignal }[] = []
  private q: Queued[] = []
  chat = {
    completions: {
      create: (params: Record<string, unknown>, opts: { signal: AbortSignal }) => {
        this.createCalls.push({ params, signal: opts.signal })
        const n = this.q[this.createCalls.length - 1] ?? { k: 'e' as const, e: new Error('parked') }
        return new Promise<AsyncIterable<unknown>>((res, rej) => {
          if (opts.signal.aborted) { rej(new Error('aborted')); return }
          opts.signal.addEventListener('abort', () => rej(new Error('aborted')), { once: true })
          if (n.k === 's') res(n.s); else rej(n.e)
        })
      },
    },
  }
  push(s: AsyncIterable<unknown>): void { this.q.push({ k: 's', s }) }
}

// ── Stream generators ────────────────────────────────────────────────────────

async function* textStream(text: string): AsyncIterable<unknown> {
  await Promise.resolve()
  // Stream in two chunks to test token-by-token accumulation
  const mid = Math.ceil(text.length / 2)
  yield { choices: [{ delta: { content: text.slice(0, mid) }, index: 0 }], usage: { prompt_tokens: 5, completion_tokens: 3 } }
  yield { choices: [{ delta: { content: text.slice(mid) }, index: 0, finish_reason: 'stop' }], usage: { prompt_tokens: 5, completion_tokens: 3 } }
}

async function* stopStream(): AsyncIterable<unknown> {
  await Promise.resolve()
  yield { choices: [{ delta: { content: 'done' }, index: 0, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1 } }
}

async function* toolCallStream(name: string, args: string): AsyncIterable<unknown> {
  await Promise.resolve()
  yield {
    choices: [{
      delta: { tool_calls: [{ index: 0, id: 'tc_1', function: { name, arguments: args } }] },
      index: 0,
      finish_reason: 'tool_calls',
    }],
    usage: { prompt_tokens: 5, completion_tokens: 2 },
  }
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function baseConfig(o: Partial<EngineConfig> = {}): EngineConfig {
  return {
    apiKey: 'test-key',
    model: 'test-model',
    maxIterations: 10,
    cwd: '/tmp',
    permissionMode: 'auto',
    permissionManager: undefined,
    enabledModules: [],
    ...o,
  }
}

const tick = (): Promise<void> => new Promise((r) => setImmediate(r))

function makeEngine(store: UIStore, tools: Tool[] = []) {
  const renderer = new InkRenderer(store)
  const client = new FakeOpenAI()
  const engine = new ExecutionEngine(
    baseConfig({ extraTools: tools }),
    renderer as unknown as ConstructorParameters<typeof ExecutionEngine>[1],
    client as unknown as ConstructorParameters<typeof ExecutionEngine>[2],
  )
  return { engine, client, renderer }
}

// A simple echo tool for testing
const echoTool: Tool = {
  name: 'Echo',
  definition: {
    type: 'function',
    function: {
      name: 'Echo',
      description: 'Echoes back the input text',
      parameters: {
        type: 'object',
        properties: { text: { type: 'string', description: 'Text to echo' } },
        required: ['text'],
      },
    },
  },
  execute: (input: Record<string, unknown>) => Promise.resolve({
    content: `echo: ${input.text as string}`,
    isError: false,
  }),
  metadata: { concurrencySafe: true },
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe('E2E: Engine → InkRenderer → UIStore', () => {
  it('simple text response: streaming text appears in store', async () => {
    const store = new UIStore()
    const { engine, client } = makeEngine(store)

    client.push(textStream('Hello world'))
    const turn = engine.runTurn('hi', [])

    await tick()
    expect(client.createCalls).toHaveLength(1)

    const result = await turn

    // Verify the store has the streamed text
    const state = store.getState()
    const assistantMsg = state.messages.find((m) => m.type === 'assistant')
    expect(assistantMsg).toBeDefined()
    expect(assistantMsg!.type === 'assistant' && assistantMsg!.text).toBe('Hello world')

    // Verify streaming was reset
    expect(state.streamingText).toBe('')

    // Verify turn completed cleanly
    expect(result.result.reason).toBe('stop_sequence')
  })

  it('tool call: toolStart + toolResult appear in store', async () => {
    const store = new UIStore()
    const { engine, client } = makeEngine(store, [echoTool])

    // Call 0: tool call
    client.push(toolCallStream('Echo', '{"text":"ping"}'))
    // Call 1: clean stop after tool execution
    client.push(stopStream())

    const result = await engine.runTurn('echo ping', [])

    // Verify tool messages exist
    const state = store.getState()
    const toolMsgs = state.messages.filter((m) => m.type === 'tool')
    expect(toolMsgs).toHaveLength(1)
    expect(toolMsgs[0].type === 'tool' && toolMsgs[0].name).toBe('Echo')
    expect(toolMsgs[0].type === 'tool' && toolMsgs[0].result).toBe('echo: ping')
    expect(toolMsgs[0].type === 'tool' && toolMsgs[0].isError).toBe(false)

    // Engine should have made exactly 2 API calls
    expect(client.createCalls).toHaveLength(2)
    expect(result.result.reason).toBe('stop_sequence')
  })

  it('banner display sets store banner state', () => {
    const store = new UIStore()
    const { renderer } = makeEngine(store)

    renderer.banner('1.0.0', 'gpt-test')

    const state = store.getState()
    expect(state.banner).toBeDefined()
    expect(state.banner!.version).toBe('1.0.0')
    expect(state.banner!.model).toBe('gpt-test')
  })

  it('spinner lifecycle: start/stop toggles store spinner state', () => {
    const store = new UIStore()
    const { renderer } = makeEngine(store)

    expect(store.getState().spinnerActive).toBe(false)

    renderer.startSpinner('Thinking')
    expect(store.getState().spinnerActive).toBe(true)
    expect(store.getState().spinnerVerb).toBe('Thinking')

    renderer.stopSpinner()
    expect(store.getState().spinnerActive).toBe(false)
  })

  it('info/success/error/warn messages appear in store', () => {
    const store = new UIStore()
    const { renderer } = makeEngine(store)

    renderer.info('info message')
    renderer.success('success message')
    renderer.error('error message')
    renderer.warn('warn message')

    const msgs = store.getState().messages
    expect(msgs.some((m) => m.type === 'info' && m.text === 'info message')).toBe(true)
    expect(msgs.some((m) => m.type === 'success' && m.text === 'success message')).toBe(true)
    expect(msgs.some((m) => m.type === 'error' && m.text === 'error message')).toBe(true)
    expect(msgs.some((m) => m.type === 'warn' && m.text === 'warn message')).toBe(true)
  })

  it('agent lifecycle: start/done/summary tracked in store', () => {
    const store = new UIStore()
    const { renderer } = makeEngine(store)

    renderer.agentStart('Research codebase', 'explore')
    let agentMsgs = store.getState().messages.filter((m) => m.type === 'agent')
    expect(agentMsgs).toHaveLength(1)
    expect(agentMsgs[0].type === 'agent' && agentMsgs[0].status).toBe('running')

    renderer.agentDone('Research codebase', true)
    agentMsgs = store.getState().messages.filter((m) => m.type === 'agent')
    expect(agentMsgs[0].type === 'agent' && agentMsgs[0].status).toBe('done')

    renderer.agentSummary('explore', 'Research codebase', 'Found 3 files')
    agentMsgs = store.getState().messages.filter((m) => m.type === 'agent')
    expect(agentMsgs[0].type === 'agent' && agentMsgs[0].summary).toBe('Found 3 files')
  })

  it('context warning adds warning to store', () => {
    const store = new UIStore()
    const { renderer } = makeEngine(store)

    renderer.contextWarning(80000, 100000, 0.8)

    const msgs = store.getState().messages
    const warning = msgs.find((m) => m.type === 'context-warning')
    expect(warning).toBeDefined()
    expect(warning!.type === 'context-warning' && warning!.pct).toBe(0.8)
  })

  it('plan mode toggle updates store', () => {
    const store = new UIStore()
    const { renderer } = makeEngine(store)

    expect(store.getState().planMode).toBe(false)
    renderer.planModeStart()
    expect(store.getState().planMode).toBe(true)
  })

  it('multi-chunk streaming accumulates correctly', async () => {
    const store = new UIStore()
    const { engine, client } = makeEngine(store)

    // A longer text that will be split across multiple yield calls
    async function* longStream(): AsyncIterable<unknown> {
      await Promise.resolve()
      yield { choices: [{ delta: { content: 'Part 1. ' }, index: 0 }] }
      yield { choices: [{ delta: { content: 'Part 2. ' }, index: 0 }] }
      yield { choices: [{ delta: { content: 'Part 3.' }, index: 0, finish_reason: 'stop' }] }
    }

    client.push(longStream())
    await engine.runTurn('tell me a story', [])

    const state = store.getState()
    const assistantMsg = state.messages.find((m) => m.type === 'assistant')
    expect(assistantMsg).toBeDefined()
    expect(assistantMsg!.type === 'assistant' && assistantMsg!.text).toBe('Part 1. Part 2. Part 3.')
    expect(state.streamingText).toBe('')
  })

  it('newHistory contains the assistant response', async () => {
    const store = new UIStore()
    const { engine, client } = makeEngine(store)

    client.push(textStream('Final answer'))
    const { newHistory } = await engine.runTurn('question', [])

    // History should contain at least the user message and assistant response
    const lastAssistant = [...newHistory].reverse().find((m) => m.role === 'assistant')
    expect(lastAssistant).toBeDefined()
    expect(lastAssistant!.content).toContain('Final answer')
  })
})
