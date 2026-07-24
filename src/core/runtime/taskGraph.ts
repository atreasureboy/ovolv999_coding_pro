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

export class TaskGraph {
  private readonly nodes = new Map<string, TaskNode>()

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
  addNode(node: Omit<TaskNode, 'status' | 'artifacts' | 'attempts'> & Partial<Pick<TaskNode, 'status' | 'artifacts' | 'attempts'>>): TaskNode {
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
    }
    this.nodes.set(node.id, full)
    // Eagerly check the node doesn't close a cycle through existing nodes.
    if (this.wouldCreateCycle(node.id)) {
      this.nodes.delete(node.id)
      throw new Error(`TaskGraph: adding "${node.id}" creates a dependency cycle`)
    }
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
  }

  markVerifying(id: string): void {
    const n = this.require(id)
    n.status = 'verifying'
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
      return
    }
    n.status = 'completed'
    n.artifacts = [...n.artifacts, ...artifacts]
  }

  fail(id: string, reason: string): void {
    const n = this.require(id)
    n.status = 'failed'
    n.failReason = reason
  }

  block(id: string, reason: string): void {
    const n = this.require(id)
    n.status = 'blocked'
    n.blockReason = reason
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

  cancel(id: string): void {
    const n = this.require(id)
    n.status = 'cancelled'
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
