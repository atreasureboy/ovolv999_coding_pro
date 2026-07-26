/**
 * TaskGraphResolver (v0.3.2, ele_goal §Phase 2).
 *
 * The TaskPlanTool no longer holds a fixed TaskGraph. Instead it
 * receives a TaskGraphResolver that maps runId → TaskGraph, allowing
 * every tool call to operate on the graph of the CURRENT run (the
 * one being executed right now). Removing the constructor-injected
 * graph is the single source-identity fix for TaskGraph pollution.
 *
 * - resolve(runId): returns the graph for the given runId
 * - the resolver is created by the Engine from the runContextStore
 * - tests can inject a fake resolver to make graph ownership explicit
 */
import type { TaskGraph } from '../core/runtime/taskGraph.js'
import type { EvidenceStore } from '../core/runtime/evidence.js'
import type { RunScopedRuntimeContextStore } from '../core/runtime/runScopedContext.js'

export interface TaskGraphResolver {
  resolve(runId: string): TaskGraph
  resolveOrNull(runId: string): TaskGraph | undefined
}

export class RunScopedTaskGraphResolver implements TaskGraphResolver {
  constructor(private readonly store: RunScopedRuntimeContextStore) {}
  resolve(runId: string): TaskGraph {
    const ctx = this.store.get(runId)
    if (!ctx) throw new Error(`TaskGraphResolver: no context for runId "${runId}"`)
    return ctx.taskGraph
  }
  resolveOrNull(runId: string): TaskGraph | undefined {
    return this.store.get(runId)?.taskGraph
  }
}

/**
 * v0.3.5: Resolves the per-run EvidenceStore from the RunScopedRuntimeContext.
 */
export class RunScopedEvidenceResolver {
  constructor(private readonly store: RunScopedRuntimeContextStore) {}
  resolve(runId: string): EvidenceStore {
    const ctx = this.store.get(runId)
    if (!ctx) throw new Error(`EvidenceResolver: no context for runId "${runId}"`)
    return ctx.evidence
  }
  resolveOrNull(runId: string): EvidenceStore | undefined {
    return this.store.get(runId)?.evidence
  }
}

/**
 * Test-only resolver that returns a single fixed graph. For tests
 * that don't wire the runContextStore; production NEVER uses this.
 */
export class FixedTaskGraphResolver implements TaskGraphResolver {
  constructor(private readonly graph: TaskGraph) {}
  resolve(_runId: string): TaskGraph {
    return this.graph
  }
  resolveOrNull(_runId: string): TaskGraph | undefined {
    return this.graph
  }
}