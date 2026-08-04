/**
 * RunScopedRuntimeContext (v0.3.2, run-scoped runtime contract §Phase 1).
 *
 * The single source of truth for everything that happens within one
 * Run. Before v0.3.2 the Coordinator, TaskPlanTool, CompletionContract
 * and ProgressMonitor each held their own references to TaskGraph /
 * ControlMessageLog / etc. — multiple components could disagree about
 * which graph was "current". This module makes the per-run scope
 * explicit so every component resolves the same Context for the same
 * runId.
 *
 * Pure data interface + a small in-memory store. The interface is
 * intentionally minimal so it can be persisted, replayed, or mocked
 * without touching the runtime.
 */
import { TaskGraph } from './taskGraph.js'
import { ProgressMonitor } from './progressMonitor.js'
import { EvidenceStore } from './evidence.js'
import { ControlMessageLog } from './internalControlMessage.js'
import type { RoutingSignals } from '../model/routingSignalCollector.js'
import type { CompletionVerdict } from './completionContract.js'
import type { TaskKind } from './taskIntent.js'

/**
 * Per-run snapshot. Populated progressively across the run lifecycle:
 *   - taskKind: set at create-time (Phase 3)
 *   - taskGraph: empty graph at create-time, populated by TaskPlanTool
 *   - progressMonitor, controlMessages: fresh per run
 *   - routingSignals: collected just before the first LLM call
 *   - completionCandidate / completionVerdict: set at completion
 *   - startedAt: monotonic now-ms
 *   - inheritedConfig: v0.5.2 (C3 — borrowed from codex multi-agent
 *     `multi_agents_common.rs` config inheritance): per-run slice of
 *     the parent's resolved config. The AgentTool + ClaudeCodeTool
 *     children populate this from the parent's effective config so
 *     sub-agent runs cannot accidentally drift provider / sandbox /
 *     permission settings without an explicit override.
 */
export interface RunScopedRuntimeContext {
  runId: string
  parentRunId?: string
  taskKind: TaskKind
  taskGraph: TaskGraph
  progressMonitor: ProgressMonitor
  controlMessages: ControlMessageLog
  /** v0.3.5: per-run evidence store for anti-false-success. */
  evidence: EvidenceStore
  routingSignals?: RoutingSignals
  completionCandidate?: CompletionCandidate
  completionVerdict?: CompletionVerdict
  startedAt: number
  /**
   * v0.5.3 Final (task 2): per-run MemoryCandidates written by
   * memory_write. They are NOT persisted at write-time; the
   * MemoryPromoter reads them after CompletionContract and
   * promotes / demotes / drops each one based on the run verdict.
   * Storage is per-run so a re-run never inherits previous candidates.
   */
  memoryCandidates: import("../memoryCandidate.js").MemoryCandidate[]
  /** v0.5.3 Final (task 2): per-run snapshot of the user message —
   *  the MemoryPromoter uses this to verify sourceQuote claims. */
  userMessage: string
  /**
   * v0.5.2 (C3): config slice inherited from the parent at create-time.
   * Children layer role-specific overrides on top via the immutable
   * `withConfigOverride()` helper. Production callers: AgentTool,
   * ClaudeCodeTool, WorkerTool. Without this, child runs had no
   * structural record of "what config did I inherit" — a runtime
   * invariant gap that surfaced as cross-child permission drift in
   * tests.
   */
  inheritedConfig?: InheritedConfig
}

/**
 * v0.5.2 (C3): minimal config slice needed by a child run. Only the
 * fields that materially affect sub-agent behaviour are included; the
 * rest stays on the parent Engine and is read through the resolver.
 */
export interface InheritedConfig {
  provider?: string
  model?: string
  cwd: string
  permissionMode: string
  sandboxEnabled: boolean
  /** Source run id for audit. */
  inheritedFrom: string
  /** Wall-clock of when the inheritance was captured. */
  inheritedAt: number
}

/**
 * v0.3.2 (run-scoped runtime contract §Phase 8): the structured snapshot the model emits
 * when it stops. Held in the RunScopedContext so the reviewer /
 * completion contract operate on the same artifact.
 */
export interface CompletionCandidate {
  /** True if the model's last message included a tool call. */
  hasToolCalls: boolean
  /** The assistant's free-text answer (the body of the final message). */
  text: string
  /** Files actually changed this run (snapshot for the verdict). */
  changedFiles: string[]
  /** Token usage snapshot at completion time. */
  usage?: { inputTokens: number; outputTokens: number }
  /** Iteration count at completion. */
  iteration: number
}

export interface RunScopedRuntimeContextStore {
  create(runId: string, options: {
    parentRunId?: string
    taskKind: TaskKind
    /** v0.5.2 (C3): explicit config inheritance. Optional — pre-wiring
     *  callers omit it and get the legacy behaviour (no inheritance). */
    inheritedConfig?: InheritedConfig
    /** v0.5.3 Final (task 2): the original user message — once we
     *  have it, the MemoryPromoter can verify sourceQuote claims
     *  against the user's actual words. */
    userMessage?: string
  }): RunScopedRuntimeContext
  get(runId: string): RunScopedRuntimeContext | undefined
  getLatest(): RunScopedRuntimeContext | undefined
  restore(runId: string, snapshot: SerializedRunContext): RunScopedRuntimeContext
  close(runId: string): void
  list(): string[]
  has(runId: string): boolean
  setEventSink(sink: ((event: { type: 'CONTEXT_CREATED' | 'CONTEXT_CLOSED' | 'TASK_GRAPH_CREATED'; runId: string }) => void) | null): void
}

/**
 * Serialized form for persistence + replay. Round-trippable via
 * JSON.stringify / JSON.parse.
 */
export interface SerializedRunContext {
  runId: string
  parentRunId?: string
  taskKind: TaskKind
  startedAt: number
  taskGraphSnapshot: ReturnType<TaskGraph['snapshot']>
  completionVerdict?: CompletionVerdict
  routingSignals?: RoutingSignals
  completionCandidate?: CompletionCandidate
  /** v0.5.3 Final (task 2): restore-time user message so MemoryPromoter
   *  can re-verify sourceQuote claims. */
  userMessage?: string
}

export class InMemoryRunScopedRuntimeContextStore implements RunScopedRuntimeContextStore {
  private readonly contexts = new Map<string, RunScopedRuntimeContext>()
  private lastClosed: RunScopedRuntimeContext | undefined
  private sink: ((event: { type: 'CONTEXT_CREATED' | 'CONTEXT_CLOSED' | 'TASK_GRAPH_CREATED'; runId: string }) => void) | null = null

  setEventSink(sink: ((event: { type: 'CONTEXT_CREATED' | 'CONTEXT_CLOSED' | 'TASK_GRAPH_CREATED'; runId: string }) => void) | null): void {
    this.sink = sink
  }

  create(runId: string, options: {
    parentRunId?: string
    taskKind: TaskKind
    /** v0.5.2 (C3): explicit config inheritance. The parent passes
     *  its effective config so the child does not silently drift. */
    inheritedConfig?: InheritedConfig
    /** v0.5.3 Final (task 2): the original user message, stored
     *  once at create-time so the MemoryPromoter can verify
     *  sourceQuote claims later. */
    userMessage?: string
  }): RunScopedRuntimeContext {
    if (this.contexts.has(runId)) {
      throw new Error(`RunScopedRuntimeContextStore: runId "${runId}" already exists`)
    }
    const ctx: RunScopedRuntimeContext = {
      runId,
      parentRunId: options.parentRunId,
      taskKind: options.taskKind,
      taskGraph: new TaskGraph(),
      progressMonitor: new ProgressMonitor(),
      controlMessages: new ControlMessageLog(),
      evidence: new EvidenceStore(),
      startedAt: Date.now(),
      inheritedConfig: options.inheritedConfig,
      memoryCandidates: [],
      userMessage: options.userMessage ?? '',
    }
    // v0.3.2: the graph inside the Context is a fresh TaskGraph;
    // set its runId so event emission is tagged correctly, and
    // also emit TASK_GRAPH_CREATED for /trace + EventStore replay.
    ctx.taskGraph.setRunId(runId)
    ctx.taskGraph.setNodeTransitionSink((transition) => ctx.progressMonitor.recordTaskNodeTransition(transition))
    this.contexts.set(runId, ctx)
    this.sink?.({ type: 'CONTEXT_CREATED', runId })
    this.sink?.({ type: 'TASK_GRAPH_CREATED', runId })
    return ctx
  }

  get(runId: string): RunScopedRuntimeContext | undefined {
    return this.contexts.get(runId)
  }

  getLatest(): RunScopedRuntimeContext | undefined {
    let latest: RunScopedRuntimeContext | undefined
    for (const context of this.contexts.values()) latest = context
    return latest ?? this.lastClosed
  }

  restore(runId: string, snapshot: SerializedRunContext): RunScopedRuntimeContext {
    const graph = TaskGraph.restore(JSON.stringify(snapshot.taskGraphSnapshot.nodes))
    graph.setRunId(snapshot.runId)
    const ctx: RunScopedRuntimeContext = {
      runId: snapshot.runId,
      parentRunId: snapshot.parentRunId,
      taskKind: snapshot.taskKind,
      taskGraph: graph,
      progressMonitor: new ProgressMonitor(),
      controlMessages: new ControlMessageLog(),
      evidence: new EvidenceStore(),
      routingSignals: snapshot.routingSignals,
      completionCandidate: snapshot.completionCandidate,
      completionVerdict: snapshot.completionVerdict,
      startedAt: snapshot.startedAt,
      memoryCandidates: [],
      userMessage: snapshot.userMessage ?? '',
    }
    ctx.taskGraph.setNodeTransitionSink((transition) => ctx.progressMonitor.recordTaskNodeTransition(transition))
    this.contexts.set(runId, ctx)
    return ctx
  }

  close(runId: string): void {
    const context = this.contexts.get(runId)
    if (context) this.lastClosed = context
    this.contexts.delete(runId)
    this.sink?.({ type: 'CONTEXT_CLOSED', runId })
  }

  list(): string[] {
    return [...this.contexts.keys()]
  }

  has(runId: string): boolean {
    return this.contexts.has(runId)
  }
}

/**
 * Resolve the Context for a given runId. Used by the ToolContext
 * resolver so every Tool sees the same Context for the same runId.
 * Throws if no Context exists — production never defaults to a
 * "default" context per run-scoped runtime contract §2.1.
 */
export class RunScopedContextResolver {
  constructor(private readonly store: RunScopedRuntimeContextStore) {}

  resolve(runId: string): RunScopedRuntimeContext {
    const ctx = this.store.get(runId)
    if (!ctx) {
      throw new Error(`RunScopedContextResolver: no context for runId "${runId}"`)
    }
    return ctx
  }

  resolveOrNull(runId: string): RunScopedRuntimeContext | undefined {
    return this.store.get(runId)
  }
}

/**
 * v0.5.2 (C3 — borrowed from codex multi_agents_common.rs): build a
 * child InheritedConfig from a parent InheritedConfig + the child
 * role-specific overrides. Strict rule: a child may override provider,
 * model, and sandboxEnabled; permissionMode and cwd are inherited
 * (cwd is locked to the parent's project root to prevent a child
 * from silently escaping it; permissionMode is sticky to keep the
 * user's mode choice consistent across the run tree).
 *
 * The result is the value to pass into `create({ inheritedConfig })`
 * for the child run. Pure function — no side effects on the parent.
 */
export function inheritConfig(
  parent: InheritedConfig,
  overrides: {
    provider?: string
    model?: string
    sandboxEnabled?: boolean
  },
): InheritedConfig {
  return {
    provider: overrides.provider ?? parent.provider,
    model: overrides.model ?? parent.model,
    cwd: parent.cwd, // locked
    permissionMode: parent.permissionMode, // locked
    sandboxEnabled: overrides.sandboxEnabled ?? parent.sandboxEnabled,
    inheritedFrom: parent.inheritedFrom,
    inheritedAt: Date.now(),
  }
}

/**
 * v0.5.2 (C3): immutable override on a RunScopedRuntimeContext.
 * Returns a NEW context object (per run-scoped runtime contract §2.1:
 * contexts are write-once, the snapshot is replaced wholesale). The
 * caller should `restore()` the new snapshot via the store, or use
 * this helper to compute the override before construction.
 */
export function withConfigOverride(
  ctx: RunScopedRuntimeContext,
  overrides: {
    provider?: string
    model?: string
    sandboxEnabled?: boolean
  },
): RunScopedRuntimeContext {
  if (!ctx.inheritedConfig) {
    throw new Error(`RunScopedRuntimeContext: runId "${ctx.runId}" has no inheritedConfig — cannot override`)
  }
  return {
    ...ctx,
    inheritedConfig: inheritConfig(ctx.inheritedConfig, overrides),
  }
}
