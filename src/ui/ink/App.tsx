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

import type { ExecutionEngine } from '../../core/engine.js'
import { Text, Box, Static, useApp, useInput, useStdout } from 'ink'
import { appendFileSync } from 'fs'
import { join } from 'path'
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
  /** Round 48: engine access for `!` bash passthrough (tool execution). */
  engine?: ExecutionEngine
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
  engine,
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
  const [, setNowTick] = useState(0)
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
      // Round 46 (codex queue): typing during a running turn queues the
      // message instead of being impossible (input was hidden) — the
      // queued message auto-submits when the turn settles.
      // Round 46b FIX: read liveness from the STORE, not the callback
      // closure — `state.running` was captured at creation time (deps:
      // runTurn/dispatchSlash/store/model), so mid-turn submissions saw
      // stale `false` and BYPASSED the queue, firing a concurrent turn.
      const turnLive = store.getState().running
      if (turnLive) {
        queueRef.current.push(text)
        store.addInfo(`Queued (${queueRef.current.length}) — runs after this turn`)
        return
      }
      // Track input history
      inputHistory.current.push(text)
      saveInputHistory(text)

      // ── Round 48: `!` bash passthrough (Claude Code parity) ──────────
      // The USER runs a shell command directly — no model, no permission
      // gate (the user IS the authority). Output is folded into the
      // conversation so the model sees it on the next turn.
      if (text.startsWith('!')) {
        const command = text.slice(1).trim()
        if (!command) {
          store.addInfo('Usage: !<command> — runs your shell command directly')
          return
        }
        const bash = engine?.getTools().find((tl) => tl.name === 'Bash')
        if (!engine || !bash) {
          store.addError('Bash tool unavailable in this context')
          return
        }
        store.addUserMessage(`! ${command}`)
        // Serialize against turns: without running=true a concurrent prompt
        // would interleave and clobber historyRef (last writer wins). A
        // rejection here must not escape either — handleSubmit's promise is
        // discarded and unhandledRejection is process-fatal.
        store.setRunning(true)
        store.setSpinner(true, 'Shell')
        try {
          const result = await bash.execute(
            { command },
            {
              cwd,
              permissionMode: 'bypassPermissions',
              sessionDir,
              signal: AbortSignal.timeout(600_000),
            } as unknown as Parameters<typeof bash.execute>[1],
          )
          const output = result.content.length > 4_000
            ? result.content.slice(0, 4_000) + `\n… (${result.content.length - 4_000} more chars)`
            : result.content
          historyRef.current = [
            ...historyRef.current,
            { role: 'user', content: `[!bash] ${command}\n${output}` },
          ]
          store.addToolComplete('Bash', { command }, output, result.isError)
        } catch (err: unknown) {
          const error = err as Error
          store.addError(
            error.name === 'TimeoutError' || error.name === 'AbortError'
              ? `!${command} — timed out (10 min cap)`
              : `!${command} failed: ${error.message}`,
          )
        } finally {
          store.setRunning(false)
          store.setSpinner(false)
        }
        return
      }

      // ── Round 48: `#` memory capture (Claude Code parity) ────────────
      // `#note` appends the line to the project OVOGO.md so it becomes
      // standing context for every future turn — no model call.
      if (text.startsWith('#')) {
        const note = text.slice(1).trim()
        if (!note) {
          store.addInfo('Usage: #<note> — appends the line to OVOGO.md (project memory)')
          return
        }
        const memoryPath = join(cwd, 'OVOGO.md')
        try {
          appendFileSync(memoryPath, `- ${note}\n`, 'utf8')
          store.addSuccess(`Saved to OVOGO.md: ${note.slice(0, 80)}${note.length > 80 ? '…' : ''}`)
        } catch (err: unknown) {
          store.addError(`Failed to write OVOGO.md: ${(err as Error).message}`)
        }
        return
      }

      // Slash command?
      if (text.startsWith('/')) {
        // A throwing command handler must not kill the REPL — this
        // rejection would escape the discarded handleSubmit promise and
        // hit the process-fatal unhandledRejection handler.
        try {
          const handled = await dispatchSlash(text)
          if (handled) return
        } catch (err: unknown) {
          store.addError(`/${text.slice(1).trim().split(/\s+/)[0] || '?'} failed: ${(err as Error).message}`)
          return
        }
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
        if (error.name === 'AbortError') {
          // Round 46b FIX: the user interrupted the turn — queued messages
          // were typed against a timeline that no longer exists. Drain the
          // queue loudly instead of silently auto-running stale intents.
          if (queueRef.current.length > 0) {
            queueRef.current = []
            store.addInfo('已清空排队消息（turn 被中断）')
          }
        } else {
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

      // Round 46 (codex queue): drain queued messages — one at a time so
      // each queued line runs as its own full turn.
      const next = queueRef.current.shift()
      if (next) {
        void handleSubmit(next)
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
  /** Round 46 (codex queue): messages typed while a turn runs. */
  const queueRef = useRef<string[]>([])
  /** Round 44: idle double-ESC exit (mirrors the Ctrl+C double-press). */
  const escCount = useRef(0)

  useEffect(() => {
    if (!state.running) {
      abortCount.current = 0
    }
  }, [state.running])

  useInput((input, key) => {
    // ── Round 48: Shift+Tab permission-mode cycle (Claude Code parity) ──
    // default → acceptEdits → plan → default. Routed through the slash
    // dispatcher so persistence + rules stay in one place.
    if (key.tab && key.shift && !store.hasOverlay()) {
      void dispatchSlash('/permissions cycle')
      return
    }

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
      // HelpOverlay owns ESC while open (dismiss); the idle-ESC quit
      // countdown must not also count that press, or "dismiss, then tap
      // ESC again" within 1.5s quits the app.
      if (!store.hasOverlay() && !showHelp) {
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
    // Round 47 FIX: also require an EMPTY composer — `?` is a printable
    // binding and useInput is broadcast, so typing "what?" popped the
    // help overlay mid-sentence.
    if (action === 'toggle-help' && !state.running && !store.hasOverlay() && store.getState().composerEmpty) {
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
  // Round 47: read the store's incrementally-maintained shards — the old
  // per-emit double filter over the full messages array grew O(history).
  const committedMessages = store.committedView()
  const liveMessages = store.liveView()
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

      {/* Round 47: queued messages stay visible while a turn runs. The
          streaming flush re-renders the app regularly, so the ref list
          refreshes without extra state. */}
      {state.running && queueRef.current.length > 0 ? (
        <Box paddingLeft={3} flexDirection="column">
          {queueRef.current.map((q, i) => (
            <Text key={`${i}-${q.slice(0, 8)}`} color={t.faint} wrap="truncate-end">
              ⤷ queued: {q.length > 60 ? q.slice(0, 57) + '…' : q}
            </Text>
          ))}
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

      {/* Input — stays visible DURING a turn (codex queue behavior):
          submitting while running queues the message for after the turn. */}
      {store.hasOverlay() || showHelp ? null : (
        <Box marginTop={1}>
          <PromptInput
            onSubmit={(text) => { void handleSubmit(text) }}
            disabled={state.running}
            queueHint={state.running ? queueRef.current.length : undefined}
            onInterrupt={handleInterrupt}
            skills={skills}
            history={inputHistory.current}
            cwd={cwd}
            onCopy={handleCopy}
            onComposerEmptyChange={(empty) => store.setComposerEmpty(empty)}
            terminalWidth={terminalWidth}
          />
        </Box>
      )}

      {/* Status bar */}
      <StatusBar
        contextPct={contextPct}
        planMode={state.planMode}
        verbose={state.verbose}
        profile={state.profile}
      />
    </Box>
  )
}
