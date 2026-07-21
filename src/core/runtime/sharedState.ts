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
 * - allTools: base + module tools, rebuilt each turn during boot
 */

import type { Tool } from '../types.js'

export class SharedRuntimeState {
  planModeActive: boolean
  currentTurnAbortController: AbortController | null = null
  softAbortRequested = false
  softAbortOwner: AbortController | null = null
  allTools: Tool[] = []

  constructor(planModeActive: boolean) {
    this.planModeActive = planModeActive
  }
}
