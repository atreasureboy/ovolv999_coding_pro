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
import type { AgentConfig } from '../core/agentPresets.js'
import { resolveAgentConfig, validateAgentConfig, PRESET_NAMES } from '../core/agentPresets.js'
import { Renderer } from '../ui/renderer.js'
import { tmuxLayout } from '../ui/tmuxLayout.js'
import { appendFileSync, existsSync, readFileSync } from 'fs'
import { join } from 'path'
import { execSync } from 'child_process'
import { str } from '../core/strings.js'
import type { PermissionManager } from '../core/permissionSystem.js'

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
  factory: AgentChildEngineFactory
  parentConfig: EngineConfig
  parentRenderer: unknown
}

export class AgentTool implements Tool {
  name = 'Agent'
  metadata = { concurrencySafe: true, longRunning: true }

  /** Immutable per-instance wiring — captured once in the constructor and
   * shared by every parallel Agent call dispatched from this tool. May
   * be undefined only when the caller bypasses the type system (e.g.
   * tests using `as any`). `execute()` guards against the runtime
   * misshape and returns "not initialized" instead of dereferencing
   * these fields. */
  private readonly factory: AgentChildEngineFactory | undefined
  private readonly parentConfig: EngineConfig | undefined
  private readonly parentRenderer: unknown

  constructor(wiring?: AgentToolWiring) {
    this.factory = wiring?.factory
    this.parentConfig = wiring?.parentConfig
    this.parentRenderer = wiring?.parentRenderer
  }

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
    const verify      = input.verify === true

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
    })
    const agentLabel = customConfig ? 'custom' : (presetName ?? 'general-purpose')

    if (typeof input.max_iterations === 'number') {
      agentConfig.maxIterations = Math.min(input.max_iterations, 200)
    }

    return this.runAgentTask(description, prompt, agentConfig, agentLabel, verify, context)
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
    verify: boolean,
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

    const mainRenderer = parentRenderer as {
      agentStart:     (desc: string, type: string) => void
      agentDone:      (desc: string, success: boolean) => void
      agentSummary:   (agentType: string, desc: string, summary: string) => void
      agentHeartbeat: (agentType: string, desc: string, elapsedSec: number) => void
    }
    mainRenderer.agentStart(description, agentLabel)
    const agentStartTime = Date.now()

    // P0-9: track this subtask in SharedRuntimeState so the runtime
    // surface reflects what's currently in flight. The id is unique
    // per invocation (depth + timestamp + counter) and is removed
    // unconditionally in the finally block below — same pattern as
    // ToolScheduler's activeToolCalls tracking.
    const subtaskId = `${description.slice(0, 40)}|d${nextDepth}|t${agentStartTime}`
    const sharedRuntimeState = (context as unknown as {
      sharedState?: { activeSubtasks: Map<string, { description: string; agentLabel: string; startedAt: number }> }
    }).sharedState
    if (sharedRuntimeState?.activeSubtasks) {
      sharedRuntimeState.activeSubtasks.set(subtaskId, { description, agentLabel, startedAt: agentStartTime })
    }

    // Structured communication event: INVOKE_SENT (with call depth)
    context.eventLog?.append('invoke_sent', agentLabel, {
      description,
      modules: agentConfig.modules ? Object.keys(agentConfig.modules) : [],
      planMode: agentConfig.identity.planMode ?? false,
      maxIterations: agentConfig.maxIterations,
      call_depth: nextDepth,
      verify_enabled: verify,
    }, [agentLabel, 'invoke'])

    const paneLabel = `[${agentLabel}] ${description}`
    const paneSlot = tmuxLayout.acquireSlot(paneLabel)
    const childRenderer = paneSlot
      ? Renderer.forFile(paneSlot.logFile)
      : (parentRenderer as Renderer)

    const childConfig: EngineConfig = {
      ...parentConfig,
      agent: agentConfig,
      cwd: context.cwd,
      hookRunner: undefined,
      sessionDir: undefined,
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
    ]

    const sessionDirHint = parentConfig.sessionDir
      ? `\n- Session dir: ${parentConfig.sessionDir}`
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

    appendAgentEvent(parentConfig, {
      event: 'delegation.start',
      agent_label: agentLabel,
      description,
      max_iterations: agentConfig.maxIterations,
      call_depth: nextDepth,
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
      mainRenderer.agentHeartbeat(agentLabel, description, elapsedSec)
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
          if (paneSlot) { tmuxLayout.releaseSlot(paneSlot.slot); childRenderer.destroy() }
          return { content: `[${agentLabel}] Cancelled (parent task aborted)`, isError: true }
        }
        abortListener = () => childEngine.abort()
        context.signal.addEventListener('abort', abortListener, { once: true })
      }

      const { result } = await childEngine.runTurn(delegatedPrompt, [])
      const durationMs = Date.now() - agentStartTime

      // ── Verification Gate (AgentOS "No Tuple, No Merge") ──
      // P0-3: a sub-agent that finishes "successfully" (reason !== 'error')
      // but leaves the workspace with failing typecheck/lint/test MUST
      // propagate as isError to the parent — otherwise the parent has
      // no structured signal and must parse natural language to
      // discover the verification failure.
      let verifySection = ''
      let verificationFailed = false
      if (verify && result.reason !== 'error' && !agentConfig.identity.planMode) {
        const verifyResult = runVerification(context.cwd)
        if (verifyResult) {
          const icon = verifyResult.passed ? '✓' : '✗'
          verifySection = `\n\n---\n[Verify Gate] ${icon}\n${verifyResult.output}`
          verificationFailed = !verifyResult.passed
          context.eventLog?.append('invoke_completed', agentLabel, {
            description,
            verified: true,
            verification_passed: verifyResult.passed,
          }, [agentLabel, 'verify', verifyResult.passed ? 'passed' : 'failed'])
        }
      }

      // P0-3: combined failure signal — engine error OR verify gate
      // failure. Either way the parent must see isError:true so it
      // can branch without parsing the natural-language report.
      const failed = result.reason === 'error' || verificationFailed
      mainRenderer.agentDone(description, !failed)
      if (paneSlot) { tmuxLayout.releaseSlot(paneSlot.slot); childRenderer.destroy() }

      context.eventLog?.append('invoke_completed', agentLabel, {
        description,
        success: !failed,
        reason: result.reason,
        verification_failed: verificationFailed || undefined,
        duration_ms: durationMs,
        call_depth: nextDepth,
        output_preview: result.output.slice(0, 500),
      }, [agentLabel, 'invoke', !failed ? 'success' : 'error'])

      if (!result.output) {
        return {
          content: `[${agentLabel}] "${description}" done (${result.reason}), no text output.${verifySection}`,
          isError: failed,
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
        isError: failed,
      }
    } catch (err: unknown) {
      mainRenderer.agentDone(description, false)
      if (paneSlot) { tmuxLayout.releaseSlot(paneSlot.slot); childRenderer.destroy() }
      appendAgentEvent(parentConfig, {
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
      // P0-9: remove the subtask from activeSubtasks on EVERY exit
      // path so the runtime surface cannot accumulate stale entries.
      if (sharedRuntimeState?.activeSubtasks) {
        sharedRuntimeState.activeSubtasks.delete(subtaskId)
      }
    }
  }
}
