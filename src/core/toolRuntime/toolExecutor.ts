/**
 * ToolExecutor — executes a single tool call with all policy checks,
 * permission enforcement, hooks, result truncation, and module notification.
 *
 * Responsibilities (from architecture plan §5.8):
 *   - Find tool in registry
 *   - Execution-time policy check (defense-in-depth: plan mode + agent allowlist)
 *   - Permission check (PermissionManager)
 *   - Pre/post hooks (PreToolCall, PostToolCall)
 *   - AbortSignal传递 (via ToolContext.signal)
 *   - Execute the tool
 *   - Error standardization
 *   - Tool Result truncation (individual, via ContextManager)
 *   - Module onToolCall notification
 *
 * Does NOT handle: batch scheduling (scheduler's job), aggregate budget
 * across parallel results (scheduler's job), or message pushing (scheduler's job).
 */

import type { ToolContext, ToolResult, IHookRunner } from '../types.js'
import type { PermissionManager } from '../permissionSystem.js'
import { classifyCommandRisk } from '../riskClassifier.js'
import { gateByPermissionMode } from './permissionModeGate.js'
import { evaluateDefaultGlobRule, sessionApprovalCache, extractPrimaryArg } from '../permissionRules.js'
import type { EventLog } from '../eventLog.js'
import type { RendererInterface } from '../types.js'
import type { ToolPolicy } from './toolPolicy.js'
import type { ToolRegistry } from './toolRegistry.js'
import type { ContextManager } from '../context/contextManager.js'
import type { RunEventEmitter } from '../runtime/events.js'
import type { ProgressMonitor } from '../runtime/progressMonitor.js'
import type { RegisteredToolResult } from '../runtime/runScopedContext.js'
import { toLegacy, isStructuredResult, type AnyToolResult } from '../structuredToolResult.js'

export type NotifyToolCall = (
  toolName: string,
  input: Record<string, unknown>,
  result: ToolResult,
  turnNumber: number,
) => void

export interface ToolExecutorDeps {
  toolRegistry: ToolRegistry
  toolPolicy: ToolPolicy
  permissionManager: PermissionManager
  contextManager: ContextManager
  requestPermission?: (
    toolName: string,
    input: Record<string, unknown>,
    riskLevel: 'safe' | 'needs-approval' | 'dangerous',
  ) => Promise<{ approved: boolean; feedback?: string }>
  notifyToolCall: NotifyToolCall
  hookRunner?: IHookRunner
  eventEmitter?: RunEventEmitter
  /** R11: emit one permission_decision event per layer decision. */
  eventLog?: EventLog
  /** Phase 4: records every tool result for stall detection. */
  progressMonitor?: ProgressMonitor
  resolveProgressMonitor?: (context: ToolContext) => ProgressMonitor | undefined
  renderer: RendererInterface
  /** v0.5.5 §2: per-run ToolResult registry. Populated after
   *  every tool completion; consumed by MemoryModule.onComplete
   *  for tool_observed evidence validation. */
  sharedState?: { toolCallRegistry?: Map<string, RegisteredToolResult> | null }
  /**
   * R5: hook additionalContext sink. Wired by the coordinator to
   * append `hook_additional_context` messages to the per-run
   * ControlMessageLog so the next LLM call sees them.
   * Optional — absent means hooks' additionalContext is dropped.
   */
  appendHookContext?: (toolName: string, hookName: string, context: string) => void
}

export class ToolExecutor {
  private readonly deps: ToolExecutorDeps

  constructor(deps: ToolExecutorDeps) {
    this.deps = deps
  }

  async execute(
    callId: string,
    toolName: string,
    input: Record<string, unknown>,
    context: ToolContext,
    planMode: boolean,
    turnNumber: number,
  ): Promise<ToolResult> {
    const { toolRegistry, toolPolicy, permissionManager, eventEmitter, eventLog } = this.deps

    // v0.5.6 §7 — single finalizer. Every tool path (unknown,
    // policy deny, permission deny, hook deny, execute throw,
    // normal) converges here. The Registry MUST record BOTH
    // originalText (what the tool returned) AND exposedText
    // (what the model saw, after truncateToolResult). duplicate
    // callIds are rejected with an explicit event; we never
    // silently overwrite.
    const runIdFromContext = (context as { execution?: { runId?: string } }).execution?.runId ?? ''
    // precomputed: callers that already truncated result content pass the
    // original/exposed pair so finalize never double-truncates (the
    // truncated form slightly exceeds the budget due to the marker, so a
    // second pass would truncate again and rewrite the spill file).
    const finalize = (result: ToolResult, precomputed?: { originalText: string; exposedText: string }) => {
      const originalText = precomputed?.originalText ?? result.content ?? ''
      const exposedText = precomputed
        ? precomputed.exposedText
        : this.deps.contextManager.truncateToolResult(originalText)
      const truncated = exposedText !== originalText
      const finalResult: ToolResult = truncated ? { ...result, content: exposedText } : result
      eventEmitter?.emit({ type: 'TOOL_COMPLETED', callId, toolName, result: finalResult })
      const registry = this.deps.sharedState?.toolCallRegistry
      if (registry && callId) {
        if (registry.has(callId)) {
          // Duplicate callId — reject. Record to the audit EventLog
          // (never silently overwrite).
          eventLog?.append('tool_result_duplicate_call_id', 'tool_executor', {
            runId: runIdFromContext,
            callId,
            toolName,
          })
        } else {
          registry.set(callId, {
            runId: runIdFromContext,
            callId,
            toolName,
            originalText,
            exposedText,
            isError: finalResult.isError === true,
            truncated,
            completedAt: Date.now(),
          })
        }
      }
      return finalResult
    }
    const allTools = toolRegistry.getAll()

    // R11: helper to emit a permission_decision event. Always best-
    // effort — never block the tool path on a log failure.
    const recordDecision = (layer: 'mode_gate' | 'glob_engine' | 'permission_manager' | 'session_approval' | 'hook', outcome: 'allow' | 'deny' | 'ask', reason: string, ruleId?: string): void => {
      if (!eventLog) return
      eventLog.append('permission_decision', layer, {
        callId,
        tool: toolName,
        primaryArg: extractPrimaryArg(input),
        mode: context.permissionMode,
        outcome,
        reason,
        ruleId: ruleId ?? null,
      })
    }

    const tool = toolRegistry.get(toolName)
    if (!tool) {
      const result: ToolResult = { content: `Unknown tool: ${toolName}`, isError: true }
      return finalize(result)
    }

    // Execution-time policy check (defense in depth)
    const policyError = toolPolicy.checkExecutionAllowed(
      allTools,
      toolName,
      planMode,
      context.excludedTools,
      context.taskKind,
    )
    if (policyError) {
      const result: ToolResult = { content: policyError, isError: true }
      return finalize(result)
    }

    // R5: Permission mode gating — coarse knob before permissionManager.
    // mode 'plan' is already enforced by toolPolicy above (planMode=true).
    const modeGated = gateByPermissionMode(context.permissionMode, toolName)
    if (modeGated === 'deny') {
      recordDecision('mode_gate', 'deny', `mode '${context.permissionMode}' denies ${toolName}`)
      const result: ToolResult = {
        content: `Permission mode '${context.permissionMode}' denies ${toolName}`,
        isError: true,
      }
      return finalize(result)
    }
    if (modeGated === 'allow') {
      recordDecision('mode_gate', 'allow', `mode '${context.permissionMode}' allows ${toolName}`)
    }

    // R9.2: Glob-engine fine-grained rules. Sits BETWEEN the coarse mode
    // gate and the permissionManager. Deny WINS over mode (defense in
    // depth — the user said "don't rm -rf", we don't rm -rf regardless
    // of mode). Allow skips the manager. Ask falls through to the
    // manager. Priority is honored via the rule order in
    // DEFAULT_PERMISSION_CONFIG.
    const globResult = evaluateDefaultGlobRule(toolName, input)
    if (globResult.decision === 'deny') {
      recordDecision('glob_engine', 'deny', globResult.reason, globResult.matchedRule?.id)
      const result: ToolResult = {
        content: `Permission rule denied: ${globResult.reason}`,
        isError: true,
      }
      return finalize(result)
    }
    if (globResult.decision === 'allow') {
      recordDecision('glob_engine', 'allow', globResult.reason, globResult.matchedRule?.id)
    }
    // If the glob rule explicitly allows OR the user has session-approved
    // this pattern, skip the permission manager entirely.
    const sessionApproved = sessionApprovalCache.isApproved(toolName, extractPrimaryArg(input))
    if (globResult.decision === 'allow' || sessionApproved) {
      if (sessionApproved) {
        recordDecision('session_approval', 'allow', 'session-scoped approval cache')
      }
      // explicit glob allow OR session approval — execute without prompt
    } else if (modeGated === 'allow') {
      // mode explicitly allows this tool — skip permission check
      // fall through to tool execution
    } else {
      // Permission check
      const isDangerous =
        toolName === 'Bash' && typeof input.command === 'string'
          ? classifyCommandRisk(input.command) === 'dangerous'
          : false
      const permission = permissionManager.check(toolName, input, isDangerous)
      if (permission === 'deny') {
        recordDecision('permission_manager', 'deny', `mode '${permissionManager.formatMode()}' denies for ${toolName}`)
        const result: ToolResult = {
          content: `Permission denied for ${toolName}. Current mode: ${permissionManager.formatMode()}`,
          isError: true,
        }
        return finalize(result)
      }
      if (permission === 'ask') {
        recordDecision('permission_manager', 'ask', 'mode suggests ask')
      }
      if (permission === 'ask') {
        if (this.deps.requestPermission) {
          const riskLevel = isDangerous ? 'dangerous' : 'needs-approval'
          const permResult = await this.deps.requestPermission(toolName, input, riskLevel)
          if (!permResult.approved) {
            const feedback = permResult.feedback?.trim()
            const result: ToolResult = {
              content: feedback
                ? `Permission denied by user for ${toolName}. Feedback: ${feedback}`
                : `Permission denied by user for ${toolName}.`,
              isError: true,
            }
            return finalize(result)
          }
        } else {
          // Round 26 (L4): FAIL CLOSED. Previously this warned and ran the
          // tool anyway ("single-user mode") — any headless embedding
          // (pipe mode, ACP without a prompt handler) silently executed
          // approval-requiring actions. Matching Claude Code's
          // non-interactive contract: no prompt ⇒ denial with guidance.
          const result: ToolResult = {
            content:
              `Permission denied for ${toolName}: this action requires approval, but no ` +
              `permission prompt is available (non-interactive mode). Allow it via a ` +
              `permissions rule in .ovogo/settings.json, or run with a higher ` +
              `permission mode if you accept the risk.`,
            isError: true,
          }
          return finalize(result)
        }
      }
    } // end of permission check branch

    // Phase 2: Pre-tool hook with outcome (allow/deny/modify/context).
    // If the runner implements runPreToolUse, prefer it over the legacy
    // runPreToolCall (which is fire-and-forget observation only). Legacy
    // runner path is preserved for back-compat — when no runPreToolUse
    // is defined, fire the legacy form for telemetry and continue.
    const hookOutcomes = this.deps.hookRunner?.runPreToolUse
      ? await this.deps.hookRunner.runPreToolUse(toolName, input, context.signal ?? new AbortController().signal)
      : null
    if (hookOutcomes) {
      const deny = hookOutcomes.find((o) => o.decision === 'deny')
      if (deny) {
        const reason = deny.reason ?? deny.error ?? `Denied by hook ${deny.hookName}`
        const result: ToolResult = {
          content: `Tool "${toolName}" denied by hook (${deny.hookName}): ${reason}`,
          isError: true,
        }
        return finalize(result)
      }
      const ask = hookOutcomes.find((o) => o.decision === 'ask')
      if (ask) {
        if (!this.deps.requestPermission) {
          return finalize({
            content: `Tool "${toolName}" requires approval from hook (${ask.hookName}), but no permission prompt is available.`,
            isError: true,
          })
        }
        const permResult = await this.deps.requestPermission(toolName, input, 'needs-approval')
        if (!permResult.approved) {
          const reason = permResult.feedback?.trim() ?? ask.reason ?? 'hook asked for approval'
          const result: ToolResult = {
            content: `Tool "${toolName}" denied by hook (${ask.hookName}): ${reason}`,
            isError: true,
          }
          return finalize(result)
        }
      }
      const firstWithUpdate = hookOutcomes.find((o) => o.updatedInput)
      if (firstWithUpdate?.updatedInput) {
        input = firstWithUpdate.updatedInput
        const updatedGlobResult = evaluateDefaultGlobRule(toolName, input)
        if (updatedGlobResult.decision === 'deny') {
          recordDecision('hook', 'deny', `updated input: ${updatedGlobResult.reason}`, updatedGlobResult.matchedRule?.id)
          return finalize({ content: `Permission rule denied hook-updated input: ${updatedGlobResult.reason}`, isError: true })
        }
        const updatedApproved = sessionApprovalCache.isApproved(toolName, extractPrimaryArg(input))
        if (updatedGlobResult.decision !== 'allow' && !updatedApproved && modeGated !== 'allow') {
          const updatedDangerous = toolName === 'Bash' && typeof input.command === 'string'
            ? classifyCommandRisk(input.command) === 'dangerous'
            : false
          const updatedPermission = permissionManager.check(toolName, input, updatedDangerous)
          if (updatedPermission === 'deny') {
            recordDecision('hook', 'deny', 'permission manager denied hook-updated input')
            return finalize({ content: `Permission denied for hook-updated ${toolName} input.`, isError: true })
          }
          if (updatedPermission === 'ask') {
            if (!this.deps.requestPermission) {
              return finalize({
                content: `Permission denied for hook-updated ${toolName}: approval is required, but no permission prompt is available.`,
                isError: true,
              })
            }
            const updatedApproval = await this.deps.requestPermission(
              toolName,
              input,
              updatedDangerous ? 'dangerous' : 'needs-approval',
            )
            if (!updatedApproval.approved) {
              return finalize({ content: `Permission denied by user for hook-updated ${toolName}.`, isError: true })
            }
          }
        }
      }
      // additionalContext is buffered in ControlMessageLog (next LLM call
      // renders it then clears). Engine injects via toolContext hookContext.
      const hookContext = hookOutcomes
        .map((o) => o.additionalContext)
        .filter((s): s is string => typeof s === 'string' && s.length > 0)
        .join('\n\n')
      if (hookContext) {
        // R5: write each hook's additionalContext to ControlMessageLog
        // so the next LLM round sees it. The legacy context.hookContext
        // field is kept as a fallback for tools that read it directly.
        ;(context as { hookContext?: string }).hookContext =
          ((context as { hookContext?: string }).hookContext ?? '') + hookContext
        if (this.deps.appendHookContext) {
          for (const o of hookOutcomes) {
            if (o.additionalContext && o.additionalContext.length > 0) {
              this.deps.appendHookContext(toolName, o.hookName, o.additionalContext)
            }
          }
        }
      }
    } else if (this.deps.hookRunner) {
      const legacyResults = await Promise.resolve(
        this.deps.hookRunner.runPreToolCall(toolName, input),
      )
      void legacyResults
    }
    eventEmitter?.emit({ type: 'TOOL_STARTED', callId, toolName, input })

    let result: ToolResult
    try {
      // Tools may return either the legacy {content, isError} shape or
      // the structured shape (status/summary/exitCode/stdout/stderr/...).
      //
      // runtime invariants §三: the internal execution chain MUST preserve
      // structured fields (status, exitCode, stdout, stderr,
      // diagnostics, artifacts, retryable) all the way through to the
      // model-message boundary. Only ToolScheduler (which builds the
      // final {role:'tool'} message for the model API) flattens to
      // {content, isError} — and even there it reads content/isError
      // from the same object.
      //
      // Previously this called toLegacy() which created a NEW object
      // with ONLY {content, isError}, irretrievably dropping status,
      // exitCode, stdout, stderr, etc. — so WorkingState, verification,
      // and structured event consumers all saw undefined for those
      // fields. Now we merge: the legacy conversion provides
      // content/isError, and the structured fields are preserved on
      // the same object for downstream readers.
      const raw: AnyToolResult = await tool.execute(input, context)
      if (isStructuredResult(raw)) {
        const legacy = toLegacy(raw)
        result = { ...raw, content: legacy.content, isError: legacy.isError }
      } else {
        result = raw
      }
    } catch (err) {
      result = {
        content: `Tool execution error: ${(err as Error).message || String(err)}`,
        isError: true,
      }
      // PostToolUseFailure hook — best-effort, fires only on exception path.
      if (this.deps.hookRunner?.runPostToolCall) {
        try {
          const failureResults = await Promise.resolve(
            this.deps.hookRunner.runPostToolCall(toolName, (err as Error).message ?? '', true),
          )
          void failureResults
        } catch { /* best-effort */ }
      }
    }

    // Individual tool result truncation (aggregate budget is scheduler's job)
    const originalText = result.content
    const exposedText = this.deps.contextManager.truncateToolResult(originalText)
    result = { ...result, content: exposedText }

    // Post-tool hook with additionalContext outcome (Phase 2).
    // additionalContext is buffered for the next LLM call; never
    // pollutes user-visible history.
    if (this.deps.hookRunner?.runPostToolUse) {
      const postOutcomes = await this.deps.hookRunner.runPostToolUse(
        toolName,
        result.content,
        result.isError,
        context.signal ?? new AbortController().signal,
      )
      const ctx = postOutcomes
        .map((o) => o.additionalContext)
        .filter((s): s is string => typeof s === 'string' && s.length > 0)
        .join('\n\n')
      if (ctx) {
        // R5: write each post-hook's additionalContext to ControlMessageLog.
        ;(context as { hookContext?: string }).hookContext =
          ((context as { hookContext?: string }).hookContext ?? '') + ctx
        if (this.deps.appendHookContext) {
          for (const o of postOutcomes) {
            if (o.additionalContext && o.additionalContext.length > 0) {
              this.deps.appendHookContext(toolName, o.hookName, o.additionalContext)
            }
          }
        }
      }
    } else if (this.deps.hookRunner) {
      const legacyResults = await Promise.resolve(
        this.deps.hookRunner.runPostToolCall(toolName, result.content, result.isError),
      )
      void legacyResults
    }
    result = finalize(result, { originalText, exposedText })

    this.deps.notifyToolCall(toolName, input, result, turnNumber)

    // runtime invariants §四: update WorkingState from the structured tool
    // result. Best-effort — a WorkingState bug must never break the
    // turn. This is the single integration point: both direct executor
    // calls and scheduler-routed calls go through here.
    try {
      this.deps.contextManager.applyToolEvent({ toolName, input, result })
    } catch { /* best-effort */ }

    // Phase 4: feed the same tool result to the ProgressMonitor so the
    // StallDetector sees changed files, repeated calls, and consecutive
    // errors. Best-effort, mirrors the WorkingState integration point.
    try {
      const progressMonitor = this.deps.resolveProgressMonitor?.(context) ?? this.deps.progressMonitor
      progressMonitor?.recordToolCall(toolName, input, {
        isError: result.isError,
        content: typeof result.content === 'string' ? result.content : '',
      })
    } catch { /* best-effort */ }

    return result
  }
}
