/**
 * RunScopedRuntimeContext (v0.3.2, ele_goal §Phase 1).
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
 */
export interface RunScopedRuntimeContext {
  runId: string
  parentRunId?: string
  taskKind: TaskKind
  taskGraph: TaskGraph
  progressMonitor: ProgressMonitor
  controlMessages: ControlMessageLog
  routingSignals?: RoutingSignals
  completionCandidate?: CompletionCandidate
  completionVerdict?: CompletionVerdict
  startedAt: number
}

/**
 * v0.3.2 (ele_goal §Phase 8): the structured snapshot the model emits
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
  create(runId: string, options: { parentRunId?: string; taskKind: TaskKind }): RunScopedRuntimeContext
  get(runId: string): RunScopedRuntimeContext | undefined
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
}

export class InMemoryRunScopedRuntimeContextStore implements RunScopedRuntimeContextStore {
  private readonly contexts = new Map<string, RunScopedRuntimeContext>()
  private sink: ((event: { type: 'CONTEXT_CREATED' | 'CONTEXT_CLOSED' | 'TASK_GRAPH_CREATED'; runId: string }) => void) | null = null

  setEventSink(sink: ((event: { type: 'CONTEXT_CREATED' | 'CONTEXT_CLOSED' | 'TASK_GRAPH_CREATED'; runId: string }) => void) | null): void {
    this.sink = sink
  }

  create(runId: string, options: { parentRunId?: string; taskKind: TaskKind }): RunScopedRuntimeContext {
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
      startedAt: Date.now(),
    }
    // v0.3.2: the graph inside the Context is a fresh TaskGraph;
    // set its runId so event emission is tagged correctly, and
    // also emit TASK_GRAPH_CREATED for /trace + EventStore replay.
    ctx.taskGraph.setRunId(runId)
    this.contexts.set(runId, ctx)
    this.sink?.({ type: 'CONTEXT_CREATED', runId })
    this.sink?.({ type: 'TASK_GRAPH_CREATED', runId })
    return ctx
  }

  get(runId: string): RunScopedRuntimeContext | undefined {
    return this.contexts.get(runId)
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
      routingSignals: snapshot.routingSignals,
      completionCandidate: snapshot.completionCandidate,
      completionVerdict: snapshot.completionVerdict,
      startedAt: snapshot.startedAt,
    }
    this.contexts.set(runId, ctx)
    return ctx
  }

  close(runId: string): void {
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
 * "default" context per ele_goal §2.1.
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