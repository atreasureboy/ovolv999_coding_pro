/**
 * v0.4.1 C5 (single card per turn) — every turn renders EXACTLY ONE
 * terminal card, at the frontend, in both UIs.
 *
 * The pre-WS8/C5 failure mode was duplication: the engine rendered an
 * error AND the frontend rendered one; a re-render could re-emit a card.
 * Pinned here:
 *   Ink     — a completed turn yields one 'Turn Outcome:' card and no
 *             error card; a failed turn yields one '✖' card and no
 *             outcome card; two turns yield exactly two cards (no
 *             duplication across re-renders).
 *   classic — renderOutcomeCard makes exactly ONE renderer call per card
 *             (the seam runSingleTask calls once per turn).
 */
import { describe, it, expect, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { createElement } from 'react'
import { render } from 'ink-testing-library'
import type { TurnOutcome } from '../src/core/runtime/turnOutcome.js'
import type { Renderer } from '../src/ui/renderer.js'
import { renderOutcomeCard } from '../src/ui/turnOutcomeCard.js'

vi.mock('../src/utils/inputHistory.js', () => ({
  loadInputHistory: () => [] as string[],
  saveInputHistory: () => {},
}))
vi.mock('../src/utils/terminalTitle.js', () => ({
  initTerminalTitle: () => {},
  updateTerminalTitle: () => {},
  restoreTerminalTitle: () => {},
}))

const completedOutcome = {
  completion: { status: 'completed', reasons: [] },
  output: 'done',
  modelAttempts: [],
  changedFiles: [],
} as unknown as TurnOutcome

const err401 = (): Error & { status: number } =>
  Object.assign(new Error('Incorrect API key provided'), { status: 401 })

function cardCounts(messages: Array<{ type: string; text?: string }>): { outcome: number; error: number } {
  let outcome = 0
  let error = 0
  for (const m of messages) {
    const text = m.text ?? ''
    if (text.includes('Turn Outcome:')) outcome++
    if (m.type === 'error' && text.includes('✖')) error++
  }
  return { outcome, error }
}

describe('Ink — exactly one terminal card per turn (v0.4.1 C5)', () => {
  it('a completed turn renders ONE outcome card and no error card', async () => {
    const { UIStore } = await import('../src/ui/ink/store.js')
    const { App } = await import('../src/ui/ink/App.js')
    const cwd = mkdtempSync(join(tmpdir(), 'app-card-'))
    const store = new UIStore()
    const instance = render(createElement(App, {
      store,
      _version: '0.4.1-test',
      model: 'gpt-4o',
      skills: [],
      runTurn: async () => ({ newHistory: [], reason: 'stop_sequence', outcome: completedOutcome }),
      dispatchSlash: async () => false,
      initialHistory: [],
      maxContextTokens: 200_000,
      cwd,
    }))
    try {
      await new Promise((r) => setTimeout(r, 100))
      instance.stdin.write('hi')
      await new Promise((r) => setTimeout(r, 80))
      instance.stdin.write('\r')
      await vi.waitFor(() => {
        expect(cardCounts(store.getState().messages).outcome).toBe(1)
      }, 4000)
      const counts = cardCounts(store.getState().messages)
      expect(counts).toEqual({ outcome: 1, error: 0 })
    } finally {
      instance.unmount()
      try { rmSync(cwd, { recursive: true, force: true }) } catch { /* best-effort */ }
    }
  })

  it('a failed turn renders ONE error card and no outcome card', async () => {
    const { UIStore } = await import('../src/ui/ink/store.js')
    const { App } = await import('../src/ui/ink/App.js')
    const cwd = mkdtempSync(join(tmpdir(), 'app-card-'))
    const store = new UIStore()
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
    }))
    try {
      await new Promise((r) => setTimeout(r, 100))
      instance.stdin.write('hi')
      await new Promise((r) => setTimeout(r, 80))
      instance.stdin.write('\r')
      await vi.waitFor(() => {
        expect(cardCounts(store.getState().messages).error).toBe(1)
      }, 4000)
      const counts = cardCounts(store.getState().messages)
      expect(counts).toEqual({ outcome: 0, error: 1 })
    } finally {
      instance.unmount()
      try { rmSync(cwd, { recursive: true, force: true }) } catch { /* best-effort */ }
    }
  })

  it('two turns render exactly two cards — no duplication across re-renders', async () => {
    const { UIStore } = await import('../src/ui/ink/store.js')
    const { App } = await import('../src/ui/ink/App.js')
    const cwd = mkdtempSync(join(tmpdir(), 'app-card-'))
    const store = new UIStore()
    const instance = render(createElement(App, {
      store,
      _version: '0.4.1-test',
      model: 'gpt-4o',
      skills: [],
      runTurn: async () => ({ newHistory: [], reason: 'stop_sequence', outcome: completedOutcome }),
      dispatchSlash: async () => false,
      initialHistory: [],
      maxContextTokens: 200_000,
      cwd,
    }))
    try {
      await new Promise((r) => setTimeout(r, 100))
      instance.stdin.write('one')
      await new Promise((r) => setTimeout(r, 80))
      instance.stdin.write('\r')
      await vi.waitFor(() => {
        expect(cardCounts(store.getState().messages).outcome).toBe(1)
      }, 4000)
      instance.stdin.write('two')
      await new Promise((r) => setTimeout(r, 80))
      instance.stdin.write('\r')
      await vi.waitFor(() => {
        expect(cardCounts(store.getState().messages).outcome).toBe(2)
      }, 4000)
      // Settle, then assert the count is STABLE (no late duplicate renders).
      await new Promise((r) => setTimeout(r, 150))
      expect(cardCounts(store.getState().messages)).toEqual({ outcome: 2, error: 0 })
    } finally {
      instance.unmount()
      try { rmSync(cwd, { recursive: true, force: true }) } catch { /* best-effort */ }
    }
  })
})

describe('classic — renderOutcomeCard emits exactly one renderer call (v0.4.1 C5)', () => {
  function countingRenderer(): { calls: Record<string, string[]>; renderer: Renderer } {
    const calls: Record<string, string[]> = {}
    const rec = (name: string) => (msg: string): void => {
      calls[name] = [...(calls[name] ?? []), msg]
    }
    return {
      calls,
      renderer: {
        success: rec('success'),
        warn: rec('warn'),
        error: rec('error'),
        info: rec('info'),
      } as unknown as Renderer,
    }
  }

  it('completed outcome → exactly one success() call, nothing else', () => {
    const { calls, renderer } = countingRenderer()
    renderOutcomeCard(renderer, { outcome: completedOutcome, elapsedSec: '1.0', model: 'm' })
    expect(calls.success ?? []).toHaveLength(1)
    expect(calls.success?.[0]).toContain('Turn Outcome: ✓ COMPLETED')
    expect(calls.warn ?? []).toHaveLength(0)
    expect(calls.error ?? []).toHaveLength(0)
    expect(calls.info ?? []).toHaveLength(0)
  })

  it('failed outcome → exactly one error() call, nothing else', () => {
    const { calls, renderer } = countingRenderer()
    const failed = {
      completion: { status: 'failed', reasons: ['provider rejected the request'] },
      output: '',
      modelAttempts: [],
      changedFiles: [],
    } as unknown as TurnOutcome
    renderOutcomeCard(renderer, { outcome: failed, elapsedSec: '1.0', model: 'm' })
    expect(calls.error ?? []).toHaveLength(1)
    expect(calls.error?.[0]).toContain('Turn Outcome: ✗ FAILED')
    expect(calls.success ?? []).toHaveLength(0)
    expect(calls.warn ?? []).toHaveLength(0)
    expect(calls.info ?? []).toHaveLength(0)
  })
})
