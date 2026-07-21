/**
 * ExecutionContext (five_goal.md §三 P0-2).
 *
 * Per-turn execution context dynamically propagated through ToolContext.
 * Replaces the older "parentRunId stored in Tool constructor" pattern,
 * which broke for multi-turn agents because every turn had a different
 * RunId but the Tool instance was reused.
 *
 * Lifecycle:
 *   RuntimeCoordinator.run() mints a TurnRun
 *     → builds ExecutionContext { runId: turnRunId, ... }
 *     → passes it via ToolContext.execution
 *     → ToolExecutor hands the same context to every tool call
 *     → AgentTool reads context.execution.runId as parentRunId for child AgentRun
 *     → ClaudeCodeTool likewise
 *
 * Tools MUST NOT cache the execution context across calls — read it
 * fresh from ToolContext each time.
 */

export interface ExecutionContext {
  /** The RunId of the currently executing TurnRun (or equivalent parent). */
  runId: string
  /** Parent RunId, if this context is itself inside a child run (e.g. a sub-agent turn). */
  parentRunId?: string

  /** Logical workspace identifier — hash of cwd, used for ResourceScheduler isolation. */
  workspaceId: string
  /** Absolute path of the workspace the run operates in. */
  workspacePath: string

  /** AbortSignal bound to the current run's lifetime. */
  signal: AbortSignal

  /** Resolved model id (e.g. 'gpt-4o-mini'). */
  model?: string
  /** Provider id (e.g. 'openai', 'anthropic'). */
  provider?: string

  /** Free-form per-run metadata (call depth, agent preset name, etc.). */
  metadata?: Record<string, unknown>
}

/**
 * Build an ExecutionContext for a fresh turn. The coordinator calls
 * this at the top of `.run()` after minting the TurnRun.
 */
export function buildExecutionContext(params: {
  runId: string
  parentRunId?: string
  cwd: string
  signal: AbortSignal
  model?: string
  provider?: string
  metadata?: Record<string, unknown>
}): ExecutionContext {
  return {
    runId: params.runId,
    parentRunId: params.parentRunId,
    workspaceId: workspaceIdFromPath(params.cwd),
    workspacePath: params.cwd,
    signal: params.signal,
    model: params.model,
    provider: params.provider,
    metadata: params.metadata,
  }
}

/**
 * Stable identifier for a workspace path. Used as the ResourceScheduler
 * workspaceKey so two runs in the same cwd serialize against each
 * other but not against unrelated repos.
 */
export function workspaceIdFromPath(cwd: string): string {
  // Simple hash — not cryptographic. Same input → same id.
  let h = 0
  for (let i = 0; i < cwd.length; i++) {
    h = ((h << 5) - h + cwd.charCodeAt(i)) | 0
  }
  return `ws-${(h >>> 0).toString(36)}`
}
