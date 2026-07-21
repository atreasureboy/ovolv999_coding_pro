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
import { execSync } from 'child_process'
import { ExecutionRunRegistry, type RunStatus } from './executionRun.js'

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
}

export interface WorkflowRunResult {
  workflowName: string
  success: boolean
  steps: StepResult[]
  /** Total duration in ms */
  durationMs: number
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
  let overallSuccess = true

  for (const step of workflow.steps) {
    const name = step.name ?? step.type

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

    const result = await executeStep(step, ctx, steps)
    steps.push(result)
    lastSuccess = result.success
    // Update the run's phase so observers can see progress per step.
    transitionRun('running', { phase: `step:${name}` })

    if (!result.success && !step.continueOnError) {
      overallSuccess = false
      break
    }
  }

  const workflowResult: WorkflowRunResult = {
    workflowName: workflow.name,
    success: overallSuccess,
    steps,
    durationMs: Date.now() - startTime,
  }

  // Terminal transition: succeeded on overall success, failed otherwise.
  // (No 'verifying' state for workflows — the per-step outcomes ARE the
  // verification. If a future step wants explicit verification, it can
  // be added as its own step type.)
  transitionRun(overallSuccess ? 'succeeded' : 'failed', {
    phase: 'finalized',
    error: overallSuccess ? undefined : 'one or more workflow steps failed',
  })

  return workflowResult
}

async function executeStep(
  step: WorkflowStep,
  ctx: WorkflowContext,
  previousSteps: StepResult[],
): Promise<StepResult> {
  const name = step.name ?? step.type
  const start = Date.now()

  try {
    switch (step.type) {
      case 'shell':
        return executeShellStep(step, name, ctx, start, previousSteps)
      case 'slash':
        return await executeSlashStep(step, name, ctx, start, previousSteps)
      case 'prompt':
        return await executePromptStep(step, name, ctx, start)
      case 'echo':
        return executeEchoStep(step, name, ctx, start, previousSteps)
      case 'agent':
        return await executeAgentStep(step, name, ctx, start, previousSteps)
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
}

function executeShellStep(
  step: WorkflowStep, name: string, ctx: WorkflowContext, start: number, previousSteps: StepResult[],
): StepResult {
  if (!step.command) {
    return { name, type: 'shell', success: false, output: '', durationMs: 0, error: 'Missing "command"' }
  }

  const cmd = substituteVars(step.command, { steps: previousSteps, inputs: ctx.inputs })
  const cwd = step.cwd ? resolve(ctx.cwd, step.cwd) : ctx.cwd
  const timeout = step.timeoutMs ?? 60_000

  try {
    const output = execSync(cmd, {
      cwd,
      encoding: 'utf8',
      timeout,
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim()
    return {
      name, type: 'shell', success: true, output,
      durationMs: Date.now() - start,
    }
  } catch (err) {
    const e = err as Error & { status?: number; stdout?: string; stderr?: string }
    return {
      name, type: 'shell', success: false,
      output: (e.stdout ?? '').trim(),
      exitCode: e.status,
      durationMs: Date.now() - start,
      error: (e.stderr ?? e.message).trim().slice(0, 500),
    }
  }
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
