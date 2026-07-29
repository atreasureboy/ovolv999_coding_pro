/**
 * InkRenderer — drop-in replacement for Renderer that pushes events into a
 * UIStore instead of writing ANSI codes to stdout.
 *
 * The engine and modules call renderer methods (banner, streamToken, toolStart,
 * etc.). With Ink, these calls become React state updates that trigger
 * re-renders of the component tree.
 *
 * The method signatures match Renderer exactly so this can be swapped in
 * without touching the engine. Methods that are purely visual (writePrompt,
 * writeInterruptPrompt) are no-ops — Ink components handle their own layout.
 */

import type { UIStore } from './store.js'

const VERBS = [
  'Thinking', 'Analyzing', 'Processing', 'Computing',
  'Reasoning', 'Working', 'Exploring', 'Building',
  'Searching', 'Drafting',
]

export class InkRenderer {
  private store: UIStore

  constructor(store: UIStore) {
    this.store = store
  }

  // ── Banner ────────────────────────────────────────────────────────────────

  banner(version: string, model: string): void {
    this.store.setBanner(version, model)
  }

  // ── User message ──────────────────────────────────────────────────────────

  humanPrompt(_text: string): void {
    // The App component adds user messages on submit, so this is a no-op.
    // Kept for interface compatibility with modules that might call it.
  }

  // ── LLM streaming ─────────────────────────────────────────────────────────

  beginAssistantText(): void {
    // No explicit action — streaming tokens are accumulated via appendStreamingToken
  }

  streamToken(token: string): void {
    this.store.appendStreamingToken(token)
  }

  streamReasoning(token: string): void {
    this.store.appendStreamingReasoning(token)
  }

  endAssistantText(): void {
    this.store.flushStreamingText()
  }

  // ── Tool calls ────────────────────────────────────────────────────────────

  toolStart(name: string, input: Record<string, unknown>, callId?: string): void {
    this.store.addToolStart(name, input, callId)
  }

  toolResult(_name: string, result: string, isError: boolean, callId?: string): void {
    // v0.4.1 C1 (callId truth): NEVER `callId ?? name` — matching the tool
    // NAME against the callId field hit nothing real and slid into the
    // store's position guess. No callId → visible orphan row instead.
    this.store.setToolResult(callId, result, isError)
  }

  // ── Spinner ───────────────────────────────────────────────────────────────

  startSpinner(verb?: string): void {
    const v = verb || VERBS[Math.floor(Math.random() * VERBS.length)]
    this.store.setSpinner(true, v)
  }

  stopSpinner(): void {
    this.store.setSpinner(false)
  }

  // ── Status messages ───────────────────────────────────────────────────────

  info(msg: string): void {
    this.store.addInfo(msg)
  }

  success(msg: string): void {
    this.store.addSuccess(msg)
  }

  error(msg: string): void {
    this.store.addError(msg)
  }

  warn(msg: string): void {
    this.store.addWarn(msg)
  }

  // ── Sub-agent ─────────────────────────────────────────────────────────────

  agentStart(desc: string, type = 'general-purpose', runId?: string): void {
    this.store.addAgentStart(desc, type, runId)
  }

  agentDone(_desc: string, ok: boolean, runId?: string): void {
    // v0.4.1 C1: no `runId ?? desc` — a desc matched against the runId
    // field is a guess. No runId → the store renders a visible orphan.
    this.store.setAgentDone(runId, ok, undefined, runId)
  }

  agentSummary(_type: string, _desc: string, summary: string): void {
    const msgs = this.store.getState().messages
    for (let i = msgs.length - 1; i >= 0; i--) {
      const m = msgs[i]
      if (m.type === 'agent' && (m.status === 'done' || m.status === 'failed')) {
        this.store.setAgentDone(m.id, m.status === 'done', summary)
        return
      }
    }
  }

  agentHeartbeat(_type: string, _desc: string, _sec: number): void {
    // Heartbeats are handled by the Spinner component's timer — no action needed.
  }

  // ── Context / compact ─────────────────────────────────────────────────────

  compactStart(tokens: number): void {
    this.store.addCompactStart(tokens)
  }

  compactDone(orig: number, sum: number): void {
    this.store.addCompactDone(orig, sum)
  }

  contextWarning(tokens: number, max: number, pct: number): void {
    this.store.addContextWarning(tokens, max, pct)
  }

  // ── Plan mode ─────────────────────────────────────────────────────────────

  planModeStart(): void {
    this.store.setPlanMode(true)
  }

  planConfirmPrompt(): void {
    // Handled by the PermissionDialog / plan approval component in Ink
  }

  // ── Interrupt ─────────────────────────────────────────────────────────────

  writeInterruptPrompt(): void {
    this.store.setInterrupt(true)
  }

  interruptInjected(msg: string): void {
    this.store.setInterrupt(true, msg)
  }

  // ── No-ops (Ink components handle their own layout) ───────────────────────

  writePrompt(): void { /* Ink PromptInput renders its own prompt */ }
  newline(): void { /* Ink Box handles spacing */ }

  // ── Lifecycle ─────────────────────────────────────────────────────────────

  destroy(): void {
    this.store.setSpinner(false)
  }
}
