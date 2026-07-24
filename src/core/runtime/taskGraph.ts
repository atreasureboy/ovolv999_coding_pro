/**
 * TaskGraph (eight_goal Phase 3) — a lightweight task-decomposition DAG.
 *
 * NOT a generic workflow engine. Built for real coding tasks: decompose a
 * goal into nodes with dependencies, compute which nodes are ready /
 * blocked / parallelisable, and gate completion on every node reaching a
 * terminal state. The model (or a planner) populates the graph; the
 * Runtime owns its state machine + invariants.
 *
 * Invariants (eight_goal §五.8/§五.9):
 *   - a node with unmet dependencies is NOT ready (status stays pending)
 *   - a node whose verification failed is 'failed', never 'completed'
 *   - the graph is "done" only when every node is terminal
 *   - cycles are rejected at addNode (a planner bug, not a runtime state)
 *
 * Pure logic — no I/O, no timers. Serialisable for event-log recovery.
 */

export type TaskNodeStatus =
  | 'pending' | 'ready' | 'running' | 'blocked'
  | 'verifying' | 'completed' | 'failed' | 'cancelled'

export interface RetryPolicy {
  maxAttempts: number
  cooldownMs?: number
}

export interface TaskNode {
  id: string
  title: string
  description: string
  status: TaskNodeStatus
  dependencies: string[]
  acceptanceCriteria: string[]
  preferredRole?: string
  preferredModelProfile?: string
  resourceClaims?: string[]
  retryPolicy?: RetryPolicy
  artifacts: string[]
  attempts: number
  blockReason?: string
  failReason?: string
}

export interface TaskGraphSnapshot {
  nodes: TaskNode[]
  summary: {
    total: number
    completed: number
    failed: number
    blocked: number
    running: number
    ready: number
    pending: number
    done: boolean
  }
}

const TERMINAL: ReadonlySet<TaskNodeStatus> = new Set(['completed', 'failed', 'cancelled'])

/** v0.3.1: optional event-emitter sink. When set, every graph mutation
 *  emits a typed RunEvent so /trace + EventStore can replay history. */
type GraphEventSink = (event: {
  type:
    | 'TASK_GRAPH_CREATED'
    | 'TASK_NODE_ADDED'
    | 'TASK_NODE_STARTED'
    | 'TASK_NODE_VERIFYING'
    | 'TASK_NODE_COMPLETED'
    | 'TASK_NODE_FAILED'
    | 'TASK_NODE_BLOCKED'
  nodeId?: string
  title?: string
  reason?: string
  satisfied?: string[]
  runId?: string
}) => void

export class TaskGraph {
  private readonly nodes = new Map<string, TaskNode>()
  private runId = 'default'
  private sink: GraphEventSink | null = null

  setRunId(runId: string): void {
    this.runId = runId
  }

  setEventSink(sink: GraphEventSink | null): void {
    this.sink = sink
  }

  private emit(event: Parameters<GraphEventSink>[0]): void {
    this.sink?.(event)
    // v0.3.1 (te_goal §六.1 + §十一.14): every node transition also
    // drives the ProgressMonitor so stall detection picks up TaskGraph
    // progress. The type-narrowing on the union makes the mapping
    // exhaustive.
    if (event.type === 'TASK_NODE_STARTED') this.nodeTransitionSink?.('started')
    else if (event.type === 'TASK_NODE_VERIFYING') this.nodeTransitionSink?.('verifying')
    else if (event.type === 'TASK_NODE_COMPLETED') this.nodeTransitionSink?.('completed')
    else if (event.type === 'TASK_NODE_FAILED') this.nodeTransitionSink?.('failed')
    else if (event.type === 'TASK_NODE_BLOCKED') this.nodeTransitionSink?.('blocked')
  }

  /** v0.3.1 (te_goal §六.1): sink for per-node transitions so the
   *  ProgressMonitor sees TaskGraph progress. Wired by Engine. */
  private nodeTransitionSink: ((transition: 'started' | 'verifying' | 'completed' | 'failed' | 'blocked' | 'cancelled' | 'unblocked') => void) | null = null
  setNodeTransitionSink(sink: ((transition: 'started' | 'verifying' | 'completed' | 'failed' | 'blocked' | 'cancelled' | 'unblocked') => void) | null): void {
    this.nodeTransitionSink = sink
  }

  has(id: string): boolean {
    return this.nodes.has(id)
  }

  size(): number {
    return this.nodes.size
  }

  get(id: string): TaskNode | undefined {
    return this.nodes.get(id)
  }

  list(): TaskNode[] {
    return [...this.nodes.values()]
  }

  /**
   * Add a node. Rejects unknown-dependency references lazily (a dep need
   * not exist yet — it may be added later — but a CYCLE is rejected
   * immediately since it's a planner bug that can never resolve).
   */
  addNode(node: Omit<TaskNode, 'status' | 'artifacts' | 'attempts' | 'acceptanceCriteria'> & Partial<Pick<TaskNode, 'status' | 'artifacts' | 'attempts' | 'acceptanceCriteria'>>): TaskNode {
    if (this.nodes.has(node.id)) {
      throw new Error(`TaskGraph: duplicate node id "${node.id}"`)
    }
    if (node.dependencies.includes(node.id)) {
      throw new Error(`TaskGraph: node "${node.id}" depends on itself`)
    }
    const full: TaskNode = {
      ...node,
      status: node.status ?? 'pending',
      artifacts: node.artifacts ?? [],
      attempts: node.attempts ?? 0,
      acceptanceCriteria: node.acceptanceCriteria ?? [],
    }
    this.nodes.set(node.id, full)
    // Eagerly check the node doesn't close a cycle through existing nodes.
    if (this.wouldCreateCycle(node.id)) {
      this.nodes.delete(node.id)
      throw new Error(`TaskGraph: adding "${node.id}" creates a dependency cycle`)
    }
    this.emit({ type: 'TASK_NODE_ADDED', nodeId: full.id, title: full.title, runId: this.runId })
    return full
  }

  /** A node is ready when pending AND every declared dependency is completed. */
  readyNodes(): TaskNode[] {
    return this.list().filter((n) => n.status === 'pending' && this.depsCompleted(n))
  }

  /** Group ready nodes into parallel batches that don't share resource claims. */
  parallelGroups(): TaskNode[][] {
    const ready = this.readyNodes()
    const groups: TaskNode[][] = []
    for (const node of ready) {
      const claims = new Set(node.resourceClaims ?? [])
      let placed = false
      for (const g of groups) {
        const conflict = g.some((m) => (m.resourceClaims ?? []).some((c) => claims.has(c)))
        if (!conflict) { g.push(node); placed = true; break }
      }
      if (!placed) groups.push([node])
    }
    return groups
  }

  start(id: string): void {
    const n = this.require(id)
    if (n.status !== 'pending' && n.status !== 'ready') {
      throw new Error(`TaskGraph: cannot start "${id}" from ${n.status}`)
    }
    if (!this.depsCompleted(n)) {
      throw new Error(`TaskGraph: cannot start "${id}" — dependencies not completed`)
    }
    n.status = 'running'
    n.attempts++
    this.emit({ type: 'TASK_NODE_STARTED', nodeId: id, runId: this.runId })
  }

  markVerifying(id: string): void {
    const n = this.require(id)
    n.status = 'verifying'
    this.emit({ type: 'TASK_NODE_VERIFYING', nodeId: id, runId: this.runId })
  }

  /**
   * Complete a node. Refuses if its declared acceptance criteria are
   * unsatisfied (eight_goal §五.9 — verification failure must not be
   * masked as completed). Caller passes the satisfied criteria; if any
   * declared criterion is missing, the node goes to 'failed' instead.
   */
  complete(id: string, satisfiedCriteria: string[] = [], artifacts: string[] = []): void {
    const n = this.require(id)
    const unmet = n.acceptanceCriteria.filter((c) => !satisfiedCriteria.includes(c))
    if (unmet.length > 0) {
      n.status = 'failed'
      n.failReason = `acceptance criteria unmet: ${unmet.join(', ')}`
      this.emit({ type: 'TASK_NODE_FAILED', nodeId: id, reason: n.failReason, runId: this.runId })
      return
    }
    n.status = 'completed'
    n.artifacts = [...n.artifacts, ...artifacts]
    this.emit({ type: 'TASK_NODE_COMPLETED', nodeId: id, satisfied: satisfiedCriteria, runId: this.runId })
  }

  fail(id: string, reason: string): void {
    const n = this.require(id)
    n.status = 'failed'
    n.failReason = reason
    this.emit({ type: 'TASK_NODE_FAILED', nodeId: id, reason, runId: this.runId })
  }

  block(id: string, reason: string): void {
    const n = this.require(id)
    n.status = 'blocked'
    n.blockReason = reason
    this.emit({ type: 'TASK_NODE_BLOCKED', nodeId: id, reason, runId: this.runId })
  }

  /** v0.3.1 (te_goal §五): transition a blocked node back to pending
   *  (or ready if deps already satisfied) so it can be retried. */
  unblock(id: string): void {
    const n = this.require(id)
    if (n.status !== 'blocked') {
      throw new Error(`TaskGraph: can only unblock blocked nodes, "${id}" is ${n.status}`)
    }
    n.status = this.depsCompleted(n) ? 'ready' : 'pending'
    n.blockReason = undefined
    this.emit({ type: 'TASK_NODE_ADDED', nodeId: id, title: n.title, runId: this.runId })
  }

  /** v0.3.1 (te_goal §五): attach a named artifact to a node. The
   *  artifact list is appended to, not replaced. */
  attachArtifact(id: string, artifact: string): void {
    const n = this.require(id)
    if (!n.artifacts.includes(artifact)) n.artifacts.push(artifact)
  }

  /** Locally retry a failed node (eight_goal §五 — 失败节点局部重试). */
  retry(id: string): void {
    const n = this.require(id)
    if (n.status !== 'failed' && n.status !== 'blocked') {
      throw new Error(`TaskGraph: can only retry failed/blocked nodes, "${id}" is ${n.status}`)
    }
    const max = n.retryPolicy?.maxAttempts ?? 1
    if (n.attempts >= max) {
      n.status = 'blocked'
      n.blockReason = `exhausted ${max} attempt(s): ${n.failReason ?? n.blockReason ?? ''}`
      return
    }
    n.status = 'pending'
    n.failReason = undefined
    n.blockReason = undefined
  }

  cancel(id: string, reason?: string): void {
    const n = this.require(id)
    n.status = 'cancelled'
    if (reason) n.failReason = reason
    this.emit({ type: 'TASK_NODE_FAILED', nodeId: id, reason: reason ?? 'cancelled', runId: this.runId })
  }

  /** Every node is in a terminal state (the graph is finished). */
  isDone(): boolean {
    return this.size() > 0 && this.list().every((n) => TERMINAL.has(n.status))
  }

  /** Unfinished = any node not terminal (gates CompletionContract). */
  hasUnfinished(): boolean {
    return this.list().some((n) => !TERMINAL.has(n.status))
  }

  /** Nodes still failing/blocked (not retryable or exhausted). */
  hasHardFailures(): boolean {
    return this.list().some((n) => n.status === 'failed' || n.status === 'blocked')
  }

  snapshot(): TaskGraphSnapshot {
    const counts = { total: 0, completed: 0, failed: 0, blocked: 0, running: 0, ready: 0, pending: 0, done: false }
    for (const n of this.list()) {
      counts.total++
      if (n.status === 'completed') counts.completed++
      else if (n.status === 'failed') counts.failed++
      else if (n.status === 'blocked') counts.blocked++
      else if (n.status === 'running') counts.running++
      else if (n.status === 'pending' && this.depsCompleted(n)) counts.ready++
      else if (n.status === 'pending') counts.pending++
    }
    counts.done = counts.total > 0 && counts.completed + counts.failed + counts.blocked === counts.total
    return { nodes: this.list(), summary: { ...counts, done: counts.done } }
  }

  /** Serialise for event-log persistence / recovery (eight_goal §五.10). */
  serialize(): string {
    return JSON.stringify([...this.nodes.values()])
  }

  static restore(json: string): TaskGraph {
    const arr = JSON.parse(json) as TaskNode[]
    const g = new TaskGraph()
    for (const n of arr) g.nodes.set(n.id, n)
    return g
  }

  /**
   * v0.3.1 (te_goal §五): reset the graph to empty. Called at the start
   * of each turn so turn 2 doesn't inherit turn 1's nodes.
   */
  reset(): void {
    this.nodes.clear()
  }

  // ── internals ───────────────────────────────────────────────────

  private require(id: string): TaskNode {
    const n = this.nodes.get(id)
    if (!n) throw new Error(`TaskGraph: unknown node "${id}"`)
    return n
  }

  private depsCompleted(n: TaskNode): boolean {
    return n.dependencies.every((d) => this.nodes.get(d)?.status === 'completed')
  }

  private wouldCreateCycle(id: string): boolean {
    // DFS from each dependency; if we reach `id`, adding it cycles.
    const visited = new Set<string>()
    const stack = [...(this.nodes.get(id)?.dependencies ?? [])]
    while (stack.length) {
      const cur = stack.pop()!
      if (cur === id) return true
      if (visited.has(cur)) continue
      visited.add(cur)
      const node = this.nodes.get(cur)
      if (node) stack.push(...node.dependencies)
    }
    return false
  }
}
