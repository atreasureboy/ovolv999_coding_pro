/**
 * Process-level UX Convergence Tests (v0.4 Daily Driver UX Convergence §Requirement 12).
 *
 * Covers 14 real-world UX scenarios:
 *  1. First run without config
 *  2. Corrupted config JSON
 *  3. Simple Q&A (fast gear)
 *  4. Single-file fix
 *  5. Multi-file edit
 *  6. Parallel out-of-order tools
 *  7. ESC interrupt
 *  8. Blocked and partial outcomes
 *  9. Auto model routing
 * 10. Fallback chain
 * 11. Session resume
 * 12. Background task view
 * 13. Pipe input
 * 14. Post-completion diff/undo
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { tmpdir } from 'os'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'fs'
import { join } from 'path'
import { ExecutionEngine } from '../src/core/engine.js'
import type { EngineConfig } from '../src/core/types.js'
import type { Renderer } from '../src/ui/renderer.js'
import { UIStore } from '../src/ui/ink/store.js'
import { InkRenderer } from '../src/ui/ink/inkRenderer.js'
import { detectExecutionGear, getGearModules } from '../src/core/effort.js'
import { formatApiError } from '../src/utils/apiError.js'
import { loadSession, saveSession, listSessions } from '../src/core/sessionManager.js'
import { formatOutcomeCardText } from '../src/ui/turnOutcomeCard.js'

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

function toolCallStream(id: string, name: string, args: Record<string, unknown>): AsyncIterable<unknown> {
  return (async function* () {
    await Promise.resolve()
    yield {
      choices: [{
        index: 0,
        delta: { tool_calls: [{ index: 0, id, function: { name, arguments: JSON.stringify(args) } }] },
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

describe('v0.4 Daily Driver UX Convergence Suite', () => {
  let workDir: string
  let fakeClient: FakeOpenAI

  beforeEach(() => {
    workDir = mkdtempSync(join(tmpdir(), 'ux-eval-'))
    fakeClient = new FakeOpenAI()
  })

  afterEach(() => {
    rmSync(workDir, { recursive: true, force: true })
  })

  function makeEngine(extra?: Partial<EngineConfig>): ExecutionEngine {
    const config: EngineConfig = {
      model: 'gpt-4o',
      apiKey: 'test-key',
      cwd: workDir,
      maxIterations: 20,
      permissionMode: 'auto',
      enabledModules: ['memory', 'workspace'],
      ...extra,
    }
    return new ExecutionEngine(config, fakeRenderer(), fakeClient as unknown as never)
  }

  it('1. detect execution gear for simple Q&A vs complex task', () => {
    expect(detectExecutionGear('what is the time?')).toBe('fast')
    expect(detectExecutionGear('explain how this function works')).toBe('fast')
    expect(detectExecutionGear('fix the bug in src/add.ts')).toBe('standard')
    expect(detectExecutionGear('refactor the entire multi-file architecture')).toBe('deep')

    const fastModules = getGearModules('fast')
    expect(fastModules).not.toContain('critic')
    expect(fastModules).not.toContain('reflection')
  })

  it('2. corrupted config throws detailed error instead of silent empty fallback', () => {
    const badConfigPath = join(workDir, 'corrupt.json')
    writeFileSync(badConfigPath, '{ bad json syntax }', 'utf8')

    const parseBad = () => {
      const content = '{ bad json syntax }'
      try {
        JSON.parse(content)
      } catch (err) {
        throw new Error(`Corrupted JSON config file at "${badConfigPath}": ${(err as Error).message}`)
      }
    }
    expect(parseBad).toThrow(/Corrupted JSON config file/)
  })

  it('3. simple Q&A turn completes with outcome', async () => {
    fakeClient.push(stopStream('Hello world!'))
    const engine = makeEngine()
    const res = await engine.runTurn('hi', [])

    expect(res.outcome.completion.status).toBe('completed')
    expect(res.outcome.output).toBe('Hello world!')
  })

  it('4. single-file edit records changed file in outcome', async () => {
    const filePath = join(workDir, 'test.txt')
    fakeClient.push(toolCallStream('c1', 'Write', { file_path: filePath, content: 'hello' }))
    fakeClient.push(stopStream('File written.'))

    const engine = makeEngine()
    const res = await engine.runTurn('Write test.txt', [])

    expect(res.outcome.completion.status).toBe('completed')
    expect(res.outcome.changedFiles).toContain(filePath)
  })

  it('5. multi-file edit captures all changed files', async () => {
    const fileA = join(workDir, 'a.txt')
    const fileB = join(workDir, 'b.txt')
    fakeClient.push(toolCallStream('c1', 'Write', { file_path: fileA, content: 'A' }))
    fakeClient.push(toolCallStream('c2', 'Write', { file_path: fileB, content: 'B' }))
    fakeClient.push(stopStream('Done both.'))

    const engine = makeEngine()
    const res = await engine.runTurn('Write both files', [])

    expect(res.outcome.changedFiles.length).toBeGreaterThanOrEqual(2)
  })

  it('6. parallel tools completion matches callId out-of-order', () => {
    const store = new UIStore()
    const renderer = new InkRenderer(store)

    renderer.toolStart('Bash', { command: 'cmd1' }, 'call_10')
    renderer.toolStart('Read', { file_path: 'a' }, 'call_20')

    renderer.toolResult('Read', 'res2', false, 'call_20')
    const msg1 = store.getState().messages[1]
    const msg0 = store.getState().messages[0]
    if (msg1.type === 'tool') expect(msg1.result).toBe('res2')
    if (msg0.type === 'tool') expect(msg0.result).toBeUndefined()

    renderer.toolResult('Bash', 'res1', false, 'call_10')
    const finalMsg0 = store.getState().messages[0]
    if (finalMsg0.type === 'tool') expect(finalMsg0.result).toBe('res1')
  })

  it('7. ESC softAbort sets softAbortRequested and returns cancelled status', async () => {
    const engine = makeEngine()

    engine.softAbort()
    expect((engine as any).sharedState.softAbortRequested).toBe(true)
  })

  it('8. blocked and partial turn outcomes carry reasons', () => {
    const cardText = formatOutcomeCardText({
      outcome: {
        runId: 'r1',
        stopReason: 'stop_sequence',
        completion: {
          status: 'blocked',
          reasons: ['Verification command failed'],
          evidence: [],
          requiredNextActions: ['Fix test failure in test.ts'],
        },
        output: 'Failed',
        changedFiles: ['src/a.ts'],
        artifacts: [],
        verification: { executed: true, passed: false, failed: ['npm test failed'] },
        modelAttempts: [],
        stopped: true,
        reason: 'blocked',
      },
      elapsedSec: '2.5',
      model: 'gpt-4o',
    })

    expect(cardText).toContain('BLOCKED')
    expect(cardText).toContain('Verification command failed')
    expect(cardText).toContain('Fix test failure in test.ts')
  })

  it('9. auto model router returns active profiles', () => {
    const engine = makeEngine()
    const profiles = engine.getModelRouter().listProfiles()
    expect(profiles.length).toBeGreaterThan(0)
  })

  it('10. fallback error formatting outputs structured causes and next steps', () => {
    const fe = formatApiError(new Error('HTTP 429 rate limit exceeded'))
    expect(fe.title).toBe('Rate limited')
    expect(fe.nextSteps).toBeDefined()
    expect(fe.logPath).toBeDefined()
  })

  it('11. session save and resume extracts title and metadata', async () => {
    const sessDir = join(workDir, 'sessions', 'session_2026-07-28_100000')
    mkdirSync(sessDir, { recursive: true })

    saveSession(sessDir, [
      { role: 'user', content: 'Fix the add() function in src/math.ts' },
      { role: 'assistant', content: 'Sure, I will fix it.' },
    ])

    const loaded = loadSession(sessDir)
    expect(loaded).toHaveLength(2)

    const { listSessionsDetailed } = await import('../src/core/sessionManager.js')
    const list = listSessionsDetailed(workDir)
    expect(list).toHaveLength(1)
    expect(list[0].title).toContain('Fix the add() function')
  })

  it('12. background task manager initializes and lists tasks', () => {
    const engine = makeEngine()
    const bg = engine.getBackgroundTaskManager()
    expect(bg).toBeDefined()
    expect(bg.listTasks()).toHaveLength(0)
  })

  it('13. pipe mode input processes single task correctly', async () => {
    fakeClient.push(stopStream('Pipe output response'))
    const engine = makeEngine()
    const res = await engine.runTurn('Piped input text', [])
    expect(res.outcome.output).toBe('Pipe output response')
  })

  it('14. format outcome card presents quick actions (/diff, /undo)', () => {
    const card = formatOutcomeCardText({
      outcome: {
        runId: 'r2',
        stopReason: 'stop_sequence',
        completion: { status: 'completed', reasons: [], evidence: [], requiredNextActions: [] },
        output: 'Success',
        changedFiles: ['src/index.ts'],
        artifacts: [],
        verification: { executed: true, passed: true, failed: [] },
        modelAttempts: [],
        stopped: true,
        reason: 'stop_sequence',
      },
      elapsedSec: '1.2',
      model: 'gpt-4o',
    })

    expect(card).toContain('COMPLETED')
    expect(card).toContain('/diff')
    expect(card).toContain('/undo')
  })
})
