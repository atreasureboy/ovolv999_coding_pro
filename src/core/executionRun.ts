/**
 * ExecutionRun — unified run state machine (fi_goal.md §三 Phase 2).
 *
 * Goal: every unit of work the runtime dispatches on behalf of a user
 * (a model turn, a sub-agent, a Claude Code worker task, a background
 * shell, a workflow, a loop) is tracked as ONE ExecutionRun with a
 * uniform state machine. UI, logs, cancel, resume, acceptance and
 * state queries all go through ExecutionRun instead of each module
 * rolling its own ad-hoc status fields.
 *
 * Round 2 scope (per §十二 work-pace):
 *   - Types + state machine + in-memory registry only.
 *   - Integrated with AgentTool only.
 *   - NO event persistence yet (Round 5).
 *   - NO BackgroundTask / Workflow / Claude integration yet (Rounds 3-4).
 *   - NO resource scheduling yet (Round 7).
 *
 * State machine:
 *
 *   queued
 *   → preparing
 *   → running
 *   → waiting
 *   → verifying
 *   → succeeded
 *
 * Any non-terminal state may transition to one of:
 *
 *   failed | cancelled | timed_out | blocked | verification_failed
 *
 * `blocked` is the only non-terminal recovery state — it can resume
 * back to `running`, or terminate via cancelled/failed. All other
 * states listed above are terminal.
 */

import { randomUUID } from 'crypto'

// ── Status ─────────────────────────────────────────────────────────────────

export type RunStatus =
  | 'queued'
  | 'preparing'
  | 'running'
  | 'waiting'
  | 'verifying'
  | 'succeeded'
  | 'failed'
  | 'cancelled'
  | 'timed_out'
  | 'blocked'
  | 'verification_failed'
  | 'lost'

/**
 * States from which no further transition is possible. The registry
 * rejects any attempt to transition out of a terminal state.
 */
export const TERMINAL_RUN_STATES: ReadonlySet<RunStatus> = new Set([
  'succeeded',
  'failed',
  'cancelled',
  'timed_out',
  'verification_failed',
  'lost',
])

export function isTerminalRunStatus(status: RunStatus): boolean {
  return TERMINAL_RUN_STATES.has(status)
}

/**
 * Valid forward transitions. The registry enforces this map — any
 * transition not listed throws InvalidRunTransition so callers can't
 * (e.g.) silently flip a `succeeded` run back to `running`.
 *
 * `blocked` is intentionally listed as a resume source for `running`
 * so a long-running task that got stuck on a resource can wake up
 * without going through `preparing` again.
 */
const VALID_TRANSITIONS: Record<RunStatus, readonly RunStatus[]> = {
  queued:      ['preparing', 'cancelled', 'failed', 'lost'],
  preparing:   ['running', 'cancelled', 'failed', 'blocked', 'lost'],
  running:     ['waiting', 'verifying', 'succeeded', 'failed', 'cancelled', 'timed_out', 'blocked', 'lost'],
  waiting:     ['running', 'verifying', 'cancelled', 'failed', 'timed_out', 'lost'],
  verifying:   ['succeeded', 'verification_failed', 'failed', 'cancelled', 'lost'],
  blocked:     ['running', 'cancelled', 'failed', 'lost'],
  // Terminals — intentionally empty.
  succeeded:           [],
  failed:              [],
  cancelled:           [],
  timed_out:           [],
  verification_failed: [],
  lost:                [],
}

export class InvalidRunTransition extends Error {
  constructor(
    public readonly runId: string,
    public readonly from: RunStatus,
    public readonly to: RunStatus,
  ) {
    super(`Invalid run transition: ${runId} ${from} → ${to}`)
    this.name = 'InvalidRunTransition'
  }
}

export class RunNotFound extends Error {
  constructor(public readonly runId: string) {
    super(`ExecutionRun not found: ${runId}`)
    this.name = 'RunNotFound'
  }
}

/** Return true iff `from → to` is permitted by the state machine. */
export function canTransition(from: RunStatus, to: RunStatus): boolean {
  if (from === to) return true // idempotent self-transition is allowed
  return VALID_TRANSITIONS[from].includes(to)
}

// ── Run shape ──────────────────────────────────────────────────────────────

export type RunKind =
  | 'turn'
  | 'agent'
  | 'external_worker'
  | 'shell_task'
  | 'workflow'
  | 'loop'

export interface WorkspaceRef {
  /** Absolute path of the workspace the run operates in. */
  cwd: string
  /** Set when the run is isolated inside a git worktree. */
  worktreePath?: string
  /** Branch name when the run operates on a dedicated branch. */
  branch?: string
}

export interface AcceptanceRule {
  /** Human-readable description of what this rule checks. */
  description: string
  /** Shell command that exits 0 on pass, non-zero on fail. */
  command?: string
  /** When false, the rule is informational only (default true). */
  required?: boolean
}

export interface RunBudget {
  /** Wall-clock cap in milliseconds. Exceeding transitions to timed_out. */
  maxDurationMs?: number
  /** Tool-call iteration cap. Exceeding transitions to failed. */
  maxIterations?: number
  /** Token-budget cap (prompt + completion). Exceeding transitions to failed. */
  maxTokens?: number
}

/**
 * Phase 4 forward-compat placeholder. The scheduler isn't built yet
 * (Round 7) but ExecutionRun carries the field so future migrations
 * don't have to reshape the interface. An empty array means "no
 * resource claims declared yet".
 */
export interface ResourceClaim {
  type: 'file' | 'directory' | 'git' | 'port' | 'process' | 'network'
  key: string
  access: 'read' | 'write' | 'exclusive'
}

export interface ArtifactRef {
  id: string
  kind: string // 'log' | 'diff' | 'test_report' | 'patch' | ...
  path?: string
  contentType?: string
  sizeBytes?: number
}

export interface VerificationResult {
  passed: boolean
  commands: Array<{
    command: string
    passed: boolean
    exitCode?: number
    output?: string
  }>
  startedAt: string
  completedAt: string
}

export interface ExecutionRun {
  runId: string
  parentRunId?: string
  kind: RunKind
  goal: string
  status: RunStatus
  /**
   * Free-form phase label inside the current status — e.g. while
   * `status === 'running'`, phase might be `'child_turn'` or
   * `'verify_commands_pending'`. Useful for UI without spawning
   * extra statuses.
   */
  phase: string
  worker?: string
  workspace: WorkspaceRef
  acceptance: AcceptanceRule[]
  budget: RunBudget
  resources: ResourceClaim[]
  artifacts: ArtifactRef[]
  verification?: VerificationResult
  /**
   * Terminal-state error message. Set when transitioning to `failed`,
   * `verification_failed`, or `timed_out`. Empty/undefined on success.
   */
  error?: string
  createdAt: string
  updatedAt: string
}

// ── Registry ───────────────────────────────────────────────────────────────

/**
 * Input shape for create(): everything required by ExecutionRun EXCEPT
 * the fields the registry owns (runId, timestamps, initial status and
 * phase). Callers may override status/phase to skip the default
 * `queued`/`'created'` start if they need to enter the machine
 * mid-flow (useful for resuming a persisted run — Round 5).
 *
 * Fields the registry can default (acceptance, budget, resources,
 * artifacts, worker, verification, error) are marked optional so
 * callers don't have to supply empty collections.
 */
export type CreateRunInput =
  Omit<
    ExecutionRun,
    | 'runId' | 'createdAt' | 'updatedAt' | 'status' | 'phase'
    | 'acceptance' | 'budget' | 'resources' | 'artifacts'
    | 'worker' | 'verification' | 'error' | 'parentRunId'
  >
  & Partial<Pick<
    ExecutionRun,
    | 'status' | 'phase' | 'acceptance' | 'budget' | 'resources'
    | 'artifacts' | 'worker' | 'verification' | 'error' | 'parentRunId'
    | 'createdAt' | 'updatedAt'
  >>
  // Optional runId is only used by crash-recovery replay — callers
  // normally leave this unset and let the registry mint a fresh UUID.
  & { runId?: string }

/**
 * Internal shape emitted to an optional EventBus (Phase 3). The
 * registry itself doesn't import the event module — it just calls
 * `onEmit?.(raw)` on every create/transition/update. The bus (in
 * executionRunEvents.ts) decorates this into a typed envelope,
 * persists, and fans out. Setting `onEmit = undefined` silences
 * emission (used during crash-recovery replay).
 */
export type RegistryEmitHook = (raw: {
  kind: 'create' | 'transition' | 'update'
  run: ExecutionRun
  from?: RunStatus
  to?: RunStatus
}) => void

/**
 * In-memory ExecutionRun registry. Round 5 will add a persistent
 * JSONL/SQLite backing store; for now the registry is process-local
 * and resets on restart.
 *
 * The registry is the SOLE authority over runId assignment and
 * transition validation — external code must never mutate an
 * ExecutionRun object's status field directly. (The objects are
 * frozen on return to enforce this at runtime; structural updates go
 * through `update()` / `transition()`.)
 *
 * Round 5: an optional `onEmit` hook lets an ExecutionRunEventBus
 * observe every create/transition/update without the registry knowing
 * about JSONL or subscribers. The hook is set externally by the bus.
 */
export class ExecutionRunRegistry {
  private readonly runs = new Map<string, ExecutionRun>()
  /**
   * Event hook (Phase 3). Set by ExecutionRunEventBus to receive
   * every create/transition/update. Undefined = silent (recovery
   * replay uses this to avoid re-emitting historical events).
   */
  onEmit?: RegistryEmitHook

  /** Create and register a new run. Initial status defaults to `queued`. */
  create(input: CreateRunInput): ExecutionRun {
    const now = new Date().toISOString()
    const runId = input.runId ?? randomUUID()
    if (this.runs.has(runId)) {
      throw new Error(`ExecutionRun already exists: ${runId}`)
    }
    const run: ExecutionRun = {
      runId,
      parentRunId: input.parentRunId,
      kind: input.kind,
      goal: input.goal,
      status: input.status ?? 'queued',
      phase: input.phase ?? 'created',
      worker: input.worker,
      workspace: input.workspace,
      acceptance: input.acceptance ?? [],
      budget: input.budget ?? {},
      resources: input.resources ?? [],
      artifacts: input.artifacts ?? [],
      verification: input.verification,
      error: input.error,
      createdAt: input.createdAt ?? now,
      updatedAt: input.updatedAt ?? now,
    }
    this.runs.set(runId, run)
    const frozen = this.freeze(run)
    this.onEmit?.({ kind: 'create', run: frozen })
    return frozen
  }

  /** Get a run by id. Returns undefined when not found. */
  get(runId: string): ExecutionRun | undefined {
    const run = this.runs.get(runId)
    return run ? this.freeze(run) : undefined
  }

  /** Get a run by id or throw RunNotFound. */
  require(runId: string): ExecutionRun {
    const run = this.runs.get(runId)
    if (!run) throw new RunNotFound(runId)
    return this.freeze(run)
  }

  /** List runs, optionally filtered. */
  list(filter?: {
    status?: RunStatus
    kind?: RunKind
    parentRunId?: string
  }): ExecutionRun[] {
    let out = [...this.runs.values()]
    if (filter?.status) out = out.filter((r) => r.status === filter.status)
    if (filter?.kind) out = out.filter((r) => r.kind === filter.kind)
    if (filter?.parentRunId) out = out.filter((r) => r.parentRunId === filter.parentRunId)
    return out.map((r) => this.freeze(r))
  }

  /**
   * Transition a run to a new status. Throws InvalidRunTransition if
   * the move isn't in VALID_TRANSITIONS. Optional patch fields may be
   * supplied to update phase/error/etc atomically with the transition.
   */
  transition(
    runId: string,
    to: RunStatus,
    patch?: Partial<Pick<ExecutionRun, 'phase' | 'error' | 'verification' | 'worker' | 'workspace' | 'artifacts'>>,
  ): ExecutionRun {
    const run = this.runs.get(runId)
    if (!run) throw new RunNotFound(runId)
    if (!canTransition(run.status, to)) {
      throw new InvalidRunTransition(runId, run.status, to)
    }
    const from = run.status
    const updated: ExecutionRun = {
      ...run,
      ...patch,
      status: to,
      updatedAt: new Date().toISOString(),
    }
    this.runs.set(runId, updated)
    const frozen = this.freeze(updated)
    this.onEmit?.({ kind: 'transition', run: frozen, from, to })
    return frozen
  }

  /**
   * Patch a run's mutable fields WITHOUT changing status. Useful for
   * accumulating artifacts or updating the phase label inside a
   * long-running state. Cannot patch status — use transition() for
   * that. Cannot patch runId/createdAt.
   */
  update(
    runId: string,
    patch: Partial<Omit<ExecutionRun, 'runId' | 'createdAt' | 'status'>>,
  ): ExecutionRun {
    const run = this.runs.get(runId)
    if (!run) throw new RunNotFound(runId)
    const updated: ExecutionRun = {
      ...run,
      ...patch,
      updatedAt: new Date().toISOString(),
    }
    this.runs.set(runId, updated)
    const frozen = this.freeze(updated)
    this.onEmit?.({ kind: 'update', run: frozen })
    return frozen
  }

  /** Remove a run from the registry (administrative/test use only). */
  delete(runId: string): boolean {
    return this.runs.delete(runId)
  }

  /** Current count of runs in the registry (any status). */
  size(): number {
    return this.runs.size
  }

  // ── Internal ──────────────────────────────────────────────────────────────

  /**
   * Return a frozen shallow copy so callers cannot mutate the
   * registry's internal state by holding a reference. Use update() /
   * transition() to change fields. (Shallow freeze — nested arrays
   * like `artifacts` are still referentially shared; this is fine
   * because the contract is "treat as read-only, replace via update".)
   */
  private freeze<T extends ExecutionRun>(run: T): ExecutionRun {
    return Object.freeze({ ...run })
  }
}
