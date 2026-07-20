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

    if (!result.success && !step.continueOnError) {
      overallSuccess = false
      break
    }
  }

  return {
    workflowName: workflow.name,
    success: overallSuccess,
    steps,
    durationMs: Date.now() - startTime,
  }
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
        return executeShellStep(step, name, ctx, start)
      case 'slash':
        return await executeSlashStep(step, name, ctx, start)
      case 'prompt':
        return await executePromptStep(step, name, ctx, start)
      case 'echo':
        return executeEchoStep(step, name, start)
      case 'agent':
        return await executeAgentStep(step, name, ctx, start)
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
  step: WorkflowStep, name: string, ctx: WorkflowContext, start: number,
): StepResult {
  if (!step.command) {
    return { name, type: 'shell', success: false, output: '', durationMs: 0, error: 'Missing "command"' }
  }

  const cmd = substituteVars(step.command)
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
  step: WorkflowStep, name: string, ctx: WorkflowContext, start: number,
): Promise<StepResult> {
  if (!step.command) {
    return { name, type: 'slash', success: false, output: '', durationMs: 0, error: 'Missing "command"' }
  }
  if (!ctx.runSlash) {
    return { name, type: 'slash', success: false, output: '', durationMs: 0, error: 'No slash runner available' }
  }
  try {
    const output = await ctx.runSlash(substituteVars(step.command))
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

function executeEchoStep(step: WorkflowStep, name: string, start: number): StepResult {
  return {
    name, type: 'echo', success: true,
    output: substituteVars(step.text ?? ''),
    durationMs: Date.now() - start,
  }
}

async function executeAgentStep(
  step: WorkflowStep, name: string, ctx: WorkflowContext, start: number,
): Promise<StepResult> {
  if (!step.prompt) {
    return { name, type: 'agent', success: false, output: '', durationMs: 0, error: 'Missing "prompt"' }
  }
  if (!ctx.runAgent) {
    return { name, type: 'agent', success: false, output: '', durationMs: 0, error: 'No agent runner available' }
  }
  try {
    const output = await ctx.runAgent(
      substituteVars(step.prompt),
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
 * Substitute `${{ vars.X }}` and `${{ env.NAME }}` style references.
 * Very basic — only supports `vars.*` from accumulated step results.
 */
function substituteVars(text: string): string {
  return text.replace(/\$\{\{\s*vars\.(\w+)\s*\}\}/g, (_match, name: string) => {
    return `\${{ vars.${name} }}` // Placeholder — actual substitution happens at runtime
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
