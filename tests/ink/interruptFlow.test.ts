/**
 * v0.4.1 C2 (interrupt truth) — the Ink ESC flow, and its copy, are honest.
 *
 * The real semantics, pinned here:
 *   ESC ×1 → onSoftAbort (engine.softAbort) — the turn STOPS at the next
 *            boundary; there is no pause-and-inject in Ink (feedback
 *            injection is classic-only in v0.4.1). Continuation = the
 *            user's next message.
 *   ESC ×2 → onHardAbort (engine.abort) — kills immediately.
 * And the interrupt overlay must never outlive the turn — pre-C2 it stayed
 * rendered under the idle prompt until the user pressed ESC again.
 */
import { describe, it, expect, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { createElement } from 'react'
import { render } from 'ink-testing-library'

// Hermetic: no writes to the user's real input history, no terminal-title
// escapes into the test runner's stdout.
vi.mock('../../src/utils/inputHistory.js', () => ({
  loadInputHistory: () => [] as string[],
  saveInputHistory: () => {},
}))
vi.mock('../../src/utils/terminalTitle.js', () => ({
  initTerminalTitle: () => {},
  updateTerminalTitle: () => {},
  restoreTerminalTitle: () => {},
}))

describe('App — interrupt flow truth (v0.4.1 C2)', () => {
  it('ESC×1 soft-aborts with truthful copy, ESC×2 hard-aborts, and the overlay never outlives the turn', async () => {
    const { UIStore } = await import('../../src/ui/ink/store.js')
    const { App } = await import('../../src/ui/ink/App.js')

    const cwd = mkdtempSync(join(tmpdir(), 'app-int-'))
    const store = new UIStore()
    const onSoftAbort = vi.fn()
    const onHardAbort = vi.fn()

    // A turn that hangs until the test releases it, so ESC lands mid-turn.
    let release: () => void = () => {}
    const gate = new Promise<void>((r) => { release = r })
    const runTurn = vi.fn(async () => {
      await gate
      return { newHistory: [], reason: 'interrupted' }
    })

    const instance = render(createElement(App, {
      store,
      _version: '0.4.1-test',
      model: 'gpt-4o',
      skills: [],
      onSoftAbort,
      onHardAbort,
      runTurn,
      dispatchSlash: async () => false,
      initialHistory: [],
      maxContextTokens: 200_000,
      cwd,
      sessionDir: join(cwd, 'sessions', 'session_test'),
    }))

    try {
      // useInput subscribes to stdin inside a useEffect that flushes AFTER
      // render() returns — writes before that race and are lost (see WS8).
      await new Promise((r) => setTimeout(r, 100))
      instance.stdin.write('hi')
      await new Promise((r) => setTimeout(r, 80))
      instance.stdin.write('\r')

      await vi.waitFor(() => {
        expect(store.getState().running).toBe(true)
      }, 2000)

      // First ESC → soft abort + truthful overlay copy.
      instance.stdin.write('\x1b')
      await vi.waitFor(() => {
        expect(onSoftAbort).toHaveBeenCalledOnce()
      }, 2000)
      const first = store.getState().interrupt
      expect(first?.active).toBe(true)
      expect(first?.feedback).toContain('正在安全中断当前任务')
      expect(first?.feedback).toContain('cancelled')
      expect(first?.feedback).toContain('再次 ESC 强制中断')
      // The pre-C2 lie ("type guidance to resume in place") must be gone:
      expect(first?.feedback).not.toContain('输入指导后重新继续')
      expect(instance.lastFrame()).toContain('Interrupted')

      // Second ESC → hard abort.
      instance.stdin.write('\x1b')
      await vi.waitFor(() => {
        expect(onHardAbort).toHaveBeenCalledOnce()
      }, 2000)
      expect(store.getState().interrupt?.feedback).toContain('强行终止')

      // Release the turn → finally{} must clear the overlay (no stickiness).
      release()
      await vi.waitFor(() => {
        expect(store.getState().running).toBe(false)
      }, 2000)
      await vi.waitFor(() => {
        expect(store.getState().interrupt).toBeNull()
      }, 2000)
      await vi.waitFor(() => {
        expect(instance.lastFrame()).not.toContain('Interrupted')
      }, 2000)
      expect(onSoftAbort).toHaveBeenCalledOnce()
    } finally {
      release()
      instance.unmount()
      try { rmSync(cwd, { recursive: true, force: true }) } catch { /* best-effort */ }
    }
  })
})
