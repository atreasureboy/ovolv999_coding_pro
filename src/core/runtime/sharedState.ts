/**
 * SharedRuntimeState — cross-turn mutable state that both the Engine
 * (public API surface) and RuntimeCoordinator (loop driver) read/write.
 *
 * This object is the bridge between the Engine facade and the Coordinator.
 * The Engine holds a reference for its public methods (abort, softAbort,
 * isPlanMode), and passes the SAME reference to the Coordinator so the
 * loop can set/clear the current turn's AbortController and check
 * soft-abort ownership.
 *
 * State ownership:
 * - planModeActive: set at construction, mutated by ExitPlanMode/EnterPlanMode
 *   tools, read as a per-turn snapshot by the Coordinator
 * - currentTurnAbortController: set during runTurn setup, cleared in finally
 * - softAbortRequested/Owner: set by softAbort(), claimed/cleared by
 *   the Coordinator's check_abort handler
 * - activeToolCalls: Map of callId → ActiveToolCall, maintained by
 *   ToolScheduler during tool execution, visible for debugging/introspection
 * - activeSubtasks: Map of subtask ID → ActiveSubtask, maintained by
 *   AgentTool when spawning sub-agents
 */

import type { Tool } from '../types.js'
import type { ModelCapabilities } from '../modelCapabilities.js'

export interface ActiveToolCall {
  callId: string
  toolName: string
  startedAt: number
}

export interface ActiveSubtask {
  subtaskId: string
  description: string
  startedAt: number
}

/**
 * P2-4 (five_goal §十三): shared, observable model state.
 * All components read from this single source of truth instead of
 * holding private copies. Updates bump `version` so subscribers can
 * detect changes.
 */
export interface RuntimeModelState {
  model: string
  provider?: string
  capabilities?: ModelCapabilities
  contextWindow?: number
  maxOutput?: number
  version: number
}

type ModelStateListener = (state: RuntimeModelState) => void

export class SharedRuntimeState {
  planModeActive: boolean
  currentTurnAbortController: AbortController | null = null
  softAbortRequested = false
  softAbortOwner: AbortController | null = null

  /**
   * P2-9: claim a pending soft-abort for the given turn's controller.
   * Single canonical implementation (previously duplicated on Engine
   * and RuntimeCoordinator). Returns true iff a soft-abort was
   * requested AND this controller owns it (no owner, or owner is it),
   * clearing the request on a successful claim so it fires once.
   */
  claimSoftAbort(turnAbortController: AbortController): boolean {
    if (!this.softAbortRequested) return false
    if (this.softAbortOwner !== null && this.softAbortOwner !== turnAbortController) {
      return false
    }
    this.softAbortRequested = false
    this.softAbortOwner = null
    return true
  }

  allTools: Tool[] = []
  readonly activeToolCalls = new Map<string, ActiveToolCall>()
  readonly activeSubtasks = new Map<string, ActiveSubtask>()

  /** P2-4: canonical model state. Components subscribe via onModelStateChanged. */
  modelState: RuntimeModelState
  private readonly modelStateListeners = new Set<ModelStateListener>()

  constructor(planModeActive: boolean, model = 'unknown') {
    this.planModeActive = planModeActive
    this.modelState = { model, version: 0 }
  }

  /**
   * Update the model state and notify all subscribers. Bumps version.
   * Callers should pass the partial fields that changed.
   */
  updateModelState(patch: Partial<Omit<RuntimeModelState, 'version'>>): void {
    this.modelState = {
      ...this.modelState,
      ...patch,
      version: this.modelState.version + 1,
    }
    for (const listener of this.modelStateListeners) {
      try { listener(this.modelState) } catch { /* best-effort */ }
    }
  }

  /** Subscribe to model state changes. Returns an unsubscribe function. */
  onModelStateChanged(listener: ModelStateListener): () => void {
    this.modelStateListeners.add(listener)
    return () => { this.modelStateListeners.delete(listener) }
  }
}
