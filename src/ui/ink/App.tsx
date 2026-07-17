/**
 * App — root Ink component for the ovolv999 REPL.
 *
 * Orchestrates:
 * - Banner display
 * - Conversation messages (from UIStore)
 * - Live streaming text
 * - Spinner during turns
 * - PromptInput with slash autocomplete
 * - StatusBar (model, context, cost)
 * - Interrupt overlay
 *
 * The engine and command system are passed in as props. The App subscribes
 * to UIStore for display state, and drives the engine via async turn execution.
 */

import { Text, Box, useApp, useInput } from 'ink'
import { useState, useCallback, useRef } from 'react'
import { type UIStore, useUIStore, type UIState } from './store.js'
import { Banner } from './Banner.js'
import { Spinner } from './Spinner.js'
import { MessageList } from './components/MessageList.js'
import { PromptInput } from './components/PromptInput.js'
import { StatusBar } from './components/StatusBar.js'
import { PlanView } from './components/PlanView.js'
import { PermissionDialog } from './components/PermissionDialog.js'
import { SelectPicker } from './components/SelectPicker.js'
import { Markdown } from './components/Markdown.js'
import { getGitBranch } from './gitInfo.js'
import type { OpenAIMessage } from '../../core/types.js'

// ── Context calculation (lightweight — avoids importing full compact module) ──

function estimateTokens(messages: OpenAIMessage[]): number {
  let chars = 0
  for (const m of messages) {
    if (typeof m.content === 'string') chars += m.content.length
    else if (Array.isArray(m.content)) chars += JSON.stringify(m.content).length
    if (m.tool_calls) chars += JSON.stringify(m.tool_calls).length
  }
  return Math.ceil(chars / 4)
}

// ── Props ────────────────────────────────────────────────────────────────────

export interface AppProps {
  store: UIStore
  _version: string
  model: string
  skills: Array<{ name: string; description: string }>
  /** Execute a turn. Returns the new history. */
  runTurn: (prompt: string, history: OpenAIMessage[]) => Promise<{ newHistory: OpenAIMessage[]; reason: string }>
  /** Slash command dispatcher. Returns null if not a slash command. */
  dispatchSlash: (input: string) => Promise<boolean>
  /** Initial history (for resume). */
  initialHistory: OpenAIMessage[]
  /** Max context tokens (for StatusBar). */
  maxContextTokens: number
  /** Working directory (for git branch display). */
  cwd: string
}

// ── Component ────────────────────────────────────────────────────────────────

export function App({
  store,
  _version: _v,
  model,
  skills,
  runTurn,
  dispatchSlash,
  initialHistory,
  maxContextTokens,
  cwd,
}: AppProps): React.ReactElement {
  const state: UIState = useUIStore(store)
  const { exit } = useApp()
  const [history, setHistory] = useState<OpenAIMessage[]>(initialHistory)
  const inputHistory = useRef<string[]>([])

  // ── Turn execution ────────────────────────────────────────────────────────

  const handleSubmit = useCallback(
    async (text: string) => {
      // Track input history
      inputHistory.current.push(text)

      // Slash command?
      if (text.startsWith('/')) {
        const handled = await dispatchSlash(text)
        if (handled) return
        // Unknown command — let the engine try it as a prompt
      }

      // Normal turn
      store.addUserMessage(text)
      store.setRunning(true)
      store.setSpinner(true, 'Thinking')

      try {
        const result = await runTurn(text, history)
        setHistory(result.newHistory)
        store.addInfo(`Done · ${result.reason}`)
      } catch (err: unknown) {
        const error = err as Error
        if (error.name !== 'AbortError') {
          store.addError(`Error: ${error.message}`)
        }
      } finally {
        store.setRunning(false)
        store.setSpinner(false)
      }
    },
    [history, runTurn, dispatchSlash, store],
  )

  // ── Interrupt ─────────────────────────────────────────────────────────────

  const handleInterrupt = useCallback(() => {
    store.setInterrupt(false)
  }, [store])

  // ── Ctrl+C: exit (double-press) ───────────────────────────────────────────

  const sigintCount = useRef(0)
  useInput((input, key) => {
    if (key.ctrl && input === 'c') {
      sigintCount.current++
      if (sigintCount.current >= 2) {
        exit()
      }
      setTimeout(() => { sigintCount.current = 0 }, 1500)
    }
  })

  // ── Context state for StatusBar ───────────────────────────────────────────

  const tokens = estimateTokens(history)
  const contextPct = maxContextTokens > 0 ? tokens / maxContextTokens : 0

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <Box flexDirection="column">
      {/* Banner */}
      {state.banner ? <Banner version={state.banner.version} model={state.banner.model} /> : null}

      {/* Interrupt overlay */}
      {state.interrupt?.active ? (
        <Box flexDirection="column" marginY={1}>
          <Text color="yellowBright">⚡ Interrupted</Text>
          {state.interrupt.feedback ? (
            <Text color="yellowBright">⚡ {state.interrupt.feedback.slice(0, 120)}</Text>
          ) : (
            <Text dimColor>Type feedback or press Enter to resume</Text>
          )}
        </Box>
      ) : null}

      {/* Conversation messages */}
      <MessageList messages={state.messages} />

      {/* Live streaming text */}
      {state.streamingText ? (
        <Box marginLeft={2} flexDirection="column">
          <Markdown>{state.streamingText}</Markdown>
        </Box>
      ) : null}

      {/* Spinner */}
      <Spinner active={state.spinnerActive} verb={state.spinnerVerb} />

      {/* Interactive overlays — these capture keyboard while active */}
      {state.pendingPlan ? (
        <PlanView
          plan={state.pendingPlan.plan}
          onResolve={(approved) => store.resolvePlan(approved)}
        />
      ) : null}

      {state.pendingPermission ? (
        <PermissionDialog
          request={state.pendingPermission}
          onResolve={(approved, alwaysAllow) => store.resolvePermission(approved, alwaysAllow)}
        />
      ) : null}

      {state.selectOverlay ? (
        <SelectPicker
          items={state.selectOverlay.items}
          title={state.selectOverlay.title}
          onSelect={(value) => store.resolveSelect(value)}
          onCancel={() => store.resolveSelect(null)}
        />
      ) : null}

      {/* Input or "running..." indicator */}
      {state.running || store.hasOverlay() ? (
        <Box marginTop={1}>
          <Text dimColor italic>  (turn in progress — ESC to interrupt)</Text>
        </Box>
      ) : (
        <Box marginTop={1}>
          <PromptInput
            onSubmit={(text) => { void handleSubmit(text) }}
            disabled={state.running}
            onInterrupt={handleInterrupt}
            skills={skills}
            history={inputHistory.current}
          />
        </Box>
      )}

      {/* Status bar */}
      <StatusBar
        model={state.banner?.model ?? model}
        messageCount={history.length}
        contextPct={contextPct}
        cost={state.cost}
        apiCalls={state.apiCalls}
        planMode={state.planMode}
        gitBranch={getGitBranch(cwd)}
      />
    </Box>
  )
}
