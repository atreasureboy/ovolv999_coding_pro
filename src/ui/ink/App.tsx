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

import { Text, Box, useApp, useInput, useStdout } from 'ink'
import { useState, useCallback, useRef, useEffect } from 'react'
import { type UIStore, useUIStore, type UIState } from './store.js'
import { Banner } from './Banner.js'
import { Spinner } from './Spinner.js'
import { MessageList } from './components/MessageList.js'
import { PromptInput } from './components/PromptInput.js'
import { StatusBar } from './components/StatusBar.js'
import { PlanView } from './components/PlanView.js'
import { PermissionDialog } from './components/PermissionDialog.js'
import { SelectPicker } from './components/SelectPicker.js'
import { StreamingMarkdown } from './components/Markdown.js'
import { getGitBranch } from './gitInfo.js'
import { HelpOverlay } from './components/HelpOverlay.js'
import { expandAtMentions } from './expandAtMentions.js'
import { copyToClipboard } from '../../utils/clipboard.js'
import { loadInputHistory, saveInputHistory } from '../../utils/inputHistory.js'
import { initTerminalTitle, updateTerminalTitle, restoreTerminalTitle } from '../../utils/terminalTitle.js'
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
  runTurn: (
    prompt: string,
    history: OpenAIMessage[],
    images?: Array<{ path: string; dataUrl: string }>,
  ) => Promise<{ newHistory: OpenAIMessage[]; reason: string }>
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
  const { stdout } = useStdout()
  const [history, setHistory] = useState<OpenAIMessage[]>(initialHistory)
  const [showHelp, setShowHelp] = useState(false)
  const inputHistory = useRef<string[]>(loadInputHistory())
  const turnStartTime = useRef(0)

  // ── Terminal title lifecycle ──────────────────────────────────────────────

  useEffect(() => {
    initTerminalTitle(`ovolv999 · ${model}`)
    return () => restoreTerminalTitle()
  }, [model])

  // ── Turn execution ────────────────────────────────────────────────────────

  const handleSubmit = useCallback(
    async (text: string) => {
      // Track input history
      inputHistory.current.push(text)
      saveInputHistory(text)

      // Slash command?
      if (text.startsWith('/')) {
        const handled = await dispatchSlash(text)
        if (handled) return
        // Unknown command — let the engine try it as a prompt
      }

      // Normal turn — expand @file mentions before sending to engine
      store.addUserMessage(text)
      const { text: expandedText, mentions, images } = expandAtMentions(text, cwd)
      if (mentions.some((m) => m.found)) {
        const found = mentions.filter((m) => m.found)
        const fileCount = found.filter((m) => !m.isImage).length
        const imgCount = found.filter((m) => m.isImage).length
        const parts: string[] = []
        if (fileCount > 0) parts.push(`📎 ${fileCount} file${fileCount > 1 ? 's' : ''}`)
        if (imgCount > 0) parts.push(`🖼️ ${imgCount} image${imgCount > 1 ? 's' : ''}`)
        store.addInfo(`${parts.join(' · ')}: ${found.map((m) => m.path).join(', ')}`)
      }
      store.setRunning(true)
      store.setSpinner(true, 'Thinking')
      turnStartTime.current = Date.now()
      updateTerminalTitle(model, true)

      try {
        const result = await runTurn(expandedText, history, images.length > 0 ? images : undefined)
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
        updateTerminalTitle(model, false)
        // Bell notification for long-running turns (>5s)
        const elapsed = Date.now() - turnStartTime.current
        if (elapsed > 5000) {
          process.stdout.write('\x07')
        }
      }
    },
    [history, runTurn, dispatchSlash, store, model],
  )

  // ── Interrupt ─────────────────────────────────────────────────────────────

  const handleInterrupt = useCallback(() => {
    store.setInterrupt(false)
  }, [store])

  // ── Copy last reply ───────────────────────────────────────────────────────

  const handleCopy = useCallback(() => {
    for (let i = history.length - 1; i >= 0; i--) {
      const m = history[i]
      if (m.role === 'assistant' && typeof m.content === 'string' && m.content) {
        const ok = copyToClipboard(m.content)
        store.addInfo(ok ? '✓ Copied to clipboard' : '⚠ No clipboard tool found')
        return
      }
    }
    store.addInfo('No assistant reply to copy')
  }, [history, store])

  // ── Ctrl+C: exit (double-press) ───────────────────────────────────────────

  const sigintCount = useRef(0)
  useInput((input, key) => {
    // `?` toggles help overlay (only when no overlay/turn is active)
    if (input === '?' && !state.running && !store.hasOverlay()) {
      setShowHelp((v) => !v)
      return
    }
    if (key.ctrl && input === 'c') {
      sigintCount.current++
      if (sigintCount.current >= 2) {
        exit()
      }
      setTimeout(() => { sigintCount.current = 0 }, 1500)
    }

    // Ctrl+L: clear screen and redraw
    if (input === '\x0c') {
      stdout.write('\x1b[2J\x1b[3J\x1b[H')
    }

    // Ctrl+O: toggle verbose/compact mode
    if (input === '\x0f') {
      store.toggleVerbose()
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
      <MessageList messages={state.messages} verbose={state.verbose} />

      {/* Reasoning / thinking display */}
      {state.streamingReasoning ? (
        <Box marginLeft={2} flexDirection="column">
          <Text dimColor italic>
            {state.streamingReasoning.split('\n').slice(0, 6).join('\n')}
            {state.streamingReasoning.split('\n').length > 6 ? '\n...' : ''}
          </Text>
        </Box>
      ) : null}

      {/* Live streaming text */}
      {state.streamingText ? (
        <Box marginLeft={2} flexDirection="column">
          <StreamingMarkdown>{state.streamingText}</StreamingMarkdown>
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
          onResolve={(approved, alwaysAllow, feedback) => store.resolvePermission(approved, alwaysAllow, feedback)}
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

      {/* Help overlay (? key) */}
      {showHelp && !store.hasOverlay() ? (
        <HelpOverlay onDismiss={() => setShowHelp(false)} />
      ) : null}

      {/* Input or "running..." indicator */}
      {state.running || store.hasOverlay() || showHelp ? (
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
            cwd={cwd}
            onCopy={handleCopy}
          />
        </Box>
      )}

      {/* Status bar */}
      <StatusBar
        model={state.banner?.model ?? model}
        messageCount={history.length}
        contextPct={contextPct}
        tokenCount={tokens}
        maxTokens={maxContextTokens}
        cost={state.cost}
        apiCalls={state.apiCalls}
        planMode={state.planMode}
        verbose={state.verbose}
        gitBranch={getGitBranch(cwd)}
      />
    </Box>
  )
}
