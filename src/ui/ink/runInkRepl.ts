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
import { registerCleanup } from '../../utils/cleanup.js'

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
    images?: Array<{ path: string; dataUrl: string }>,
  ): Promise<{ newHistory: OpenAIMessage[]; reason: string }> {
    store.setRunning(true)
    store.setSpinner(true, 'Thinking')
    try {
      const result = await engine.runTurn(prompt, history, images)
      history = result.newHistory
      // Update cost tracking after each turn
      const ct = engine.getCostTracker()
      store.setCost(ct.getTotalCost(), ct.getTotalAPICalls())
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

        // ── Interactive /model (no args) → SelectPicker ──────────────────────
        if (input.trim() === '/model') {
          const currentModel = engine.getModel()
          const models = [
            { label: 'glm-4.6', description: 'ZhipuAI GLM-4.6 (default)', value: 'glm-4.6' },
            { label: 'glm-4.5', description: 'ZhipuAI GLM-4.5', value: 'glm-4.5' },
            { label: 'gpt-4o', description: 'OpenAI GPT-4o', value: 'gpt-4o' },
            { label: 'gpt-4o-mini', description: 'OpenAI GPT-4o-mini (fast)', value: 'gpt-4o-mini' },
            { label: 'claude-sonnet-4-20250514', description: 'Claude Sonnet 4', value: 'claude-sonnet-4-20250514' },
            { label: 'deepseek-chat', description: 'DeepSeek Chat (cheap)', value: 'deepseek-chat' },
          ]
          const items = models.map((m) => ({
            ...m,
            description: m.value === currentModel ? `${m.description} ← current` : m.description,
          }))
          const selected = await store.showSelectPicker('Switch Model', items)
          if (selected && selected !== currentModel) {
            engine.setModel(selected)
            store.setModel(selected)
            store.addInfo(`Switched model: ${selected}`)
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
      cwd: opts.cwd,
    }),
  )

  store.setBanner(opts.version, opts.model)

  // Register cleanup handlers for signals/crashes
  const cleanup = registerCleanup({ onCleanup: () => instance.unmount() })

  try {
    await instance.waitUntilExit()
  } finally {
    cleanup()
  }
}
