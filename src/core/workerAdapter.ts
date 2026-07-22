/**
 * WorkerAdapter (GAP-K / fi_goal §三 Phase 5 / five_goal §六 P0-8).
 *
 * Unifies the lifecycle operations across the different worker backings
 * ovolv999 supports:
 *
 *   - ClaudeCodeTool  → tmux session running `claude` CLI
 *   - AgentTool       → in-process child ExecutionEngine
 *   - (future)        → ACP peer, MCP server, remote runtime, ...
 *
 * The host (engine, CLI `/workers steer`, or programmatic caller)
 * obtains a WorkerAdapter reference and calls e.g. `steer(runId, instr)`
 * or `status(runId)` without caring about the backing transport.
 *
 * Lifecycle (five_goal §六):
 *
 *   start()     — launch a new worker for a task; returns a handle
 *   status()    — query current run state (non-terminal preferred source
 *                 of truth, but adapters may fall back to transport)
 *   steer()     — inject a follow-up instruction mid-run
 *   cancel()    — abort a running worker (best-effort)
 *   collect()   — harvest the terminal result + artifacts
 *   reattach()  — reconnect to a worker after a host restart, given
 *                 only the serializable WorkerDescriptor
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
 *   - `reattach()` is OPTIONAL — adapters that do not support cross-
 *     process reconnection (e.g. in-process AgentTool) may omit it or
 *     always return null. Returning null means "this worker cannot be
 *     reattached, treat as lost".
 */

/**
 * Serialisable description of a worker's transport-level identity —
 * enough for a restarted host to call `reattach()` and reconnect.
 *
 * `type` discriminates the transport; the other fields are populated
 * as relevant for that type. Designed to be JSON-round-trippable so
 * it can live in event logs / JSONL recovery stores.
 */
export interface WorkerDescriptor {
  type: 'tmux' | 'process' | 'remote' | 'internal'
  /** tmux session name (type==='tmux'). */
  sessionId?: string
  /** OS process id (type==='process'). */
  pid?: number
  /** Remote host (type==='remote'). */
  host?: string
  /** Free-form per-adapter metadata. */
  metadata?: Record<string, unknown>
}

/**
 * Handle returned by start()/reattach(). Carries the runId (the
 * host-side ExecutionRun identity, stable across adapter
 * implementations) plus the workerKind + descriptor so the host can
 * route subsequent ops without re-resolving.
 */
export interface WorkerHandle {
  runId: string
  workerKind: string
  /** Stable instance id for the underlying worker process/session. */
  workerInstanceId: string
  descriptor: WorkerDescriptor
}

/** Coarse status used by adapters (finer-grained state lives on Run). */
export type WorkerStatus =
  | 'unknown'
  | 'pending'
  | 'running'
  | 'waiting'
  | 'succeeded'
  | 'failed'
  | 'cancelled'
  | 'lost'

/** Generic task payload (adapters may narrow via TTask). */
export interface WorkerTask {
  goal: string
  cwd?: string
  instructions?: string
  timeoutMs?: number
}

/** Generic terminal result (adapters may narrow via TResult). */
export interface WorkerResult {
  runId: string
  status: WorkerStatus
  output?: string
  artifacts?: WorkerArtifact[]
  error?: string
}

/** Reference to an out-of-band artifact (diff, patch, log file). */
export interface WorkerArtifact {
  kind: 'diff' | 'patch' | 'log' | 'stdout' | 'stderr' | 'other'
  path?: string
  content?: string
  contentType?: string
}

/** Acknowledgement that a steer/delivery landed. */
export interface DeliveryAck {
  delivered: boolean
  reason?: 'unknown_run' | 'terminal' | 'transport_error' | 'not_supported'
  message?: string
}

export interface WorkerAdapter<
  TTask extends WorkerTask = WorkerTask,
  TResult extends WorkerResult = WorkerResult,
> {
  /** Human-readable adapter kind (e.g. 'claude-code', 'agent'). */
  readonly workerKind: string

  /**
   * Launch a new worker for the given task. Returns a handle whose
   * `runId` is the canonical id for all subsequent operations on this
   * worker (status/steer/cancel/collect). The worker MAY still be
   * running when start() resolves — adapters that support background
   * dispatch should leave the run non-terminal.
   */
  start(task: TTask, context?: { cwd?: string; signal?: AbortSignal; parentRunId?: string }): Promise<WorkerHandle>

  /**
   * Query the current status of a worker. The adapter SHOULD prefer
   * its own live transport signal (e.g. tmux pane liveness, child
   * process exit code) over the cached ExecutionRunRegistry state,
   * because the registry is best-effort and may not reflect a worker
   * that died between polls.
   */
  status(runId: string): Promise<WorkerStatus>

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

  /**
   * Abort a running worker (best-effort). Adapters SHOULD release
   * transport resources (kill tmux pane, terminate child process)
   * and transition the underlying ExecutionRun to 'cancelled'.
   * `reason` is surfaced to the run's terminal patch.
   */
  cancel(runId: string, reason?: string): Promise<void>

  /**
   * Harvest the terminal result + artifacts from a finished worker.
   * Adapters MAY block until the worker reaches a terminal state, or
   * return immediately with status='running' if the caller is polling.
   * Artifacts (diffs, patches, logs) should be collected eagerly —
   * the transport may disappear once the worker is cancelled.
   */
  collect(runId: string): Promise<TResult>

  /**
   * OPTIONAL: block until the worker reaches a terminal state (or
   * timeout). Returns the terminal WorkerResult — same shape as
   * collect(). Adapters that don't support detached workers can
   * throw 'not supported'.
   */
  wait?(runId: string, opts?: { timeoutMs?: number; signal?: AbortSignal }): Promise<TResult>

  /**
   * OPTIONAL: reconnect to a worker after a host restart, given only
   * the serialisable WorkerDescriptor persisted earlier. Returns null
   * if the worker can no longer be found (tmux pane gone, child
   * process exited, remote host down). Returning null means the host
   * should mark the run as 'lost' (distinct from 'failed').
   */
  reattach?(runId: string, descriptor: WorkerDescriptor): Promise<WorkerHandle | null>
}

/**
 * Callback the host wires in to record steer deliveries on the
 * ExecutionRunEventBus (`run.steered`). Adapters call this on a
 * successful steer so the bus persists + fans out the event.
 */
export type SteerEventEmitter = (runId: string, instruction: string) => void
