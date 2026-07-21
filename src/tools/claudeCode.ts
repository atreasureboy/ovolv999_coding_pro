import type { Tool, ToolContext, ToolDefinition, ToolResult } from '../core/types.js'
import { ClaudeCodeWorkerManager } from '../core/claudeCodeWorkerManager.js'
import { str } from '../core/strings.js'
import { ExecutionRunRegistry, type RunStatus } from '../core/executionRun.js'
import { isTerminalRunStatus } from '../core/executionRun.js'
import type { WorkerAdapter, SteerEventEmitter } from '../core/workerAdapter.js'

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
            description: 'tmux session name. Defaults to ovogo-claude-worker.',
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
          return await this.start(input, ctx)
        case 'run':
          return await this.run(input, ctx)
        case 'send':
          return await this.send(input)
        case 'capture':
          return await this.capture(input)
        case 'wait':
          return await this.wait(input, ctx)
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

  private async start(input: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
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
      try { registry.transition(runId, to, patch as never) } catch { /* best-effort */ }
      // GAP-K: when entering a terminal state, drop the runId→session
      // mapping so future steer() calls for this runId return false
      // instead of writing to a stale tmux pane.
      if (runId && isTerminalRunStatus(to)) {
        this.runSessions.delete(runId)
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
      if (runId) this.runSessions.set(runId, result.session)

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
          // The [TASK_DONE <id>] match is the completion verification
          // for an external worker — route through the canonical
          // verifying → succeeded path.
          transitionRun('verifying', { phase: 'completion-matched' })
          transitionRun('succeeded', { phase: 'finalized' })
        } else {
          transitionRun('timed_out', { phase: 'wait-timeout', error: 'waitFor timed out' })
        }
        return {
          content: [
            `ClaudeCode worker: ${result.session}`,
            result.created ? 'Status: started and task sent' : 'Status: reused and task sent',
            waited.matched ? 'Completion: matched' : 'Completion: timed out',
            '',
            waited.output || '(no output)',
          ].join('\n'),
          isError: !waited.matched,
        }
      }

      // No wait requested — the task was dispatched but completion is
      // unverified. Treat as succeeded (the dispatch itself worked)
      // so observers see a clean terminal state; the caller is
      // responsible for following up with a `wait` or `capture`.
      transitionRun('succeeded', { phase: 'dispatched-no-wait' })
      return {
        content: [
          `ClaudeCode worker: ${result.session}`,
          result.created ? 'Status: started and task sent' : 'Status: reused and task sent',
          'Use ClaudeCode({ action: "wait", session: "' + result.session + '" }) or capture to inspect progress.',
        ].join('\n'),
        isError: false,
      }
    } catch (err) {
      transitionRun('failed', { phase: 'thrown', error: (err as Error).message })
      throw err
    }
  }

  private async send(input: Record<string, unknown>): Promise<ToolResult> {
    const session = defaultSession(input)
    const text = str(input.text)
    if (!text) return { content: 'Error: text is required for send.', isError: true }
    if (!await this.manager.sessionExists(session)) return this.sessionNotFound(session)
    await this.manager.send(session, text)
    return { content: `Sent follow-up to ClaudeCode worker: ${session}`, isError: false }
  }

  private async capture(input: Record<string, unknown>): Promise<ToolResult> {
    const session = defaultSession(input)
    if (!await this.manager.sessionExists(session)) return this.sessionNotFound(session)
    const output = await this.manager.capture(session, nonNegativeNumber(input.lines, 80))
    return { content: output || '(no output)', isError: false }
  }

  private async wait(input: Record<string, unknown>, ctx?: ToolContext): Promise<ToolResult> {
    const session = defaultSession(input)
    if (!await this.manager.sessionExists(session)) return this.sessionNotFound(session)
    const result = await this.manager.waitFor({
      session,
      pattern: str(input.pattern) || undefined,
      timeoutMs: positiveNumber(input.timeoutMs, 120_000),
      lines: nonNegativeNumber(input.lines, 120),
      signal: ctx?.signal,
    })
    return {
      content: [
        result.matched ? `Matched completion pattern in ${session}.` :
          result.aborted ? `Aborted waiting for ${session}.` : `Timed out waiting for ${session}.`,
        '',
        result.output || '(no output)',
      ].join('\n'),
      isError: !result.matched,
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
    const session = defaultSession(input)
    const result = await this.manager.stop(session)
    if (!result.stopped) return this.sessionNotFound(session)
    return { content: `Stopped ClaudeCode worker: ${session}`, isError: false }
  }

  private sessionNotFound(session: string): ToolResult {
    return {
      content: `ClaudeCode worker session not found: ${session}. Use ClaudeCode({ action: "list" }) or /workers list.`,
      isError: true,
    }
  }
}
