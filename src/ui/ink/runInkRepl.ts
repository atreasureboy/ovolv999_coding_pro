/**
 * runInkRepl — entry point for the Ink-based REPL.
 *
 * Accepts a pre-created engine (with InkRenderer) and UIStore.
 * Handles slash command dispatch, turn execution, and Ink rendering.
 *
 * Usage (from bin/ovogogogo.ts):
 *   const store = new UIStore()
 *   const inkRenderer = new InkRenderer(store)
 *   const engine = new ExecutionEngine(config, inkRenderer as unknown as Renderer)
 *   await runInkRepl({ store, engine, version, model, ... })
 */

import { render } from 'ink'
import { createElement } from 'react'
import type { UIStore } from './store.js'
import type { ExecutionEngine } from '../../core/engine.js'
import type { OpenAIMessage } from '../../core/types.js'
import type { Renderer } from '../renderer.js'
import { dispatchSlashCommand, type SlashCommandContext } from '../../commands/index.js'
import { listSessions, loadSession as loadSessionFile, resolveSessionPath } from '../../core/sessionManager.js'

export interface InkReplOptions {
  store: UIStore
  engine: ExecutionEngine
  inkRenderer: Renderer
  version: string
  model: string
  skills: Array<{ name: string; description: string }>
  sessionDir?: string
  cwd: string
  resumedHistory?: OpenAIMessage[]
  maxContextTokens: number
}

export async function runInkRepl(opts: InkReplOptions): Promise<void> {
  const { store, engine } = opts

  // ── Slash command context ─────────────────────────────────────────────────
  let history: OpenAIMessage[] = opts.resumedHistory ? [...opts.resumedHistory] : []

  const slashCtx: SlashCommandContext = {
    engine,
    renderer: opts.inkRenderer,
    history,
    cwd: opts.cwd,
    sessionDir: opts.sessionDir,
    setHistory: (msgs: OpenAIMessage[]) => {
      history.length = 0
      history.push(...msgs)
      store.clearMessages()
    },
    runPrompt: (prompt: string) => {
      void runOneTurn(prompt)
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
        return loadSessionFile(sessionPath)
      } catch {
        return null
      }
    },
  }

  // ── Turn execution ────────────────────────────────────────────────────────

  async function runOneTurn(
    prompt: string,
  ): Promise<{ newHistory: OpenAIMessage[]; reason: string }> {
    store.setRunning(true)
    store.setSpinner(true, 'Thinking')
    try {
      const result = await engine.runTurn(prompt, history)
      history = result.newHistory
      return { newHistory: result.newHistory, reason: result.result.reason }
    } catch (err: unknown) {
      const error = err as Error
      if (error.name !== 'AbortError') {
        store.addError(`Error: ${error.message}`)
      }
      return { newHistory: history, reason: 'error' }
    } finally {
      store.setRunning(false)
      store.setSpinner(false)
    }
  }

  // ── Render ────────────────────────────────────────────────────────────────

  const { App: AppComponent } = await import('./App.js')

  const instance = render(
    createElement(AppComponent, {
      store,
      _version: opts.version,
      model: opts.model,
      skills: opts.skills,
      runTurn: async (prompt: string, currentHistory: OpenAIMessage[]) => {
        history = currentHistory
        return runOneTurn(prompt)
      },
      dispatchSlash: async (input: string): Promise<boolean> => {
        // ── Interactive /resume (no args) → SelectPicker ─────────────────────
        if (input.trim() === '/resume' || input.trim() === '/r') {
          const sessions = listSessions(opts.cwd)
          if (sessions.length === 0) {
            store.addInfo('No saved sessions found.')
            return true
          }
          const items = sessions.slice(0, 20).map((s) => ({
            label: s.name,
            description: `${s.messages} msgs`,
            value: s.name,
          }))
          const selected = await store.showSelectPicker('Resume Session', items)
          if (selected) {
            const loaded = slashCtx.loadSession?.(selected)
            if (loaded && loaded.length > 0) {
              history.length = 0
              history.push(...loaded)
              store.clearMessages()
              store.addInfo(`Resumed session: ${selected} (${loaded.length} messages)`)
            } else {
              store.addError(`Failed to load session: ${selected}`)
            }
          }
          return true
        }

        const result = await dispatchSlashCommand(input, slashCtx)
        if (result === null) return false
        switch (result.type) {
          case 'text':
            store.addInfo(result.value)
            return true
          case 'exit':
            instance.unmount()
            return true
          case 'prompt':
            void runOneTurn(result.value)
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
    }),
  )

  store.setBanner(opts.version, opts.model)

  await instance.waitUntilExit()
}
