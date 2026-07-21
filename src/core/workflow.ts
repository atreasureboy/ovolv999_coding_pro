/**
 * Workflow Engine — reusable, multi-step automation scripts.
 *
 * Workflows are JSON files in `.ovolv999/workflows/*.json` that define
 * a sequence of steps. Each step can run a shell command, a slash command,
 * prompt the user, dispatch a sub-agent, or print a message.
 *
 * Workflow file format:
 * {
 *   "name": "lint-fix",
 *   "description": "Run lint, fix issues, commit",
 *   "steps": [
 *     { "name": "lint",   "type": "shell", "command": "npm run lint" },
 *     { "name": "fix",    "type": "shell", "command": "npm run lint:fix",
 *       "continueOnError": true },
 *     { "name": "commit", "type": "slash", "command": "/cost",
 *       "if": "success" }
 *   ]
 * }
 *
 * Inspired by GitHub Actions and Claude Code's workflow system.
 */

import { existsSync, readdirSync, readFileSync, mkdirSync, writeFileSync } from 'fs'
import { join, resolve, extname } from 'path'
import { spawn } from 'child_process'
import { randomUUID } from 'crypto'
import {
  ExecutionRunRegistry,
  type RunStatus,
  type RunKind,
  type ResourceClaim,
  type ArtifactRef,
} from './executionRun.js'
import {
  routeLargeOutput,
  type StructuredToolResult,
} from './structuredToolResult.js'

// ── Types ───────────────────────────────────────────────────────────────────

export type StepType = 'shell' | 'slash' | 'prompt' | 'echo' | 'agent'

export type StepCondition = 'success' | 'failure' | 'always'

export interface WorkflowStep {
  /** Step label (used in output and for variable references) */
  name?: string
  /** Step type */
  type: StepType
  /** Shell command to execute (type=shell) */
  command?: string
  /** Working directory override (type=shell) */
  cwd?: string
  /** Timeout in ms (type=shell, default: 60_000) */
  timeoutMs?: number
  /** Continue workflow even if this step fails */
  continueOnError?: boolean
  /** Condition: only run if previous step matched this state */
  if?: StepCondition
  /** Prompt message for user input (type=prompt) */
  message?: string
  /** Default value for prompt (type=prompt) */
  default?: string
  /** Text to print (type=echo) */
  text?: string
  /** Agent prompt (type=agent) */
  prompt?: string
  /** Agent preset (type=agent, default: general-purpose) */
  preset?: string
  /** Agent description (type=agent) */
  description?: string
}

export interface Workflow {
  name: string
  description?: string
  /** Optional trigger (future: auto-run on events) */
  trigger?: 'manual' | 'auto'
  /** Optional tags for organization */
  tags?: string[]
  steps: WorkflowStep[]
}

export interface StepResult {
  name: string
  type: StepType
  success: boolean
  /** Captured stdout (shell) or response (prompt/slash) */
  output: string
  /** Exit code (shell) */
  exitCode?: number
  /** Duration in ms */
  durationMs: number
  /** Error message if failed */
  error?: string
  /** User-provided value (prompt) */
  value?: string
  /**
   * P1-10: structured shell result for `type:'shell'` steps. Carries
   * stdout/stderr/exitCode/status/artifacts separately from the
   * flat `output` string (which remains for back-compat). Non-shell
   * steps leave this undefined.
   */
  structured?: StructuredToolResult
  /**
   * P1-9: ExecutionRun id for this step when a registry was wired
   * in. Undefined when no registry is supplied (legacy mode).
   */
  runId?: string
}

/**
 * P1-11: workflow-level terminal status. The boolean `success` on
 * WorkflowRunResult is retained for back-compat, but `status`
 * distinguishes "all steps clean" from "completed with soft
 * failures via continueOnError" — the two MUST NOT be equivalent
 * per five_goal §十一 P1-11.
 */
export type WorkflowStatus =
  | 'succeeded'
  | 'succeeded_with_warnings'
  | 'failed'
  | 'blocked'
  | 'cancelled'

export interface WorkflowRunResult {
  workflowName: string
  success: boolean
  /**
   * P1-11: rich workflow status. `success` is `true` iff this is
   * `'succeeded'` or `'succeeded_with_warnings'`. The two "ok-ish"
   * states are distinguishable via `status` but collapse to
   * `success=true` for legacy callers.
   */
  status: WorkflowStatus
  steps: StepResult[]
  /** Total duration in ms */
  durationMs: number
  /** P1-9: ExecutionRun id for the workflow run, if a registry was supplied. */
  runId?: string
}

// ── Context for execution ───────────────────────────────────────────────────

export interface WorkflowContext {
  /** Base working directory */
  cwd: string
  /** Run a slash command — returns the result text */
  runSlash?: (command: string) => Promise<string>
  /** Prompt the user — returns their input */
  promptUser?: (message: string, defaultValue?: string) => Promise<string>
  /** Dispatch a sub-agent — returns the agent's summary */
  runAgent?: (prompt: string, preset: string, description: string) => Promise<string>
  /**
   * P0-6: input variables passed to the workflow at invocation time.
   * Referenced as `${{ inputs.X }}` in steps. Optional — workflows
   * that don't read inputs don't need to supply this.
   */
  inputs?: Record<string, string>
  /**
   * Round 4: optional ExecutionRun registry. When supplied,
   * executeWorkflow creates a child run with kind='workflow' and
   * walks it through queued → preparing → running → succeeded/failed
   * so workflows are observable alongside agents + workers + shell
   * tasks. When omitted, executeWorkflow behaves exactly as before.
   */
  runRegistry?: ExecutionRunRegistry
  /** Optional parent run id for linking into a call tree. */
  parentRunId?: string
  /**
   * P1-10: optional abort signal. When the caller aborts (e.g.
   * Ctrl-C from the UI), every running shell step receives the
   * signal and the workflow lands in `status:'cancelled'`.
   * Non-shell steps are non-interruptible (they're fast user
   * interactions like prompt/slash/echo).
   */
  signal?: AbortSignal
}

// ── Loader ──────────────────────────────────────────────────────────────────

const WORKFLOW_DIR = '.ovolv999/workflows'

/**
 * Load all workflows from `.ovolv999/workflows/`.
 * Returns a map of name → Workflow.
 */
export function loadWorkflows(cwd: string): Map<string, Workflow> {
  const dir = join(resolve(cwd), WORKFLOW_DIR)
  const workflows = new Map<string, Workflow>()

  if (!existsSync(dir)) return workflows

  let files: string[]
  try {
    files = readdirSync(dir).filter(f => extname(f) === '.json')
  } catch {
    return workflows
  }

  for (const file of files) {
    try {
      const raw = readFileSync(join(dir, file), 'utf8')
      const wf = parseWorkflow(raw)
      if (wf) {
        workflows.set(wf.name, wf)
      }
    } catch {
      // Skip malformed files
    }
  }

  return workflows
}

/** Load a single workflow by name */
export function loadWorkflow(cwd: string, name: string): Workflow | null {
  const workflows = loadWorkflows(cwd)
  return workflows.get(name) ?? null
}

/** Parse and validate a workflow JSON string */
export function parseWorkflow(raw: string): Workflow | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }

  return validateWorkflow(parsed)
}

/** Validate a parsed object as a Workflow */
export function validateWorkflow(data: unknown): Workflow | null {
  if (typeof data !== 'object' || data === null) return null
  const obj = data as Record<string, unknown>

  if (typeof obj.name !== 'string' || !obj.name.trim()) return null
  if (!Array.isArray(obj.steps) || obj.steps.length === 0) return null

  const steps: WorkflowStep[] = []
  for (const raw of obj.steps) {
    const step = validateStep(raw)
    if (!step) return null
    steps.push(step)
  }

  return {
    name: obj.name,
    description: typeof obj.description === 'string' ? obj.description : undefined,
    trigger: obj.trigger === 'auto' ? 'auto' : 'manual',
    tags: Array.isArray(obj.tags) ? obj.tags.filter((t): t is string => typeof t === 'string') : undefined,
    steps,
  }
}

export function validateStep(raw: unknown): WorkflowStep | null {
  if (typeof raw !== 'object' || raw === null) return null
  const obj = raw as Record<string, unknown>

  const validTypes: StepType[] = ['shell', 'slash', 'prompt', 'echo', 'agent']
  if (typeof obj.type !== 'string' || !validTypes.includes(obj.type as StepType)) {
    return null
  }

  const step: WorkflowStep = { type: obj.type as StepType }

  if (typeof obj.name === 'string') step.name = obj.name
  if (typeof obj.command === 'string') step.command = obj.command
  if (typeof obj.cwd === 'string') step.cwd = obj.cwd
  if (typeof obj.timeoutMs === 'number') step.timeoutMs = obj.timeoutMs
  if (obj.continueOnError === true) step.continueOnError = true
  if (obj.if === 'success' || obj.if === 'failure' || obj.if === 'always') step.if = obj.if
  if (typeof obj.message === 'string') step.message = obj.message
  if (typeof obj.default === 'string') step.default = obj.default
  if (typeof obj.text === 'string') step.text = obj.text
  if (typeof obj.prompt === 'string') step.prompt = obj.prompt
  if (typeof obj.preset === 'string') step.preset = obj.preset
  if (typeof obj.description === 'string') step.description = obj.description

  return step
}

// ── Executor ────────────────────────────────────────────────────────────────

/**
 * Execute a workflow step by step.
 * Returns the result of each step plus overall success.
 *
 * P1-9: when a registry is supplied, EVERY step creates its own
 * child ExecutionRun linked to the workflow run. Each step run
 * carries input snapshot (substituted command in `goal`), output
 * Artifact (for large captures), duration, resource claims, and
 * is cancellable via the workflow's AbortController.
 *
 * P1-10: shell steps run asynchronously via spawn() — never
 * execSync. They honor AbortSignal, per-step timeout, stream
 * stdout/stderr through a bounded head+tail buffer, and report
 * results via StructuredToolResult fields.
 *
 * P1-11: `WorkflowRunResult.status` distinguishes clean success
 * from `succeeded_with_warnings` (continueOnError soft failures).
 */
export async function executeWorkflow(
  workflow: Workflow,
  ctx: WorkflowContext,
): Promise<WorkflowRunResult> {
  // ── Round 4: ExecutionRun lifecycle ──────────────────────────────
  // When a registry is supplied on the context, this workflow run is
  // observable through the same state machine as agents + workers +
  // shell tasks. Best-effort — registry failures never break the run.
  const registry = ctx.runRegistry
  let runId: string | undefined
  if (registry) {
    try {
      const run = registry.create({
        kind: 'workflow',
        parentRunId: ctx.parentRunId,
        goal: workflow.description ?? workflow.name,
        workspace: { cwd: ctx.cwd },
        worker: workflow.name,
      })
      runId = run.runId
    } catch {
      // registry create failed — workflow still runs
    }
  }
  const transitionRun = (to: RunStatus, patch?: Record<string, unknown>): void => {
    if (!registry || !runId) return
    try { registry.transition(runId, to, patch as never) } catch { /* best-effort */ }
  }

  transitionRun('preparing', { phase: 'workflow-starting' })
  transitionRun('running', { phase: 'executing-steps' })

  const startTime = Date.now()
  const steps: StepResult[] = []
  let lastSuccess = true
  let hardFailure = false
  let softFailure = false
  let cancelled = false

  // P1-10: bind a local abort listener so the loop can break out
  // cleanly when ctx.signal fires. We do NOT throw — we let the
  // current step finish (its shell already receives the signal)
  // and then stop dispatching further steps.
  if (ctx.signal) {
    if (ctx.signal.aborted) {
      cancelled = true
    } else {
      ctx.signal.addEventListener('abort', () => { cancelled = true }, { once: true })
    }
  }

  for (const step of workflow.steps) {
    const name = step.name ?? step.type

    if (cancelled) {
      // Remaining steps are not dispatched — record a skipped marker
      // so the step list still sums to workflow.steps.length.
      steps.push({
        name, type: step.type, success: false,
        output: '[skipped: workflow cancelled]',
        durationMs: 0,
      })
      continue
    }

    // Check condition
    if (step.if && step.if !== 'always') {
      if (step.if === 'success' && !lastSuccess) {
        steps.push({
          name, type: step.type, success: true, output: '[skipped: condition not met]',
          durationMs: 0,
        })
        continue
      }
      if (step.if === 'failure' && lastSuccess) {
        steps.push({
          name, type: step.type, success: true, output: '[skipped: condition not met]',
          durationMs: 0,
        })
        continue
      }
    }

    const result = await executeStep(step, ctx, steps, runId)
    steps.push(result)
    lastSuccess = result.success
    // Update the workflow run's phase so observers can see progress.
    transitionRun('running', { phase: `step:${name}` })

    if (!result.success) {
      if (step.continueOnError) {
        // P1-11: continueOnError soft-failures are tracked separately
        // from hard failures. They do NOT flip overallSuccess=false
        // (back-compat) but DO flip the new workflow status to
        // 'succeeded_with_warnings'.
        softFailure = true
      } else {
        hardFailure = true
        break
      }
    }
  }

  // P1-11: derive WorkflowStatus from the three flags. Precedence:
  //   cancelled > hardFailure > softFailure > clean
  let status: WorkflowStatus
  if (cancelled) {
    status = 'cancelled'
  } else if (hardFailure) {
    status = 'failed'
  } else if (softFailure) {
    status = 'succeeded_with_warnings'
  } else {
    status = 'succeeded'
  }

  const workflowResult: WorkflowRunResult = {
    workflowName: workflow.name,
    // Back-compat: true iff the workflow reached a non-failed,
    // non-cancelled terminal state. Soft failures count as success.
    success: status === 'succeeded' || status === 'succeeded_with_warnings',
    status,
    steps,
    durationMs: Date.now() - startTime,
    runId,
  }

  // Terminal transition: succeeded on overall success, failed otherwise.
  // (No 'verifying' state for workflows — the per-step outcomes ARE the
  // verification. If a future step wants explicit verification, it can
  // be added as its own step type.)
  //
  // P1-11: 'succeeded_with_warnings' has no equivalent in RunStatus.
  // We map it to RunStatus='succeeded' but stamp `phase` so observers
  // reading the registry can still distinguish ("completed-with-warnings"
  // vs "finalized"). This keeps the run-state machine coherent while
  // still surfacing the distinction at the workflow layer.
  const terminalStatus: RunStatus =
    status === 'cancelled' ? 'cancelled'
    : status === 'failed' ? 'failed'
    : 'succeeded'
  const terminalPhase =
    status === 'succeeded_with_warnings' ? 'completed-with-warnings'
    : 'finalized'
  transitionRun(terminalStatus, {
    phase: terminalPhase,
    error: status === 'failed' ? 'one or more workflow steps failed'
      : status === 'cancelled' ? 'workflow cancelled before completion'
      : undefined,
  })

  return workflowResult
}

/**
 * Map a WorkflowStep type to the RunKind used for its child run.
 * Shell → shell_task, agent → agent, others fall back to 'workflow'
 * (the same kind as the parent — they're inline workflow actions
 * that don't have a dedicated RunKind).
 */
function stepRunKind(stepType: StepType): RunKind {
  if (stepType === 'shell') return 'shell_task'
  if (stepType === 'agent') return 'agent'
  return 'workflow'
}

/**
 * P1-9: create, transition, and finalize a child ExecutionRun for
 * a single step. The step run is linked to the workflow run via
 * parentRunId and carries:
 *   - input snapshot in `goal` (the substituted command/prompt text)
 *   - workspace.cwd (step.cwd override honored)
 *   - resource claims (shell steps claim directory R/W on cwd)
 *   - output artifact (when stdout/stderr is large)
 *   - duration (via timestamps)
 *   - terminal status (succeeded / failed / cancelled)
 *
 * Returns the stepRunId so the caller can stamp it on StepResult.
 * No-ops cleanly when registry or parent runId is absent.
 */
function withStepRun<T>(
  step: WorkflowStep,
  name: string,
  ctx: WorkflowContext,
  workflowRunId: string | undefined,
  inputSnapshot: string,
  fn: () => Promise<T>,
  finalize: (result: T) => {
    success: boolean
    error?: string
    artifacts?: ArtifactRef[]
    phase?: string
  },
): { runId?: string; promise: Promise<T> } {
  const registry = ctx.runRegistry
  if (!registry || !workflowRunId) {
    return { promise: fn() }
  }
  const cwd = step.cwd ? resolve(ctx.cwd, step.cwd) : ctx.cwd
  const resources: ResourceClaim[] =
    step.type === 'shell'
      ? [
          { type: 'directory', key: cwd, access: 'read' },
          { type: 'directory', key: cwd, access: 'write' },
        ]
      : []
  let stepRunId: string | undefined
  try {
    const run = registry.create({
      kind: stepRunKind(step.type),
      parentRunId: workflowRunId,
      goal: inputSnapshot.slice(0, 4000),
      workspace: { cwd },
      worker: name,
      resources,
      status: 'preparing',
      phase: 'step-starting',
    })
    stepRunId = run.runId
    try { registry.transition(stepRunId, 'running', { phase: 'executing' }) } catch { /* best-effort */ }
  } catch {
    // registry create/transition failed — step still runs
    return { promise: fn() }
  }
  const promise = fn().then(
    (result) => {
      const fin = finalize(result)
      try {
        registry.transition(
          stepRunId!,
          fin.success ? 'succeeded' : 'failed',
          {
            phase: fin.phase ?? 'finalized',
            error: fin.error,
            artifacts: fin.artifacts,
          } as never,
        )
      } catch { /* best-effort */ }
      return result
    },
    (err) => {
      try {
        registry.transition(stepRunId!, 'failed', {
          phase: 'exception',
          error: (err as Error).message?.slice(0, 1000) ?? 'step threw',
        })
      } catch { /* best-effort */ }
      throw err
    },
  )
  return { runId: stepRunId, promise }
}

async function executeStep(
  step: WorkflowStep,
  ctx: WorkflowContext,
  previousSteps: StepResult[],
  workflowRunId?: string,
): Promise<StepResult> {
  const name = step.name ?? step.type
  const start = Date.now()

  // P1-9: wrap EVERY step (not just shell) in a child ExecutionRun so
  // each step has independent state, input snapshot, output artifact,
  // duration, and is observable in the registry. The shell step does
  // its own wrapping (it needs to stamp artifacts from the structured
  // result); other types go through the generic wrapper here.
  if (step.type === 'shell') {
    try {
      return await executeShellStep(step, name, ctx, start, previousSteps, workflowRunId)
    } catch (err) {
      return {
        name, type: step.type, success: false, output: '',
        durationMs: Date.now() - start, error: (err as Error).message,
      }
    }
  }

  // Build an input snapshot string for non-shell step types.
  const inputSnapshot =
    step.type === 'echo' ? step.text ?? ''
    : step.type === 'prompt' ? step.message ?? ''
    : step.type === 'slash' ? step.command ?? ''
    : step.type === 'agent' ? step.prompt ?? ''
    : ''

  const { runId, promise } = withStepRun<StepResult>(
    step,
    name,
    ctx,
    workflowRunId,
    inputSnapshot,
    async () => {
      try {
        switch (step.type) {
          case 'slash': return await executeSlashStep(step, name, ctx, start, previousSteps)
          case 'prompt': return await executePromptStep(step, name, ctx, start)
          case 'echo': return executeEchoStep(step, name, ctx, start, previousSteps)
          case 'agent': return await executeAgentStep(step, name, ctx, start, previousSteps)
          default:
            return {
              name, type: step.type, success: false, output: '',
              durationMs: Date.now() - start, error: `Unknown step type: ${step.type}`,
            }
        }
      } catch (err) {
        return {
          name, type: step.type, success: false, output: '',
          durationMs: Date.now() - start, error: (err as Error).message,
        }
      }
    },
    (result) => ({
      success: result.success,
      error: result.error,
      phase: result.success ? 'step-ok' : 'step-failed',
    }),
  )

  const result = await promise
  if (runId && !result.runId) {
    result.runId = runId
  }
  return result
}

/**
 * P1-10: asynchronous shell step. Replaces the historical execSync
 * implementation with a streaming spawn() that honors AbortSignal,
 * enforces per-step timeout, and returns a StructuredToolResult.
 *
 * The returned StepResult retains the flat `output`/`exitCode`/`error`
 * fields for back-compat with existing readers (including variable
 * substitution in subsequent steps); the richer structured shape is
 * attached as `structured` for new callers.
 *
 * Large outputs (> DEFAULT_LARGE_OUTPUT_BYTES) are routed into an
 * ArtifactRef and replaced with a head+tail preview in the structured
 * result. The artifact is also attached to the step's child run when
 * a registry is in play.
 */
async function executeShellStep(
  step: WorkflowStep,
  name: string,
  ctx: WorkflowContext,
  start: number,
  previousSteps: StepResult[],
  workflowRunId?: string,
): Promise<StepResult> {
  if (!step.command) {
    return { name, type: 'shell', success: false, output: '', durationMs: 0, error: 'Missing "command"' }
  }

  const cmd = substituteVars(step.command, { steps: previousSteps, inputs: ctx.inputs })
  const cwd = step.cwd ? resolve(ctx.cwd, step.cwd) : ctx.cwd
  const timeoutMs = step.timeoutMs ?? 60_000

  const { runId, promise } = withStepRun<StructuredToolResult>(
    step,
    name,
    ctx,
    workflowRunId,
    cmd,
    () => runShellAsync({ command: cmd, cwd, timeoutMs, signal: ctx.signal }),
    (result) => ({
      success: result.status === 'success',
      error: result.status === 'failed'
        ? (result.stderr && result.stderr.trim()) || result.summary
        : undefined,
      artifacts: result.artifacts,
      phase: result.status === 'success' ? 'shell-ok' : 'shell-failed',
    }),
  )

  let structured: StructuredToolResult
  try {
    structured = await promise
  } catch (err) {
    return {
      name, type: 'shell', success: false, output: '',
      durationMs: Date.now() - start,
      error: (err as Error).message,
      runId,
    }
  }

  // Back-compat: flat fields derived from the structured result.
  const output = (structured.stdout ?? '').trim()
  return {
    name,
    type: 'shell',
    success: structured.status === 'success',
    output,
    exitCode: structured.exitCode,
    durationMs: Date.now() - start,
    error: structured.status !== 'success'
      ? ((structured.stderr && structured.stderr.trim())
          || structured.summary).slice(0, 500) || undefined
      : undefined,
    structured,
    runId,
  }
}

/**
 * P1-10: spawn a shell command asynchronously with abort + timeout
 * + streaming capture. Returns a StructuredToolResult. Used by the
 * workflow shell step; deliberately factored out so other callers
 * (loopEngine, future slash commands) can share the same semantics.
 *
 * Behaviour:
 *   - Already-aborted signal  → immediate 'cancelled' result, no spawn
 *   - signal fires mid-flight → SIGTERM child, settle as 'cancelled'
 *   - timeout fires           → SIGTERM child, settle as 'timed_out'
 *   - non-zero exit           → 'failed' with exitCode/stderr
 *   - exit 0                  → 'success'
 *
 * Output is collected in full (capped at a generous 1 MiB per stream
 * to bound memory; workflow step output is not expected to approach
 * that, but the cap prevents a runaway generator from OOMing). When
 * a stream exceeds DEFAULT_LARGE_OUTPUT_BYTES it is routed to an
 * ArtifactRef shape on the returned StructuredToolResult.
 */
export async function runShellAsync(opts: {
  command: string
  cwd: string
  timeoutMs: number
  signal?: AbortSignal
}): Promise<StructuredToolResult> {
  const { command, cwd, timeoutMs, signal } = opts

  // Pre-abort short-circuit.
  if (signal?.aborted) {
    return {
      status: 'cancelled',
      summary: `Command cancelled before spawn: ${command.slice(0, 200)}`,
      retryable: false,
    }
  }

  return new Promise<StructuredToolResult>((resolve) => {
    let settled = false
    let timeoutTimer: ReturnType<typeof setTimeout> | null = null
    let killTimer: ReturnType<typeof setTimeout> | null = null
    let timedOut = false
    let aborted = false
    const stdoutChunks: Buffer[] = []
    const stderrChunks: Buffer[] = []
    let stdoutBytes = 0
    let stderrBytes = 0
    const STREAM_CAP = 1024 * 1024 // 1 MiB per stream

    const child = spawn(command, {
      cwd,
      env: process.env,
      shell: true,
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    })

    const clearTimers = () => {
      if (timeoutTimer) { clearTimeout(timeoutTimer); timeoutTimer = null }
      if (killTimer) { clearTimeout(killTimer); killTimer = null }
    }

    const killTree = (sig: NodeJS.Signals) => {
      const pid = child.pid
      if (pid === undefined) return
      try {
        if (process.platform === 'win32') {
          // best-effort: avoid importing execSync here — the workflow
          // module is forbidden from using execSync per P1-10, and the
          // Windows process-kill path is best handled by the runtime
          // child.kill() which traverses the job object when shell:true.
          child.kill(sig)
        } else {
          // Negative pid = process group (shell:true spawns a subshell
          // that owns the actual command; killing the group reaches
          // both).
          process.kill(-pid, sig)
        }
      } catch { /* ESRCH if already gone */ }
    }

    const settle = (result: StructuredToolResult) => {
      if (settled) return
      settled = true
      clearTimers()
      if (abortListener && signal) {
        signal.removeEventListener('abort', abortListener)
      }
      resolve(result)
    }

    child.stdout?.on('data', (chunk: Buffer) => {
      if (stdoutBytes < STREAM_CAP) {
        const room = STREAM_CAP - stdoutBytes
        const slice = chunk.length > room ? chunk.subarray(0, room) : chunk
        stdoutChunks.push(slice)
        stdoutBytes += slice.length
      }
    })
    child.stderr?.on('data', (chunk: Buffer) => {
      if (stderrBytes < STREAM_CAP) {
        const room = STREAM_CAP - stderrBytes
        const slice = chunk.length > room ? chunk.subarray(0, room) : chunk
        stderrChunks.push(slice)
        stderrBytes += slice.length
      }
    })

    timeoutTimer = setTimeout(() => {
      if (settled) return
      timedOut = true
      killTree('SIGTERM')
      killTimer = setTimeout(() => {
        killTimer = null
        killTree('SIGKILL')
      }, 2000)
      if (typeof killTimer.unref === 'function') killTimer.unref()
    }, timeoutMs)
    if (typeof timeoutTimer.unref === 'function') timeoutTimer.unref()

    const onAbort = () => {
      if (settled) return
      aborted = true
      killTree('SIGTERM')
      killTimer = setTimeout(() => {
        killTimer = null
        killTree('SIGKILL')
      }, 2000)
      if (typeof killTimer.unref === 'function') killTimer.unref()
      clearTimers()
    }
    let abortListener: (() => void) | null = onAbort
    signal?.addEventListener('abort', abortListener, { once: true })

    child.on('error', (err) => {
      // Spawn failure (ENOENT, EACCES, etc.) — child never started.
      settle({
        status: 'failed',
        summary: `Failed to spawn: ${err.message}`,
        stderr: err.message,
        retryable: false,
      })
    })

    child.on('close', (code, sig) => {
      if (settled) return
      const stdoutRaw = Buffer.concat(stdoutChunks).toString('utf8')
      const stderrRaw = Buffer.concat(stderrChunks).toString('utf8')

      // Large-output routing: build artifacts and replace inline text
      // with a head+tail preview so the model still gets a hint.
      const artifacts: ArtifactRef[] = []
      let stdoutFinal = stdoutRaw
      let stderrFinal = stderrRaw
      const outRoute = routeLargeOutput(stdoutRaw, `shell-stdout-${randomUUID()}`)
      if (outRoute) {
        artifacts.push(outRoute.artifact)
        stdoutFinal = outRoute.preview
      }
      const errRoute = routeLargeOutput(stderrRaw, `shell-stderr-${randomUUID()}`)
      if (errRoute) {
        artifacts.push(errRoute.artifact)
        stderrFinal = errRoute.preview
      }

      if (aborted) {
        settle({
          status: 'cancelled',
          summary: `Command cancelled by abort signal: ${command.slice(0, 200)}`,
          stdout: stdoutFinal,
          stderr: stderrFinal,
          exitCode: code ?? undefined,
          artifacts: artifacts.length ? artifacts : undefined,
          retryable: false,
        })
        return
      }
      if (timedOut) {
        settle({
          status: 'timed_out',
          summary: `Command timed out after ${timeoutMs}ms: ${command.slice(0, 200)}`,
          stdout: stdoutFinal,
          stderr: stderrFinal,
          exitCode: code ?? undefined,
          artifacts: artifacts.length ? artifacts : undefined,
          retryable: true,
        })
        return
      }
      const exitCode = code ?? 0
      if (exitCode === 0) {
        settle({
          status: 'success',
          summary: `Command succeeded: ${command.slice(0, 200)}`,
          stdout: stdoutFinal,
          stderr: stderrFinal,
          exitCode: 0,
          artifacts: artifacts.length ? artifacts : undefined,
          retryable: false,
        })
        return
      }
      settle({
        status: 'failed',
        summary: `Command failed (exit ${exitCode}${sig ? `, signal ${sig}` : ''}): ${command.slice(0, 200)}`,
        stdout: stdoutFinal,
        stderr: stderrFinal,
        exitCode,
        artifacts: artifacts.length ? artifacts : undefined,
        retryable: false,
      })
    })
  })
}

async function executeSlashStep(
  step: WorkflowStep, name: string, ctx: WorkflowContext, start: number, previousSteps: StepResult[],
): Promise<StepResult> {
  if (!step.command) {
    return { name, type: 'slash', success: false, output: '', durationMs: 0, error: 'Missing "command"' }
  }
  if (!ctx.runSlash) {
    return { name, type: 'slash', success: false, output: '', durationMs: 0, error: 'No slash runner available' }
  }
  try {
    const output = await ctx.runSlash(substituteVars(step.command, { steps: previousSteps, inputs: ctx.inputs }))
    return { name, type: 'slash', success: true, output, durationMs: Date.now() - start }
  } catch (err) {
    return { name, type: 'slash', success: false, output: '', durationMs: Date.now() - start, error: (err as Error).message }
  }
}

async function executePromptStep(
  step: WorkflowStep, name: string, ctx: WorkflowContext, start: number,
): Promise<StepResult> {
  if (!ctx.promptUser) {
    return { name, type: 'prompt', success: false, output: '', durationMs: 0, error: 'No prompt handler available' }
  }
  try {
    const value = await ctx.promptUser(step.message ?? 'Enter value:', step.default)
    return {
      name, type: 'prompt', success: true, output: value, value,
      durationMs: Date.now() - start,
    }
  } catch (err) {
    return { name, type: 'prompt', success: false, output: '', durationMs: Date.now() - start, error: (err as Error).message }
  }
}

function executeEchoStep(
  step: WorkflowStep, name: string, ctx: WorkflowContext, start: number, previousSteps: StepResult[],
): StepResult {
  return {
    name, type: 'echo', success: true,
    output: substituteVars(step.text ?? '', { steps: previousSteps, inputs: ctx.inputs }),
    durationMs: Date.now() - start,
  }
}

async function executeAgentStep(
  step: WorkflowStep, name: string, ctx: WorkflowContext, start: number, previousSteps: StepResult[],
): Promise<StepResult> {
  if (!step.prompt) {
    return { name, type: 'agent', success: false, output: '', durationMs: 0, error: 'Missing "prompt"' }
  }
  if (!ctx.runAgent) {
    return { name, type: 'agent', success: false, output: '', durationMs: 0, error: 'No agent runner available' }
  }
  try {
    const output = await ctx.runAgent(
      substituteVars(step.prompt, { steps: previousSteps, inputs: ctx.inputs }),
      step.preset ?? 'general-purpose',
      step.description ?? 'Workflow agent step',
    )
    return { name, type: 'agent', success: true, output, durationMs: Date.now() - start }
  } catch (err) {
    return { name, type: 'agent', success: false, output: '', durationMs: Date.now() - start, error: (err as Error).message }
  }
}

// ── Variable substitution ───────────────────────────────────────────────────

/**
 * P0-6: real variable substitution for workflow steps.
 *
 * Supported syntax (GitHub-Actions-like `${{ }}` envelope so it cannot
 * accidentally collide with shell `$VAR` expansion):
 *
 *   ${{ inputs.NAME }}              → ctx.inputs[NAME]
 *   ${{ steps.STEP_NAME.output }}   → captured stdout of a prior step
 *   ${{ steps.STEP_NAME.exitCode }} → numeric exit code of a prior step
 *   ${{ steps.STEP_NAME.success }}  → "true" | "false"
 *   ${{ steps.STEP_NAME.error }}    → captured error message
 *
 * Step-name lookup is case-sensitive and matches either the explicit
 * `step.name` field or, if absent, the step's `type` (preserving the
 * existing "name ?? type" fallback used everywhere else in this module).
 *
 * Missing variable → THROWS. This is the opposite of the pre-fix
 * behavior (which silently preserved the literal `${{ vars.X }}`
 * placeholder verbatim into the shell command, where it produced
 * confusing shell errors or — worse — was interpreted as the empty
 * string). Explicit failure lets the operator diagnose the typo
 * immediately instead of debugging downstream shell behavior.
 *
 * The legacy `${{ vars.X }}` and `${{ env.NAME }}` namespaces are NOT
 * supported (they were no-ops pre-fix and had no callers); references
 * to them now throw like any other unknown namespace, surfacing the
 * configuration mistake instead of swallowing it.
 */
export interface SubstitutionScope {
  steps: StepResult[]
  inputs?: Record<string, string>
}

export class WorkflowSubstitutionError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'WorkflowSubstitutionError'
  }
}

export function substituteVars(text: string, scope: SubstitutionScope): string {
  // Match ${{ <dotted.path> }} with optional internal whitespace.
  // The path is restricted to [\w.]+ so callers cannot inject shell
  // metacharacters via the substitution path itself; the resolved
  // VALUE is still inserted verbatim (callers must escape as needed
  // for their target language — same contract as GitHub Actions).
  return text.replace(/\$\{\{\s*([\w.]+)\s*\}\}/g, (match, path: string) => {
    const parts = path.split('.')
    const ns = parts[0]

    if (ns === 'inputs') {
      const key = parts[1]
      if (!key) throw new WorkflowSubstitutionError(`workflow: malformed input reference: ${path}`)
      const inputs = scope.inputs ?? {}
      if (!(key in inputs)) {
        throw new WorkflowSubstitutionError(
          `workflow: unknown input variable: inputs.${key}`,
        )
      }
      return String(inputs[key] ?? '')
    }

    if (ns === 'steps') {
      const stepName = parts[1]
      const field = parts[2]
      if (!stepName || !field) {
        throw new WorkflowSubstitutionError(`workflow: malformed step reference: ${path}`)
      }
      const step = scope.steps.find(s => s.name === stepName)
      if (!step) {
        throw new WorkflowSubstitutionError(
          `workflow: unknown step reference: steps.${stepName} (known: ${scope.steps.map(s => s.name).join(', ') || 'none'})`,
        )
      }
      switch (field) {
        case 'output': return step.output ?? ''
        case 'exitCode': return step.exitCode === undefined ? '' : String(step.exitCode)
        case 'success': return String(step.success)
        case 'error': return step.error ?? ''
        case 'value': return step.value ?? ''
        case 'durationMs': return String(step.durationMs)
        default:
          throw new WorkflowSubstitutionError(
            `workflow: unsupported step field: steps.${stepName}.${field} (supported: output, exitCode, success, error, value, durationMs)`,
          )
      }
    }

    throw new WorkflowSubstitutionError(
      `workflow: unknown variable namespace: ${ns} (supported: inputs, steps)`,
    )
  })
}

// ── Sample writer (for /workflow init) ──────────────────────────────────────

export function writeSampleWorkflow(cwd: string, name: string): string {
  const dir = join(resolve(cwd), WORKFLOW_DIR)
  mkdirSync(dir, { recursive: true })
  const filePath = join(dir, `${name}.json`)

  const sample: Workflow = {
    name,
    description: 'Sample workflow — customize me',
    trigger: 'manual',
    steps: [
      { name: 'hello', type: 'echo', text: 'Starting workflow...' },
      { name: 'check', type: 'shell', command: 'echo "Hello from workflow"' },
    ],
  }

  writeFileSync(filePath, JSON.stringify(sample, null, 2) + '\n', 'utf8')
  return filePath
}
