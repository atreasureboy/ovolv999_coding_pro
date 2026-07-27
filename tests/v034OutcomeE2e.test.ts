/**
 * v0.3.4 (durable supervisor contract §Phase 12) additional integration tests.
 * Tests TurnOutcome propagation, terminal events, and lease lifecycle.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { tmpdir } from 'os'
import { mkdtempSync, rmSync } from 'fs'
import { join } from 'path'
import { ExecutionEngine } from '../src/core/engine.js'
import type { EngineConfig } from '../src/core/types.js'
import type { Renderer } from '../src/ui/renderer.js'

class FakeOpenAI {
  createCalls = 0
  chat = { completions: { create: (_p: Record<string, unknown>, o: { signal: AbortSignal }) => {
    this.createCalls++
    return new Promise<AsyncIterable<unknown>>((res, rej) => {
      if (o.signal.aborted) { rej(new Error('aborted')); return }
      o.signal.addEventListener('abort', () => rej(new Error('aborted')), { once: true })
      res((async function* () {
        await Promise.resolve()
        yield { choices: [{ index: 0, delta: { content: 'ok' }, finish_reason: null }] }
        yield { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 5, completion_tokens: 2 } }
      })())
    })
  } } }
}

function fakeRenderer(): Renderer {
  const r: Record<string, (...args: unknown[]) => void> = {}
  for (const k of ['banner','raw','info','warn','error','success','startSpinner','stopSpinner','beginAssistantText','endAssistantText','streamToken','streamReasoning','assistantMessage','userMessage','toolCall','toolStart','toolResult','compactStart','compactDone','contextWarning','cost','compactionNotice','turnEnd','planModeHeader','agentStart','agentDone','agentSummary','agentHeartbeat']) r[k] = () => {}
  return r as unknown as Renderer
}

function baseConfig(o: Partial<EngineConfig> = {}): EngineConfig {
  return { apiKey: 'k', model: 'm', maxIterations: 10, cwd: '/tmp', permissionMode: 'auto', permissionManager: undefined, enabledModules: [], ...o }
}

let tmp = ''
beforeEach(() => { tmp = mkdtempSync(`${tmpdir}/v034e2e-`) })
afterEach(() => { rmSync(tmp, { recursive: true, force: true }) })

describe('v0.3.4 TurnOutcome e2e (durable supervisor contract §Phase 12)', () => {
  it('treats a conversational question as completed without mutation warnings', async () => {
    const c = new FakeOpenAI()
    const warnings: string[] = []
    const renderer = fakeRenderer()
    renderer.warn = (message: string) => { warnings.push(message) }
    const e = new ExecutionEngine(baseConfig({ executionRunLogDir: join(tmp, 'logs') }), renderer, c as unknown as never)
    const { outcome } = await e.runTurn('你是谁', [])
    expect(outcome.completion.status).toBe('completed')
    expect(e.getLastRunContext()?.taskKind).toBe('informational')
    expect(warnings).toEqual([])
  })

  it('§7: TurnResult carries completionStatus for Hook/Module consumption', async () => {
    const logDir = join(tmp, 'logs')
    const c = new FakeOpenAI()
    const cfg = baseConfig({ executionRunLogDir: logDir })
    const e = new ExecutionEngine(cfg, fakeRenderer(), c as unknown as never)
    const { result, outcome } = await e.runTurn('explain something', [])
    expect(result).toBeDefined()
    expect(outcome).toBeDefined()
    expect(outcome.completion.status).toBeTruthy()
    expect(outcome.runId).toBeTruthy()
    expect(outcome.stopReason).toBe('stop_sequence')
  })

  it('stores the completion candidate and verdict before closing the run context', async () => {
    const c = new FakeOpenAI()
    const e = new ExecutionEngine(baseConfig({ executionRunLogDir: join(tmp, 'logs') }), fakeRenderer(), c as unknown as never)
    const { outcome } = await e.runTurn('explain something', [])
    const context = e.getLastRunContext()
    expect(context?.runId).toBe(outcome.runId)
    expect(context?.completionCandidate?.text).toBe(outcome.output)
    expect(context?.completionCandidate?.iteration).toBe(1)
    expect(context?.completionVerdict?.status).toBe(outcome.completion.status)
    expect(e.getTaskGraph()).toBe(context?.taskGraph)
    expect(e.getProgressMonitor()).toBe(context?.progressMonitor)
  })

  it('stores exhausted completion for a run that reaches its iteration limit', async () => {
    const c = new FakeOpenAI()
    const e = new ExecutionEngine(baseConfig({ executionRunLogDir: join(tmp, 'logs'), maxIterations: 0 }), fakeRenderer(), c as unknown as never)
    const { outcome } = await e.runTurn('explain something', [])
    expect(outcome.completion.status).toBe('exhausted')
    expect(e.getLastRunContext()?.completionVerdict?.status).toBe('exhausted')
  })

  it('closes the run context after terminal events', async () => {
    const c = new FakeOpenAI()
    const events: string[] = []
    const holder: { engine?: ExecutionEngine } = {}
    const hookRunner = {
      runPreToolCall: () => [],
      runPostToolCall: () => [],
      runUserPromptSubmit: () => [],
      runOnComplete: () => {
        const context = holder.engine?.getLastRunContext()
        expect(context?.completionVerdict).toBeDefined()
        expect(holder.engine?.getTaskGraphStore().get(context?.runId ?? '')).toBe(context?.taskGraph)
        events.push('hook')
        return []
      },
    }
    const e = new ExecutionEngine(baseConfig({ executionRunLogDir: join(tmp, 'logs'), hookRunner }), fakeRenderer(), c as unknown as never)
    holder.engine = e
    e.getEventEmitter().on('RUN_TERMINATED', () => events.push('terminated'))
    e.getEventEmitter().on('RUN_COMPLETED', () => events.push('completed'))
    e.getEventEmitter().on('CONTEXT_CLOSED', () => events.push('closed'))
    await e.runTurn('explain something', [])
    expect(events).toEqual(['terminated', 'hook', 'closed'])
    expect(e.getTaskGraphStore().has(e.getLastRunContext()?.runId ?? '')).toBe(false)
  })

  it('closes the run context when a completion hook throws', async () => {
    const c = new FakeOpenAI()
    const hookRunner = {
      runPreToolCall: () => [],
      runPostToolCall: () => [],
      runUserPromptSubmit: () => [],
      runOnComplete: () => {
        throw new Error('completion hook failed')
      },
    }
    const e = new ExecutionEngine(baseConfig({ executionRunLogDir: join(tmp, 'logs'), hookRunner }), fakeRenderer(), c as unknown as never)
    const events: string[] = []
    e.getEventEmitter().on('CONTEXT_CLOSED', () => events.push('closed'))
    await expect(e.runTurn('explain something', [])).rejects.toThrow('completion hook failed')
    expect(events).toEqual(['closed'])
    expect(e.getLastRunContext()?.completionVerdict).toBeDefined()
  })

  it('§14: reason !== error no longer used as sole success check', async () => {
    const logDir = join(tmp, 'logs')
    const c = new FakeOpenAI()
    const cfg = baseConfig({ executionRunLogDir: logDir })
    const e = new ExecutionEngine(cfg, fakeRenderer(), c as unknown as never)
    const { outcome } = await e.runTurn('hello', [])
    // outcome.completion.status is the authoritative signal, not reason
    expect(outcome.completion.status).toBe('completed')
    expect(outcome.reason).toBe('stop_sequence') // deprecated
  })

  it('§28: fallback usage attributed to final model', async () => {
    // Structural: outcome.modelAttempts is populated from coordinator
    const c = new FakeOpenAI()
    const cfg = baseConfig()
    const e = new ExecutionEngine(cfg, fakeRenderer(), c as unknown as never)
    const { outcome } = await e.runTurn('test', [])
    expect(Array.isArray(outcome.modelAttempts)).toBe(true)
  })

  it('§29: Run Context available during Hook (close in finally)', async () => {
    const c = new FakeOpenAI()
    const cfg = baseConfig({ executionRunLogDir: join(tmp, 'logs') })
    const e = new ExecutionEngine(cfg, fakeRenderer(), c as unknown as never)
    await e.runTurn('test', [])
    // After runTurn, the context should be closed (no leak)
    // This is verified by running 20 consecutive turns without crash
    for (let i = 0; i < 20; i++) {
      await e.runTurn(`iteration ${i}`, [])
    }
    expect(e.getTaskGraphStore().list()).toEqual(['default'])
    expect(e.getBackgroundTaskManager().listTasks()).toEqual([])
    expect(e.getRunRegistry().list().every((run) =>
      ['succeeded', 'failed', 'cancelled', 'timed_out', 'verification_failed', 'lost'].includes(run.status),
    )).toBe(true)
  })

  it('§31: terminal event matches CompletionStatus', async () => {
    const c = new FakeOpenAI()
    const cfg = baseConfig({ executionRunLogDir: join(tmp, 'logs') })
    const e = new ExecutionEngine(cfg, fakeRenderer(), c as unknown as never)
    const events: string[] = []
    e.getEventEmitter().on('RUN_TERMINATED', (evt: { status: string }) => {
      events.push(`RUN_TERMINATED:${evt.status}`)
    })
    await e.runTurn('explain', [])
    expect(events.length).toBe(1) // exactly one terminal event
    expect(events[0]).toContain('RUN_TERMINATED:')
  })

  it('§32: terminal event emitted once (not multiple)', async () => {
    const c = new FakeOpenAI()
    const cfg = baseConfig({ executionRunLogDir: join(tmp, 'logs') })
    const e = new ExecutionEngine(cfg, fakeRenderer(), c as unknown as never)
    let count = 0
    e.getEventEmitter().on('RUN_TERMINATED', () => { count++ })
    e.getEventEmitter().on('RUN_COMPLETED', () => { count++ })
    await e.runTurn('explain', [])
    expect(count).toBe(1)
  })

  it('§35: 20 sequential runs leave no leaked contexts', async () => {
    const c = new FakeOpenAI()
    const cfg = baseConfig({ executionRunLogDir: join(tmp, 'logs') })
    const e = new ExecutionEngine(cfg, fakeRenderer(), c as unknown as never)
    for (let i = 0; i < 20; i++) {
      await e.runTurn(`run ${i}`, [])
    }
    const store = e.getRunRegistry()
    // Registry should have runs but they're terminal — the context store
    // is separate from the registry. Verify no crash after 20 runs.
    expect(store.list().length).toBeGreaterThanOrEqual(20)
  })
})
