/**
 * WorkerAdapter (GAP-K / fi_goal §三 Phase 5).
 *
 * Unifies the "send a follow-up instruction to a running worker"
 * operation across the different worker backings ovolv999 supports:
 *
 *   - ClaudeCodeTool  → tmux session running `claude` CLI
 *   - AgentTool       → in-process child ExecutionEngine
 *   - (future)        → ACP peer, MCP server, remote runtime, ...
 *
 * The host (engine, CLI `/workers steer`, or programmatic caller)
 * obtains a WorkerAdapter reference and calls `steer(runId, instr)`
 * without caring about the backing transport.
 *
 * `run.steered` is the canonical subsystem event (see
 * executionRunEvents.ts) emitted when a steer call lands. Adapters
 * SHOULD call their injected `onSteered` hook so the bus records
 * the event, but the actual instruction delivery is the adapter's
 * own concern.
 *
 * Design notes:
 *   - `steer()` returns true iff the instruction was delivered to a
 *     non-terminal run. False covers "unknown runId" AND "run already
 *     finished" — callers don't need to distinguish.
 *   - Synchronous-await workers (e.g. AgentTool with no background
 *     mode) may return false from steer() if they cannot inject text
 *     mid-turn. The contract is "best-effort delivery", not "guaranteed
 *     application" — even ClaudeCode's tmux send can race a worker
 *     that's about to emit [TASK_DONE].
 *   - Steer MUST NOT block on the worker reacting to the instruction.
 *     It only confirms the delivery channel accepted the bytes.
 */

export interface WorkerAdapter {
  /** Human-readable adapter kind (e.g. 'claude-code', 'agent'). */
  readonly workerKind: string

  /**
   * Send a follow-up instruction to a worker currently running the
   * given ExecutionRun. The instruction is appended to the worker's
   * input stream so it influences subsequent iterations / tool calls
   * without restarting the run.
   *
   * Returns true if the instruction was delivered, false if the
   * runId is unknown to this adapter or the run has already reached
   * a terminal state.
   */
  steer(runId: string, instruction: string): Promise<boolean>
}

/**
 * Callback the host wires in to record steer deliveries on the
 * ExecutionRunEventBus (`run.steered`). Adapters call this on a
 * successful steer so the bus persists + fans out the event.
 */
export type SteerEventEmitter = (runId: string, instruction: string) => void
