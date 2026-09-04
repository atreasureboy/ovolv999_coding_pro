/**
 * Default hook runner — concrete IHookRunner that loads hook config
 * from disk and executes user-defined hooks via the JSON protocol.
 *
 * Falls back to no-op when no config exists, so engines that opt in
 * to the new outcome API without configuring any hooks still work.
 */

import type {
  IHookRunner,
  HookResult,
  PreToolUseOutcome,
  PostToolUseOutcome,
} from '../types.js'
import { executeHooksParallel } from './hookExecutor.js'
import { loadHookConfig, matchersForEvent, type HookConfig, type HookCommandConfig } from './hooksConfig.js'
import {
  type HookEvent,
  type HookInput,
  type PreToolUseInput,
  type PostToolUseInput,
  type UserPromptSubmitInput,
  type SessionStartInput,
  type SessionEndInput,
  type StopInput,
  type PreCompactInput,
  type PostCompactInput,
} from './hookProtocol.js'

export interface DefaultHookRunnerOptions {
  cwd?: string
  sessionId?: string
  configOverride?: HookConfig
  includeProject?: boolean
}

function genSessionId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
}

function execToHookResult(exec: {
  hookName: string
  command: string
  ok: boolean
  exitCode: number | null
  durationMs: number
  timedOut: boolean
  cancelled: boolean
  error?: string
}): HookResult {
  let errorCode: HookResult['errorCode']
  if (!exec.ok) {
    if (exec.timedOut) errorCode = 'timeout'
    else if (exec.error?.startsWith('spawn')) errorCode = 'spawn_failed'
    else if (exec.exitCode === 127) errorCode = 'not_found'
    else if (exec.cancelled) errorCode = 'unknown'
    else errorCode = 'non_zero'
  }
  return {
    hook: exec.hookName,
    command: exec.command,
    ok: exec.ok,
    status: exec.exitCode,
    signal: null,
    durationMs: exec.durationMs,
    error: exec.error,
    errorCode,
  }
}

export class DefaultHookRunner implements IHookRunner {
  private readonly cwd: string
  private readonly sessionId: string
  private readonly includeProject: boolean
  private config: HookConfig | null
  /** Round 26 re-audit (D7): SessionStart must fire ONCE per session (CC
   *  semantics) — the coordinator invokes run* at every turn, so an
   *  un-gated hook would execute per user message. */
  private sessionStartFired = false

  constructor(options: DefaultHookRunnerOptions = {}) {
    this.cwd = options.cwd ?? process.cwd()
    this.sessionId = options.sessionId ?? genSessionId()
    this.includeProject = options.includeProject === true
    this.config = options.configOverride ?? loadHookConfig(this.cwd, this.includeProject) ?? null
  }

  reload(): void {
    this.config = loadHookConfig(this.cwd, this.includeProject) ?? null
  }

  setConfig(config: HookConfig | null): void {
    this.config = config
  }

  getSessionId(): string {
    return this.sessionId
  }

  private getCommandsFor(event: HookEvent, candidate: string): HookCommandConfig[] {
    if (!this.config) return []
    const matchers = matchersForEvent(this.config, event, candidate)
    return matchers.flatMap(m => m.hooks)
  }

  async runPreToolCall(toolName: string, input: Record<string, unknown>): Promise<HookResult[]> {
    if (!this.config) return []
    const cmds = this.getCommandsFor('PreToolUse', toolName)
    if (cmds.length === 0) return []
    const ev: PreToolUseInput = {
      session_id: this.sessionId, cwd: this.cwd, hook_event_name: 'PreToolUse',
      tool_name: toolName, tool_input: input, tool_use_id: `legacy-${Date.now()}`,
    }
    const execs = await executeHooksParallel(cmds, ev, { cwd: this.cwd })
    return execs.map(execToHookResult)
  }

  async runPostToolCall(toolName: string, result: string, isError: boolean): Promise<HookResult[]> {
    if (!this.config) return []
    const cmds = this.getCommandsFor('PostToolUse', toolName)
    if (cmds.length === 0) return []
    const ev: PostToolUseInput = {
      session_id: this.sessionId, cwd: this.cwd, hook_event_name: 'PostToolUse',
      tool_name: toolName, tool_input: {},
      tool_result: { content: result, is_error: isError },
      tool_use_id: `legacy-${Date.now()}`,
    }
    const execs = await executeHooksParallel(cmds, ev, { cwd: this.cwd })
    return execs.map(execToHookResult)
  }

  async runUserPromptSubmit(prompt: string): Promise<HookResult[]> {
    if (!this.config) return []
    const cmds = this.getCommandsFor('UserPromptSubmit', prompt)
    if (cmds.length === 0) return []
    const ev: UserPromptSubmitInput = {
      session_id: this.sessionId, cwd: this.cwd, hook_event_name: 'UserPromptSubmit',
      prompt,
    }
    const execs = await executeHooksParallel(cmds, ev, { cwd: this.cwd })
    return execs.map(execToHookResult)
  }

  async runPreToolUse(toolName: string, input: Record<string, unknown>, signal: AbortSignal): Promise<PreToolUseOutcome[]> {
    if (!this.config) return []
    const cmds = this.getCommandsFor('PreToolUse', toolName)
    if (cmds.length === 0) return []
    const ev: PreToolUseInput = {
      session_id: this.sessionId, cwd: this.cwd, hook_event_name: 'PreToolUse',
      tool_name: toolName, tool_input: input,
      tool_use_id: `pre-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    }
    const execs = await executeHooksParallel(cmds, ev, { signal, cwd: this.cwd })
    return execs.map((exec) => {
      const specific = exec.output?.hookSpecificOutput
      const decision = specific && 'permissionDecision' in specific ? specific.permissionDecision : undefined
      const outcome: PreToolUseOutcome = {
        decision: decision ?? 'allow',
        reason: specific && 'permissionDecisionReason' in specific ? specific.permissionDecisionReason : undefined,
        updatedInput: specific && 'updatedInput' in specific ? specific.updatedInput : undefined,
        additionalContext: specific && 'additionalContext' in specific ? specific.additionalContext : undefined,
        hookName: exec.hookName,
        error: exec.error,
      }
      if (exec.output?.decision === 'block' && outcome.decision === 'allow') {
        outcome.decision = 'deny'
      }
      if (exec.output?.reason && !outcome.reason) outcome.reason = exec.output.reason
      if (exec.output?.systemMessage && !outcome.reason) outcome.reason = exec.output.systemMessage
      return outcome
    })
  }

  async runPostToolUse(toolName: string, content: string, isError: boolean, signal: AbortSignal): Promise<PostToolUseOutcome[]> {
    if (!this.config) return []
    const cmds = this.getCommandsFor('PostToolUse', toolName)
    if (cmds.length === 0) return []
    const ev: PostToolUseInput = {
      session_id: this.sessionId, cwd: this.cwd, hook_event_name: 'PostToolUse',
      tool_name: toolName, tool_input: {},
      tool_result: { content, is_error: isError },
      tool_use_id: `post-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    }
    const execs = await executeHooksParallel(cmds, ev, { signal, cwd: this.cwd })
    return execs.map((exec) => {
      const specific = exec.output?.hookSpecificOutput
      const ctx = specific && 'additionalContext' in specific ? specific.additionalContext : undefined
      return {
        additionalContext: ctx,
        hookName: exec.hookName,
        error: exec.error,
      }
    })
  }

  /** R7: dispatch a session/start/end/stop/compact event with no candidate matcher. */
  private async dispatchSessionEvent(ev: HookInput): Promise<void> {
    if (!this.config) return
    const cmds = this.getCommandsFor(ev.hook_event_name, '')
    if (cmds.length === 0) return
    await executeHooksParallel(cmds, ev, { cwd: this.cwd })
  }

  async runSessionStart(source: 'startup' | 'resume' | 'clear' | 'compact'): Promise<void> {
    if (this.sessionStartFired && source === 'startup') return
    this.sessionStartFired = true
    const ev: SessionStartInput = {
      session_id: this.sessionId, cwd: this.cwd, hook_event_name: 'SessionStart',
      source,
    }
    await this.dispatchSessionEvent(ev)
  }

  async runSessionEnd(reason: string): Promise<void> {
    const ev: SessionEndInput = {
      session_id: this.sessionId, cwd: this.cwd, hook_event_name: 'SessionEnd',
      reason,
    }
    await this.dispatchSessionEvent(ev)
  }

  async runStop(reason: string): Promise<void> {
    const ev: StopInput = {
      session_id: this.sessionId, cwd: this.cwd, hook_event_name: 'Stop',
      reason,
    }
    await this.dispatchSessionEvent(ev)
  }

  async runPreCompact(trigger: 'auto' | 'manual'): Promise<void> {
    const ev: PreCompactInput = {
      session_id: this.sessionId, cwd: this.cwd, hook_event_name: 'PreCompact',
      trigger,
    }
    await this.dispatchSessionEvent(ev)
  }

  async runPostCompact(trigger: 'auto' | 'manual'): Promise<void> {
    const ev: PostCompactInput = {
      session_id: this.sessionId, cwd: this.cwd, hook_event_name: 'PostCompact',
      trigger,
    }
    await this.dispatchSessionEvent(ev)
  }
}
