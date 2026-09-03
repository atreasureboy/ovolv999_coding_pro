/**
 * runInkRepl — entry point for the Ink-based REPL.
 *
 * Accepts a pre-created engine (with InkRenderer) and UIStore.
 * Handles slash command dispatch, turn execution, and Ink rendering.
 *
 * Usage (from bin/ovogogogo.ts):
 *   const store = new UIStore()
 *   const inkRenderer = new InkRenderer(store)
 *   const engine = new ExecutionEngine(config, inkRenderer)
 *   await runInkRepl({ store, engine, version, model, ... })
 */

import { render } from 'ink'
import { createElement } from 'react'
import { join } from 'path'
import type { UIStore } from './store.js'
import type { ExecutionEngine } from '../../core/engine.js'
import type { OpenAIMessage } from '../../core/types.js'
import type { RendererInterface } from '../renderer.js'
import type { TurnOutcome } from '../../core/runtime/turnOutcome.js'
import { appendCheckpoint } from '../../core/conversationCheckpoints.js'
import { dispatchSlashCommand, type SlashCommandContext } from '../../commands/index.js'
import { listSessions, loadSession as loadSessionFile, resolveSessionPath } from '../../core/sessionManager.js'
import { registerCleanup } from '../../utils/cleanup.js'
import { wireModelBridge } from './modelBridge.js'
import { formatSessionLoadDiagnostic, saveSession, saveSessionIncremental, summarizeOutcome } from '../../core/sessionManager.js'
import { warnOnce } from '../../utils/warnOnce.js'

export interface InkReplOptions {
  store: UIStore
  engine: ExecutionEngine
  inkRenderer: RendererInterface
  version: string
  model: string
  skills: Array<{ name: string; description: string }>
  sessionDir?: string
  cwd: string
  resumedHistory?: OpenAIMessage[]
  maxContextTokens: number
  loopMaxIters: number
}

export function completionAwareReason(
  stopReason: string,
  completionStatus: string | undefined,
): string {
  return stopReason === 'stop_sequence' && completionStatus && completionStatus !== 'completed'
    ? `completion_${completionStatus}`
    : stopReason
}

export async function runInkRepl(opts: InkReplOptions): Promise<void> {
  let sessionLoadDiagnosticRendered = false
  const { store, engine } = opts

  // ── Slash command context ─────────────────────────────────────────────────
  let history: OpenAIMessage[] = opts.resumedHistory ? [...opts.resumedHistory] : []
  // Rebindable save target: /resume swaps this so subsequent autosaves and
  // the exit-cleanup save land in the RESUMED session directory, not the
  // original one (matches the non-Ink REPL behaviour in bin/ovogogogo.ts).
  let currentSessionDir = opts.sessionDir

  const slashCtx: SlashCommandContext = {
    engine,
    renderer: opts.inkRenderer,
    // Getters, not snapshots: runOneTurn rebinds `history` to a new array
    // every turn and /resume rebinds currentSessionDir — a one-time
    // property copy would leave every command reading pre-first-turn
    // state (/fork even persisted that stale array over the live file).
    get history() {
      return history
    },
    cwd: opts.cwd,
    get sessionDir() {
      return currentSessionDir
    },
    setHistory: (msgs: OpenAIMessage[]) => {
      history.length = 0
      history.push(...msgs)
      store.clearMessages()
    },
    runPrompt: (prompt: string) => {
      void runOneTurnSafe(prompt)
    },
    runLoop: async ({ restart }) => {
      const { runLoop } = await import('../../core/loopEngine.js')
      store.setRunning(true)
      try {
        await runLoop(engine, opts.inkRenderer, {
          cwd: opts.cwd,
          loopDir: join(opts.cwd, '.loop'),
          maxIters: opts.loopMaxIters,
          restart,
        })
      } finally {
        store.setRunning(false)
        store.setSpinner(false)
      }
    },
    getSkillsText: () => {
      if (opts.skills.length === 0) return 'No skills available.'
      return opts.skills.map((s) => `/${s.name.padEnd(16)} ${s.description}`).join('\n')
    },
    getSessionsText: () => {
      const sessions = listSessions(opts.cwd)
      if (sessions.length === 0) return 'No saved sessions found.'
      return sessions
        .slice(0, 10)
        .map((s) => `  ${s.name}  ${s.messages} msgs`)
        .join('\n')
    },
    loadSession: (name: string) => {
      const sessionPath = resolveSessionPath(opts.cwd, name)
      if (!sessionPath) return null
      try {
        const loaded = loadSessionFile(sessionPath)
        if (loaded.length > 0) currentSessionDir = sessionPath
        return loaded
      } catch (error) {
        store.addError(formatSessionLoadDiagnostic(error, sessionPath))
        sessionLoadDiagnosticRendered = true
        return null
      }
    },
  }

  // ── Turn execution ────────────────────────────────────────────────────────

  // v0.4.1 WS7 (session truth): the last finished turn's outcome, kept so the
  // exit/cleanup save (which has no runTurn result in scope) can persist the
  // REAL verdict into the Envelope v2 `lastOutcome` — /resume lists status
  // from the envelope, never guessed.
  let lastOutcome: TurnOutcome | undefined

  async function runOneTurn(
    prompt: string,
    images?: Array<{ path: string; dataUrl: string }>,
  ): Promise<{ newHistory: OpenAIMessage[]; reason: string; outcome?: TurnOutcome }> {
    store.setRunning(true)
    store.setSpinner(true, 'Thinking')
    try {
      const result = await engine.runTurn(prompt, history, images)
      history = result.newHistory
      if (result.outcome) lastOutcome = result.outcome
      // Update cost tracking after each turn
      const ct = engine.getCostTracker()
      store.setCost(ct.getTotalCost(), ct.getTotalAPICalls())
      // Autosave session after each completed turn — with the turn's outcome
      // so the envelope carries the persisted verdict (v0.4.1 WS7).
      if (currentSessionDir && history.length > 0) {
        try {
          // Round 42: incremental per-turn save (append-only ledger).
          saveSessionIncremental(currentSessionDir, history, result.outcome ? summarizeOutcome(result.outcome) : undefined)
          // Round 45 (audit fix): the classic path anchors a conversation
          // checkpoint after every turn — the Ink path never did, so
          // /rewind turn N was always empty on the DEFAULT UI. Parity now.
          appendCheckpoint(currentSessionDir, history, engine.getFileHistory(), prompt.slice(0, 80), opts.cwd)
        } catch (err: unknown) {
          store.addWarn(`Session save warning: ${(err as Error).message}`)
        }
      }

      const status = result.outcome?.completion?.status ?? 'completed'
      return { newHistory: result.newHistory, reason: status, outcome: result.outcome }
    } catch (err: unknown) {
      const error = err as Error
      if (error.name === 'AbortError') {
        // ESC interrupt — not an error; App renders the plain stop line.
        return { newHistory: history, reason: 'error' }
      }
      // v0.4.1 WS8 (render-once): rethrow to App.handleSubmit's catch — the
      // SINGLE Ink error renderer (5-section card with sessionDir + the real
      // attempt count from store.apiAttempts). Pre-WS8 this catch swallowed
      // the error after a plain addError, leaving App's card handler dead.
      // The finally below still runs first, so spinner/running state is
      // cleaned up before the error reaches App.
      throw err
    } finally {
      store.setRunning(false)
      store.setSpinner(false)
    }
  }

  // v0.5.5 (lifecycle): the floating runOneTurn call sites below (slash
  // `prompt` action, slashCtx.runPrompt via /retry) do NOT return the
  // promise into App.handleSubmit's try/catch — so a rejection there
  // would become an unhandledRejection (process-fatal via cleanup.ts:59).
  // This wrapper renders the error card itself, mirroring App.handleSubmit:182-191,
  // so those paths get the same render-once card without duplicating logic.
  // The normal submit path (runTurn prop, SITE 1) still returns runOneTurn
  // directly so handleSubmit remains the single renderer for that path.
  async function runOneTurnSafe(prompt: string): Promise<void> {
    try {
      await runOneTurn(prompt)
    } catch (err: unknown) {
      if ((err as Error).name === 'AbortError') return
      const { formatErrorCardText } = await import('../../utils/apiError.js')
      store.addError(formatErrorCardText(err, opts.sessionDir, store.getState().apiAttempts))
    }
  }

  // ── Render ────────────────────────────────────────────────────────────────

  const { App: AppComponent } = await import('./App.js')
  store.setBanner(opts.version, opts.model)

  // v0.4.1 WS5 (UI model truth): bridge runtime events into the UIStore so
  // the StatusBar shows the model the engine is ACTUALLY running — not the
  // startup value. Disconnected in the finally block below so a dead REPL
  // never leaks listeners on a reused engine.
  const modelBridge = wireModelBridge(store, engine.getEventEmitter())

  const instance = render(
    createElement(AppComponent, {
      store,
      engine,
      _version: opts.version,
      model: opts.model,
      skills: opts.skills,
      onSoftAbort: () => {
        engine.softAbort()
      },
      onHardAbort: () => {
        engine.abort()
      },
      runTurn: async (
        prompt: string,
        currentHistory: OpenAIMessage[],
        images?: Array<{ path: string; dataUrl: string }>,
      ) => {
        history = currentHistory
        return runOneTurn(prompt, images)
      },
      dispatchSlash: async (input: string): Promise<boolean> => {
        // ── Interactive /resume (no args) → SelectPicker ─────────────────────
        if (input.trim() === '/resume' || input.trim() === '/r') {
          const { listSessionsDetailed } = await import('../../core/sessionManager.js')
          const sessions = listSessionsDetailed(opts.cwd)
          if (sessions.length === 0) {
            store.addInfo('No saved sessions found.')
            return true
          }
          const items = sessions.slice(0, 20).map((s) => {
            const filesStr = s.changedFiles && s.changedFiles.length > 0 ? ` · ${s.changedFiles.length} file(s)` : ''
            const timeStr = s.updatedAt ? ` · ${s.updatedAt}` : ''
            const statusStr = s.status ? `[${s.status}] ` : ''
            return {
              label: s.title ? `${s.title.slice(0, 40)}` : s.name,
              description: `${statusStr}${s.name}${timeStr}${filesStr} · ${s.messages} msgs`,
              value: s.name,
            }
          })
          const selected = await store.showSelectPicker('Resume Session', items)
          if (selected) {
            const loaded = slashCtx.loadSession?.(selected)
            if (loaded && loaded.length > 0) {
              history.length = 0
              history.push(...loaded)
              store.clearMessages()
              store.addInfo(`Resumed session: ${selected} (${loaded.length} messages)`)
            } else {
              if (!sessionLoadDiagnosticRendered) {
                store.addError(`Session not found: ${selected}`)
              }
              sessionLoadDiagnosticRendered = false
            }
          }
          return true
        }

        // ── Interactive /model (no args) → SelectPicker from ModelRouter profiles ──────
        if (input.trim() === '/model') {
          const currentModel = engine.getModel()
          const profiles = engine.getModelRouter().listProfiles()
          const items = profiles.map((p) => {
            const isCurrent = p.id === currentModel || p.model === currentModel
            return {
              label: p.id,
              description: `[${p.tier ?? 'top'}] ${p.provider}/${p.model} (${p.roles.join(', ') || 'general'})${isCurrent ? ' ← current' : ''}`,
              value: p.model || p.id,
            }
          })
          if (items.length === 0) {
            items.push({
              label: currentModel,
              description: `${currentModel} (current model)`,
              value: currentModel,
            })
          }
          const selected = await store.showSelectPicker('Switch Model', items)
          if (selected && selected !== currentModel) {
            try {
              engine.setModel(selected)
              store.setModel(selected)
              store.addInfo(`Switched model: ${selected}`)
            } catch (err: unknown) {
              const msg = (err as Error).message
              store.addError(`Model switch failed: ${msg}`)
            }
          }
          return true
        }

        const result = await dispatchSlashCommand(input, slashCtx)
        if (result === null) return false
        switch (result.type) {
          case 'text':
            if (!sessionLoadDiagnosticRendered) store.addInfo(result.value)
            sessionLoadDiagnosticRendered = false
            return true
          case 'exit':
            instance.unmount()
            return true
          case 'prompt':
            void runOneTurnSafe(result.value)
            return true
          case 'clear-history':
            history.length = 0
            store.clearMessages()
            return true
          case 'noop':
            return true
        }
        return true
      },
      initialHistory: history,
      maxContextTokens: opts.maxContextTokens,
      cwd: opts.cwd,
      sessionDir: opts.sessionDir,
    }),
  )

  // Register cleanup handlers for signals/crashes
  const cleanup = registerCleanup({
    onCleanup: () => {
      // Final session save on exit — v0.4.1 WS7: persist the last turn's
      // verdict so /resume shows the real status. A failed save is warned to
      // stderr exactly once per process (never swallowed silently — the user
      // must learn their work did not persist).
      if (currentSessionDir && history.length > 0) {
        try {
          saveSessionIncremental(currentSessionDir, history, lastOutcome ? summarizeOutcome(lastOutcome) : undefined)
        } catch (err: unknown) {
          warnOnce('session:save:inkRepl', `Failed to persist session: ${(err as Error).message}`)
        }
      }
      instance.unmount()
    },
  })

  try {
    await instance.waitUntilExit()
  } finally {
    modelBridge.disconnect()
    cleanup()
  }
}
