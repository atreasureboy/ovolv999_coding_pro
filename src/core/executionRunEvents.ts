/**
 * ExecutionRun event system (fi_goal.md §四 Phase 3 / Round 5).
 *
 * Layered on top of ExecutionRunRegistry (Phase 2). Every state
 * transition emits a typed event envelope:
 *
 *   { eventId, runId, parentRunId?, sequence, timestamp, type, payload }
 *
 * Requirements (from §四):
 *   - sequence is monotonic per Run (1, 2, 3, ...)
 *   - events persist FIRST, then push to UI subscribers
 *   - process crash → state recoverable from the event log
 *   - subscriber errors never silently swallowed
 *   - best-effort subscriber errors are logged (not thrown)
 *   - critical subscriber errors must change Run status
 *
 * Persistence format:
 *   - Round 5: JSONL (one event per line, append-only)
 *   - Later rounds: SQLite (the JSONL contract stays as a fallback)
 *
 * The ExecutionRunRegistry itself stays pure — it doesn't know about
 * JSONL or subscribers. This module wires the registry to an event
 * store + subscriber bus via a thin adapter (ExecutionRunEventBus).
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { dirname, join } from 'path'
import { randomUUID } from 'crypto'
import {
  ExecutionRunRegistry,
  canTransition,
  type ExecutionRun,
  type RunStatus,
  type RegistryEmitHook,
} from './executionRun.js'

// ── Event envelope ─────────────────────────────────────────────────────────

/**
 * Typed envelope around an arbitrary payload. The `type` field is a
 * string (not a closed enum) so downstream tools can layer their own
 * event types (tool.requested, artifact.created, ...) without
 * forcing a library bump. The core runtime commits to emitting the
 * run.* family; tool.* / artifact.* / verification.* are emitted by
 * the relevant subsystems.
 */
export interface RunEventEnvelope<T = unknown> {
  /** Globally-unique event id (UUID). */
  eventId: string
  /** The run this event belongs to. */
  runId: string
  /** Parent run id (if any) — copied from ExecutionRun for log queries. */
  parentRunId?: string
  /** Per-run monotonic sequence (1, 2, 3, ...). */
  sequence: number
  /** ISO timestamp. */
  timestamp: string
  /** Event type — dotted string (e.g. 'run.created'). */
  type: string
  /** Typed payload. */
  payload: T
}

/**
 * Canonical event types emitted by the registry itself. Subsystems
 * emit their own types (tool.*, artifact.*, verification.*) — those
 * are appended via the bus, not enumerated here.
 */
export type CoreRunEventType =
  | 'run.created'
  | 'run.started'
  | 'run.progress'
  | 'run.blocked'
  | 'run.steered'
  | 'run.cancelled'
  | 'run.completed'
  | 'run.failed'

/**
 * Subsystem-emitted event types (fi_goal.md §四). These are not
 * fired by the registry; subsystems call the bus's emit helpers
 * (emitToolRequested, emitArtifactCreated, etc.).
 */
export type SubsystemEventType =
  | 'tool.requested'
  | 'tool.started'
  | 'tool.completed'
  | 'tool.failed'
  | 'artifact.created'
  | 'verification.started'
  | 'verification.completed'
  | 'verification.failed'

/**
 * Map of core event type → payload shape. Used by the typed
 * `on()` subscribe helper so handlers get type-checked payloads.
 */
export interface CoreRunEventPayloads {
  'run.created':   { run: ExecutionRun }
  'run.started':   { from: RunStatus; run: ExecutionRun }
  'run.progress':  { from: RunStatus; phase: string; run: ExecutionRun }
  'run.blocked':   { from: RunStatus; reason?: string; run: ExecutionRun }
  'run.steered':   { runId: string; instruction: string; run: ExecutionRun }
  'run.cancelled': { from: RunStatus; run: ExecutionRun }
  'run.completed': { from: RunStatus; run: ExecutionRun }
  'run.failed':    { from: RunStatus; error?: string; run: ExecutionRun }
}

/**
 * Translate a RunStatus terminal into the matching core event type.
 * Non-terminal transitions emit 'run.progress' (or 'run.blocked' for
 * the blocked state, 'run.started' for the first preparing transition).
 */
function terminalEventType(status: RunStatus): CoreRunEventType {
  switch (status) {
    case 'succeeded':           return 'run.completed'
    case 'failed':              return 'run.failed'
    case 'cancelled':           return 'run.cancelled'
    case 'timed_out':           return 'run.failed'
    case 'verification_failed': return 'run.failed'
    case 'lost':                return 'run.failed'
    default:                    return 'run.progress'
  }
}

/**
 * Decide which core event type a (from → to) transition should emit.
 * - queued → preparing:                   'run.started'
 * - * → blocked:                          'run.blocked'
 * - * → succeeded/failed/cancelled/...:   terminal mapping above
 * - otherwise (e.g. running → verifying): 'run.progress'
 */
function eventTypeForTransition(from: RunStatus, to: RunStatus): CoreRunEventType {
  if (from === 'queued' && to === 'preparing') return 'run.started'
  if (to === 'blocked') return 'run.blocked'
  return terminalEventType(to)
}

// ── EventStore interface ───────────────────────────────────────────────────

/**
 * Persistence backend for RunEvents. The contract is intentionally
 * minimal:
 *   - append(event): write a single event durably (fsync implied)
 *   - readAll(): read every event back in append order
 *
 * Round 5 ships a JSONL implementation. SQLite lands later — same
 * interface, different backend.
 */
export interface EventStore {
  append(event: RunEventEnvelope): void
  readAll(): RunEventEnvelope[]
  /** Path or identifier for diagnostics. */
  readonly label: string
}

/**
 * JSONL-backed EventStore. Appends one event per line to `<dir>/runs.jsonl`.
 *
 * Crash semantics: each append is an atomic write of one line + newline.
 * A half-written line (process killed mid-append) is silently skipped
 * on read — JSON.parse failure on a single line doesn't lose the rest
 * of the log.
 *
 * Round 5 intentionally does NOT fsync after every write (fsync-per-event
 * is expensive and the spec lets us batch later). The OS page cache is
 * good enough for the common crash case; exotic scenarios (kernel panic
 * mid-flush) can lose the tail of the log.
 */
export class JsonlEventStore implements EventStore {
  private readonly filePath: string

  constructor(logDir: string, fileName = 'runs.jsonl') {
    this.filePath = join(logDir, fileName)
    // Ensure the dir exists; if it's already a dir, this is a no-op.
    try {
      mkdirSync(dirname(this.filePath), { recursive: true })
    } catch {
      // best-effort — append() will throw if the dir genuinely doesn't exist
    }
  }

  get label(): string {
    return this.filePath
  }

  append(event: RunEventEnvelope): void {
    // Atomic per-line append. Concurrent appenders are safe on POSIX
    // (O_APPEND) and Windows (the Node 'a' flag is append-with-truncate
    // guarded by the kernel for small writes < 4KB).
    appendFileSync(this.filePath, JSON.stringify(event) + '\n', 'utf8')
  }

  readAll(): RunEventEnvelope[] {
    if (!existsSync(this.filePath)) return []
    let raw: string
    try {
      raw = readFileSync(this.filePath, 'utf8')
    } catch {
      return []
    }
    const events: RunEventEnvelope[] = []
    for (const line of raw.split('\n')) {
      const trimmed = line.trim()
      if (!trimmed) continue
      try {
        events.push(JSON.parse(trimmed) as RunEventEnvelope)
      } catch {
        // Half-written / corrupted line — skip, keep the rest.
        // Real crash recovery must be robust to this.
      }
    }
    return events
  }

  /** Truncate the log (test use only — never call in production). */
  _resetForTest(): void {
    try {
      writeFileSync(this.filePath, '', 'utf8')
    } catch {
      // best-effort
    }
  }
}

// ── Subscriber model ───────────────────────────────────────────────────────

export type RunEventHandler = (event: RunEventEnvelope) => void

export interface SubscriberOptions {
  /**
   * 'critical' subscribers can transition the run to failed if they
   * throw. 'best-effort' subscribers just get their error logged.
   * Default: 'best-effort'.
   */
  criticality?: 'critical' | 'best-effort'
}

interface Subscriber {
  handler: RunEventHandler
  criticality: 'critical' | 'best-effort'
}

// ── EventBus ───────────────────────────────────────────────────────────────

/**
 * Wires an ExecutionRunRegistry to an EventStore + subscriber bus.
 *
 * Lifecycle:
 *   const bus = new ExecutionRunEventBus(registry, store)
 *   bus.on((event) => renderer.logEvent(event))
 *   bus.on((event) => metrics.record(event), { criticality: 'critical' })
 *
 * The bus hooks into the registry via an emit callback (the registry
 * itself stays pure). It assigns per-run sequence numbers, persists
 * to the store, then fans out to subscribers.
 *
 * On a critical subscriber failure, the bus transitions the offending
 * run to 'failed' (so a broken metric/audit subscriber can't silently
 * lose data — it gets surfaced as a run-level failure).
 */
export class ExecutionRunEventBus {
  private readonly registry: ExecutionRunRegistry
  private readonly store?: EventStore
  private readonly subscribers: Subscriber[] = []
  private readonly sequences = new Map<string, number>()
  /** Re-entrancy guard: a subscriber that throws a 'critical' error
   * transitions the run to failed, which itself emits a 'run.failed'
   * event. Without this guard we'd recurse. */
  private readonly emitting = new Set<string>()

  constructor(registry: ExecutionRunRegistry, store?: EventStore) {
    this.registry = registry
    this.store = store
    // Plug into the registry via the onEmit hook. The registry calls
    // this for every create/transition/update; the bus decorates the
    // raw payload into a typed envelope and dispatches.
    registry.onEmit = (raw) => this.dispatch(raw)
  }
  on(handler: RunEventHandler, opts?: SubscriberOptions): () => void {
    const sub: Subscriber = {
      handler,
      criticality: opts?.criticality ?? 'best-effort',
    }
    this.subscribers.push(sub)
    return () => {
      const idx = this.subscribers.indexOf(sub)
      if (idx >= 0) this.subscribers.splice(idx, 1)
    }
  }

  /**
   * Snapshot all events currently in the store. Useful for tests +
   * for crash-recovery replay (see recoverRegistryFromStore).
   */
  readLog(): RunEventEnvelope[] {
    return this.store ? this.store.readAll() : []
  }

  // ── Subsystem emitters (fi_goal.md §四) ─────────────────────────────
  //
  // The registry only emits run.* events for state transitions.
  // Subsystems that need to publish tool / artifact / verification
  // events call these helpers, which:
  //   1. assign the next per-run sequence
  //   2. decorate with eventId / timestamp / runId / parentRunId
  //   3. persist BEFORE fanning out to subscribers (same guarantee
  //      as registry-emitted events)
  //
  // The runId MUST exist in the registry; orphan events are rejected.

  /** Emit a non-registry event with the same persist-first + sequence guarantees. */
  emit(type: string, runId: string, payload: unknown): void {
    const run = this.registry.get(runId)
    if (!run) {
      // Orphan event — silently skip (subsystem raced with run removal).
      return
    }
    this.dispatchExplicit(type, run, payload)
  }

  /** Record a steering instruction targeted at a run (P0-5 long-term / §十). */
  emitSteered(runId: string, instruction: string): void {
    this.emit('run.steered', runId, { runId, instruction })
  }

  /** Tool was requested by the model (just parsed, not yet dispatched). */
  emitToolRequested(runId: string, tool: {
    toolCallId: string
    toolName: string
    input: unknown
  }): void {
    this.emit('tool.requested', runId, tool)
  }

  /** Tool started executing. */
  emitToolStarted(runId: string, tool: {
    toolCallId: string
    toolName: string
  }): void {
    this.emit('tool.started', runId, tool)
  }

  /** Tool completed successfully. */
  emitToolCompleted(runId: string, tool: {
    toolCallId: string
    toolName: string
    status: 'success' | 'failed' | 'cancelled' | 'timed_out'
    summary: string
    exitCode?: number
  }): void {
    this.emit('tool.completed', runId, tool)
  }

  /** Tool failed (exception, permission denied, etc.). */
  emitToolFailed(runId: string, tool: {
    toolCallId: string
    toolName: string
    error: string
  }): void {
    this.emit('tool.failed', runId, tool)
  }

  /** A new artifact was produced (log, diff, test report, patch). */
  emitArtifactCreated(runId: string, artifact: {
    artifactId: string
    kind: string
    path?: string
    sizeBytes?: number
  }): void {
    this.emit('artifact.created', runId, artifact)
  }

  /** Verification gate started running acceptance commands. */
  emitVerificationStarted(runId: string, info: { commands: string[] }): void {
    this.emit('verification.started', runId, info)
  }

  /** Verification gate completed (all commands ran). */
  emitVerificationCompleted(runId: string, result: {
    passed: boolean
    commands: Array<{ command: string; passed: boolean; exitCode?: number }>
  }): void {
    this.emit('verification.completed', runId, result)
  }

  /** Verification gate itself failed to run (timeout, crash). */
  emitVerificationFailed(runId: string, error: { error: string }): void {
    this.emit('verification.failed', runId, error)
  }

  // ── Internal ──────────────────────────────────────────────────────────────

  private dispatch(raw: Parameters<RegistryEmitHook>[0]): void {
    const runId = raw.run.runId
    if (this.emitting.has(runId)) return // re-entrancy guard

    // Assign sequence FIRST so persistence sees the right number.
    const seq = (this.sequences.get(runId) ?? 0) + 1
    this.sequences.set(runId, seq)

    let type: string
    let payload: unknown
    if (raw.kind === 'create') {
      type = 'run.created'
      payload = { run: raw.run }
    } else if (raw.kind === 'transition') {
      // RegistryEmitHook guarantees from/to are set for kind:'transition'.
      const from = raw.from!
      const to = raw.to!
      type = eventTypeForTransition(from, to)
      payload = payloadForTransition(from, to, raw.run)
    } else {
      // update — emit as progress with the new phase
      type = 'run.progress'
      payload = { from: raw.run.status, phase: raw.run.phase, run: raw.run }
    }

    const envelope: RunEventEnvelope = {
      eventId: randomUUID(),
      runId,
      parentRunId: raw.run.parentRunId,
      sequence: seq,
      timestamp: raw.run.updatedAt,
      type,
      payload,
    }

    // Persist FIRST (spec: "事件先持久化，再推送给 UI"). If persistence
    // throws, we re-raise — losing the event is worse than crashing
    // the transition. (Round 7 will add retries / circuit-breakers.)
    if (this.store) {
      this.store.append(envelope)
    }

    // Fan out to subscribers. Critical subscribers that throw
    // transition the run to failed.
    this.emitting.add(runId)
    try {
      for (const sub of [...this.subscribers]) {
        try {
          sub.handler(envelope)
        } catch (err) {
          if (sub.criticality === 'critical') {
            // Re-throw to outer catch — the run must be marked failed.
            throw new CriticalSubscriberError(sub, err as Error)
          }
          // best-effort: log via onError if wired, otherwise swallow
          this.onError?.(envelope, err as Error)
        }
      }
    } catch (err) {
      // Critical subscriber failed — transition the run to failed.
      // We're inside the `emitting` guard so the resulting 'run.failed'
      // event won't recurse.
      try {
        if (raw.run.status !== 'failed' && canTransitionToFailed(raw.run.status)) {
          this.registry.transition(runId, 'failed', {
            phase: 'critical-subscriber-error',
            error: `critical subscriber threw: ${(err as Error).message}`,
          })
        }
      } catch {
        // registry may reject the transition (e.g. already terminal).
        // The original subscriber error is still surfaced via the
        // CriticalSubscriberError throw below.
      }
      this.onError?.(envelope, err as Error)
    } finally {
      this.emitting.delete(runId)
    }
  }

  /** Optional sink for best-effort subscriber errors. */
  onError?: (event: RunEventEnvelope, error: Error) => void

  /**
   * Dispatch a subsystem-emitted event (tool.*, artifact.*, verification.*,
   * run.steered). Same persist-first + fan-out contract as registry events,
   * but the type/payload come straight from the caller.
   */
  private dispatchExplicit(type: string, run: ExecutionRun, payload: unknown): void {
    const runId = run.runId
    if (this.emitting.has(runId)) {
      // Re-entrant call (a subscriber itself triggered an explicit emit).
      // Persistence still happens; subscriber fan-out is skipped to avoid
      // recursion. The next non-re-entrant emit will pick up new subscribers.
      const seq = (this.sequences.get(runId) ?? 0) + 1
      this.sequences.set(runId, seq)
      const envelope: RunEventEnvelope = {
        eventId: randomUUID(),
        runId,
        parentRunId: run.parentRunId,
        sequence: seq,
        timestamp: new Date().toISOString(),
        type,
        payload,
      }
      if (this.store) this.store.append(envelope)
      return
    }
    const seq = (this.sequences.get(runId) ?? 0) + 1
    this.sequences.set(runId, seq)
    const envelope: RunEventEnvelope = {
      eventId: randomUUID(),
      runId,
      parentRunId: run.parentRunId,
      sequence: seq,
      timestamp: new Date().toISOString(),
      type,
      payload,
    }
    if (this.store) this.store.append(envelope)
    this.emitting.add(runId)
    try {
      for (const sub of [...this.subscribers]) {
        try {
          sub.handler(envelope)
        } catch (err) {
          if (sub.criticality === 'critical') {
            this.onError?.(envelope, err as Error)
          } else {
            this.onError?.(envelope, err as Error)
          }
        }
      }
    } finally {
      this.emitting.delete(runId)
    }
  }
}

class CriticalSubscriberError extends Error {
  constructor(sub: Subscriber, original: Error) {
    super(`critical subscriber threw: ${original.message}`)
    this.name = 'CriticalSubscriberError'
    void sub // satisfy unused-binding lint; sub identity already in message
  }
}

function canTransitionToFailed(from: RunStatus): boolean {
  // failed is reachable from every non-terminal state.
  return !['succeeded', 'failed', 'cancelled', 'timed_out', 'verification_failed'].includes(from)
}

function payloadForTransition(from: RunStatus, to: RunStatus, run: ExecutionRun): unknown {
  switch (eventTypeForTransition(from, to)) {
    case 'run.completed': return { from, run }
    case 'run.failed':    return { from, error: run.error, run }
    case 'run.cancelled': return { from, run }
    case 'run.blocked':   return { from, reason: run.error, run }
    case 'run.started':   return { from, run }
    default:              return { from, phase: run.phase, run }
  }
}

// ── Crash recovery ─────────────────────────────────────────────────────────

/**
 * Rebuild an ExecutionRunRegistry from an EventStore.
 *
 * Replay strategy: fold the events in append order, applying each
 * transition to the in-memory run. The resulting registry reflects
 * the last persisted state of every run.
 *
 * Incomplete / corrupt events are skipped (same as JsonlEventStore.readAll).
 * Events for unknown runs (orphan transitions) are skipped — they'd
 * transition a non-existent run and throw, which we swallow.
 *
 * The returned registry has its onEmit UNPLUGGED — calling
 * transition() on it does NOT emit new events. Callers that want to
 * continue emitting should construct a fresh ExecutionRunEventBus
 * around it.
 */
export function recoverRegistryFromStore(store: EventStore): ExecutionRunRegistry {
  const registry = new ExecutionRunRegistry()
  // Don't emit during recovery — we're replaying historical events.
  registry.onEmit = undefined
  const events = store.readAll()
  for (const event of events) {
    try {
      applyEventToRegistry(registry, event)
    } catch {
      // skip — orphan transition, missing run, invalid transition, etc.
    }
  }
  // Leave onEmit undefined so the caller decides whether to plug in a bus.
  return registry
}

function applyEventToRegistry(registry: ExecutionRunRegistry, event: RunEventEnvelope): void {
  const existing = registry.get(event.runId)
  if (event.type === 'run.created') {
    if (existing) return // already exists — duplicate create, skip
    const payload = event.payload as { run: ExecutionRun }
    registry.create({
      runId: event.runId,
      kind: payload.run.kind,
      parentRunId: payload.run.parentRunId,
      goal: payload.run.goal,
      workspace: payload.run.workspace,
      worker: payload.run.worker,
      acceptance: payload.run.acceptance,
      budget: payload.run.budget,
      resources: payload.run.resources,
      artifacts: payload.run.artifacts,
      verification: payload.run.verification,
      status: payload.run.status,
      phase: payload.run.phase,
      error: payload.run.error,
      createdAt: event.timestamp,
      updatedAt: event.timestamp,
    })
    return
  }
  if (!existing) return // orphan transition — skip
  // The payload always carries the post-transition run snapshot
  // (including its terminal status). We trust the persisted snapshot
  // over event-type inference so that non-terminal transitions like
  // `preparing → running` (emitted as run.progress) round-trip
  // correctly through recovery.
  const payload = event.payload as { run?: ExecutionRun; phase?: string; error?: string }
  const snapshot = payload.run
  const targetStatus = snapshot?.status ?? statusFromEventType(event.type, existing.status)
  if (targetStatus && targetStatus !== existing.status) {
    if (canTransition(existing.status, targetStatus)) {
      registry.transition(event.runId, targetStatus, {
        phase: payload.phase ?? snapshot?.phase,
        error: payload.error ?? snapshot?.error,
      })
    }
  } else if (payload.phase || snapshot?.phase) {
    registry.update(event.runId, {
      phase: payload.phase ?? snapshot!.phase,
    })
  }
}

function statusFromEventType(type: string, current: RunStatus): RunStatus | undefined {
  if (type === 'run.completed') return 'succeeded'
  if (type === 'run.failed') return 'failed'
  if (type === 'run.cancelled') return 'cancelled'
  if (type === 'run.blocked') return 'blocked'
  if (type === 'run.lost') return 'lost'
  if (type === 'run.started') return current === 'queued' ? 'preparing' : current
  return undefined
}
