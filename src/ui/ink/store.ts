/**
 * UI Store — the bridge between the imperative engine and declarative Ink/React.
 *
 * The engine calls InkRenderer methods (which match the Renderer interface).
 * InkRenderer pushes events into this store. React components subscribe via
 * useSyncExternalStore and re-render on changes.
 *
 * This decouples the engine (which knows nothing about React) from the UI
 * (which knows nothing about the engine's internal flow).
 */

import { useSyncExternalStore } from 'react'

// ── Message model ───────────────────────────────────────────────────────────

export type UIMessage =
  | { id: number; type: 'user'; text: string }
  | { id: number; type: 'assistant'; text: string }
  | {
      id: number
      type: 'tool'
      name: string
      input: Record<string, unknown>
      result?: string
      isError?: boolean
    }
  | { id: number; type: 'info'; text: string }
  | { id: number; type: 'success'; text: string }
  | { id: number; type: 'warn'; text: string }
  | { id: number; type: 'error'; text: string }
  | {
      id: number
      type: 'agent'
      desc: string
      agentType: string
      status: 'running' | 'done' | 'failed'
      summary?: string
    }
  | { id: number; type: 'compact'; phase: 'start' | 'done'; origTokens?: number; sumTokens?: number }
  | { id: number; type: 'context-warning'; tokens: number; max: number; pct: number }

// ── Interactive overlay types (plan approval, permission, select picker) ─────

export interface UIPermissionRequest {
  toolName: string
  preview: string
  riskLevel: 'safe' | 'needs-approval' | 'dangerous'
}

export interface UISelectItem<T = unknown> {
  label: string
  description?: string
  value: T
}

/** Distributive Omit — properly handles the discriminated union. */
export type NewUIMessage = {
  [K in UIMessage['type']]: Omit<Extract<UIMessage, { type: K }>, 'id'>
}[UIMessage['type']]

// ── Full UI state ───────────────────────────────────────────────────────────

export interface UIState {
  messages: UIMessage[]
  /** Currently streaming assistant text (accumulated token by token). */
  streamingText: string
  /** True while engine.runTurn() is in flight. */
  running: boolean
  /** Spinner state. */
  spinnerActive: boolean
  spinnerVerb: string
  /** Banner info (set once at startup). */
  banner: { version: string; model: string } | null
  /** Interrupt overlay (ESC pressed). */
  interrupt: { active: boolean; feedback?: string } | null
  /** Plan mode indicator. */
  planMode: boolean
  /** Pending plan approval (ExitPlanMode tool). */
  pendingPlan: { plan: string } | null
  /** Pending permission request (tool approval). */
  pendingPermission: UIPermissionRequest | null
  /** Pending select picker overlay. */
  selectOverlay: { title: string; items: UISelectItem[] } | null
}

const INITIAL_STATE: UIState = {
  messages: [],
  streamingText: '',
  running: false,
  spinnerActive: false,
  spinnerVerb: '',
  banner: null,
  interrupt: null,
  planMode: false,
  pendingPlan: null,
  pendingPermission: null,
  selectOverlay: null,
}

// ── Store implementation ────────────────────────────────────────────────────

export class UIStore {
  private state: UIState = { ...INITIAL_STATE }
  private listeners = new Set<() => void>()
  private nextId = 1
  // Resolvers for interactive overlays (kept outside state — not serializable)
  private planResolver: ((approved: boolean) => void) | null = null
  private permissionResolver: ((result: { approved: boolean; alwaysAllow: boolean }) => void) | null = null
  private selectResolver: ((value: unknown) => void) | null = null

  getState = (): UIState => this.state

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private emit(): void {
    // Shallow-clone the top-level object so useSyncExternalStore detects change.
    // The `messages` array reference is updated on each mutation (see below).
    this.state = { ...this.state }
    for (const l of this.listeners) l()
  }

  // ── Mutations ─────────────────────────────────────────────────────────────

  private add(msg: NewUIMessage): number {
    const id = this.nextId++
    this.state = {
      ...this.state,
      messages: [...this.state.messages, { ...msg, id }],
    }
    this.emit()
    return id
  }

  private update(id: number, patch: Partial<UIMessage>): void {
    this.state = {
      ...this.state,
      messages: this.state.messages.map((m) =>
        m.id === id ? ({ ...m, ...patch } as UIMessage) : m,
      ),
    }
    this.emit()
  }

  // ── High-level operations ─────────────────────────────────────────────────

  addUserMessage(text: string): void {
    this.add({ type: 'user', text })
  }

  addAssistantMessage(text: string): void {
    this.add({ type: 'assistant', text })
  }

  /** Streaming: accumulate tokens into a temporary buffer. */
  appendStreamingToken(token: string): void {
    this.state.streamingText += token
    this.emit()
  }

  /** Flush accumulated streaming text as a message, then clear the buffer. */
  flushStreamingText(): void {
    const text = this.state.streamingText.trim()
    this.state = { ...this.state, streamingText: '' }
    if (text) this.add({ type: 'assistant', text })
    else this.emit()
  }

  addToolStart(name: string, input: Record<string, unknown>): number {
    return this.add({ type: 'tool', name, input })
  }

  setToolResult(id: number, result: string, isError: boolean): void {
    this.update(id, { result, isError })
  }

  addInfo(text: string): void { this.add({ type: 'info', text }) }
  addSuccess(text: string): void { this.add({ type: 'success', text }) }
  addWarn(text: string): void { if (text.trim()) this.add({ type: 'warn', text }) }
  addError(text: string): void { this.add({ type: 'error', text }) }

  addAgentStart(desc: string, agentType: string): number {
    return this.add({ type: 'agent', desc, agentType, status: 'running' })
  }

  setAgentDone(id: number, ok: boolean, summary?: string): void {
    this.update(id, { status: ok ? 'done' : 'failed', summary })
  }

  addCompactStart(tokens: number): void {
    this.add({ type: 'compact', phase: 'start', origTokens: tokens })
  }

  addCompactDone(orig: number, sum: number): void {
    this.add({ type: 'compact', phase: 'done', origTokens: orig, sumTokens: sum })
  }

  addContextWarning(tokens: number, max: number, pct: number): void {
    this.add({ type: 'context-warning', tokens, max, pct })
  }

  // ── State setters ─────────────────────────────────────────────────────────

  setRunning(running: boolean): void {
    this.state = { ...this.state, running }
    this.emit()
  }

  setSpinner(active: boolean, verb = ''): void {
    this.state = { ...this.state, spinnerActive: active, spinnerVerb: verb }
    this.emit()
  }

  setBanner(version: string, model: string): void {
    this.state = { ...this.state, banner: { version, model } }
    this.emit()
  }

  setInterrupt(active: boolean, feedback?: string): void {
    this.state = { ...this.state, interrupt: active ? { active, feedback } : null }
    this.emit()
  }

  setPlanMode(active: boolean): void {
    this.state = { ...this.state, planMode: active }
    this.emit()
  }

  // ── Interactive overlays (plan approval, permission, select picker) ───────
  // These return Promises that resolve when the user responds via the UI.
  // The resolve functions are stored privately and called by resolveX().

  showPlanApproval(plan: string): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      this.planResolver = resolve
      this.state = { ...this.state, pendingPlan: { plan } }
      this.emit()
    })
  }

  resolvePlan(approved: boolean): void {
    this.planResolver?.(approved)
    this.planResolver = null
    this.state = { ...this.state, pendingPlan: null }
    this.emit()
  }

  showPermissionDialog(request: UIPermissionRequest): Promise<{ approved: boolean; alwaysAllow: boolean }> {
    return new Promise<{ approved: boolean; alwaysAllow: boolean }>((resolve) => {
      this.permissionResolver = resolve
      this.state = { ...this.state, pendingPermission: request }
      this.emit()
    })
  }

  resolvePermission(approved: boolean, alwaysAllow: boolean): void {
    this.permissionResolver?.({ approved, alwaysAllow })
    this.permissionResolver = null
    this.state = { ...this.state, pendingPermission: null }
    this.emit()
  }

  showSelectPicker<T>(title: string, items: UISelectItem<T>[]): Promise<T | null> {
    return new Promise<T | null>((resolve) => {
      this.selectResolver = resolve as (value: unknown) => void
      this.state = { ...this.state, selectOverlay: { title, items } }
      this.emit()
    })
  }

  resolveSelect(value: unknown): void {
    this.selectResolver?.(value)
    this.selectResolver = null
    this.state = { ...this.state, selectOverlay: null }
    this.emit()
  }

  /** True when any interactive overlay is blocking input. */
  hasOverlay(): boolean {
    return this.state.pendingPlan !== null
      || this.state.pendingPermission !== null
      || this.state.selectOverlay !== null
  }

  /** Clear all messages (for /clear). */
  clearMessages(): void {
    this.state = { ...this.state, messages: [] }
    this.emit()
  }

  /** Full reset (for testing). */
  reset(): void {
    this.state = { ...INITIAL_STATE }
    this.nextId = 1
    this.emit()
  }
}

// ── React hook ──────────────────────────────────────────────────────────────

export function useUIStore(store: UIStore): UIState {
  return useSyncExternalStore(store.subscribe, store.getState)
}

// ── Singleton (used by InkRenderer, set during App initialization) ──────────

let _globalStore: UIStore | null = null

export function setGlobalStore(store: UIStore): void {
  _globalStore = store
}

export function getGlobalStore(): UIStore {
  if (!_globalStore) {
    _globalStore = new UIStore()
  }
  return _globalStore
}
