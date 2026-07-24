/**
 * TaskGraphStore (v0.3.1, te_goal §五).
 *
 * The runtime previously kept a single shared TaskGraph and reset it at
 * the start of every turn — a coarse way to stop turn 1's nodes from
 * leaking into turn 2. It still leaked sub-task identities across
 * sessions, races between concurrent runs in the same engine, and
 * crashed-recovery state. TaskGraphStore fixes that by keying each
 * graph on runId so:
 *   - turn N's graph is independent of turn M's
 *   - the same engine can serve multiple parallel runs
 *   - closed runs are dropped, not mutated
 *   - /tasks <runId> can resolve the right graph
 *
 * In-memory implementation; the interface allows swapping in a
 * persistent backing later.
 */
import { TaskGraph, type TaskGraphSnapshot } from './taskGraph.js'

export interface TaskGraphStore {
  create(runId: string): TaskGraph
  get(runId: string): TaskGraph | undefined
  restore(runId: string, snapshot: TaskGraphSnapshot): TaskGraph
  close(runId: string): void
  list(): string[]   // active run ids
  has(runId: string): boolean
  setEventSink(sink: ((event: { type: 'TASK_GRAPH_CREATED'; runId: string }) => void) | null): void
}

export class InMemoryTaskGraphStore implements TaskGraphStore {
  private readonly graphs = new Map<string, TaskGraph>()
  /** v0.3.1 (te_goal §五): optional event sink for graph lifecycle. */
  private sink: ((event: { type: 'TASK_GRAPH_CREATED'; runId: string }) => void) | null = null

  setEventSink(sink: ((event: { type: 'TASK_GRAPH_CREATED'; runId: string }) => void) | null): void {
    this.sink = sink
  }

  create(runId: string): TaskGraph {
    if (this.graphs.has(runId)) {
      throw new Error(`TaskGraphStore: runId "${runId}" already exists; call restore() to reuse.`)
    }
    const g = new TaskGraph()
    g.setRunId(runId)
    this.graphs.set(runId, g)
    this.sink?.({ type: 'TASK_GRAPH_CREATED', runId })
    return g
  }

  get(runId: string): TaskGraph | undefined {
    return this.graphs.get(runId)
  }

  restore(runId: string, snapshot: TaskGraphSnapshot): TaskGraph {
    const g = TaskGraph.restore(JSON.stringify(snapshot.nodes))
    this.graphs.set(runId, g)
    return g
  }

  close(runId: string): void {
    this.graphs.delete(runId)
  }

  list(): string[] {
    return [...this.graphs.keys()]
  }

  has(runId: string): boolean {
    return this.graphs.has(runId)
  }

  /**
   * Drop graphs that are completely terminal (every node in
   * completed/failed/cancelled). Used to bound memory.
   */
  pruneTerminal(): string[] {
    const removed: string[] = []
    for (const [runId, g] of this.graphs) {
      if (g.isDone()) {
        this.graphs.delete(runId)
        removed.push(runId)
      }
    }
    return removed
  }
}