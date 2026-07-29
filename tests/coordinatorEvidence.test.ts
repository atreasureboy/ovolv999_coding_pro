/**
 * v0.4.1 WS7 — the coordinator must fill TurnOutcome from the REAL
 * CompletionVerdict, not hardcoded empties.
 *
 * Pre-WS7 the outcome literal threw the verdict away:
 *   evidence: []               // now verdict.evidence → {type:'contract'}
 *   requiredNextActions: []    // now verdict.remaining ?? verdict.blockers
 * and carried no durationMs. These tests drive the real coordinator through
 * the engine DI seam (fake client, no network) and assert the outcome
 * reflects what the completion contract actually decided.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, existsSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { ExecutionEngine } from '../src/core/engine.js'
import type { EngineConfig } from '../src/core/types.js'
import type { Renderer } from '../src/ui/renderer.js'
import { SemanticMemory } from '../src/core/semanticMemory.js'
import { EpisodicMemory } from '../src/core/episodicMemory.js'
import { summarizeOutcome } from '../src/core/sessionManager.js'

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

function stopStream(text: string): AsyncIterable<unknown> {
  return (async function* () {
    await Promise.resolve()
    yield { choices: [{ index: 0, delta: { content: text }, finish_reason: null }] }
    yield { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 5 } }
  })()
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

function fakeRenderer(): Renderer {
  const r: Record<string, (...args: unknown[]) => void> = {}
  for (const k of ['banner', 'raw', 'info', 'warn', 'error', 'success', 'startSpinner', 'stopSpinner', 'beginAssistantText', 'endAssistantText', 'streamToken', 'streamReasoning', 'assistantMessage', 'userMessage', 'toolCall', 'toolStart', 'toolResult', 'compactStart', 'compactDone', 'contextWarning', 'cost', 'compactionNotice', 'turnEnd', 'planModeHeader', 'agentStart', 'agentDone', 'agentSummary', 'agentHeartbeat']) r[k] = () => {}
  return r as unknown as Renderer
}

describe('coordinator outcome truth (fake client e2e)', () => {
  let workDir: string
  let sessionDir: string
  let fakeClient: FakeOpenAI

  beforeEach(() => {
    workDir = mkdtempSync(join(tmpdir(), 'evidence-eval-'))
    sessionDir = mkdtempSync(join(tmpdir(), 'evidence-session-'))
    fakeClient = new FakeOpenAI()
  })
  afterEach(() => {
    try { rmSync(workDir, { recursive: true, force: true }) } catch { /* best-effort */ }
    try { rmSync(sessionDir, { recursive: true, force: true }) } catch { /* best-effort */ }
  })

  function makeEngine(): ExecutionEngine {
    const config: EngineConfig = {
      model: 'gpt-4o',
      apiKey: 'test-key',
      cwd: workDir,
      maxIterations: 20,
      permissionMode: 'auto',
      sessionDir,
      semanticMemory: new SemanticMemory(join(workDir, 'sem')),
      episodicMemory: new EpisodicMemory(join(workDir, 'ep')),
      enabledModules: ['memory', 'workspace'],
    }
    return new ExecutionEngine(config, fakeRenderer(), fakeClient as unknown as never)
  }

  it('mutation with changes but no verification → partial verdict surfaces REAL evidence + next actions', async () => {
    const target = join(workDir, 'hello.txt')
    // First model turn writes a file; then it stops. The premature-handoff
    // detector may force up to MAX_COMPLETION_CONTINUATIONS (3) extra
    // "you claimed done without verification" rounds, so queue enough
    // identical stops that the loop always terminates on its own terms —
    // the final verdict is partial either way (unused streams are ignored).
    fakeClient.push(toolCallStream('call_1', 'Write', { file_path: target, content: 'hi' }))
    fakeClient.push(stopStream('done'))
    fakeClient.push(stopStream('done'))
    fakeClient.push(stopStream('done'))
    fakeClient.push(stopStream('done'))
    const engine = makeEngine()

    const { outcome } = await engine.runTurn('create hello.txt containing the word hi', [])
    engine.dispose()

    expect(existsSync(target)).toBe(true) // the tool really ran
    expect(outcome.completion.status).toBe('partial')

    // evidence flows from the CompletionVerdict, tagged 'contract' — not [].
    expect(outcome.completion.evidence.length).toBeGreaterThan(0)
    for (const e of outcome.completion.evidence) {
      expect(e.type).toBe('contract')
      expect(e.detail.length).toBeGreaterThan(0)
    }
    expect(outcome.completion.evidence.some((e) => e.detail.includes('file(s) changed'))).toBe(true)

    // requiredNextActions flows from verdict.remaining — the pre-WS7 code
    // hardcoded [] here, hiding exactly this from /resume and the card.
    expect(outcome.completion.requiredNextActions).toEqual([
      'execute verification (typecheck/test/lint)',
    ])

    // durationMs is wall-clock truth, always populated by the coordinator.
    expect(typeof outcome.durationMs).toBe('number')
    expect(outcome.durationMs as number).toBeGreaterThan(0)

    // And the persistable summary inherits the same truth.
    const summary = summarizeOutcome(outcome)
    expect(summary.status).toBe('partial')
    expect(summary.requiredNextActions).toEqual(['execute verification (typecheck/test/lint)'])
    expect(summary.durationMs).toBe(outcome.durationMs)
  })

  it('plain Q&A → completed with well-shaped (possibly empty) evidence and no next actions', async () => {
    fakeClient.push(stopStream('4'))
    const engine = makeEngine()

    const { outcome } = await engine.runTurn('what is 2+2?', [])
    engine.dispose()

    expect(outcome.completion.status).toBe('completed')
    expect(Array.isArray(outcome.completion.evidence)).toBe(true)
    for (const e of outcome.completion.evidence) {
      expect(e.type).toBe('contract')
      expect(e.detail.length).toBeGreaterThan(0)
    }
    expect(outcome.completion.requiredNextActions).toEqual([])
    expect(typeof outcome.durationMs).toBe('number')
    expect(outcome.durationMs as number).toBeGreaterThan(0)
  })
})
