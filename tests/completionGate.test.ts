/**
 * Main-path integration test for the CompletionContract gate (Phase 4).
 *
 * Proves the gate is LIVE in the coordinator: when the model emits
 * stop_sequence but a verification command FAILED during the turn, the
 * Run is marked 'blocked' (not 'succeeded') — the model cannot self-
 * declare done over a red verification. Uses the REAL ExecutionEngine
 * + ToolScheduler + Bash tool + WorkingState.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { tmpdir } from 'os'
import { mkdtempSync, rmSync } from 'fs'
import { join } from 'path'
import { ExecutionEngine } from '../src/core/engine.js'
import type { EngineConfig, Tool } from '../src/core/types.js'
import type { Renderer } from '../src/ui/renderer.js'

type Queued = { k: 's'; s: AsyncIterable<unknown> } | { k: 'e'; e: Error }
class FakeOpenAI {
  createCalls = 0
  private q: Queued[] = []
  chat = { completions: { create: (_p: Record<string, unknown>, o: { signal: AbortSignal }) => {
    this.createCalls++
    const n = this.q[this.createCalls - 1] ?? { k: 'e' as const, e: new Error('parked') }
    return new Promise<AsyncIterable<unknown>>((res, rej) => {
      if (o.signal.aborted) { rej(new Error('aborted')); return }
      o.signal.addEventListener('abort', () => rej(new Error('aborted')), { once: true })
      if (n.k === 's') res(n.s); else rej(n.e)
    })
  } } }
  push(s: AsyncIterable<unknown>) { this.q.push({ k: 's', s }) }
}

function toolCallStream(name: string, args: Record<string, unknown>): AsyncIterable<unknown> {
  return (async function* () {
    await Promise.resolve()
    yield {
      choices: [{
        index: 0,
        delta: { tool_calls: [{ index: 0, id: 'c1', function: { name, arguments: JSON.stringify(args) } }] },
        finish_reason: null,
      }],
    }
    yield { choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] }
  })()
}
function stopStream(text: string): AsyncIterable<unknown> {
  return (async function* () {
    await Promise.resolve()
    yield { choices: [{ index: 0, delta: { content: text }, finish_reason: null }] }
    yield { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 5 } }
  })()
}

function fakeRenderer(): Renderer {
  const r: Record<string, (...args: unknown[]) => void> = {}
  for (const k of ['banner', 'raw', 'info', 'warn', 'error', 'success', 'startSpinner', 'stopSpinner', 'beginAssistantText', 'endAssistantText', 'streamToken', 'streamReasoning', 'assistantMessage', 'userMessage', 'toolCall', 'toolStart', 'toolResult', 'compactStart', 'compactDone', 'contextWarning', 'cost', 'compactionNotice', 'turnEnd', 'planModeHeader', 'agentStart', 'agentDone', 'agentSummary', 'agentHeartbeat']) r[k] = () => {}
  return r as unknown as Renderer
}

function baseConfig(o: Partial<EngineConfig> = {}): EngineConfig {
  return { apiKey: 'k', model: 'm', maxIterations: 10, cwd: '/tmp', permissionMode: 'auto', permissionManager: undefined, enabledModules: [], ...o }
}

let tmp = ''
beforeEach(() => { tmp = mkdtempSync(`${tmpdir}/gate-`) })
afterEach(() => { rmSync(tmp, { recursive: true, force: true }) })

describe('CompletionContract main-path gate (Phase 4)', () => {
  it('blocks succeeded when a verification command failed during the turn', async () => {
    const logDir = join(tmp, 'logs')
    const c = new FakeOpenAI()
    // turn 1: run a failing command; turn 2: model claims "all done"
    c.push(toolCallStream('Bash', { command: 'node -e "process.exit(1)"' }))
    c.push(stopStream('All tests pass — task complete.'))
    const e = new ExecutionEngine(baseConfig({ executionRunLogDir: logDir }), fakeRenderer(), c as unknown as never)

    await e.runTurn('fix and verify', [])

    const run = e.getRunRegistry().list({ kind: 'turn' })[0]
    // The gate MUST block: verification.failed has 1 entry (exit-1 bash).
    expect(run.status).toBe('blocked')
    expect(run.phase).toMatch(/completion-blocked/)
    expect(run.error).toMatch(/completion/i)
    // WorkingState corroborates the failure.
    expect(e.getProgressMonitor().snapshot(0).changedFiles).toEqual([]) // no files changed
  })

  it('still marks succeeded when stop_sequence follows a clean turn (no false block)', async () => {
    const logDir = join(tmp, 'logs')
    const c = new FakeOpenAI()
    c.push(stopStream('done.')) // no tools, no failures — legit Q&A stop
    const e = new ExecutionEngine(baseConfig({ executionRunLogDir: logDir }), fakeRenderer(), c as unknown as never)
    await e.runTurn('hi', [])
    const run = e.getRunRegistry().list({ kind: 'turn' })[0]
    expect(run.status).toBe('succeeded')
  })

  it('marks succeeded when a verification command actually passed', async () => {
    const logDir = join(tmp, 'logs')
    const c = new FakeOpenAI()
    c.push(toolCallStream('Bash', { command: 'node -e "process.exit(0)"' })) // success
    c.push(stopStream('verified, done.'))
    const e = new ExecutionEngine(baseConfig({ executionRunLogDir: logDir }), fakeRenderer(), c as unknown as never)
    await e.runTurn('verify', [])
    const run = e.getRunRegistry().list({ kind: 'turn' })[0]
    expect(run.status).toBe('succeeded') // exit 0 → verification.passed, not failed → gate allows
  })
})
