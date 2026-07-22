/**
 * RunEvent — typed internal event protocol for the agent runtime.
 *
 * Design (from replan.md §4):
 *   - Event is an internal runtime protocol, NOT just a log format.
 *   - State transitions are dispatched as typed events.
 *   - EventLog, Renderer, Hooks can subscribe to these events.
 *   - In-process, type-safe, easily traceable — no message bus, no
 *     distributed system, no heavyweight framework.
 *
 * The RunEventEmitter is a simple typed pub/sub dispatcher:
 *   - `on(type, handler)` registers a subscriber
 *   - `emit(event)` calls all subscribers for that event type
 *   - Subscribers are synchronous (fire-and-forget); async side effects
 *     should be kicked off without awaiting
 *
 * The coordinator emits events at every state transition. Existing
 * consumers (EventLog, Renderer) can adapt by subscribing to relevant
 * event types instead of being called ad-hoc.
 */

import type { ToolResult, TurnResult } from '../types.js'

// ── Run Event Types ────────────────────────────────────────────────────────

export type RunEvent =
  | { type: 'RUN_STARTED'; userMessage: string }
  | { type: 'BOOT_COMPLETED'; moduleCount: number; toolCount: number }
  | { type: 'ITERATION_STARTED'; iteration: number }
  | { type: 'MODEL_REQUESTED'; model: string }
  | { type: 'MODEL_COMPLETED'; assistantText: string; finishReason: string | null; toolCallCount: number }
  | { type: 'MODEL_FAILED'; error: string }
  | { type: 'TOOL_BATCH_STARTED'; count: number; parallel: boolean }
  | { type: 'TOOL_STARTED'; callId: string; toolName: string; input: Record<string, unknown> }
  | { type: 'TOOL_COMPLETED'; callId: string; toolName: string; result: ToolResult }
  | { type: 'CONTEXT_COMPACTED'; strategy: string; tokensBefore: number; tokensAfter: number }
  | { type: 'PLAN_MODE_ENTERED' }
  | { type: 'PLAN_MODE_EXITED' }
  | { type: 'ABORT_REQUESTED'; kind: 'soft' | 'hard'; reason: string }
  | { type: 'MAX_ITERATIONS_REACHED'; maxIterations: number }
  | { type: 'RUN_COMPLETED'; result: TurnResult }
  | { type: 'RUN_FAILED'; error: string; output: string }
  | { type: 'MODEL_CHANGED'; from: string; to: string }

export type RunEventType = RunEvent['type']

// ── Event Handler Types ────────────────────────────────────────────────────

export type RunEventHandler<E extends RunEvent = RunEvent> = (event: E) => void

type HandlerMap = {
  [T in RunEventType]: Array<(event: Extract<RunEvent, { type: T }>) => void>
}

// ── RunEventEmitter ────────────────────────────────────────────────────────

export class RunEventEmitter {
  private readonly handlers: Partial<HandlerMap> = {}

  /** Subscribe to a specific event type. Returns an unsubscribe function. */
  on<T extends RunEventType>(
    type: T,
    handler: (event: Extract<RunEvent, { type: T }>) => void,
  ): () => void {
    if (!this.handlers[type]) {
      this.handlers[type] = [] as HandlerMap[T]
    }
    ;(this.handlers[type] as Array<(event: Extract<RunEvent, { type: T }>) => void>).push(handler)
    return () => this.off(type, handler)
  }

  /** Unsubscribe from a specific event type. */
  off<T extends RunEventType>(
    type: T,
    handler: (event: Extract<RunEvent, { type: T }>) => void,
  ): void {
    const list = this.handlers[type]
    if (!list) return
    const idx = (list as Array<(event: unknown) => void>).indexOf(handler as (event: unknown) => void)
    if (idx >= 0) list.splice(idx, 1)
  }

  /** Emit an event to all subscribers of that type. */
  emit(event: RunEvent): void {
    const list = this.handlers[event.type] as Array<(event: RunEvent) => void> | undefined
    if (!list) return
    for (const handler of list) {
      try {
        handler(event)
      } catch {
        // subscriber failures must never break the runtime loop
      }
    }
  }

  /** Remove all subscribers. */
  clear(): void {
    for (const key of Object.keys(this.handlers)) {
      delete this.handlers[key as RunEventType]
    }
  }
}
