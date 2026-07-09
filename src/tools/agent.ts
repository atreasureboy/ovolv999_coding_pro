/**
 * AgentTool — spawn a specialized sub-agent to handle a focused subtask.
 *
 * Features:
 *   - AgentConfig-driven (preset name or custom config)
 *   - Verification gate: auto-run tsc/lint after sub-agent completes
 *   - Call chain tracking: prevent infinite recursion + audit depth
 *   - Parallel execution (multiple Agent calls in one response)
 */

import type { Tool, ToolContext, ToolDefinition, ToolResult } from '../core/types.js'
import type { EngineConfig } from '../core/types.js'
import type { AgentConfig } from '../core/agentPresets.js'
import { resolveAgentConfig, validateAgentConfig, PRESET_NAMES } from '../core/agentPresets.js'
import { Renderer } from '../ui/renderer.js'
import { tmuxLayout } from '../ui/tmuxLayout.js'
import { appendFileSync, existsSync, readFileSync } from 'fs'
import { join } from 'path'
import { execSync } from 'child_process'
import { str } from '../core/strings.js'

// ── Call chain tracking (AgentOS §6 pattern) ─────────────────────────────────

let _callDepth = 0
const MAX_CALL_DEPTH = 5

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
function runVerification(cwd: string): { passed: boolean; output: string } | null {
  const commands = detectVerifyCommands(cwd)
  if (commands.length === 0) return null

  const results: string[] = []
  let allPassed = true

  for (const cmd of commands) {
    try {
      execSync(cmd, { cwd, encoding: 'utf8', timeout: 60_000, stdio: ['ignore', 'pipe', 'pipe'] })
      results.push(`✓ ${cmd.split(' ')[1] || cmd} — passed`)
    } catch (err: unknown) {
      allPassed = false
      const e = err as { stdout?: string; stderr?: string; message?: string }
      const output = (e.stdout ?? '') + (e.stderr ?? '')
      const trimmed = output.trim().slice(0, 800)
      results.push(`✗ ${cmd.split(' ')[1] || cmd} — FAILED\n${trimmed}`)
    }
  }

  if (results.length === 0) return null
  return { passed: allPassed, output: results.join('\n\n') }
}

// ── Engine factory injection ─────────────────────────────────────────────────

type ChildEngine = {
  runTurn: (msg: string, history: never[]) => Promise<{ result: { output: string; reason: string } }>
  abort: () => void
}
let _engineFactory: ((config: EngineConfig, renderer: unknown) => ChildEngine) | null = null
let _currentConfig: EngineConfig | null = null
let _currentRenderer: unknown = null
const AGENT_EVENT_LOG_FILE = 'agent_events.ndjson'

function normalizeDelegatedPrompt(prompt: string, config: EngineConfig): string {
  let normalized = prompt
  if (config.sessionDir) {
    normalized = normalized
      .replace(/\bSESSION_DIR\b/g, config.sessionDir)
      .replace(/\/SESSION\b/g, config.sessionDir)
  }
  return normalized
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

export function registerAgentFactory(
  factory: ((config: EngineConfig, renderer: unknown) => ChildEngine),
  config: EngineConfig,
  renderer: unknown,
): void {
  _engineFactory = factory
  _currentConfig = config
  _currentRenderer = renderer
}

// ── runAgentTask ─────────────────────────────────────────────────────────────

async function runAgentTask(
  description: string,
  prompt: string,
  agentConfig: AgentConfig,
  agentLabel: string,
  verify: boolean,
  context: ToolContext,
): Promise<ToolResult> {
  if (!_engineFactory || !_currentConfig || !_currentRenderer) {
    return { content: 'Error: AgentTool not initialized', isError: true }
  }

  // Call chain depth check (prevent infinite recursion)
  _callDepth++
  if (_callDepth > MAX_CALL_DEPTH) {
    _callDepth--
    return {
      content: `Max agent call depth (${MAX_CALL_DEPTH}) exceeded — possible recursion. Call chain: ${_callDepth} levels deep.`,
      isError: true,
    }
  }

  const mainRenderer = _currentRenderer as {
    agentStart:     (desc: string, type: string) => void
    agentDone:      (desc: string, success: boolean) => void
    agentSummary:   (agentType: string, desc: string, summary: string) => void
    agentHeartbeat: (agentType: string, desc: string, elapsedSec: number) => void
  }
  mainRenderer.agentStart(description, agentLabel)
  const agentStartTime = Date.now()

  // Structured communication event: INVOKE_SENT (with call depth)
  context.eventLog?.append('invoke_sent', agentLabel, {
    description,
    modules: agentConfig.modules ? Object.keys(agentConfig.modules) : [],
    planMode: agentConfig.identity.planMode ?? false,
    maxIterations: agentConfig.maxIterations,
    call_depth: _callDepth,
    verify_enabled: verify,
  }, [agentLabel, 'invoke'])

  const paneLabel = `[${agentLabel}] ${description}`
  const paneSlot = tmuxLayout.acquireSlot(paneLabel)
  const childRenderer = paneSlot
    ? Renderer.forFile(paneSlot.logFile)
    : (_currentRenderer as Renderer)

  const childConfig: EngineConfig = {
    ..._currentConfig,
    agent: agentConfig,
    cwd: context.cwd,
    hookRunner: undefined,
    sessionDir: undefined,
  }

  const childEngine = _engineFactory(childConfig, childRenderer)

  const normalizedPrompt = normalizeDelegatedPrompt(prompt, _currentConfig)
  const placeholdersReplaced = normalizedPrompt !== prompt
  const inheritedContextLines = [
    `- session_dir: ${_currentConfig.sessionDir ?? 'not set'}`,
    `- call_depth: ${_callDepth}`,
  ]

  const sessionDirHint = _currentConfig.sessionDir
    ? `\n- Session dir: ${_currentConfig.sessionDir}`
    : ''
  const delegatedPrompt = [
    '[Delegation Contract]',
    '- Strictly follow the "Task Instructions" below. Do not change task scope.',
    '- If user/main agent gave explicit constraints, treat them as highest priority.',
    '- If information is missing and blocks execution, report what is missing. Do not guess.',
    '- If SESSION_DIR placeholder appears, use the value from "Inherited Context" below.',
    sessionDirHint,
    '',
    '[Inherited Context]',
    ...inheritedContextLines,
    '',
    '[Task Description]',
    description,
    '',
    '[Task Instructions]',
    normalizedPrompt,
  ].join('\n')

  appendAgentEvent(_currentConfig, {
    event: 'delegation.start',
    agent_label: agentLabel,
    description,
    max_iterations: agentConfig.maxIterations,
    call_depth: _callDepth,
    verify_enabled: verify,
    placeholders_replaced: placeholdersReplaced,
    prompt_preview: normalizedPrompt.slice(0, 500),
  })

  if (context.signal) {
    if (context.signal.aborted) {
      _callDepth--
      mainRenderer.agentDone(description, false)
      if (paneSlot) { tmuxLayout.releaseSlot(paneSlot.slot); childRenderer.destroy() }
      return { content: `[${agentLabel}] Cancelled (parent task aborted)`, isError: true }
    }
    context.signal.addEventListener('abort', () => childEngine.abort(), { once: true })
  }

  const HEARTBEAT_MS = 2 * 60 * 1000
  const heartbeatTimer = setInterval(() => {
    const elapsedSec = Math.round((Date.now() - agentStartTime) / 1000)
    mainRenderer.agentHeartbeat(agentLabel, description, elapsedSec)
  }, HEARTBEAT_MS)

  try {
    const { result } = await childEngine.runTurn(delegatedPrompt, [])
    clearInterval(heartbeatTimer)
    const durationMs = Date.now() - agentStartTime

    mainRenderer.agentDone(description, result.reason !== 'error')
    if (paneSlot) { tmuxLayout.releaseSlot(paneSlot.slot); childRenderer.destroy() }

    // ── Verification Gate (AgentOS "No Tuple, No Merge") ──
    let verifySection = ''
    if (verify && result.reason !== 'error' && !agentConfig.identity.planMode) {
      const verifyResult = runVerification(context.cwd)
      if (verifyResult) {
        const icon = verifyResult.passed ? '✓' : '✗'
        verifySection = `\n\n---\n[Verify Gate] ${icon}\n${verifyResult.output}`
        context.eventLog?.append('invoke_completed', agentLabel, {
          description,
          verified: true,
          verification_passed: verifyResult.passed,
        }, [agentLabel, 'verify', verifyResult.passed ? 'passed' : 'failed'])
      }
    }

    context.eventLog?.append('invoke_completed', agentLabel, {
      description,
      success: result.reason !== 'error',
      reason: result.reason,
      duration_ms: durationMs,
      call_depth: _callDepth,
      output_preview: result.output.slice(0, 500),
    }, [agentLabel, 'invoke', result.reason !== 'error' ? 'success' : 'error'])

    _callDepth--

    if (!result.output) {
      return {
        content: `[${agentLabel}] "${description}" done (${result.reason}), no text output.${verifySection}`,
        isError: false,
      }
    }

    const summaryLines = result.output
      .split('\n')
      .map((l: string) => l.trimEnd())
      .filter((l: string) => l.trim().length > 0)
      .slice(0, 8)
      .join('\n')
    if (summaryLines) {
      mainRenderer.agentSummary(agentLabel, description, summaryLines)
    }

    return {
      content: `[${agentLabel}] "${description}":\n\n${result.output}${verifySection}`,
      isError: false,
    }
  } catch (err: unknown) {
    clearInterval(heartbeatTimer)
    _callDepth--
    mainRenderer.agentDone(description, false)
    if (paneSlot) { tmuxLayout.releaseSlot(paneSlot.slot); childRenderer.destroy() }
    appendAgentEvent(_currentConfig, {
      event: 'delegation.error',
      agent_label: agentLabel,
      description,
      success: false,
      duration_ms: Date.now() - agentStartTime,
      error: (err as Error).message,
    })
    return {
      content: `[${agentLabel}] "${description}" error: ${(err as Error).message}`,
      isError: true,
    }
  }
}

// ── AgentTool ────────────────────────────────────────────────────────────────

export class AgentTool implements Tool {
  name = 'Agent'
  metadata = { concurrencySafe: true, longRunning: true }

  definition: ToolDefinition = {
    type: 'function',
    function: {
      name: 'Agent',
      description: `Spawn a specialized sub-agent for a focused task. Multiple Agent calls in one response run concurrently (Promise.all).

## Agent Configuration

Option 1 — Preset name: subagent_type: "explore" | "plan" | "code-reviewer" | "general-purpose"
Option 2 — Custom config: agent_config: { identity, modules, tools, maxIterations }

## Verification Gate

Set verify: true to auto-run tsc --noEmit after the sub-agent completes code changes.
Failed verification includes error details so you can fix immediately.

## Rules
- prompt must be fully self-contained (sub-agent has no parent context)
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
          verify: { type: 'boolean', description: 'Verification gate: auto-run tsc --noEmit after completion (default false)' },
        },
        required: ['description', 'prompt'],
      },
    },
  }

  async execute(input: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
    const description = str(input.description, 'subtask')
    const prompt      = str(input.prompt, '')
    const verify      = input.verify === true

    if (!prompt.trim()) {
      return { content: 'Error: prompt cannot be empty', isError: true }
    }

    if (!_engineFactory || !_currentConfig || !_currentRenderer) {
      return { content: 'Error: AgentTool not initialized. Call registerAgentFactory first.', isError: true }
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
    })
    const agentLabel = customConfig ? 'custom' : (presetName ?? 'general-purpose')

    if (typeof input.max_iterations === 'number') {
      agentConfig.maxIterations = Math.min(input.max_iterations, 200)
    }

    return runAgentTask(description, prompt, agentConfig, agentLabel, verify, context)
  }
}
