/**
 * AgentTool — spawn a specialized sub-agent to handle a focused subtask.
 *
 * Features:
 *   - AgentConfig-driven (preset name or custom config)
 *   - Verification gate: auto-run tsc/lint after sub-agent completes
 *   - Call chain tracking: prevent infinite recursion + audit depth
 *   - Parallel execution (multiple Agent calls in one response)
 *
 * Each AgentTool instance carries its OWN (factory, parentConfig,
 * parentRenderer) binding. Call depth is derived from
 * `EngineConfig.initialAgentDepth` on the parent config — there's NO
 * mutable counter on the instance, so concurrent siblings dispatched in
 * the same Promise.all batch all observe the SAME depth value, and the
 * global cap (MAX_CALL_DEPTH) holds across nested spawns without any
 * shared mutable state.
 */

import type { Tool, ToolContext, ToolDefinition, ToolResult, EngineConfig, AgentChildEngineFactory } from '../core/types.js'
import type { TurnOutcome } from '../core/runtime/turnOutcome.js'
import type { AgentConfig } from '../core/agentPresets.js'
import { resolveAgentConfig, validateAgentConfig, PRESET_NAMES } from '../core/agentPresets.js'
import { customAgentNames } from '../core/customAgents.js'
import type { RendererInterface } from '../core/types.js'
import { tmuxLayout } from '../core/tmuxLayout.js'
import { appendFileSync, existsSync, readFileSync } from 'fs'
import { join } from 'path'
import { randomBytes } from 'crypto'
import { withGitMutex } from '../core/gitMutex.js'
import { execSync, execFileSync } from 'child_process'
import { runCommandSync } from '../core/commandRunner.js'
import { str } from '../core/strings.js'
import type { PermissionManager } from '../core/permissionSystem.js'
import { getWorktreeManager, type WorktreeInfo } from './worktree.js'
import type { ExecutionRunRegistry} from '../core/executionRun.js';
import { type RunStatus } from '../core/executionRun.js'
import { isTerminalRunStatus } from '../core/executionRun.js'
import type { WorkerAdapter, SteerEventEmitter, WorkerHandle, WorkerStatus, WorkerResult, WorkerDescriptor, WorkerTask } from '../core/workerAdapter.js'
import {
  AgentModelAssignmentError,
  architectureEscalationReasons,
  resolveAgentModelAssignment,
  type AgentModelAssignment,
  type AgentModelRole,
} from '../core/model/agentModelPolicy.js'

/** Hard cap on agent call chain depth (across nesting).
 * The depth is threaded through `EngineConfig.initialAgentDepth` so the
 * cap stays global across nested sub-agents without storing it on any
 * shared mutable state. */
const MAX_CALL_DEPTH = 5

const AGENT_EVENT_LOG_FILE = 'agent_events.ndjson'

// ── Verification gate (AgentOS §6 "No Tuple, No Merge") ─────────────────────

function packageManagerCommand(cwd: string, script: string, packageManager?: string): string {
  const pm = packageManager?.split('@')[0]
  if (pm === 'bun' || existsSync(join(cwd, 'bun.lock')) || existsSync(join(cwd, 'bun.lockb'))) return `bun run ${script} 2>&1`
  if (pm === 'pnpm' || existsSync(join(cwd, 'pnpm-lock.yaml'))) return `pnpm run ${script} 2>&1`
  if (pm === 'yarn' || existsSync(join(cwd, 'yarn.lock'))) return `yarn ${script} 2>&1`
  return script === 'test' ? 'npm test 2>&1' : `npm run ${script} 2>&1`
}

function readPackageInfo(cwd: string): { scripts: Record<string, string>; packageManager?: string } {
  try {
    const raw = readFileSync(join(cwd, 'package.json'), 'utf8')
    const parsed = JSON.parse(raw) as { scripts?: unknown; packageManager?: unknown }
    return {
      scripts: parsed.scripts && typeof parsed.scripts === 'object' && !Array.isArray(parsed.scripts)
        ? parsed.scripts as Record<string, string>
        : {},
      packageManager: typeof parsed.packageManager === 'string' ? parsed.packageManager : undefined,
    }
  } catch {
    return { scripts: {} }
  }
}

/**
 * Detect appropriate verification commands based on project files.
 * Project scripts win over generic guesses so verification follows local intent.
 */
export function detectVerifyCommands(cwd: string): string[] {
  const has = (f: string): boolean => {
    try { return existsSync(join(cwd, f)) } catch { return false }
  }

  // Python
  if (has('pyproject.toml') || has('setup.py') || has('requirements.txt')) {
    return ['python -m compileall -q . 2>&1']
  }
  // Go
  if (has('go.mod')) {
    return ['go vet ./... 2>&1']
  }
  // Rust
  if (has('Cargo.toml')) {
    return ['cargo check 2>&1']
  }
  // TypeScript / JavaScript
  if (has('package.json')) {
    const { scripts, packageManager } = readPackageInfo(cwd)
    const commands: string[] = []
    const firstTypecheck = scripts.typecheck ? 'typecheck' : scripts.tsc ? 'tsc' : scripts.build ? 'build' : null
    if (firstTypecheck) commands.push(packageManagerCommand(cwd, firstTypecheck, packageManager))
    if (scripts.lint) commands.push(packageManagerCommand(cwd, 'lint', packageManager))
    if (scripts.test) commands.push(packageManagerCommand(cwd, 'test', packageManager))
    if (commands.length > 0) return commands
  }
  if (has('tsconfig.json')) {
    return ['npx tsc --noEmit 2>&1']
  }
  // No known project type — skip verification
  return []
}

/**
 * Run verification commands and return results.
 * Returns null if no commands or all pass, or a formatted failure summary.
 */
export function runVerification(cwd: string): { passed: boolean; output: string } | null {
  const commands = detectVerifyCommands(cwd)
  if (commands.length === 0) return null

  const results: string[] = []
  let allPassed = true

  for (const cmd of commands) {
    // Phase 2: route through CommandRunner instead of execSync. The
    // verification commands are trusted project scripts (package.json
    // scripts / language toolchains), so shell:true is acceptable here
    // (trust boundary = user project config, same as AUDIT-006).
    // CommandRunner adds process-tree kill on timeout, bounded output,
    // and a structured result — execSync gave none of these.
    const label = cmd.split(' ')[1] || cmd
    const res = runCommandSync({
      executable: cmd,
      args: [],
      cwd,
      shell: true,
      timeoutMs: 60_000,
    })
    if (res.exitCode === 0 && !res.timedOut && !res.cancelled) {
      results.push(`✓ ${label} — passed`)
    } else {
      allPassed = false
      const reason = res.timedOut ? 'TIMEOUT' : res.cancelled ? 'CANCELLED' : 'FAILED'
      const trimmed = ((res.stdout ?? '') + (res.stderr ?? '')).trim().slice(0, 800)
      results.push(`✗ ${label} — ${reason}\n${trimmed}`)
    }
  }

  if (results.length === 0) return null
  return { passed: allPassed, output: results.join('\n\n') }
}

// ── Prompt helpers ─────────────────────────────────────────────────────────

function normalizeDelegatedPrompt(prompt: string, config: EngineConfig): string {
  let normalized = prompt
  if (config.sessionDir) {
    normalized = normalized
      .replace(/\bSESSION_DIR\b/g, config.sessionDir)
      .replace(/\/SESSION\b/g, config.sessionDir)
  }
  return normalized
}

interface DelegationContext {
  goal?: string
  constraints?: string[]
  relevantFiles?: string[]
  acceptanceCriteria?: string[]
  decisions?: string[]
}

function normalizeDelegationContext(value: unknown): DelegationContext | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const input = value as Record<string, unknown>
  const strings = (entry: unknown): string[] | undefined => {
    if (!Array.isArray(entry)) return undefined
    const values = entry
      .filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
      .map((item) => item.trim())
    return values.length > 0 ? values : undefined
  }
  const context: DelegationContext = {
    goal: typeof input.goal === 'string' && input.goal.trim() ? input.goal.trim() : undefined,
    constraints: strings(input.constraints),
    relevantFiles: strings(input.relevant_files),
    acceptanceCriteria: strings(input.acceptance_criteria),
    decisions: strings(input.decisions),
  }
  return Object.values(context).some((entry) => entry !== undefined) ? context : undefined
}

function appendAgentEvent(config: EngineConfig, event: Record<string, unknown>): void {
  if (!config.sessionDir) return
  const logPath = join(config.sessionDir, AGENT_EVENT_LOG_FILE)
  const payload = {
    ts: new Date().toISOString(),
    ...event,
  }
  try {
    appendFileSync(logPath, JSON.stringify(payload) + '\n', 'utf8')
  } catch {
    // best-effort audit logging; never break execution on log failure
  }
}

// ── PermissionManager clone helper ──────────────────────────────────────────

/**
 * Commit any pending (unstaged or staged) changes inside a worktree
 * before merging its branch back to base. Sub-agents often edit files
 * via Write/Edit/Bash tools without explicitly running `git commit` —
 * without this auto-commit, those edits would be lost when
 * `git worktree remove --force` wipes the working directory, and the
 * merge would bring back an empty branch.
 *
 * Best-effort: if there's nothing to commit (clean tree), the commit
 * step is skipped silently. Commit failures are swallowed because the
 * orchestrator may have intentionally left the worktree in a
 * half-applied state (e.g. for review); the merge attempt below will
 * surface a more useful error in that case.
 */
function commitPendingChangesInWorktree(wtPath: string, message: string): void {
  try {
    execSync('git add -A', { cwd: wtPath, stdio: 'pipe' })
    // `git diff --cached --quiet` exits 0 when there's nothing staged.
    // If anything is staged, run a commit on the sub-agent's behalf.
    try {
      execSync('git diff --cached --quiet', { cwd: wtPath, stdio: 'pipe' })
    } catch {
      // Non-zero exit means there IS something staged — commit it.
      execFileSync('git', ['commit', '-m', message, '--no-verify'], {
        cwd: wtPath,
        stdio: 'pipe',
      })
    }
  } catch {
    // best-effort — don't crash the finalize path on commit failure
  }
}

/**
 * List unmerged paths after a failed merge. The conflicts live in the
 * repository where the merge was ATTEMPTED (the parent cwd), not in
 * the worktree itself — so `repoCwd` is the parent, not the worktree
 * path. Used by the delivery phase (P0-5) to surface a structured
 * conflict list to the parent agent.
 *
 * Returns relative paths (POSIX) of files in conflicted state, or an
 * empty list if git is unavailable or no conflicts are present. Best-
 * effort — never throws.
 */
function extractMergeConflicts(repoCwd: string): string[] {
  try {
    const out = execSync('git diff --name-only --diff-filter=U', {
      cwd: repoCwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      encoding: 'utf8',
    })
    return out.split('\n').map(s => s.trim()).filter(Boolean)
  } catch {
    return []
  }
}

function worktreeHasChanges(worktreePath: string): boolean {
  try {
    return execSync('git status --porcelain', {
      cwd: worktreePath,
      stdio: ['pipe', 'pipe', 'pipe'],
      encoding: 'utf8',
    }).trim().length > 0
  } catch {
    return false
  }
}

/**
 * Attempt to merge `branch` into the base branch at `repoCwd`. Returns
 * 'ok' on success or the conflict detail on failure. We do NOT use
 * WorktreeManager.removeWorktree({merge:true}) here because that helper
 * blindly deletes the worktree + branch even when the merge fails —
 * we need fine-grained control so we can PRESERVE both on conflict
 * (runtime invariants §五: "保留 Worktree；保留分支；不删除成果").
 */
function attemptMerge(
  repoCwd: string,
  branch: string,
): { ok: true } | { ok: false; conflicts: string[]; message: string } {
  try {
    execFileSync('git', ['merge', branch, '--no-edit'], {
      cwd: repoCwd,
      stdio: 'pipe',
    })
    return { ok: true }
  } catch (err) {
    // Capture conflicts BEFORE running `git merge --abort` (which
    // would reset the working tree). Then abort so the parent repo
    // is not left in a half-merged state — the branch is preserved
    // and the parent can retry later.
    const conflicts = extractMergeConflicts(repoCwd)
    try {
      execSync('git merge --abort', { cwd: repoCwd, stdio: 'pipe' })
    } catch {
      // best-effort — if abort fails the parent repo is messy but
      // at least we have the conflict list to surface.
    }
    return { ok: false, conflicts, message: (err as Error).message }
  }
}

/**
 * Make an independent copy of a PermissionManager so the child engine's
 * permission rules and mode never bleed back into (or get clobbered by)
 * the parent. Wrapped as a small helper to keep the call-site readable
 * and to centralize the "no shared mutable references" invariant.
 *
 * Delegates to PermissionManager.clone() — the helper is here so the
 * agent-tool file's import of PermissionManager is value-typed (not
 * type-only) in one localized spot, and to keep the call-site readable
 * when the clone must precede a child config snapshot.
 */
function clonePermissionManager(mgr: PermissionManager): PermissionManager {
  return mgr.clone()
}

// ── AgentTool ────────────────────────────────────────────────────────────────

/**
 * Wire-up for one AgentTool instance. ALL fields are required when wiring
 * IS supplied: there is no module-level fallback for the factory /
 * parentConfig / parentRenderer, and no fallback for the depth counter.
 * The constructor parameter itself is OPTIONAL so `createTools` can build
 * an AgentTool that returns "not initialized" at action time when no
 * wiring is provided; the runtime guard in `execute()` fires in that case.
 */
export interface AgentToolWiring {
  factory?: AgentChildEngineFactory
  parentConfig?: EngineConfig
  parentRenderer?: RendererInterface
  /** Round 26: injected file-renderer factory (see AgentWiring). */
  createFileRenderer?: (path: string) => RendererInterface
  /**
   * Optional ExecutionRun registry (runtime architecture contract §三 Phase 2). When
   * supplied, every Agent invocation creates a child ExecutionRun,
   * walks it through queued → preparing → running → verifying →
   * succeeded/failed, and exposes it via the registry so UI / logs /
   * queries can observe the run uniformly. When omitted, AgentTool
   * behaves exactly as before (no registry integration).
   */
  runRegistry?: ExecutionRunRegistry
  /**
   * Optional parent run id. When supplied, child runs created by this
   * AgentTool carry parentRunId so the registry can reconstruct the
   * call tree. The host engine sets this when it knows its own runId.
   */
  parentRunId?: string
  /**
   * GAP-K: optional steer-event emitter (host wires to
   * ExecutionRunEventBus.emitSteered). Recorded on a successful
   * steer() so the bus persists + fans out the `run.steered` event.
   */
  onSteered?: SteerEventEmitter
}

export class AgentTool implements Tool, WorkerAdapter {
  name = 'Agent'
  metadata = {
    concurrencySafe: true,
    longRunning: true,
    mutatesState: true,
    // Round 32 (true parallelism): the scheduler only parallelizes calls
    // that declare claims (toolScheduler.ts partition rule). Modify
    // agents mutate their OWN per-invocation worktree (created below)
    // — the exclusive key is the unique worktree path, so siblings never
    // contend; delivery merges serialize via the process-global
    // gitMutex, not via this claim. Read-only agents take a read claim
    // on the shared cwd. Without this field every Agent call ran as its
    // own serial batch — N sub-agents cost the full wall-clock SUM.
    claims: (input: Record<string, unknown>): Array<{ type: 'directory'; key: string; access: 'read' | 'exclusive' }> => {
      const mode = typeof input.task_mode === 'string' ? input.task_mode
        : input.modifies_state === true ? 'modify' : 'read_only'
      const cwd = typeof input.cwd === 'string' ? input.cwd : process.cwd()
      if (mode === 'modify') {
        // Exclusive on a UNIQUE per-invocation key — parallel modify
        // siblings never contend (each owns its worktree); delivery
        // serialization is the process-global gitMutex, not this claim.
        return [{ type: 'directory', key: `wt://agent/${randomBytes(8).toString('hex')}`, access: 'exclusive' }]
      }
      return [{ type: 'directory', key: cwd, access: 'read' }]
    },
  }
  readonly workerKind = 'agent'

  /**
   * GAP-K: runId → queued steer instructions. AgentTool runs its
   * child engine synchronously (runAgentTask awaits childEngine.
   * runTurn()), so there's no live tmux pane to write to. Instead,
   * steer() records the instruction here and runAgentTask picks it
   * up between iterations via the child engine's `injectUserText`
   * hook (when present). This is best-effort: if the child engine
   * doesn't expose the hook, the instruction is dropped.
   *
   * Entries are removed when the run reaches a terminal state.
   */
  private readonly liveChildren = new Map<string, { steer: (instruction: string) => boolean }>()
  /**
   * Phase 4 (provider-runtime contract §七.2): runId → abort trigger for each running
   * in-process child engine. Populated when a child run starts so
   * `cancel(runId)` can ACTUALLY terminate the child (call its
   * `abort()`), not merely transition the registry status. Cleared in
   * the run's `finally`. Without this map, cancel(runId) had no path
   * to the in-flight `runTurn()`.
   */
  private readonly childAborts = new Map<string, () => void>()
  private readonly completedResults = new Map<string, WorkerResult>()
  private readonly onSteeredHook?: SteerEventEmitter

  /** Immutable per-instance wiring — captured once in the constructor and
   * shared by every parallel Agent call dispatched from this tool. May
   * be undefined only when the caller bypasses the type system (e.g.
   * tests using `as any`). `execute()` guards against the runtime
   * misshape and returns "not initialized" instead of dereferencing
   * these fields. */
  private readonly factory: AgentChildEngineFactory | undefined
  private readonly parentConfig: EngineConfig | undefined
  private readonly parentRenderer: RendererInterface | undefined
  private readonly createFileRenderer: ((path: string) => RendererInterface) | undefined
  private readonly runRegistry: ExecutionRunRegistry | undefined
  private readonly parentRunId: string | undefined

  constructor(wiring?: AgentToolWiring) {
    this.factory = wiring?.factory
    this.parentConfig = wiring?.parentConfig
    this.parentRenderer = wiring?.parentRenderer
    this.createFileRenderer = wiring?.createFileRenderer
    this.runRegistry = wiring?.runRegistry
    this.parentRunId = wiring?.parentRunId
    this.onSteeredHook = wiring?.onSteered

    // Field initializers run before the constructor body, so `definition`
    // is already built here. Extend its subagent_type enum with custom
    // agents discovered on disk (.agents/*.md|.json) so the model can
    // dispatch them by name. Best-effort: discovery failures leave the
    // built-in enum untouched.
    const cwd = wiring?.parentConfig?.cwd
    if (cwd) {
      try {
        const extra = customAgentNames(cwd).filter((n) => !PRESET_NAMES.includes(n))
        if (extra.length > 0) {
          const fn = this.definition.function
          const params = fn.parameters as { properties?: Record<string, { enum?: string[]; description?: string }> }
          const prop = params.properties?.subagent_type
          if (prop?.enum) {
            prop.enum = [...prop.enum, ...extra]
            prop.description = `Preset or custom agent name (default: general-purpose). Custom agents: ${extra.join(', ')}`
          }
        }
      } catch {
        /* best-effort — built-in presets stay available */
      }
    }
  }

  /**
   * GAP-K: queue a follow-up instruction for the child sub-agent
   * running the given ExecutionRun. Returns true iff the runId is
   * currently active (registered as 'running' or 'waiting') AND the
   * instruction was queued. Returns false if the run is unknown,
   * terminal, or wasn't tracked by this AgentTool instance.
   *
   * Note: delivery to the child engine's next iteration is
   * best-effort and depends on runAgentTask polling this queue.
   */
  // eslint-disable-next-line @typescript-eslint/require-await
  async steer(runId: string, instruction: string): Promise<boolean> {
    const registry = this.runRegistry
    if (registry) {
      const run = registry.get(runId)
      if (!run || isTerminalRunStatus(run.status)) return false
      // Only accept steer for runs we own and that are mid-flight.
      if (run.status !== 'running' && run.status !== 'waiting' && run.status !== 'preparing') return false
    }
    // Round 32: REAL delivery — forward to the live child engine, which
    // lands it in the in-flight turn's control channel. Returns false
    // when there is no live child (undelivered, never a lying true).
    const child = this.liveChildren.get(runId)
    if (!child) return false
    const delivered = child.steer(instruction)
    if (delivered) this.onSteeredHook?.(runId, instruction)
    return delivered
  }

  // ── WorkerAdapter lifecycle (runtime invariants §六 P0-8) ──────────────────
  //
  // AgentTool's children are synchronous (await runTurn), so most
  // lifecycle ops are stubs that reflect that limitation: there is no
  // long-lived transport to query or kill — by the time start()
  // resolves, the child has already finished. The host should use
  // ClaudeCodeTool or a future background-capable adapter for true
  // detached workers. These stubs exist so the WorkerAdapter contract
  // is uniform across implementations.

  /**
   * Not supported for in-process AgentTool — child engines are
   * synchronous. Use execute() directly. Always rejects.
   */
  // eslint-disable-next-line @typescript-eslint/require-await
  async start(
    _task: WorkerTask,
    _context?: { cwd?: string; signal?: AbortSignal; parentRunId?: string },
  ): Promise<WorkerHandle> {
    throw new Error('AgentTool.start() is not supported — in-process child engines are synchronous. Use AgentTool.execute() instead.')
  }

  /**
   * Query the registry for the child run's current status. Returns
   * 'unknown' for runIds not tracked by this instance's registry.
   */
  // eslint-disable-next-line @typescript-eslint/require-await
  async status(runId: string): Promise<WorkerStatus> {
    const registry = this.runRegistry
    if (!registry) return 'unknown'
    const run = registry.get(runId)
    if (!run) return 'unknown'
    switch (run.status) {
      case 'succeeded': return 'succeeded'
      case 'failed':
      case 'verification_failed':
      case 'timed_out':
      case 'lost':
        return 'failed'
      case 'cancelled': return 'cancelled'
      case 'blocked': return 'waiting'
      default: return 'running'
    }
  }

  /**
   * Abort a running child engine. Sets the abort signal the child
   * observes between iterations. Idempotent.
   */
  // eslint-disable-next-line @typescript-eslint/require-await
  async cancel(runId: string, reason?: string): Promise<void> {
    // Phase 4: actually terminate the running in-process child by
    // firing its abort trigger. This propagates to the child engine's
    // turnAbortController, cancelling its in-flight LLM call / tool
    // execution. Previously cancel() only flipped the registry status
    // and the child kept running to completion.
    const abort = this.childAborts.get(runId)
    if (abort) {
      try { abort() } catch { /* best-effort */ }
    }
    const registry = this.runRegistry
    if (!registry) return
    try {
      registry.transition(runId, 'cancelled', {
        phase: 'cancelled-by-caller',
        error: reason ?? 'cancel() invoked',
      })
    } catch {
      // Already terminal — nothing to do.
    }
    this.liveChildren.delete(runId)
  }

  /**
   * Harvest the child's terminal result. Because AgentTool children
   * are synchronous, this is essentially a status check — the result
   * was already returned via execute(). Output and artifacts are not
   * retained beyond the execute() return.
   */
  async collect(runId: string): Promise<WorkerResult> {
    const completed = this.completedResults.get(runId)
    if (completed) return completed
    const st = await this.status(runId)
    return { runId, status: st }
  }

  private rememberResult(result: WorkerResult): void {
    this.completedResults.set(result.runId, result)
    while (this.completedResults.size > 128) {
      const oldest = this.completedResults.keys().next().value
      if (!oldest) break
      this.completedResults.delete(oldest)
    }
  }

  /**
   * reattach() is not supported for in-process AgentTool — child
   * engines cannot survive a host restart. Always returns null.
   */
  // eslint-disable-next-line @typescript-eslint/require-await
  async reattach?(_runId: string, _descriptor: WorkerDescriptor): Promise<WorkerHandle | null> {
    return null
  }

  definition: ToolDefinition = {
    type: 'function',
    function: {
      name: 'Agent',
      description: `Spawn a specialized sub-agent for a focused task. Multiple Agent calls in one response run concurrently (Promise.all).

## Agent Configuration

Option 1 — Preset name: subagent_type: "explore" | "plan" | "code-reviewer" | "general-purpose" | "coordinator"
Option 2 — Custom config: agent_config: { identity, modules, tools, maxIterations }

## Role-aware model assignment

Sub-agents default to secondary roles. Use model_role to request builder, reviewer, utility, worker, or planner capability.
Only the root main agent may request architect, and it must include escalation_reason.
The runtime resolves that role within configured tier:"secondary"; architect resolves only within tier:"top".
Tier is configured truth. Roles express purpose and never override tier.
Use delegation_context to pass the global goal, constraints, relevant files, decisions, and acceptance criteria.
Use secondary roles for repetitive work, bounded low-level implementation, code reading and summaries, tests, and independent review.
Architecture, cross-module public interfaces, migrations, security boundaries, and root-cause design require architect participation.

## Verification Gate

Set verify: true to auto-run tsc --noEmit after the sub-agent completes code changes.
Failed verification includes error details so you can fix immediately.

## Task Mode (P0-4)

'task_mode' controls isolation, verification, and delivery (replaces 'modifies_state'):

- 'read_only' (default): runs in parent cwd, no worktree, no verification gate. The
  sub-agent is NOT given Write/Edit/Bash-write tools (enforced by tool whitelist).
- 'modify': enforces isolated git worktree, mandatory verification gate (verify=true
  by default), merge-on-success or branch retention, and structured delivery result.

For backward compatibility 'modifies_state: true' is treated as task_mode:'modify'.

## Worktree Isolation (P0-3 fail-closed)

For task_mode:'modify', the Runtime MUST create an isolated git worktree before
spawning the sub-agent. If worktree creation fails (no git repo, disk full, etc.)
the sub-agent is NOT started — the run goes to 'blocked' and a structured error is
returned. There is NO fallback to the parent cwd.

## Delivery Outcome (P0-5)

For modify tasks the result is split into three phases: worker / verification / delivery.
A merge conflict marks the run as 'blocked' (NOT 'failed'), preserves the worktree and
branch, and surfaces conflict file names so a parent agent can resolve manually.

## Rules
- prompt must be fully self-contained (sub-agent has no parent context)
- Prefer delegation_context for durable facts instead of copying the whole conversation
- Treat the returned Worker Result as evidence; the main agent owns final acceptance
- Sub-agent cannot call Agent (no recursion, max depth 5)
- Independent tasks can run concurrently (multiple Agent calls in one response)`,
      parameters: {
        type: 'object',
        properties: {
          description: { type: 'string', description: 'Task label' },
          prompt: { type: 'string', description: 'Full task instructions (must be self-contained)' },
          subagent_type: { type: 'string', enum: PRESET_NAMES, description: 'Preset name (default: general-purpose)' },
          agent_config: { type: 'object', description: 'Custom config (overrides subagent_type)' },
          max_iterations: { type: 'number', description: 'Max iterations (overrides preset default)' },
          verify: { type: 'boolean', description: 'Verification gate: auto-run tsc --noEmit after completion. For task_mode:"modify" this defaults to true; otherwise false.' },
          modifies_state: { type: 'boolean', description: '(Deprecated alias for task_mode:"modify") Task edits files — Runtime auto-creates an isolated git worktree and merges on success. Prefer task_mode.' },
          task_mode: { type: 'string', enum: ['read_only', 'modify'], description: 'P0-4: Task mode. "modify" enforces isolated worktree + verification + structured delivery (default "read_only").' },
          merge_on_success: { type: 'boolean', description: 'When task_mode:"modify", merge the worktree branch back on success (default true). Set false to keep the worktree for manual review.' },
          model_role: { type: 'string', enum: ['architect', 'builder', 'reviewer', 'utility', 'worker', 'planner'], description: 'Capability role used to select the sub-agent model profile. Defaults from subagent_type.' },
          escalation_reason: { type: 'string', description: 'Required when the root main agent requests model_role:"architect". Nested agents cannot request architect.' },
          delegation_context: {
            type: 'object',
            description: 'Structured handoff from the main agent.',
            properties: {
              goal: { type: 'string' },
              constraints: { type: 'array', items: { type: 'string' } },
              relevant_files: { type: 'array', items: { type: 'string' } },
              acceptance_criteria: { type: 'array', items: { type: 'string' } },
              decisions: { type: 'array', items: { type: 'string' } },
            },
          },
        },
        required: ['description', 'prompt'],
      },
    },
  }

  async execute(input: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
    // Runtime guard: every AgentTool instance must be constructed with a
    // complete wiring. The TypeScript type makes this a compile error, but
    // tests / dynamic callers can still bypass it — fail fast with a
    // descriptive "not initialized" error rather than crashing on a
    // downstream undefined access.
    if (!this.factory || !this.parentConfig || !this.parentRenderer) {
      return {
        content: 'Error: AgentTool not initialized. Construct AgentTool with a complete AgentToolWiring (factory, parentConfig, parentRenderer).',
        isError: true,
      }
    }

    const description = str(input.description, 'subtask')
    const prompt      = str(input.prompt, '')
    // P0-4: replace modifies_state with an explicit task_mode enum.
    // Backward compat: `modifies_state: true` aliases to task_mode:'modify'.
    // `modifies_state: false` is NOT interpreted (default read_only applies).
    const inputMode = typeof input.task_mode === 'string'
      ? (input.task_mode === 'modify' ? 'modify' : 'read_only')
      : (input.modifies_state === true ? 'modify' : 'read_only')
    const taskMode: 'read_only' | 'modify' = inputMode
    // P0-4 (runtime invariants §六.2): modify mode FORCES verify=true. The
    // model's verify:false input is IGNORED for modify tasks — only
    // the host config or a trusted human interface can skip
    // verification on a task that will be auto-merged to the base
    // branch. Read-only tasks keep verify as opt-in (default false).
    const verify        = taskMode === 'modify' ? true : input.verify === true
    const modifiesState  = taskMode === 'modify'
    const mergeOnSuccess = input.merge_on_success !== false

    if (!prompt.trim()) {
      return { content: 'Error: prompt cannot be empty', isError: true }
    }

    const presetName = str(input.subagent_type, '') || undefined
    const rawConfig = input.agent_config
    const customConfig = rawConfig ? validateAgentConfig(rawConfig) ?? undefined : undefined
    if (rawConfig && !customConfig) {
      return { content: 'Error: agent_config is malformed — need identity.systemPrompt at minimum', isError: true }
    }
    const agentConfig = resolveAgentConfig({
      preset: customConfig ? undefined : presetName,
      config: customConfig,
    }, this.parentConfig?.cwd ?? context.cwd)
    const agentLabel = customConfig ? 'custom' : (presetName ?? 'general-purpose')
    const requestedRole = typeof input.model_role === 'string'
      && ['architect', 'builder', 'reviewer', 'utility', 'worker', 'planner'].includes(input.model_role)
      ? input.model_role as AgentModelRole
      : undefined
    const delegationContext = normalizeDelegationContext(input.delegation_context)
    const architectureReasons = architectureEscalationReasons([
      description,
      prompt,
      delegationContext ? JSON.stringify(delegationContext) : '',
    ].join('\n'))
    if (architectureReasons.length > 0 && requestedRole !== 'architect') {
      return {
        content: `Error: this delegation requires architect participation (${architectureReasons.join(', ')}). The root main agent must retry with model_role:"architect" and escalation_reason.`,
        isError: true,
      }
    }
    const escalationReason = str(input.escalation_reason, '').trim()
    if (requestedRole === 'architect' && this.parentConfig.agent) {
      return {
        content: 'Error: only the root main agent may request an architect sub-agent',
        isError: true,
      }
    }
    if (requestedRole === 'architect' && !escalationReason) {
      return {
        content: 'Error: escalation_reason is required when requesting an architect sub-agent',
        isError: true,
      }
    }
    let modelAssignment: AgentModelAssignment
    try {
      modelAssignment = resolveAgentModelAssignment(this.parentConfig, {
        agentPreset: agentLabel,
        requestedRole,
      })
    } catch (error) {
      if (error instanceof AgentModelAssignmentError) {
        return { content: `Error: ${error.message}`, isError: true }
      }
      throw error
    }
    if (typeof input.max_iterations === 'number') {
      agentConfig.maxIterations = Math.min(input.max_iterations, 200)
    }

    return this.runAgentTask(
      description,
      prompt,
      agentConfig,
      agentLabel,
      modelAssignment,
      escalationReason || undefined,
      delegationContext,
      verify,
      modifiesState,
      mergeOnSuccess,
      taskMode,
      context,
    )
  }

  // ── runAgentTask — depth is derived, not mutated ─────────────────────────
  //
  // `inheritedDepth` comes from `parentConfig.initialAgentDepth`, which the
  // parent engine sets when it spawns a child. `nextDepth = inheritedDepth + 1`
  // is computed at the start of each invocation; there is NO instance-level
  // mutable counter, so parallel sibling Agent calls dispatched from the
  // SAME parent config all observe the SAME nextDepth (no shared state to
  // race on). The child's childConfig then carries `initialAgentDepth =
  // nextDepth` so the cap propagates through nested spawns.

  private async runAgentTask(
    description: string,
    prompt: string,
    agentConfig: AgentConfig,
    agentLabel: string,
    modelAssignment: AgentModelAssignment,
    escalationReason: string | undefined,
    delegationContext: DelegationContext | undefined,
    verify: boolean,
    modifiesState: boolean,
    mergeOnSuccess: boolean,
    taskMode: 'read_only' | 'modify',
    context: ToolContext,
  ): Promise<ToolResult> {
    // The execute() entry point already validated the wiring is present,
    // so `this.*` are guaranteed defined below.
    const factory = this.factory!
    const parentConfig = this.parentConfig!
    const parentRenderer = this.parentRenderer!

    const inheritedDepth = parentConfig.initialAgentDepth ?? 0
    const nextDepth = inheritedDepth + 1
    if (nextDepth > MAX_CALL_DEPTH) {
      return {
        content: `Max agent call depth (${MAX_CALL_DEPTH}) exceeded — possible recursion. Call chain: ${nextDepth} levels deep.`,
        isError: true,
      }
    }

    const mainRenderer = parentRenderer
    const agentDisplayLabel = `${agentLabel} · ${modelAssignment.tier}/${modelAssignment.role}/${modelAssignment.profileId}`
    mainRenderer.agentStart(description, agentDisplayLabel)
    const agentStartTime = Date.now()
    // Round 32 audit F1: unique per-INVOCATION id. Parallel same-tick
    // siblings with identical descriptions previously minted the same
    // worktree name (Date.now() has zero entropy within a tick) → the
    // second createWorktree threw 'already exists'. This id feeds BOTH
    // the resource-claim key and the worktree name.
    const invocationId = randomBytes(6).toString('hex')

    // ── ExecutionRun lifecycle (runtime architecture contract §三 Phase 2) ───────────────
    // When a registry is wired in, this Agent invocation creates a
    // child run and walks it through the canonical state machine so
    // UI / logs / cancel / state queries can observe every sub-agent
    // uniformly. The registry is OPTIONAL — without it AgentTool
    // behaves exactly as before.
    const registry = this.runRegistry
    let runId: string | undefined
    if (registry) {
      // runtime invariants P0-2: prefer the per-turn ExecutionContext.runId
      // (dynamic — different every turn) over the static constructor
      // parentRunId (a deprecated back-compat fallback). Tools MUST
      // NOT cache parentRunId across calls.
      const dynamicParent = context.execution?.runId ?? this.parentRunId
      const run = registry.create({
        kind: 'agent',
        parentRunId: dynamicParent,
        goal: description,
        workspace: { cwd: context.cwd },
        worker: agentLabel,
        modelProfile: modelAssignment.profileId,
        modelRole: modelAssignment.role,
        modelTier: modelAssignment.tier,
        model: modelAssignment.model,
        provider: modelAssignment.provider,
        budget: {
          maxIterations: agentConfig.maxIterations,
        },
      })
      runId = run.runId
    }
    /** Best-effort transition — registry failures must never break the run. */
    const transitionRun = (to: RunStatus, patch?: Record<string, unknown>): void => {
      if (!registry || !runId) return
      try {
        registry.transition(runId, to, patch)
      } catch {
        // best-effort — registry is observability, not control plane
      }
      // Round 32: drop the live-child registration when the run reaches
      // a terminal state so future steer() calls return false.
      if (runId && isTerminalRunStatus(to)) {
        this.liveChildren.delete(runId)
      }
    }

    transitionRun('preparing', { phase: 'spawning-child' })

    // P0-9: track this subtask in SharedRuntimeState so the runtime
    // surface reflects what's currently in flight. The id is unique
    // per invocation (depth + timestamp + counter) and is removed
    // unconditionally in the finally block below — same pattern as
    // ToolScheduler's activeToolCalls tracking.
    const subtaskId = `${description.slice(0, 40)}|d${nextDepth}|t${agentStartTime}`
    const sharedRuntimeState = context.sharedState
    if (sharedRuntimeState?.activeSubtasks) {
      sharedRuntimeState.activeSubtasks.set(subtaskId, {
        subtaskId,
        description,
        agentLabel,
        startedAt: agentStartTime,
        modelProfile: modelAssignment.profileId,
        modelRole: modelAssignment.role,
        modelTier: modelAssignment.tier,
        model: modelAssignment.model,
        provider: modelAssignment.provider,
      })
    }

    // Structured communication event: INVOKE_SENT (with call depth)
    context.eventLog?.append('invoke_sent', agentLabel, {
      description,
      modules: agentConfig.modules ? Object.keys(agentConfig.modules) : [],
      planMode: agentConfig.identity.planMode ?? false,
      maxIterations: agentConfig.maxIterations,
      modelProfile: modelAssignment.profileId,
      modelRole: modelAssignment.role,
      modelTier: modelAssignment.tier,
      model: modelAssignment.model,
      provider: modelAssignment.provider,
      modelAssignmentSource: modelAssignment.source,
      modelAssignmentReason: modelAssignment.reason,
      call_depth: nextDepth,
      verify_enabled: verify,
    }, [agentLabel, 'invoke'])

    const paneLabel = `[${agentDisplayLabel}] ${description}`
    const paneSlot = tmuxLayout.acquireSlot(paneLabel)
    const childRenderer: RendererInterface = paneSlot && this.createFileRenderer
      ? this.createFileRenderer(paneSlot.logFile)
      : parentRenderer

    // ── P0-3 (runtime invariants §四): Worktree isolation MUST be fail-closed ──
    // For modify tasks the Runtime creates an isolated git worktree
    // BEFORE spawning the sub-agent. If creation fails (no git repo,
    // disk full, path clash, etc.) the sub-agent is NOT started and
    // the run goes to 'blocked' — there is NO fallback to the parent
    // cwd. A modify agent writing the shared parent working tree
    // would race with parallel siblings and pollute the orchestrator's
    // tree, which is exactly what isolation is meant to prevent.
    //
    // Plan-mode agents are exempt — they cannot mutate state by
    // definition, so the worktree is unnecessary. read_only tasks
    // also skip this and run in the parent cwd.
    let wtInfo: WorktreeInfo | null = null
    if (modifiesState && !agentConfig.identity.planMode) {
      const safeDesc = description.replace(/[^a-zA-Z0-9_-]/g, '-').slice(0, 24) || 'task'
      const wtName = `agent-d${nextDepth}-${agentStartTime}-${invocationId}-${safeDesc}`
      try {
        const mgr = getWorktreeManager(context.cwd)
        wtInfo = mgr.createWorktree(wtName)
      } catch (err) {
        // P0-3 fail-closed: NO parent-cwd fallback. Transition the
        // run to 'blocked' (retryable), emit a structured error, and
        // abort the invocation. The parent agent can retry, switch
        // to read_only, or fall back to a temporary_copy policy
        // explicitly — but the Runtime never silently lets a modify
        // task loose on the shared working tree.
        appendAgentEvent(parentConfig, {
          event: 'worktree.create_failed',
          agent_label: agentLabel,
          description,
          error: (err as Error).message,
        })
        transitionRun('blocked', {
          phase: 'worktree-create-failed',
          error: (err as Error).message,
          retryable: true,
        })
        mainRenderer.agentDone(description, false)
        if (paneSlot && this.createFileRenderer) { tmuxLayout.releaseSlot(paneSlot.slot); childRenderer.destroy() }
        else if (paneSlot) { tmuxLayout.releaseSlot(paneSlot.slot) }
        // This early return predates the try/finally that deregisters the
        // subtask — without this delete the entry leaks forever and every
        // later "N workers still running" surface sees a phantom.
        sharedRuntimeState?.activeSubtasks?.delete(subtaskId)
        return {
          content: `[${agentLabel}] "${description}" blocked: unable to create isolated worktree — ${(err as Error).message}`,
          isError: true,
          // Structured fields (consumed by future ToolResult normalizer):
          status: 'blocked',
          summary: 'Unable to create isolated workspace for modify task',
          retryable: true,
          diagnostics: [{
            code: 'WORKTREE_CREATION_FAILED',
            message: (err as Error).message,
          }],
        } as ToolResult & { status: string; summary: string; retryable: boolean; diagnostics: { code: string; message: string }[] }
      }
    }
    const effectiveCwd = wtInfo?.path ?? context.cwd

    const childConfig: EngineConfig = {
      ...parentConfig,
      agent: agentConfig,
      model: modelAssignment.model,
      provider: modelAssignment.provider,
      apiKey: modelAssignment.apiKey,
      baseURL: modelAssignment.baseURL,
      // P0-4: when a worktree was created, the child runs INSIDE it.
      // All child tool calls (Bash/Read/Write/Edit) resolve paths
      // against this cwd, so modifications land on the isolated
      // branch, not the parent's working tree.
      cwd: effectiveCwd,
      hookRunner: undefined,
      sessionDir: undefined,
      // Round 31 (sub-agent ↔ sub-agent todo isolation): every child gets
      // its own logical TodoStore scope — sessionDir stays undefined so
      // nothing persists, and parallel siblings can't clobber each other.
      todoScopeId: `agent-${randomBytes(8).toString('hex')}`,
      // Thread depth so the child engine's AgentTool derives the SAME
      // nextDepth = inheritedDepth + 1 = nextDepth + 1 hop later, even
      // though we don't mutate any counter on the parent side.
      initialAgentDepth: nextDepth,
      // ── Isolated PermissionManager for the child engine ────────
      // Spread of `parentConfig` would otherwise hand the child the
      // SAME PermissionManager instance the parent is using — meaning
      // the child's addRule / removeRule / setMode would mutate the
      // parent's permission state, and a parent's mode cycle would
      // silently change what the child auto-approves. Clone via the
      // manager's own `clone()` so rules + mode are decoupled from
      // the parent's instance. Pass `undefined` (not the parent's
      // manager) when no manager is configured — the child engine
      // creates a fresh one from `permissionMode` itself.
      permissionManager: parentConfig.permissionManager
        ? clonePermissionManager(parentConfig.permissionManager)
        : undefined,
    }

    const childEngine = factory(childConfig, childRenderer)

    const normalizedPrompt = normalizeDelegatedPrompt(prompt, parentConfig)
    const placeholdersReplaced = normalizedPrompt !== prompt
    const inheritedContextLines = [
      `- session_dir: ${parentConfig.sessionDir ?? 'not set'}`,
      `- call_depth: ${nextDepth}`,
      `- model_role: ${modelAssignment.role}`,
      `- model_tier: ${modelAssignment.tier}`,
      `- model_profile: ${modelAssignment.profileId}`,
      `- model: ${modelAssignment.provider}/${modelAssignment.model}`,
      ...(escalationReason ? [`- escalation_reason: ${escalationReason}`] : []),
    ]

    const sessionDirHint = parentConfig.sessionDir
      ? `\n- Session dir: ${parentConfig.sessionDir}`
      : ''
    const delegatedPrompt = [
      '[Delegation Contract]',
      '- Strictly follow the "Task Instructions" below. Do not change task scope.',
      '- If user/main agent gave explicit constraints, treat them as highest priority.',
      '- If information is missing and blocks execution, report what is missing. Do not guess.',
      '- If bounded work uncovers an architecture, public-interface, migration, security-boundary, or root-cause decision, stop and return it as a blocker for the root main agent.',
      '- If SESSION_DIR placeholder appears, use the value from "Inherited Context" below.',
      sessionDirHint,
      '',
      '[Inherited Context]',
      ...inheritedContextLines,
      '',
      '[Task Description]',
      description,
      ...(delegationContext ? [
        '',
        '[Structured Context]',
        JSON.stringify(delegationContext, null, 2),
      ] : []),
      '',
      '[Task Instructions]',
      normalizedPrompt,
    ].join('\n')

    appendAgentEvent(parentConfig, {
      event: 'delegation.start',
      agent_label: agentLabel,
      description,
      max_iterations: agentConfig.maxIterations,
      call_depth: nextDepth,
      model_profile: modelAssignment.profileId,
      model_role: modelAssignment.role,
      model_tier: modelAssignment.tier,
      model: modelAssignment.model,
      provider: modelAssignment.provider,
      escalation_reason: escalationReason,
      verify_enabled: verify,
      placeholders_replaced: placeholdersReplaced,
      prompt_preview: normalizedPrompt.slice(0, 500),
    })

    // ── Lifecycle scaffolding: timer + abort listener, BOTH torn down
    //    in `finally` regardless of how the function exits (success,
    //    error, or pre-aborted early return). Setup is hoisted ABOVE
    //    the pre-aborted check so the timer exists even on the early-
    //    return path — otherwise the `finally` would skip a timer that
    //    was never created, leaving callers to wonder whether the
    //    "no clearInterval" path is intentional or a leak.
    //
    // Heartbeat: `unref()` so a still-active interval does not keep
    // the Node.js event loop alive on process exit. The interval is
    // also cleared in `finally` so we don't leak a callback when the
    // child finishes (success/error/abort). unref() is a Node-specific
    // extension; the optional-chain tolerates non-Node runtimes.
    const HEARTBEAT_MS = 2 * 60 * 1000
    const heartbeatTimer = setInterval(() => {
      const elapsedSec = Math.round((Date.now() - agentStartTime) / 1000)
      mainRenderer.agentHeartbeat(agentDisplayLabel, description, elapsedSec)
    }, HEARTBEAT_MS)
    if (typeof heartbeatTimer.unref === 'function') heartbeatTimer.unref()

    // Abort listener: store in a named variable so `finally` can
    // remove it. The previous anonymous-arrow pattern meant the
    // listener could never be detached — a long-lived parent signal
    // would retain a reference to `childEngine` forever, defeating
    // the `dispose()` teardown below. `{ once: true }` keeps the
    // fire-and-forget semantics so we don't need to track removal
    // for the "abort already fired" case, but explicit removal is
    // still required on the normal (no-abort) exit path.
    let abortListener: (() => void) | null = null

    try {
      // Phase 4: register this child's abort trigger keyed by runId so
      // cancel(runId) can terminate the running child directly — not
      // just flip the registry status. Independent of the parent-signal
      // wiring below: a caller-initiated cancel(runId) must reach the
      // child even when the parent turn's signal is not aborted.
      if (runId) this.childAborts.set(runId, () => childEngine.abort())

      if (context.signal) {
        if (context.signal.aborted) {
          // Pre-aborted path: the parent task was already cancelled
          // BEFORE we got to attach our abort listener. Surface a
          // synthetic cancellation result and let `finally` clean up
          // the timer + dispose the child. Without the move-into-try
          // refactor, the early `return` would skip both — leaking
          // the heartbeat timer AND leaving the child engine's
          // background tasks (its BackgroundTaskManager, transient
          // caches) running indefinitely.
          mainRenderer.agentDone(description, false)
          if (paneSlot && this.createFileRenderer) { tmuxLayout.releaseSlot(paneSlot.slot); childRenderer.destroy() }
        else if (paneSlot) { tmuxLayout.releaseSlot(paneSlot.slot) }
          transitionRun('cancelled', { phase: 'pre-aborted', error: 'parent task aborted before spawn' })
          return { content: `[${agentLabel}] Cancelled (parent task aborted)`, isError: true }
        }
        abortListener = () => childEngine.abort()
        context.signal.addEventListener('abort', abortListener, { once: true })
      }

      let result: { output: string; reason: string; completionStatus?: string }
      let childOutcome: TurnOutcome | undefined
      transitionRun('running', { phase: 'child-turn' })
      // Round 32: expose the live engine so steer(runId) reaches it
      // mid-run. Optional-steer typing keeps test stubs valid; when the
      // child can't steer, steer() reports undelivered (never lies).
      if (runId && typeof childEngine.steer === 'function') {
        this.liveChildren.set(runId, { steer: (i: string) => childEngine.steer!(i) })
      }
      try {
        const turnResult = await childEngine.runTurn(delegatedPrompt, [])
        result = turnResult.result
        childOutcome = turnResult.outcome
      } finally {
        if (runId) this.liveChildren.delete(runId)
      }
      const durationMs = Date.now() - agentStartTime

      // ── P0-5 (runtime invariants §五): three-phase outcome split ───────────────
      // Each phase is tracked independently so a merge conflict does NOT
      // get masked by `failed = workerFailed || verificationFailed` and
      // leave the orchestrator unable to tell "sub-agent crashed" apart
      // from "sub-agent finished fine, parent branch moved under it".
      //
      //   phase 1 — worker: did the engine run to completion?
      //   phase 2 — verification: did typecheck/lint/tests pass?
      //   phase 3 — delivery: did the merge (or branch retention) succeed?
      //
      // Final run-status mapping:
      //   worker error                → failed
      //   worker ok + verify fail     → verification_failed
      //   worker ok + verify ok +
      //     merge conflict            → blocked   (worktree PRESERVED)
      //   worker ok + verify ok +
      //     delivery ok               → succeeded
      // v0.3.4 (durable supervisor contract §Phase 2): the worker failed if the LLM turn
      // errored OR if the completion status from the outcome is not
      // 'completed'. Previously only reason === 'error' was checked, which
      // let 'blocked'/'partial' child runs be treated as worker success.
      const workerFailed = result.reason === 'error'
        || (result.completionStatus !== undefined && result.completionStatus !== 'completed')
      if (process.env.R32_DEBUG) console.error('CHILD-VERDICT', JSON.stringify({ reason: result.reason, completionStatus: result.completionStatus, completionReasons: (result as { completionReasons?: string[] }).completionReasons }))
      let verifyOutcome: { ran: boolean; passed: boolean } = { ran: false, passed: true }
      let verificationCommands: string[] = []
      let verificationOutput: string | undefined
      // deliveryOutcome is assigned inside the worktree delivery block
      // (possibly within the withGitMutex closure) — definite-assignment
      // via the initializer on the declaration below.
      type DeliveryOutcome =
        | { status: 'delivered'; branch: string }
        | { status: 'kept_for_review'; branch: string; path: string }
        | { status: 'conflict'; branch: string; conflicts: string[]; message: string }
        | { status: 'not_required' }
      let deliveryOutcome: DeliveryOutcome = { status: 'not_required' }
      // Assignments happen inside the withGitMutex closure — the
      // control-flow analyzer can't see them, so reads go through this
      // alias to defeat (unsound) narrowing to the initializer.
      const delivery = (): DeliveryOutcome => deliveryOutcome

      // ── Verification Gate (AgentOS "No Tuple, No Merge") ──
      // A sub-agent that finishes "successfully" (reason !== 'error')
      // but leaves the workspace with failing typecheck/lint/test MUST
      // propagate as isError — otherwise the parent has no structured
      // signal and must parse natural language to discover the failure.
      // Verify runs in the EFFECTIVE cwd (worktree path when isolated)
      // so the gate measures the isolated branch's state, not parent's.
      let verifySection = ''
      if (verify && !workerFailed && !agentConfig.identity.planMode) {
        transitionRun('verifying', { phase: 'verify-commands' })
        verificationCommands = detectVerifyCommands(effectiveCwd)
        const verifyResult = runVerification(effectiveCwd)
        if (verifyResult) {
          const icon = verifyResult.passed ? '✓' : '✗'
          verifySection = `\n\n---\n[Verify Gate] ${icon}\n${verifyResult.output}`
          verifyOutcome = { ran: true, passed: verifyResult.passed }
          verificationOutput = verifyResult.output

      context.eventLog?.append('invoke_completed', agentLabel, {
            description,
            verified: true,
            verification_passed: verifyResult.passed,
          }, [agentLabel, 'verify', verifyResult.passed ? 'passed' : 'failed'])
        }
      }

      const verificationFailed = verifyOutcome.ran && !verifyOutcome.passed
      const workerAndVerifyOk = !workerFailed && !verificationFailed

      // ── Delivery phase (P0-5) ───────────────────────────────────────
      // Only runs when worker + verify both succeeded. Delivery may be:
      //   - merge (default): fast-forward or 3-way merge to base branch
      //   - kept_for_review (merge_on_success:false): branch preserved
      //   - not_required: read_only task with no worktree
      // On merge conflict the worktree + branch are PRESERVED so a parent
      // agent (or human) can inspect and resolve; the run goes to
      // 'blocked' (NOT 'failed') because the sub-agent's work was sound.
      let worktreeSection = ''
      if (wtInfo) {
        const capturedBranch = wtInfo.branch
        const capturedName = wtInfo.name
        const capturedPath = wtInfo.path
        const capturedBase = wtInfo.baseBranch
        const mgr = getWorktreeManager(context.cwd)
        if (!workerAndVerifyOk) {
          worktreeSection = `\n\n---\n[Worktree] preserved ${capturedBranch} at ${capturedPath} (worker/verify incomplete)`
          deliveryOutcome = { status: 'kept_for_review', branch: capturedBranch, path: capturedPath }
          context.eventEmitter?.emit({ type: 'AGENT_WORKTREE_PRESERVED', runId: runId ?? 'unknown', branch: capturedBranch, reason: 'worker_or_verify_incomplete' })
        } else if (!mergeOnSuccess) {
          // Keep-for-review: leave worktree + branch intact.
          worktreeSection = `\n\n---\n[Worktree] kept ${capturedBranch} at ${capturedPath} (merge_on_success:false)`
          deliveryOutcome = { status: 'kept_for_review', branch: capturedBranch, path: capturedPath }
          context.eventEmitter?.emit({ type: 'AGENT_WORKTREE_PRESERVED', runId: runId ?? 'unknown', branch: capturedBranch, reason: 'merge_on_success_disabled' })
        } else {
          // Delivery: merge. Auto-commit any uncommitted sub-agent
          // edits first so they aren't silently dropped by
          // `git worktree remove --force`.
          //
          // Round 32 (parallel-safe delivery): the merge + worktree
          // removal mutate the SHARED parent tree. Sibling agents can
          // now finalize concurrently (parallel Agent dispatch), and
          // each engine owns a separate ResourceScheduler — so exclusivity
          // comes from the process-global gitMutex, FIFO. Verify already
          // ran OUTSIDE the mutex (per-worktree, no shared state) so the
          // critical section stays as short as possible.
          worktreeSection = await withGitMutex(async () => {
            commitPendingChangesInWorktree(capturedPath, `agent: ${description}`)
            // Inline the merge (rather than calling
            // WorktreeManager.removeWorktree({merge:true})) so we can
            // capture the conflict list and PRESERVE the branch + worktree
            // on failure. The shared helper deletes the branch even when
            // the merge fails, which violates runtime invariants §五 P0-5
            // ("保留 Worktree；保留分支；不删除成果").
            context.eventEmitter?.emit({ type: 'AGENT_MERGE_STARTED', runId: runId ?? 'unknown', branch: capturedBranch })
            const mergeRes = attemptMerge(context.cwd, capturedBranch)
            if (mergeRes.ok) {
              context.eventEmitter?.emit({ type: 'AGENT_MERGE_COMPLETED', runId: runId ?? 'unknown', branch: capturedBranch })
              // Merge succeeded — now safe to remove worktree + branch.
              try {
                mgr.removeWorktree(capturedName, { merge: false, deleteBranch: true })
              } catch {
                // best-effort cleanup; merge already happened so the
                // changes are on the base — leaking the dir is benign.
              }
              deliveryOutcome = { status: 'delivered', branch: capturedBranch }
              return `\n\n---\n[Worktree] merged ${capturedBranch} → ${capturedBase}`
            }
            // P0-5: merge conflict. PRESERVE the worktree + branch so
            // a parent agent (or human) can resolve. Surface the
            // conflict list. Run → 'blocked' (retryable). We do NOT
            // call removeWorktree — that would wipe the work.
            deliveryOutcome = { status: 'conflict', branch: capturedBranch, conflicts: mergeRes.conflicts, message: mergeRes.message }
            context.eventEmitter?.emit({ type: 'AGENT_WORKTREE_PRESERVED', runId: runId ?? 'unknown', branch: capturedBranch, reason: `merge_conflict: ${mergeRes.message}` })
            return `\n\n---\n[Worktree] delivery blocked: ${mergeRes.message}\n[Conflicts] ${mergeRes.conflicts.length ? mergeRes.conflicts.join(', ') : '(unavailable)'}\n[Branch preserved] ${capturedBranch} at ${capturedPath}`
          })
        }
        // wtInfo is consumed — null it so the catch/finally paths
        // below don't double-finalize. NOTE: in the keep-for-review
        // and conflict paths the worktree + branch are intentionally
        // left alive, but we still null wtInfo so the finally
        // safety-net doesn't force-discard them.
        wtInfo = null
      }

      // ── P0-5: final status is derived from the three phases, not
      // from a single `failed` boolean. This is the critical fix —
      // previously a merge conflict left the run as 'succeeded'
      // (worker+verify both passed) which lied to the orchestrator.
      // ──────────────────────────────────────────────────────────
      const isError: boolean =
        workerFailed || verificationFailed || delivery().status === 'conflict'

      let finalStatus: RunStatus
      if (workerFailed) {
        finalStatus = 'failed'
      } else if (verificationFailed) {
        finalStatus = 'verification_failed'
      } else if (delivery().status === 'conflict') {
        finalStatus = 'blocked'
      } else {
        finalStatus = 'succeeded'
      }

      mainRenderer.agentDone(description, !isError)
      if (paneSlot && this.createFileRenderer) { tmuxLayout.releaseSlot(paneSlot.slot); childRenderer.destroy() }
        else if (paneSlot) { tmuxLayout.releaseSlot(paneSlot.slot) }

      transitionRun(finalStatus, {
        phase: 'finalized',
        error: workerFailed
          ? (result.reason || 'run failed')
          : verificationFailed
            ? 'verification gate failed'
            : delivery().status === 'conflict'
              ? `delivery blocked: ${(delivery() as { message?: string }).message}`
              : undefined,
        verification: verificationFailed ? {
          passed: false,
          commands: [],
          startedAt: new Date(agentStartTime).toISOString(),
          completedAt: new Date().toISOString(),
        } : undefined,
        delivery: deliveryOutcome,
        retryable: delivery().status === 'conflict',
      })

      // v0.3.4 (durable supervisor contract §Phase 2): emit structured agent completion events
      // through BOTH the EventLog (for /trace replay) and the Registry's
      // event bus (for real-time subscribers).
      const accepted = finalStatus === 'succeeded'
      context.eventLog?.append('agent_completion', agentLabel, {
        description,
        final_status: finalStatus,
        delivery: deliveryOutcome.status,
        accepted,
      }, [agentLabel, accepted ? 'success' : 'error'])

      if (accepted) {
        context.eventEmitter?.emit({ type: 'AGENT_COMPLETION_ACCEPTED', runId: runId ?? 'unknown', description })
      } else {
        context.eventEmitter?.emit({ type: 'AGENT_COMPLETION_REJECTED', runId: runId ?? 'unknown', description, reason: finalStatus })
      }

      // Emit through the registry's onEmit hook (if wired to EventBus)
      if (this.runRegistry?.onEmit && runId) {
        try {
          const run = this.runRegistry.get(runId)
          // When the run is missing from the registry (e.g. an agent
          // spawned before the registry existed), synthesize a minimal
          // terminal record so the transition event still fires. The
          // `phase`/`acceptance`/`budget`/`resources`/`artifacts` fields
          // default to empty values — this is a best-effort emit inside
          // a try/catch, never the authoritative record.
          this.runRegistry.onEmit({
            kind: 'transition',
            run: run ?? {
              runId,
              kind: 'agent',
              status: finalStatus,
              goal: description,
              workspace: { cwd: context.cwd },
              phase: 'completed',
              acceptance: [],
              budget: {},
              resources: [],
              artifacts: [],
              createdAt: '',
              updatedAt: '',
            },
            from: 'running',
            to: finalStatus,
          })
        } catch { /* best-effort */ }
      }

      const deliveryNow = delivery()
      const worktreeOutcomeLegacy =
        deliveryNow.status === 'delivered' ? { branch: deliveryNow.branch, merged: true }
        : deliveryNow.status === 'kept_for_review' ? { branch: deliveryNow.branch, merged: false }
        : deliveryNow.status === 'conflict' ? { branch: deliveryNow.branch, merged: false }
        : undefined

      context.eventLog?.append('invoke_completed', agentLabel, {
        description,
        success: !isError,
        reason: result.reason,
        final_status: finalStatus,
        worker_failed: workerFailed || undefined,
        verification_failed: verificationFailed || undefined,
        delivery: deliveryOutcome,
        worktree: worktreeOutcomeLegacy,
        duration_ms: durationMs,
        call_depth: nextDepth,
        output_preview: result.output.slice(0, 500),
      }, [agentLabel, 'invoke', !isError ? 'success' : 'error'])

      const summaryLines = result.output
        .split('\n')
        .map((l: string) => l.trimEnd())
        .filter((l: string) => l.trim().length > 0)
        .slice(0, 8)
        .join('\n')
      const workerResult: WorkerResult = {
        runId: runId ?? `untracked-${agentStartTime}`,
        status: finalStatus === 'succeeded' ? 'succeeded' : 'failed',
        outcomeStatus: childOutcome?.completion.status ?? finalStatus,
        output: result.output || undefined,
        summary: summaryLines || `${description}: ${finalStatus}`,
        changedFiles: childOutcome?.changedFiles ?? [],
        verification: {
          executed: verifyOutcome.ran,
          passed: verifyOutcome.passed,
          commands: verificationCommands,
          output: verificationOutput,
        },
        blockers: childOutcome?.completion.reasons ?? [],
        requiredNextActions: childOutcome?.completion.requiredNextActions ?? [],
        modelAttempts: childOutcome?.modelAttempts?.map((attempt: { provider: string; model: string; status: string; startedAt: number; endedAt: number; estimatedCost?: number; usage?: unknown }) => ({
          provider: attempt.provider,
          model: attempt.model,
          status: attempt.status,
          latencyMs: Math.max(0, attempt.endedAt - attempt.startedAt),
          estimatedCost: attempt.estimatedCost ?? 0,
          usage: attempt.usage as { inputTokens: number; outputTokens: number } | undefined,
        })) ?? [],
        estimatedCost: childOutcome?.modelAttempts?.reduce(
          (total: number, attempt: { estimatedCost?: number }) => total + (attempt.estimatedCost ?? 0),
          0,
        ) ?? 0,
        worktree: (() => {
          const d = delivery()
          return d.status === 'not_required'
            ? undefined
            : {
                branch: (d as { branch?: string }).branch,
                path: d.status === 'kept_for_review' ? d.path : undefined,
                delivery: d.status,
              }
        })(),
        model: {
          profileId: modelAssignment.profileId,
          role: modelAssignment.role,
          tier: modelAssignment.tier,
          provider: modelAssignment.provider,
          model: modelAssignment.model,
          apiKeyEnv: modelAssignment.apiKeyEnv,
          source: modelAssignment.source,
          reason: modelAssignment.reason,
        },
      }
      if (runId) this.rememberResult(workerResult)
      for (const attempt of childOutcome?.modelAttempts ?? []) {
        if (attempt.usage) {
          context.recordModelUsage?.(
            attempt.model,
            attempt.usage,
            Math.max(0, attempt.endedAt - attempt.startedAt),
          )
        }
      }
      if (sharedRuntimeState?.completedSubtasks) {
        sharedRuntimeState.completedSubtasks.set(workerResult.runId, {
          runId: workerResult.runId,
          status: workerResult.status,
          outcomeStatus: workerResult.outcomeStatus,
          modelProfile: workerResult.model?.profileId,
          modelRole: workerResult.model?.role,
          modelTier: workerResult.model?.tier,
          model: workerResult.model?.model,
          provider: workerResult.model?.provider,
          changedFiles: workerResult.changedFiles,
          worktree: workerResult.worktree?.path,
          branch: workerResult.worktree?.branch,
        })
      }
      const handoff = {
        runId: workerResult.runId,
        status: workerResult.status,
        outcomeStatus: workerResult.outcomeStatus,
        summary: workerResult.summary,
        changedFiles: workerResult.changedFiles,
        verification: workerResult.verification,
        blockers: workerResult.blockers,
        requiredNextActions: workerResult.requiredNextActions,
        modelAttempts: workerResult.modelAttempts,
        estimatedCost: workerResult.estimatedCost,
        worktree: workerResult.worktree,
        model: workerResult.model,
      }
      const handoffSection = `\n\n---\n[Worker Result]\n${JSON.stringify(handoff, null, 2)}`

      if (!result.output) {
        return {
          content: `[${agentLabel}] "${description}" done (${result.reason}), no text output.${verifySection}${worktreeSection}${handoffSection}`,
          isError,
          status: finalStatus,
          runId: workerResult.runId,
          workerResult,
          summary: delivery().status === 'conflict'
            ? `delivery blocked: ${(delivery() as { message?: string }).message}`
            : undefined,
          retryable: delivery().status === 'conflict' || undefined,
        } as ToolResult & { status: RunStatus; summary?: string; retryable?: boolean }
      }

      if (summaryLines) {
        mainRenderer.agentSummary(agentDisplayLabel, description, summaryLines)
      }

      return {
        content: `[${agentLabel}] "${description}":\n\n${result.output}${verifySection}${worktreeSection}${handoffSection}`,
        isError,
        status: finalStatus,
        runId: workerResult.runId,
        workerResult,
        summary: (() => {
          const d = delivery()
          return d.status === 'conflict' ? `delivery blocked: ${d.message}` : undefined
        })(),
        conflicts: (() => {
          const d = delivery()
          return d.status === 'conflict' ? d.conflicts : undefined
        })(),
        retryable: delivery().status === 'conflict' || undefined,
      } as ToolResult & { status: RunStatus; summary?: string; conflicts?: string[]; retryable?: boolean }
    } catch (err: unknown) {
      mainRenderer.agentDone(description, false)
      if (paneSlot && this.createFileRenderer) { tmuxLayout.releaseSlot(paneSlot.slot); childRenderer.destroy() }
        else if (paneSlot) { tmuxLayout.releaseSlot(paneSlot.slot) }
      transitionRun('failed', { phase: 'thrown', error: (err as Error).message })
      let preservedWorktree: { branch: string; path: string } | undefined
      if (wtInfo) {
        if (worktreeHasChanges(wtInfo.path)) {
          preservedWorktree = { branch: wtInfo.branch, path: wtInfo.path }
        } else {
          try {
            getWorktreeManager(context.cwd).removeWorktree(wtInfo.name, { deleteBranch: true })
          } catch (cleanupError) {
            void cleanupError
          }
        }
        wtInfo = null
      }
      appendAgentEvent(parentConfig, {
        event: 'delegation.error',
        agent_label: agentLabel,
        description,
        success: false,
        duration_ms: Date.now() - agentStartTime,
        error: (err as Error).message,
      })
      const failedWorkerResult: WorkerResult = {
        runId: runId ?? `untracked-${agentStartTime}`,
        status: 'failed',
        outcomeStatus: 'failed',
        summary: `${description}: ${(err as Error).message}`,
        error: (err as Error).message,
        changedFiles: [],
        verification: { executed: false, passed: false, commands: [] },
        blockers: [(err as Error).message],
        requiredNextActions: preservedWorktree
          ? [`Inspect and continue from ${preservedWorktree.path}`]
          : ['Retry with corrected instructions or configuration'],
        worktree: preservedWorktree
          ? { ...preservedWorktree, delivery: 'kept_for_review' }
          : undefined,
        model: {
          profileId: modelAssignment.profileId,
          role: modelAssignment.role,
          tier: modelAssignment.tier,
          provider: modelAssignment.provider,
          model: modelAssignment.model,
          apiKeyEnv: modelAssignment.apiKeyEnv,
          source: modelAssignment.source,
          reason: modelAssignment.reason,
        },
      }
      if (runId) this.rememberResult(failedWorkerResult)
      if (sharedRuntimeState?.completedSubtasks) {
        sharedRuntimeState.completedSubtasks.set(failedWorkerResult.runId, {
          runId: failedWorkerResult.runId,
          status: 'failed',
          outcomeStatus: 'failed',
          modelProfile: modelAssignment.profileId,
          modelRole: modelAssignment.role,
          modelTier: modelAssignment.tier,
          model: modelAssignment.model,
          provider: modelAssignment.provider,
          worktree: preservedWorktree?.path,
          branch: preservedWorktree?.branch,
        })
      }
      return {
        content: `[${agentLabel}] "${description}" error: ${(err as Error).message}\n\n[Worker Result]\n${JSON.stringify(failedWorkerResult, null, 2)}`,
        isError: true,
        runId: failedWorkerResult.runId,
        workerResult: failedWorkerResult,
      } as ToolResult & { runId: string; workerResult: WorkerResult }
    } finally {
      // ── Always tear down timer + listener + child engine ──────────
      // Three pieces of teardown that MUST happen on every exit path
      // (success, error, pre-aborted early return):
      //
      // 1. clearInterval — heartbeat runs forever otherwise. Safe to
      //    call even when the interval was never scheduled (e.g. some
      //    future refactor moves setInterval back inside the try); an
      //    already-cleared timer is a no-op for clearInterval.
      //
      // 2. removeEventListener — detach the parent-signal listener so
      //    the AbortSignal no longer holds a strong reference to the
      //    child engine closure. Without this, the parent's signal
      //    (which can outlive the child) would prevent the child from
      //    being GC'd until the parent itself is torn down. Safe even
      //    when no listener was registered (removeEventListener on a
      //    never-added handler is a no-op).
      //
      // 3. childEngine.dispose?.() — tear down the child engine's
      //    background tasks. The child ExecutionEngine owns its own
      //    BackgroundTaskManager distinct from the parent's — so
      //    `run_in_background:true` Bash calls inside the sub-agent
      //    are tracked on the child, not the host. Without an explicit
      //    dispose, a sub-agent that spawns a long-running process
      //    would keep that process alive after the sub-agent finishes
      //    (or aborts, or errors). `dispose()` is optional on
      //    ChildEngineLike (simple test stubs omit it); the call is
      //    wrapped in try/catch so disposal failures never propagate
      //    out of the host's runTurn.
      clearInterval(heartbeatTimer)
      if (abortListener && context.signal) {
        try {
          context.signal.removeEventListener('abort', abortListener)
        } catch {
          // signal may have been detached elsewhere; teardown is best-effort
        }
      }
      try {
        childEngine.dispose?.()
      } catch {
        // best-effort teardown; never throw out of the host's finally
      }
      // P0-4 safety net: if we exit through the pre-aborted early
      // return (or any path that nulls `this.factory` mid-flight), the
      // success/catch finalize above never ran. Discard the worktree
      // here too so we never leak an isolated branch. The success path
      // already nulls wtInfo after merging, so this only fires when
      // finalize was skipped.
      if (wtInfo) {
        try {
          getWorktreeManager(context.cwd).removeWorktree(wtInfo.name, { deleteBranch: true })
        } catch {
          // best-effort; finally must not throw
        }
      }
      // P0-9: remove the subtask from activeSubtasks on EVERY exit
      // path so the runtime surface cannot accumulate stale entries.
      if (sharedRuntimeState?.activeSubtasks) {
        sharedRuntimeState.activeSubtasks.delete(subtaskId)
      }
      // Phase 4: drop the runId → abort mapping on every exit path
      // (success/error/abort) so it can't retain a dead childEngine.
      if (runId) this.childAborts.delete(runId)
    }
  }
}
