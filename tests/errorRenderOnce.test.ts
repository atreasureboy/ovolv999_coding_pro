/**
 * v0.4.1 WS8 — errors render EXACTLY ONCE, at the frontend, and the card
 * tells the truth.
 *
 * Pre-WS8 three lies compounded:
 *  1. the coordinator rendered `Engine error: …` itself AND emitted RUN_FAILED,
 *     so frontends that also rendered produced a double card;
 *  2. `autoRecovery` was a static fabricated string per error branch
 *     ("ModelRouter fallback chain triggered" etc.) that lied whenever no
 *     recovery actually happened;
 *  3. `logPath` pointed at events.jsonl — the real event log is events.ndjson.
 *
 * These tests pin the contract at three layers: the pure formatter (derived
 * truth), the engine (never self-renders; surfaces the error + RUN_FAILED),
 * and the Ink App (the single renderer, card carries the session's real log
 * path and the turn's real attempt count).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { createElement } from 'react'
import { render } from 'ink-testing-library'
import { formatApiError, formatErrorCardText } from '../src/utils/apiError.js'
import { ExecutionEngine } from '../src/core/engine.js'
import type { EngineConfig } from '../src/core/types.js'
import type { Renderer } from '../src/ui/renderer.js'
import { SemanticMemory } from '../src/core/semanticMemory.js'
import { EpisodicMemory } from '../src/core/episodicMemory.js'

// Keep the App test hermetic: no writes to the user's real input history or
// terminal title escapes into the test runner's stdout.
vi.mock('../src/utils/inputHistory.js', () => ({
  loadInputHistory: () => [] as string[],
  saveInputHistory: () => {},
}))
vi.mock('../src/utils/terminalTitle.js', () => ({
  initTerminalTitle: () => {},
  updateTerminalTitle: () => {},
  restoreTerminalTitle: () => {},
}))

const err401 = (): Error & { status: number } =>
  Object.assign(new Error('Incorrect API key provided'), { status: 401 })

// ── Layer 1: the pure formatter — autoRecovery is DERIVED, logPath is real ──

describe('formatApiError — autoRecovery truth (v0.4.1 WS8)', () => {
  it('real attempt count → derived plural line', () => {
    expect(formatApiError(err401(), undefined, 2).autoRecovery)
      .toBe('Engine attempted 2 model calls before surfacing this error')
  })

  it('exactly one attempt → singular line', () => {
    expect(formatApiError(err401(), undefined, 1).autoRecovery)
      .toBe('Engine attempted 1 model call before surfacing this error')
  })

  it('zero attempts → honest no-recovery line', () => {
    expect(formatApiError(err401(), undefined, 0).autoRecovery)
      .toBe('No automatic recovery was performed — the error surfaced directly')
  })

  it('absent attempts → honest no-recovery line', () => {
    expect(formatApiError(err401()).autoRecovery)
      .toBe('No automatic recovery was performed — the error surfaced directly')
  })

  it('AbortError carries no autoRecovery section at all', () => {
    const e = new Error('The user aborted the request')
    e.name = 'AbortError'
    expect(formatApiError(e, '/sess', 3).autoRecovery).toBeUndefined()
  })

  it('never resurrects the pre-WS8 fabricated recovery claims', () => {
    const card = formatErrorCardText(err401(), '/sess', 0)
    expect(card).not.toContain('fallback chain triggered')
    expect(card).not.toContain('Circuit breaker')
  })
})

describe('formatApiError — log trace truth (v0.4.1 WS8)', () => {
  it('sessionDir → <sessionDir>/events.ndjson (the real event log name)', () => {
    expect(formatApiError(new Error('boom'), '/tmp/sess-a', 1).logPath)
      .toBe('/tmp/sess-a/events.ndjson')
  })

  it('no sessionDir → generic logs pointer, never a fabricated session path', () => {
    expect(formatApiError(new Error('boom')).logPath).toBe('~/.ovogo/logs')
  })

  it('card text never points at the pre-WS8 events.jsonl', () => {
    expect(formatErrorCardText(err401(), '/tmp/sess-a', 1)).not.toContain('events.jsonl')
  })
})

describe('formatErrorCardText — exactly one five-section card', () => {
  it('all five sections present with the derived attempt truth', () => {
    const card = formatErrorCardText(err401(), '/tmp/sess-a', 3)
    const lines = card.split('\n')
    // exactly one card header — this is what "render once" means in text form
    expect(lines.filter((l) => l.startsWith('✖'))).toHaveLength(1)
    expect(lines[0]).toContain('✖ Authentication failed')
    expect(card).toContain('• What happened:')
    expect(card).toContain('• Possible causes:')
    expect(card).toContain('• Auto-recovery: Engine attempted 3 model calls before surfacing this error')
    expect(card).toContain('• Recommended next steps:')
    expect(card).toContain('• Log trace location: /tmp/sess-a/events.ndjson')
  })
})

// ── Layer 2: the engine never renders the error card itself ─────────────────

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

/** Every Renderer method records its args — so "never called" is provable. */
function countingRenderer(): { renderer: Renderer; calls: Record<string, unknown[][]> } {
  const calls: Record<string, unknown[][]> = {}
  const r: Record<string, (...args: unknown[]) => void> = {}
  for (const k of ['banner', 'raw', 'info', 'warn', 'error', 'success', 'startSpinner', 'stopSpinner', 'beginAssistantText', 'endAssistantText', 'streamToken', 'streamReasoning', 'assistantMessage', 'userMessage', 'toolCall', 'toolStart', 'toolResult', 'compactStart', 'compactDone', 'contextWarning', 'cost', 'compactionNotice', 'turnEnd', 'planModeHeader', 'agentStart', 'agentDone', 'agentSummary', 'agentHeartbeat']) {
    r[k] = (...args: unknown[]) => { (calls[k] ??= []).push(args) }
  }
  return { renderer: r as unknown as Renderer, calls }
}

describe('engine render-once contract (v0.4.1 WS8)', () => {
  let workDir: string
  let sessionDir: string

  beforeEach(() => {
    workDir = mkdtempSync(join(tmpdir(), 'render-once-eval-'))
    sessionDir = mkdtempSync(join(tmpdir(), 'render-once-session-'))
  })
  afterEach(() => {
    try { rmSync(workDir, { recursive: true, force: true }) } catch { /* best-effort */ }
    try { rmSync(sessionDir, { recursive: true, force: true }) } catch { /* best-effort */ }
  })

  it('provider failure → failed outcome + RUN_FAILED, renderer.error NEVER called', async () => {
    const fakeClient = new FakeOpenAI() // empty queue → every create() rejects
    const { renderer, calls } = countingRenderer()
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
    const engine = new ExecutionEngine(config, renderer, fakeClient as unknown as never)

    let attemptStarts = 0
    let runFailed = 0
    engine.getEventEmitter().on('MODEL_ATTEMPT_STARTED', () => { attemptStarts++ })
    engine.getEventEmitter().on('RUN_FAILED', () => { runFailed++ })

    const { outcome } = await engine.runTurn('hello', [])
    engine.dispose()

    // The engine surfaces the failure as a real verdict + event…
    expect(outcome.completion.status).toBe('failed')
    expect(runFailed).toBe(1)
    // …exactly one model call was really attempted…
    expect(attemptStarts).toBe(1)
    // …and the engine itself rendered NO error card. Pre-WS8 this was 1
    // ("Engine error: parked") — the frontend's card was a duplicate.
    expect(calls.error ?? []).toHaveLength(0)

    // With the engine silent, the frontend's single renderer produces exactly
    // this card from the REAL attempt count and the REAL log path:
    const card = formatErrorCardText(new Error('parked'), sessionDir, attemptStarts)
    expect(card).toContain('Engine attempted 1 model call before surfacing this error')
    expect(card).toContain(`${sessionDir}/events.ndjson`)
  })
})

// ── Layer 3: the Ink App is the single error renderer ───────────────────────

describe('App — the single Ink error card (v0.4.1 WS8)', () => {
  it('a failed turn yields EXACTLY ONE card with the real sessionDir + attempt count', async () => {
    const { UIStore } = await import('../src/ui/ink/store.js')
    const { App } = await import('../src/ui/ink/App.js')

    const cwd = mkdtempSync(join(tmpdir(), 'app-err-'))
    const sessionDir = join(cwd, 'sessions', 'session_2026-07-29_120000')
    const store = new UIStore()
    // What the modelBridge counted for this turn via MODEL_ATTEMPT_STARTED
    // (attemptId 0 and 1 → two real calls before the failure surfaced).
    store.setApiAttempts(2)

    const instance = render(createElement(App, {
      store,
      _version: '0.4.1-test',
      model: 'gpt-4o',
      skills: [],
      runTurn: async () => { throw err401() },
      dispatchSlash: async () => false,
      initialHistory: [],
      maxContextTokens: 200_000,
      cwd,
      sessionDir,
    }))

    try {
      // PromptInput's useInput subscribes to stdin inside a useEffect, which
      // flushes after render() returns — writes before that race and are
      // lost. Let the subscription establish, then type, then submit.
      await new Promise((r) => setTimeout(r, 100))
      instance.stdin.write('hi')
      await new Promise((r) => setTimeout(r, 80))
      instance.stdin.write('\r')

      await vi.waitFor(() => {
        const errs = store.getState().messages.filter((m) => m.type === 'error')
        expect(errs).toHaveLength(1)
      }, 4000)

      const errs = store.getState().messages.filter((m) => m.type === 'error')
      const text = (errs[0] as { text: string }).text
      expect(text).toContain('✖ Authentication failed')
      expect(text).toContain('• Auto-recovery: Engine attempted 2 model calls before surfacing this error')
      expect(text).toContain(`• Log trace location: ${sessionDir}/events.ndjson`)
    } finally {
      instance.unmount()
      try { rmSync(cwd, { recursive: true, force: true }) } catch { /* best-effort */ }
    }
  })
})
