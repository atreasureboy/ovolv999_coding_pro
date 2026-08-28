/**
 * App — root Ink component for the ovolv999 REPL.
 *
 * Orchestrates:
 * - Banner display
 * - Conversation messages (from UIStore)
 * - Live streaming text
 * - Codex-style `• Working (Ns · esc to interrupt)` status line
 * - PromptInput with slash autocomplete
 * - StatusBar (model, context, cost)
 * - Interrupt overlay
 *
 * The engine and command system are passed in as props. The App subscribes
 * to UIStore for display state, and drives the engine via async turn execution.
 */

import { Text, Box, Static, useApp, useInput, useStdout } from 'ink'
import { t } from '../theme.js'
import { useState, useCallback, useRef, useEffect, useMemo } from 'react'
import { type UIStore, useUIStore, type UIState } from './store.js'
import { Banner } from './Banner.js'
import { MessageList, MessageRow } from './components/MessageList.js'
import { PromptInput } from './components/PromptInput.js'
import { StatusBar } from './components/StatusBar.js'
import { PlanView } from './components/PlanView.js'
import { PermissionDialog } from './components/PermissionDialog.js'
import { SelectPicker } from './components/SelectPicker.js'
import { getGitBranch } from './gitInfo.js'
import { HelpOverlay } from './components/HelpOverlay.js'
import type { TurnOutcome } from '../../core/runtime/turnOutcome.js'
import { expandAtMentions } from './expandAtMentions.js'
import { copyToClipboard } from '../../utils/clipboard.js'
import { loadInputHistory, saveInputHistory } from '../../utils/inputHistory.js'
import { initTerminalTitle, updateTerminalTitle, restoreTerminalTitle } from '../../utils/terminalTitle.js'
import { loadKeybindings, lookupAction } from '../keybindings.js'
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

export function safeTerminalWidth(columns: number | undefined): number {
  return Math.max(20, (columns || 80) - 1)
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
    currentHistory: OpenAIMessage[],
    images?: Array<{ path: string; dataUrl: string }>,
  ) => Promise<{ newHistory: OpenAIMessage[]; reason: string; outcome?: TurnOutcome }>
  /** Slash command dispatcher. Returns null if not a slash command. */
  dispatchSlash: (input: string) => Promise<boolean>
  /** Initial history (for resume). */
  initialHistory: OpenAIMessage[]
  /** Max context tokens (for StatusBar). */
  maxContextTokens?: number
  /** Working directory (for git branch display). */
  cwd: string
  /**
   * v0.4.1 WS8: session directory for the error card's log-trace line
   * (points at <sessionDir>/events.ndjson). Absent when sessions are
   * disabled (e.g. --pipe).
   */
  sessionDir?: string
  /** Callback for soft abort (first ESC) */
  onSoftAbort?: () => void
  /** Callback for hard abort (second ESC) */
  onHardAbort?: () => void
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
  sessionDir,
  onSoftAbort,
  onHardAbort,
}: AppProps): React.ReactElement {
  const state: UIState = useUIStore(store)
  const { exit } = useApp()
  const { stdout } = useStdout()
  const historyRef = useRef<OpenAIMessage[]>(initialHistory)
  const [showHelp, setShowHelp] = useState(false)
  // Round 46 (codex status line): a 1s heartbeat while a turn runs so
  // `• Working (12s · esc to interrupt)` counts up. No timer when idle.
  const [nowTick, setNowTick] = useState(0)
  useEffect(() => {
    if (!state.running) return
    const id = setInterval(() => setNowTick((n) => n + 1), 1000)
    return () => clearInterval(id)
  }, [state.running])
  const inputHistory = useRef<string[]>(loadInputHistory())
  const turnStartTime = useRef(0)
  const renderEpoch = useRef(state.renderEpoch)

  // ── Terminal title lifecycle ──────────────────────────────────────────────

  useEffect(() => {
    initTerminalTitle(`ovolv999 · ${model}`)
    return () => restoreTerminalTitle()
  }, [model])

  useEffect(() => {
    if (state.renderEpoch === renderEpoch.current) return
    renderEpoch.current = state.renderEpoch
  }, [state.renderEpoch])

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
      updateTerminalTitle(store.getState().banner?.model ?? model, true)

      try {
        const result = await runTurn(expandedText, historyRef.current, images.length > 0 ? images : undefined)
        historyRef.current = result.newHistory
        const elapsed = ((Date.now() - turnStartTime.current) / 1000).toFixed(1)
        if (result.outcome) {
          const { formatOutcomeCardText } = await import('../turnOutcomeCard.js')
          const card = formatOutcomeCardText({
            outcome: result.outcome,
            elapsedSec: elapsed,
            model: store.getState().banner?.model ?? model,
            costStr: `$${store.getState().cost.toFixed(4)}`,
          })
          const status = result.outcome.completion?.status ?? 'completed'
          if (status === 'completed') store.addSuccess(card)
          else if (status === 'cancelled') store.addWarn(card)
          else if (status === 'blocked' || status === 'failed') store.addError(card)
          else store.addInfo(card)
        } else {
          if (result.reason === 'stop_sequence') store.addSuccess(`Done in ${elapsed}s`)
          else if (result.reason.startsWith('completion_')) {
            const status = result.reason.slice('completion_'.length).replaceAll('_', ' ')
            store.addWarn(`${status[0]?.toUpperCase() ?? ''}${status.slice(1)} in ${elapsed}s · /why for details`)
          } else {
            store.addInfo(`Stopped in ${elapsed}s · ${result.reason.replaceAll('_', ' ')}`)
          }
        }
      } catch (err: unknown) {
        const error = err as Error
        if (error.name !== 'AbortError') {
          // v0.4.1 WS8 (render-once): the SINGLE Ink error renderer.
          // runOneTurn rethrows non-abort failures here; the card carries
          // the session's real log path and the turn's real attempt count
          // (tracked by the modelBridge via MODEL_ATTEMPT_STARTED).
          const { formatErrorCardText } = await import('../../utils/apiError.js')
          store.addError(formatErrorCardText(err, sessionDir, store.getState().apiAttempts))
        }
      } finally {
        store.setRunning(false)
        store.setSpinner(false)
        // v0.4.1 C2 (interrupt truth): the interrupt overlay must not outlive
        // the turn. Pre-C2 it stayed rendered under the idle input box until
        // the user pressed ESC again — a stuck "Interrupted" banner over a
        // fresh prompt.
        store.setInterrupt(false)
        updateTerminalTitle(store.getState().banner?.model ?? model, false)
        // Bell notification for long-running turns (>5s)
        const elapsed = Date.now() - turnStartTime.current
        if (elapsed > 5000) {
          if (stdout.isTTY) stdout.write('\x07')
        }
      }
    },
    [runTurn, dispatchSlash, store, model],
  )

  // ── Interrupt ─────────────────────────────────────────────────────────────

  const handleInterrupt = useCallback(() => {
    store.setInterrupt(false)
  }, [store])

  // ── Copy last reply ───────────────────────────────────────────────────────

  const handleCopy = useCallback(() => {
    for (let i = historyRef.current.length - 1; i >= 0; i--) {
      const m = historyRef.current[i]
      if (m.role === 'assistant' && typeof m.content === 'string' && m.content) {
        const ok = copyToClipboard(m.content)
        store.addInfo(ok ? '✓ Copied to clipboard' : '⚠ No clipboard tool found')
        return
      }
    }
    store.addInfo('No assistant reply to copy')
  }, [store])

  // ── Keybindings (loaded once per cwd) ─────────────────────────────────────

  const keybindings = useMemo(() => loadKeybindings(cwd), [cwd])

  // Show config warnings on first load
  useEffect(() => {
    if (keybindings.errors.length > 0) {
      store.addInfo(`⚠ Keybinding config errors (${keybindings.errors.length}). Run /keybindings to see details.`)
    }
    if (keybindings.conflicts.length > 0) {
      store.addInfo(`⚠ ${keybindings.conflicts.length} keybinding conflict(s). Run /keybindings to see details.`)
    }
    // Mount-only: surface keybinding config/conflict banners once on
    // first paint. (react-hooks plugin is not enabled in this repo.)
  }, [])

  // ── Global key handler (Ctrl+C, Ctrl+L, Ctrl+O, ESC interrupt, ?, etc.) ──

  const sigintCount = useRef(0)
  const abortCount = useRef(0)
  /** Round 44: idle double-ESC exit (mirrors the Ctrl+C double-press). */
  const escCount = useRef(0)

  useEffect(() => {
    if (!state.running) {
      abortCount.current = 0
    }
  }, [state.running])

  useInput((input, key) => {
    if (state.running) {
      if (key.escape || input === '\x1b') {
        if (abortCount.current === 0) {
          abortCount.current = 1
          store.setSpinner(true, 'Cancelling turn...')
          // v0.4.1 C2 (interrupt truth): soft abort stops the turn at the next
          // boundary — it does NOT pause-and-inject in Ink (feedback injection
          // is classic-only in v0.4.1). Continuation = the user's next message.
          store.setInterrupt(true, '正在安全中断当前任务；当前步骤结束后返回 cancelled（再次 ESC 强制中断）')
          onSoftAbort?.()
        } else {
          abortCount.current = 2
          store.setSpinner(true, 'Interrupting...')
          store.setInterrupt(true, '强行终止当前任务...')
          onHardAbort?.()
        }
      }
      return
    }

    // Round 44: ESC while idle — first press shows the way out, second
    // press within 1.5s exits. ESC during a turn remains the interrupt
    // path above and NEVER kills the session.
    if (key.escape || input === '\x1b') {
      if (!store.hasOverlay()) {
        escCount.current++
        if (escCount.current >= 2) {
          exit()
          return
        }
        store.addInfo('再次按 ESC 退出 · Ctrl+C 亦可 · 单次 ESC 仅在任务运行时中断当前步骤')
        const resetEsc = setTimeout(() => { escCount.current = 0 }, 1500)
        resetEsc.unref?.()
      }
      return
    }

    if ((input === '\x04' || (key.ctrl && input === 'd')) && !state.running && !store.hasOverlay()) {
      exit()
      return
    }
    const action = lookupAction(input, key, keybindings.bindings)

    // Help overlay toggle (only when no overlay/turn is active)
    if (action === 'toggle-help' && !state.running && !store.hasOverlay()) {
      setShowHelp((v) => !v)
      return
    }

    // Exit: double-press Ctrl+C
    if (action === 'exit') {
      sigintCount.current++
      if (sigintCount.current >= 2) {
        exit()
        return
      }
      // Round 44: make the double-press discoverable — silence here read
      // as "broken ESC/keybindings" to every new user.
      store.addInfo('再按一次 Ctrl+C 退出 · Ctrl+D 亦可')
      // R18: unref so the reset timer can't keep the event loop alive if
      // the app exits within the 1.5s window. One-shot, ref-only mutation.
      const reset = setTimeout(() => { sigintCount.current = 0 }, 1500)
      reset.unref()
      return
    }

    // Clear screen and redraw
    if (action === 'clear-screen') {
      stdout.write('\x1b[2J\x1b[3J\x1b[H')
      return
    }

    // Toggle verbose/compact mode
    if (action === 'toggle-verbose') {
      store.toggleVerbose()
      return
    }
  })

  // ── Context state for StatusBar ───────────────────────────────────────────

  // Round 45 (usage polish): token estimation re-runs only when the
  // message count changes — the full-history JSON.stringify otherwise
  // ran on EVERY render (each keystroke, each spinner tick) and grew
  // linearly with the session.
  const historyLength = historyRef.current.length
  const tokens = useMemo(() => estimateTokens(historyRef.current), [historyLength])
  const maxCtx = maxContextTokens ?? 200_000
  const contextPct = maxCtx > 0 ? tokens / maxCtx : 0
  const terminalWidth = safeTerminalWidth(stdout.columns)
  const committedMessages = state.messages.filter((message) => message.id <= state.committedThroughId)
  const liveMessages = state.messages.filter((message) => message.id > state.committedThroughId)
  const staticItems: Array<
    | { kind: 'banner'; id: string; version: string; model: string }
    | { kind: 'message'; id: string; message: (typeof committedMessages)[number] }
  > = [
    ...(state.banner
      ? [{
          kind: 'banner' as const,
          id: `banner:${state.banner.version}:${state.banner.model}`,
          version: state.banner.version,
          model: state.banner.model,
        }]
      : []),
    ...committedMessages.map((message) => ({
      kind: 'message' as const,
      id: `message:${message.id}`,
      message,
    })),
  ]

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <Box width={terminalWidth} flexDirection="column">
      <Static key={state.renderEpoch} items={staticItems}>
        {(item) => item.kind === 'banner' ? (
          <Banner
            key={item.id}
            version={item.version}
            model={item.model}
            cwd={cwd}
            gitBranch={getGitBranch(cwd)}
            contextWindow={maxContextTokens}
            terminalWidth={terminalWidth}
          />
        ) : (
          <MessageRow key={item.id} msg={item.message} />
        )}
      </Static>

      {/* Interrupt overlay */}
      {state.interrupt?.active ? (
        <Box flexDirection="column" marginY={1}>
          <Text color={t.warning}>⚡ Interrupted</Text>
          {state.interrupt.feedback ? (
            <Text color={t.warning}>⚡ {state.interrupt.feedback.slice(0, 120)}</Text>
          ) : (
            <Text dimColor>当前步骤完成后停止——发送消息即可继续</Text>
          )}
        </Box>
      ) : null}

      <MessageList messages={liveMessages} verbose={state.verbose} />

      {/* Round 45: live streaming — reasoning (dim) + visible text as it
          arrives, throttled by the store. Replaces the old behavior of
          showing nothing until the whole turn finished. */}
      {state.running && (state.streamingReasoning || state.streamingText) ? (
        <Box flexDirection="column" marginTop={1} paddingX={1}>
          {state.streamingReasoning ? (
            <Text color={t.muted} italic>
              {(() => {
                const lines = state.streamingReasoning.split('\n')
                return lines.slice(-4).join('\n')
              })()}
            </Text>
          ) : null}
          {state.streamingText ? (
            <Text color={t.text}>
              {(() => {
                // Round 45: tail window — rendering the WHOLE accumulated
                // reply every 60ms made long responses progressively
                // jankier (O(accumulated) re-layout per flush). The full
                // text lands in the static history at turn end.
                const lines = state.streamingText.split('\n')
                return lines.slice(-12).join('\n')
              })()}
            </Text>
          ) : null}
        </Box>
      ) : null}

      {/* Round 46 (codex status line): one quiet line while working —
          `• Working (12s · esc to interrupt)` — replacing the two-line
          spinner + italic hint. The verb comes from the engine
          (Thinking / running tools), elapsed counts up live. */}
      {state.running ? (
        <Box paddingLeft={1}>
          <Text color={t.primary}>• </Text>
          <Text color={t.text}>{state.spinnerVerb || 'Working'} </Text>
          <Text color={t.muted}>({Math.max(0, Math.floor((Date.now() - turnStartTime.current) / 1000))}s · esc to interrupt)</Text>
        </Box>
      ) : null}

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

      {/* Input — hidden while a turn runs (the status line above owns
          the "working" signal, codex-style). */}
      {state.running || store.hasOverlay() || showHelp ? null : (
        <Box marginTop={1}>
          <PromptInput
            onSubmit={(text) => { void handleSubmit(text) }}
            disabled={state.running}
            onInterrupt={handleInterrupt}
            skills={skills}
            history={inputHistory.current}
            cwd={cwd}
            onCopy={handleCopy}
            terminalWidth={terminalWidth}
          />
        </Box>
      )}

      {/* Status bar */}
      <StatusBar
        model={state.banner?.model ?? model}
        messageCount={historyRef.current.length}
        contextPct={contextPct}
        tokenCount={tokens}
        maxTokens={maxContextTokens}
        cost={state.cost}
        apiCalls={state.apiCalls}
        planMode={state.planMode}
        verbose={state.verbose}
        profile={state.profile}
        gitBranch={getGitBranch(cwd)}
        terminalWidth={terminalWidth}
      />
    </Box>
  )
}
