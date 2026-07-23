import type { Tool, ToolContext, ToolDefinition, ToolResult } from '../core/types.js'
import { ClaudeCodeWorkerManager } from '../core/claudeCodeWorkerManager.js'
import { str } from '../core/strings.js'
import type { ExecutionRunRegistry} from '../core/executionRun.js';
import { type RunStatus } from '../core/executionRun.js'
import { isTerminalRunStatus } from '../core/executionRun.js'
import type {
  WorkerAdapter,
  SteerEventEmitter,
  WorkerHandle,
  WorkerStatus,
  WorkerResult,
  WorkerDescriptor,
  WorkerTask,
  DeliveryAck,
} from '../core/workerAdapter.js'

function defaultSession(input: Record<string, unknown>): string {
  return str(input.session, 'ovogo-claude-worker')
}

function positiveNumber(value: unknown, fallback: number): number {
  const n = Number(value)
  return Number.isFinite(n) && n > 0 ? n : fallback
}

function nonNegativeNumber(value: unknown, fallback: number): number {
  const n = Number(value)
  return Number.isFinite(n) && n >= 0 ? n : fallback
}

export class ClaudeCodeTool implements Tool, WorkerAdapter {
  name = 'ClaudeCode'
  metadata = { mutatesState: true, longRunning: true, concurrencySafe: false }
  readonly workerKind = 'claude-code'

  /**
   * GAP-K: runId → tmux session name, populated when the `run` action
   * creates an ExecutionRun. Used by `steer()` to resolve which worker
   * pane to send the follow-up instruction to. Entries are removed
   * when the run reaches a terminal state.
   */
  private readonly runSessions = new Map<string, string>()

  /**
   * P1-1 fix: runId → Claude Worker taskId (the UUID embedded in the
   * [TASK_DONE <id>] / [TASK_FAILED <id>] sentinels). Populated by the
   * `run` action / `start()` so a later `wait({runId})` can bind the
   * waitFor() to THIS task's sentinel instead of degrading to the
   * legacy ^[DONE]$ pattern (which is vulnerable to stale-sentinel
   * matching when a tmux session is reused). Mirrors runSessions
   * lifecycle: cleared on every terminal transition.
   */
  private readonly runTasks = new Map<string, string>()

  /**
   * GAP-K: optional emitter the host wires in so successful steer()
   * calls land on the ExecutionRunEventBus as `run.steered` events.
   * When unset, steer still delivers to the tmux pane but no event
   * is recorded on the bus.
   */
  private readonly onSteered?: SteerEventEmitter

  constructor(
    private readonly manager = new ClaudeCodeWorkerManager(),
    /**
     * Optional ExecutionRun registry (fi_goal.md §三 Phase 2 / Round 3).
     * When supplied, the `run` action creates a child run with
     * kind='external_worker' and walks it through the state machine so
     * observers can track tmux-backed delegations uniformly. When
     * omitted, the tool behaves exactly as before.
     */
    private readonly runRegistry?: ExecutionRunRegistry,
    /** Optional parent run id for linking into a call tree. */
    private readonly parentRunId?: string,
    /** Optional GAP-K steer-event emitter (host wires to bus.emitSteered). */
    onSteered?: SteerEventEmitter,
  ) {
    this.onSteered = onSteered
  }

  /**
   * GAP-K: send a follow-up instruction to the tmux pane running the
   * given ExecutionRun. Returns true iff the runId is known to this
   * adapter AND the run hasn't reached a terminal state AND the tmux
   * `send-keys` landed successfully.
   */
  async steer(runId: string, instruction: string): Promise<boolean> {
    const session = this.runSessions.get(runId)
    if (!session) return false
    // Refuse to steer a terminal run — the worker is gone (or about
    // to be) and the instruction would land on a stale pane.
    if (this.runRegistry) {
      const run = this.runRegistry.get(runId)
      if (run && isTerminalRunStatus(run.status)) return false
    }
    try {
      if (!await this.manager.sessionExists(session)) return false
      await this.manager.send(session, instruction)
    } catch {
      return false
    }
    this.onSteered?.(runId, instruction)
    return true
  }

  // ── WorkerAdapter lifecycle (five_goal §六 P0-8) ──────────────────
  //
  // The ClaudeCode adapter is the first to grow the full lifecycle
  // (start/status/cancel/collect/reattach) beyond just steer(). Each
  // method is anchored on the same `runSessions` map populated by the
  // `run` action so the runId-keyed API is the single source of truth
  // — the orchestrator never has to switch to session names.

  /**
   * Launch a new ClaudeCode worker for `task`. Creates the tmux
   * session, sends the task, registers the runId↔session mapping,
   * and returns a WorkerHandle. The worker keeps running after this
   * resolves — the run stays non-terminal until the host calls
   * collect() / cancel() or the [TASK_DONE <id>] sentinel is seen.
   */
  async start(
    task: WorkerTask,
    context?: { cwd?: string; signal?: AbortSignal; parentRunId?: string },
  ): Promise<WorkerHandle> {
    const session = `claude-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    const cwd = context?.cwd ?? process.cwd()
    const registry = this.runRegistry
    let runId: string
    if (registry) {
      const run = registry.create({
        kind: 'external_worker',
        parentRunId: context?.parentRunId,
        goal: task.goal,
        workspace: { cwd },
        worker: this.workerKind,
      })
      runId = run.runId
      try { registry.transition(runId, 'preparing', { phase: 'start-spawning' }) } catch { /* best-effort */ }
    } else {
      runId = `claude-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    }
    const result = await this.manager.runTask({
      session,
      cwd,
      task: task.goal,
      instructions: task.instructions,
    })
    this.runSessions.set(runId, result.session)
    if (registry) {
      try { registry.transition(runId, 'running', { phase: 'task-sent', worker: result.session }) } catch { /* best-effort */ }
      try { registry.transition(runId, 'waiting', { phase: 'dispatched', worker: result.session }) } catch { /* best-effort */ }
    }
    return {
      runId,
      workerKind: this.workerKind,
      workerInstanceId: result.taskId,
      descriptor: { type: 'tmux', sessionId: result.session },
    }
  }

  /**
   * Query the live status of a worker. Prefers the transport signal
   * (does the tmux session still exist?) over the cached registry
   * state — a pane that disappeared between polls means the run is
   * 'lost', not 'waiting'.
   */
  async status(runId: string): Promise<WorkerStatus> {
    const session = this.runSessions.get(runId)
    if (!session) return 'unknown'
    // First check the registry — if it's already terminal we trust
    // that state (cancellation, succeeded with [DONE], etc).
    if (this.runRegistry) {
      const run = this.runRegistry.get(runId)
      if (run) {
        if (run.status === 'succeeded') return 'succeeded'
        if (run.status === 'failed') return 'failed'
        if (run.status === 'cancelled') return 'cancelled'
        if (run.status === 'timed_out') return 'failed'
        if (run.status === 'verification_failed') return 'failed'
        if (run.status === 'lost') return 'lost'
      }
    }
    // Transport-level liveness check.
    let exists: boolean
    try {
      exists = await this.manager.sessionExists(session)
    } catch {
      return 'unknown'
    }
    if (!exists) {
      // Pane gone but registry still non-terminal → the worker died
      // out-of-band. Write back to the registry so the Run doesn't
      // stay stuck in 'waiting' forever.
      if (this.runRegistry) {
        const run = this.runRegistry.get(runId)
        if (run && !isTerminalRunStatus(run.status)) {
          try {
            this.runRegistry.transition(runId, 'lost', {
              phase: 'pane-disappeared',
              error: 'worker pane no longer exists',
            })
          } catch { /* best-effort */ }
        }
      }
      return 'lost'
    }
    // Pane exists — assume still running.
    return 'running'
  }

  /**
   * Abort a running worker. Kills the tmux session and transitions
   * the underlying ExecutionRun to 'cancelled'. Idempotent — calling
   * cancel() on an already-terminal run is a no-op.
   */
  async cancel(runId: string, reason?: string): Promise<void> {
    const session = this.runSessions.get(runId)
    if (!session) return
    try {
      await this.manager.stop(session)
    } catch {
      // best-effort — the session may already be gone.
    }
    if (this.runRegistry) {
      try {
        this.runRegistry.transition(runId, 'cancelled', {
          phase: 'cancelled-by-caller',
          error: reason ?? 'cancel() invoked',
        })
      } catch {
        // Already terminal — nothing to transition.
      }
    }
    this.runSessions.delete(runId)
    this.runTasks.delete(runId)
  }

  /**
   * Harvest the terminal result + artifacts from a worker. If the
   * worker is still running, this returns immediately with status
   * 'running' — the caller is expected to poll or call wait() first.
   * Artifacts captured: pane output (as 'log'), and (future) git diff.
   */
  async collect(runId: string): Promise<WorkerResult> {
    const session = this.runSessions.get(runId)
    if (!session) {
      return { runId, status: 'unknown' as WorkerStatus, error: 'unknown runId' }
    }
    const live = await this.status(runId)
    if (live === 'running' || live === 'waiting') {
      return { runId, status: 'running' }
    }
    // Capture whatever is left in the pane before it scrolls away.
    let output = ''
    try {
      output = await this.manager.capture(session, 0)
    } catch {
      // best-effort — pane may already be gone.
    }
    const registryStatus = this.runRegistry?.get(runId)?.status
    const terminal: WorkerStatus =
      registryStatus === 'succeeded' ? 'succeeded'
      : registryStatus === 'cancelled' ? 'cancelled'
      : registryStatus === 'failed' || registryStatus === 'verification_failed' || registryStatus === 'timed_out' ? 'failed'
      : registryStatus === 'lost' ? 'lost'
      : live === 'lost' ? 'lost'
      : 'failed'
    return {
      runId,
      status: terminal,
      output: output || undefined,
      artifacts: output
        ? [{ kind: 'log', content: output, contentType: 'text/plain' }]
        : undefined,
    }
  }

  /**
   * GAP 5.2 (five_goal §六): block until the worker reaches a terminal
   * state. Polls the tmux pane for [TASK_DONE] / [TASK_FAILED], then
   * transitions the run through verifying→succeeded or →failed.
   */
  async wait(runId: string, opts?: { timeoutMs?: number; signal?: AbortSignal }): Promise<WorkerResult> {
    const session = this.runSessions.get(runId)
    if (!session) {
      return { runId, status: 'unknown' as WorkerStatus, error: 'unknown runId' }
    }
    if (this.runRegistry) {
      const run = this.runRegistry.get(runId)
      if (run && isTerminalRunStatus(run.status)) {
        return this.collect(runId)
      }
      try { this.runRegistry.transition(runId, 'waiting', { phase: 'polling-completion' }) } catch { /* best-effort */ }
    }
    const result = await this.manager.waitFor({
      session,
      timeoutMs: opts?.timeoutMs ?? 120_000,
      signal: opts?.signal,
    })
    if (result.aborted) {
      if (this.runRegistry) {
        try { this.runRegistry.transition(runId, 'cancelled', { phase: 'aborted', error: 'wait aborted via signal' }) } catch { /* best-effort */ }
      }
    } else if (result.matched) {
      if (result.matchKind === 'failed') {
        if (this.runRegistry) {
          try { this.runRegistry.transition(runId, 'failed', { phase: 'task-failed', error: result.failureReason ?? 'TASK_FAILED' }) } catch { /* best-effort */ }
        }
      } else {
        if (this.runRegistry) {
          try { this.runRegistry.transition(runId, 'verifying', { phase: 'completion-matched' }) } catch { /* best-effort */ }
          try { this.runRegistry.transition(runId, 'succeeded', { phase: 'finalized' }) } catch { /* best-effort */ }
        }
      }
    } else {
      if (this.runRegistry) {
        try { this.runRegistry.transition(runId, 'timed_out', { phase: 'wait-timeout', error: 'waitFor timed out' }) } catch { /* best-effort */ }
      }
    }
    // Collect BEFORE cleaning up the runSession mapping.
    const collected = await this.collect(runId)
    if (isTerminalRunStatus(this.runRegistry?.get(runId)?.status ?? 'succeeded')) {
      this.runSessions.delete(runId)
      this.runTasks.delete(runId)
    }
    return collected
  }

  private transitionTerminal(runId: string, to: RunStatus, patch?: Record<string, unknown>): void {
    if (!this.runRegistry) return
    try { this.runRegistry.transition(runId, to, patch) } catch { /* best-effort */ }
    if (isTerminalRunStatus(to)) {
      this.runSessions.delete(runId)
      this.runTasks.delete(runId)
    }
  }

  /**
   * OPTIONAL: reconnect to a worker after a host restart. Given the
   * original runId + the serialisable descriptor (sessionId),
   * reconstruct the runId↔session mapping. Returns null if the tmux
   * pane is gone (run should be marked 'lost').
   */
  async reattach(runId: string, descriptor: WorkerDescriptor): Promise<WorkerHandle | null> {
    if (descriptor.type !== 'tmux' || !descriptor.sessionId) return null
    let exists: boolean
    try {
      exists = await this.manager.sessionExists(descriptor.sessionId)
    } catch {
      return null
    }
    if (!exists) return null
    this.runSessions.set(runId, descriptor.sessionId)
    return {
      runId,
      workerKind: this.workerKind,
      workerInstanceId: descriptor.sessionId,
      descriptor,
    }
  }

  definition: ToolDefinition = {
    type: 'function',
    function: {
      name: 'ClaudeCode',
      description: `Delegate focused coding work to an external Claude Code CLI worker running in tmux. The supervisor remains responsible for review, tests, and commits.

## Actions
- start: start or reuse a Claude Code tmux worker
- run: start/reuse worker, send a structured task, optionally wait for [DONE]
- send: send arbitrary follow-up text to a worker
- capture: capture worker output
- wait: wait until output matches a regex, default \\[DONE\\]
- list: list active tmux sessions
- stop: kill a worker session

Use narrow tasks with explicit file scope and required tests. ClaudeCode workers are external CLI processes; always inspect diff and run verification after they finish.`,
      parameters: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            enum: ['start', 'run', 'send', 'capture', 'wait', 'list', 'stop'],
            description: 'Operation to perform',
          },
          session: {
            type: 'string',
            description: 'tmux session name. Deprecated — prefer runId for runId-keyed operations.',
          },
          runId: {
            type: 'string',
            description: 'Run id returned by a prior run action. Preferred over session for capture/wait/send/stop — resolves to the correct tmux session automatically.',
          },
          command: {
            type: 'string',
            description: '(start/run) Command to launch. Defaults to claude.',
          },
          task: {
            type: 'string',
            description: '(run) Focused task to delegate to Claude Code.',
          },
          instructions: {
            type: 'string',
            description: '(run) Additional constraints, file scope, and verification commands.',
          },
          text: {
            type: 'string',
            description: '(send) Follow-up text to send to the worker.',
          },
          wait: {
            type: 'boolean',
            description: '(run) Wait for completion marker [DONE]. Defaults to false.',
          },
          pattern: {
            type: 'string',
            description: '(wait/run) Regex completion pattern. Defaults to \\[DONE\\].',
          },
          timeoutMs: {
            type: 'number',
            description: '(wait/run) Max wait time in milliseconds. Default 120000.',
          },
          lines: {
            type: 'number',
            description: '(capture/wait/run) Number of pane lines to return. Default 120 for wait/run, 80 for capture. Use 0 for full history.',
          },
        },
        required: ['action'],
      },
    },
  }

  isConcurrencySafe(input: Record<string, unknown>): boolean {
    const action = String(input.action)
    return action === 'capture' || action === 'list'
  }

  async execute(input: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    try {
      switch (String(input.action)) {
        case 'start':
          return await this.startAction(input, ctx)
        case 'run':
          return await this.run(input, ctx)
        case 'send':
          return await this.send(input)
        case 'capture':
          return await this.capture(input)
        case 'wait':
          return await this.waitAction(input, ctx)
        case 'list':
          return await this.list()
        case 'stop':
          return await this.stop(input)
        default:
          return { content: 'Unknown action. Use start | run | send | capture | wait | list | stop.', isError: true }
      }
    } catch (error: unknown) {
      return { content: `ClaudeCode error: ${(error as Error).message}`, isError: true }
    }
  }

  private async startAction(input: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const result = await this.manager.start({
      session: defaultSession(input),
      cwd: ctx.cwd,
      command: str(input.command, 'claude'),
    })
    return {
      content: [
        `ClaudeCode worker: ${result.session}`,
        result.created ? 'Status: started' : 'Status: reused existing session',
        `Synced env: ${result.syncedEnv.length ? result.syncedEnv.join(', ') : 'none'}`,
      ].join('\n'),
      isError: false,
    }
  }

  private async run(input: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const task = str(input.task)
    if (!task) return { content: 'Error: task is required for run.', isError: true }

    // ── ExecutionRun lifecycle (Round 3) ────────────────────────────
    // Create a child run with kind='external_worker' and walk it
    // through queued → preparing → running → waiting → succeeded/
    // failed. Best-effort: registry failures never break the run.
    const registry = this.runRegistry
    let runId: string | undefined
    if (registry) {
      // five_goal P0-2: prefer the per-turn ExecutionContext.runId
      // over the static constructor parentRunId.
      const dynamicParent = ctx.execution?.runId ?? this.parentRunId
      const run = registry.create({
        kind: 'external_worker',
        parentRunId: dynamicParent,
        goal: task,
        workspace: { cwd: ctx.cwd },
        worker: defaultSession(input),
      })
      runId = run.runId
    }
    const transitionRun = (to: RunStatus, patch?: Record<string, unknown>): void => {
      if (!registry || !runId) return
      try { registry.transition(runId, to, patch) } catch { /* best-effort */ }
      // GAP-K: when entering a terminal state, drop the runId→session
      // mapping so future steer() calls for this runId return false
      // instead of writing to a stale tmux pane.
      if (runId && isTerminalRunStatus(to)) {
        this.runSessions.delete(runId)
        this.runTasks.delete(runId)
      }
    }

    try {
      transitionRun('preparing', { phase: 'starting-session' })
      const result = await this.manager.runTask({
        session: defaultSession(input),
        cwd: ctx.cwd,
        command: str(input.command, 'claude'),
        task,
        instructions: str(input.instructions),
      })
      // Stamp the taskId onto the run so observers can correlate with
      // the [TASK_DONE <id>] sentinel in the pane output (P0-5).
      transitionRun('running', { phase: 'task-sent', worker: result.session })
      // GAP-K: record runId→session so steer() can resolve the pane.
      if (runId) {
    this.runSessions.set(runId, result.session)
    if (result.taskId) this.runTasks.set(runId, result.taskId)
        // P1-1: persist taskId so a later detached wait({runId}) binds
        // to THIS task's sentinel, not a stale ^[DONE]$.
        if (result.taskId) this.runTasks.set(runId, result.taskId)
      }

      if (input.wait === true) {
        // P0-5: bind the wait to THIS run's taskId unless the caller
        // supplied a custom pattern (custom pattern wins — explicit
        // opt-out of the task-id matching protocol).
        const customPattern = str(input.pattern) || undefined
        transitionRun('waiting', { phase: 'polling-completion' })
        const waited = await this.manager.waitFor({
          session: result.session,
          pattern: customPattern,
          taskId: customPattern ? undefined : result.taskId,
          timeoutMs: positiveNumber(input.timeoutMs, 120_000),
          lines: nonNegativeNumber(input.lines, 120),
          signal: ctx.signal,
        })
        if (waited.aborted) {
          transitionRun('cancelled', { phase: 'aborted', error: 'wait aborted via signal' })
        } else if (waited.matched) {
          if (waited.matchKind === 'failed') {
            transitionRun('failed', { phase: 'task-failed', error: waited.failureReason ?? 'worker reported TASK_FAILED' })
          } else {
            transitionRun('verifying', { phase: 'completion-matched' })
            transitionRun('succeeded', { phase: 'finalized' })
          }
        } else {
          transitionRun('timed_out', { phase: 'wait-timeout', error: 'waitFor timed out' })
        }
        return {
          content: [
            `ClaudeCode worker: ${result.session}`,
            result.created ? 'Status: started and task sent' : 'Status: reused and task sent',
            waited.matched
              ? (waited.matchKind === 'failed' ? 'Completion: TASK_FAILED' : 'Completion: matched')
              : 'Completion: timed out',
            '',
            waited.output || '(no output)',
          ].join('\n'),
          isError: !waited.matched || waited.matchKind === 'failed',
          runId,
          sessionId: result.session,
          status: waited.matched ? (waited.matchKind === 'failed' ? 'failed' : 'succeeded') : 'timed_out',
        } as ToolResult & { runId?: string; sessionId: string; status: string }
      }

      // P0-6 (five_goal §六): NO `succeeded` transition here. A dispatched-
      // but-not-waited task is NOT complete — the worker is still running
      // in the tmux pane. The Run stays in `waiting` (non-terminal) until
      // the caller explicitly waits, captures, or cancels. The runId→
      // session mapping is RETAINED so a later steer()/status()/collect()
      // can resolve to this same run.
      //
      // The previous behavior (mark `succeeded` immediately on dispatch)
      // violated five_goal §六 P0-6: '任务已发送 → succeeded → 删除
      // runId/session 映射' is explicitly forbidden — it lied to the
      // orchestrator about completion and broke later runId-keyed ops.
      transitionRun('waiting', { phase: 'dispatched-no-wait', detached: true })
      return {
        content: [
          `ClaudeCode worker: ${result.session}`,
          result.created ? 'Status: started and task sent' : 'Status: reused and task sent',
          `Run: ${runId ?? '(untracked)'} (detached — use wait/capture/steer/cancel with this runId)`,
          'Use ClaudeCode({ action: "wait", session: "' + result.session + '" }) or capture to inspect progress.',
        ].join('\n'),
        isError: false,
        // Structured fields for programmatic callers (five_goal §六):
        runId,
        workerId: this.workerKind,
        sessionId: result.session,
        status: 'waiting',
        detached: true,
      } as ToolResult & { runId?: string; workerId: string; sessionId: string; status: string; detached: boolean }
    } catch (err) {
      transitionRun('failed', { phase: 'thrown', error: (err as Error).message })
      throw err
    }
  }

  /**
   * GAP 5.1 (five_goal §六): resolve the tmux session for a tool
   * action. Prefer the runId→session map (populated by the `run`
   * action). Fall back to input.session for callers that haven't
   * migrated to the runId protocol.
   */
  private resolveSession(input: Record<string, unknown>): string | undefined {
    if (typeof input.runId === 'string') {
      const s = this.runSessions.get(input.runId)
      if (s) return s
    }
    if (typeof input.session === 'string') return input.session
    return undefined
  }

  private async send(input: Record<string, unknown>): Promise<ToolResult> {
    const session = this.resolveSession(input)
    if (!session) return { content: 'Error: runId or session is required for send.', isError: true }
    const text = str(input.text)
    if (!text) return { content: 'Error: text is required for send.', isError: true }
    if (!await this.manager.sessionExists(session)) return this.sessionNotFound(session)
    await this.manager.send(session, text)
    return { content: `Sent follow-up to ClaudeCode worker: ${session}`, isError: false }
  }

  private async capture(input: Record<string, unknown>): Promise<ToolResult> {
    const session = this.resolveSession(input)
    if (!session) return { content: 'Error: runId or session is required for capture.', isError: true }
    if (!await this.manager.sessionExists(session)) return this.sessionNotFound(session)
    const output = await this.manager.capture(session, nonNegativeNumber(input.lines, 80))
    return { content: output || '(no output)', isError: false }
  }

  private async waitAction(input: Record<string, unknown>, ctx?: ToolContext): Promise<ToolResult> {
    const session = this.resolveSession(input)
    if (!session) return { content: 'Error: runId or session is required for wait.', isError: true }
    if (!await this.manager.sessionExists(session)) return this.sessionNotFound(session)
    // P1-1 fix: recover THIS run's taskId from the runTasks map so the
    // waitFor() binds to the [TASK_DONE <id>] sentinel of the task that
    // originally populated this run — NOT the legacy ^[DONE]$ pattern
    // (which would match a stale sentinel from a prior task when the
    // tmux session is reused). The previous code read from the registry
    // but the registry only stores the session name in `worker`, never
    // the taskId, so taskId was always undefined here (dead ternary).
    let taskId: string | undefined
    if (typeof input.runId === 'string') {
      taskId = this.runTasks.get(input.runId)
    }
    const customPattern = str(input.pattern) || undefined
    const result = await this.manager.waitFor({
      session,
      pattern: customPattern,
      taskId: customPattern ? undefined : taskId,
      timeoutMs: positiveNumber(input.timeoutMs, 120_000),
      lines: nonNegativeNumber(input.lines, 120),
      signal: ctx?.signal,
    })
    return {
      content: [
        result.matched
          ? (result.matchKind === 'failed'
            ? `TASK_FAILED in ${session}${result.failureReason ? ': ' + result.failureReason : ''}.`
            : `Matched completion pattern in ${session}.`)
          : result.aborted ? `Aborted waiting for ${session}.` : `Timed out waiting for ${session}.`,
        '',
        result.output || '(no output)',
      ].join('\n'),
      isError: !result.matched || result.matchKind === 'failed',
    }
  }

  private async list(): Promise<ToolResult> {
    const sessions = await this.manager.list()
    return {
      content: sessions.length ? `tmux sessions:\n${sessions.map((s) => '  ' + s).join('\n')}` : 'No active tmux sessions.',
      isError: false,
    }
  }

  private async stop(input: Record<string, unknown>): Promise<ToolResult> {
    const session = this.resolveSession(input)
    if (!session) return { content: 'Error: runId or session is required for stop.', isError: true }
    const result = await this.manager.stop(session)
    if (!result.stopped) return this.sessionNotFound(session)
    // GAP 5.1: if resolved via runId, also clean up the mapping + transition.
    if (typeof input.runId === 'string') {
      const runId = input.runId
      this.runSessions.delete(runId)
      this.runTasks.delete(runId)
      if (this.runRegistry) {
        try { this.runRegistry.transition(runId, 'cancelled', { phase: 'stopped-by-caller' }) } catch { /* best-effort */ }
      }
    }
    return { content: `Stopped ClaudeCode worker: ${session}`, isError: false }
  }

  private sessionNotFound(session: string): ToolResult {
    return {
      content: `ClaudeCode worker session not found: ${session}. Use ClaudeCode({ action: "list" }) or /workers list.`,
      isError: true,
    }
  }
}
