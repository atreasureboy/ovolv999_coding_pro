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
  | { type: 'STALL_DETECTED'; kind: string; reason: string; action: string }
  | { type: 'RUN_COMPLETED'; result: TurnResult }
  | { type: 'RUN_FAILED'; error: string; output: string }
  | { type: 'MODEL_CHANGED'; from: string; to: string }
  // v0.3.1 (te_goal §三.1.1 / §八) — explicit routing events so
  // /trace + /why + EventStore can replay them faithfully instead of
  // reconstructing intent from generic MODEL_CHANGED.
  | { type: 'MODEL_OVERRIDE_SET'; modelOrProfile: string }
  | { type: 'MODEL_OVERRIDE_CLEARED' }
  | { type: 'ROUTING_DECIDED'; selectedModel: string; reasonCodes: string[]; estimatedComplexity: number }
  | { type: 'ROUTING_APPLIED'; from: string; to: string; reasonCodes: string[] }
  | { type: 'ROUTING_FALLBACK'; from: string; to: string; error: string }
  | { type: 'BUDGET_ALLOCATION_APPLIED'; allocation: { maxInputTokens?: number; maxOutputTokens?: number } }
  | { type: 'MODEL_CALL_RECORDED'; profileId: string; ok: boolean; latencyMs: number; failureReason?: string }
  // v0.3.1 (te_goal §五 + §六 + §四): TaskGraph + critic + completion
  // events so /trace + EventStore can replay the full decision timeline.
  | { type: 'TASK_GRAPH_CREATED'; runId: string }
  | { type: 'TASK_NODE_ADDED'; nodeId: string; title: string; runId: string }
  | { type: 'TASK_NODE_STARTED'; nodeId: string; runId: string }
  | { type: 'TASK_NODE_VERIFYING'; nodeId: string; runId: string }
  | { type: 'TASK_NODE_COMPLETED'; nodeId: string; satisfied: string[]; runId: string }
  | { type: 'TASK_NODE_FAILED'; nodeId: string; reason: string; runId: string }
  | { type: 'TASK_NODE_BLOCKED'; nodeId: string; reason: string; runId: string }
  | { type: 'PROGRESS_RECORDED'; kind: 'progress' | 'stall' | 'replan' }
  | { type: 'REPLAN_REQUESTED'; reason: string }
  | { type: 'CRITIC_INVOKED'; reason: string; modelClaimingCompletion: boolean }
  | { type: 'CRITIC_COMPLETED'; verdict: string; problems: string[] }
  | { type: 'COMPLETION_EVALUATED'; verdict: { status: string; reasons?: string[]; blockers?: string[]; remaining?: string[]; evidence?: string[] } }
  | { type: 'COMPLETION_REJECTED'; verdict: { status: string; reasons?: string[]; blockers?: string[]; remaining?: string[]; evidence?: string[] } }
  | { type: 'REVIEW_COMPLETED'; verdict: string; findings: string[] }
  // v0.3.2 (ele_goal §Phase 3): TaskIntent classification event
  | { type: 'TASK_INTENT_CLASSIFIED'; runId: string; intent: { kind: 'informational' | 'analysis' | 'mutation'; source: string; confidence: number } }
  // v0.3.2 (ele_goal §Phase 7): per-attempt model call events so the
  // fallback chain emits structured events for each hop.
  | { type: 'MODEL_ATTEMPT_STARTED'; model: string; attemptId: number }
  | { type: 'MODEL_ATTEMPT_FAILED'; model: string; attemptId: number; error: string; retryable: boolean }
  | { type: 'MODEL_ATTEMPT_SUCCEEDED'; model: string; attemptId: number; latencyMs: number; usage?: { inputTokens: number; outputTokens: number } }
  // v0.3.2 (ele_goal §Phase 9): terminal semantic events. The legacy
  // generic RUN_COMPLETED is kept for back-compat; these typed
  // variants are emitted after the CompletionContract evaluates.
  | { type: 'RUN_EXECUTION_STARTED'; runId: string }
  | { type: 'RUN_EXECUTION_STOPPED'; runId: string; stopReason: 'stop_sequence' | 'length' | 'max_iterations' | 'interrupted' | 'error' }
  | { type: 'RUN_STATUS_TRANSITIONED'; runId: string; from: string; to: string; verdict: { status: string; reasons?: string[]; blockers?: string[]; remaining?: string[]; evidence?: string[] } }

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
