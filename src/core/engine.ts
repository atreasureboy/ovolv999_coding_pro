/**
 * Think-Act-Observe Engine — with streaming output
 *
 * Key features:
 * 1. Parallel tool execution — read-only tools batched via Promise.all;
 *    state-mutating tools run serially.
 * 2. AbortController per turn — engine.abort() cancels in-flight API calls
 *    and tool executions.
 * 3. Plan mode — only read-only tools are exposed/executed.
 * 4. Hook callbacks around every tool call.
 * 5. Critic loop — every N iterations a lightweight LLM call reviews recent
 *    context for common failure modes and injects corrections.
 * 6. Context budget management — automatic compression with anchor preservation.
 *
 * Architecture:
 *   runTurn() orchestrates the high-level loop, delegating to:
 *     - buildSystemPrompt()        → compose system prompt
 *     - evaluateContextBudget()    → check token usage, compact if needed
 *     - maybeRunCritic()           → inject correction every N iterations
 *     - callLLM()                  → streaming LLM invocation
 *     - consumeStream()            → parse streamed response
 *     - scheduleToolCalls()        → partition + execute tool calls
 *     - executeToolCall()          → single tool execution
 */

import OpenAI from 'openai'
import type {
  EngineConfig,
  OpenAIMessage,
  Tool,
  ToolContext,
  ToolResult,
  TurnResult,
  ToolDefinition,
} from './types.js'
import { createTools, findTool, getToolDefinitions } from '../tools/index.js'
import { getPlanModePrefix } from '../prompts/system.js'
import type { Renderer } from '../ui/renderer.js'
import {
  maybeCompact,
  estimateTokens,
  getCompressionStrategy,
  MODEL_MAX_CONTEXT_TOKENS,
} from './compact.js'
import type { AgentModule, ModuleBootResult, ModuleBootContext } from './module.js'
import { globalModuleRegistry } from './moduleRegistry.js'
import { applyAgentToConfig } from './agentPresets.js'
import { clearFileState } from './fileState.js'

// ── Constants ────────────────────────────────────────────────────────────────

const MAX_TOOL_RESULT_LENGTH = 20_000

/** Plan mode — only read-only tools are exposed */
const PLAN_MODE_TOOLS = new Set([
  'Read',
  'Glob',
  'Grep',
  'WebFetch',
  'WebSearch',
])

/**
 * Concurrency-safe tools: run in parallel within a single LLM response.
 * When the LLM emits multiple tool calls in one response, they are intended
 * to be independent — execute them concurrently.
 */
const CONCURRENCY_SAFE_TOOLS = new Set([
  'Read',
  'Glob',
  'Grep',
  'WebFetch',
  'WebSearch',
  'Bash', // parallel — dependent ops should use && in one call
  'Agent', // parallel — multiple sub-agents run simultaneously
  'ShellSession', // parallel — different sessions
  'TmuxSession', // parallel — different sessions
])

// ── Internal types ───────────────────────────────────────────────────────────

interface StreamingToolCall {
  index: number
  id: string
  name: string
  arguments: string
}

interface ParsedToolCall {
  tc: StreamingToolCall
  input: Record<string, unknown>
}

interface ToolBatch {
  safe: boolean
  calls: ParsedToolCall[]
}

// ── Pure helper functions ────────────────────────────────────────────────────

/**
 * Partition tool calls into scheduling batches:
 * - All safe tools → merged into one parallel batch (Promise.all)
 * - Stateful tools (Write, Edit, etc.) → each gets its own serial batch
 */
function partitionToolCalls(calls: ParsedToolCall[]): ToolBatch[] {
  const batches: ToolBatch[] = []

  for (const call of calls) {
    const safe = CONCURRENCY_SAFE_TOOLS.has(call.tc.name)
    const last = batches[batches.length - 1]

    if (last && last.safe && safe) {
      last.calls.push(call) // extend existing parallel batch
    } else {
      batches.push({ safe, calls: [call] }) // new batch
    }
  }

  return batches
}

/** Truncate a tool result to stay within token budget */
function truncateToolResult(result: string): string {
  if (result.length <= MAX_TOOL_RESULT_LENGTH) return result
  const half = MAX_TOOL_RESULT_LENGTH / 2
  return (
    result.slice(0, half) +
    `\n\n[... ${result.length - MAX_TOOL_RESULT_LENGTH} chars truncated ...]\n\n` +
    result.slice(result.length - half)
  )
}

// ── Engine class ─────────────────────────────────────────────────────────────

export class ExecutionEngine {
  private client: OpenAI
  private tools: Tool[]
  private config: EngineConfig
  private renderer: Renderer
  /** Abort controller for the current turn — null when idle */
  private currentTurnAbortController: AbortController | null = null
  /** Soft-interrupt flag: pause after current tool finishes */
  private softAbortRequested = false
  /** Event log — may be undefined if not configured */
  private eventLog: EngineConfig['eventLog']
  /** Enabled capability modules */
  private modules: AgentModule[]
  /** Cached boot results (populated in runTurn) */
  private moduleBootResults: ModuleBootResult[] = []
  /** Estimated system prompt tokens — set during boot, used in context budget */
  private systemPromptTokens = 0
  /** All available tools — base + module-provided (populated in runTurn) */
  private allTools: Tool[]

  constructor(config: EngineConfig, renderer: Renderer) {
    // Merge agent config into effective config (overrides legacy fields)
    this.config = applyAgentToConfig(config)
    this.renderer = renderer
    this.client = new OpenAI({
      apiKey: config.apiKey,
      baseURL: config.baseURL,
      maxRetries: 5,      // SDK auto-retries 429/5xx with exponential backoff
      timeout: 120_000,   // 2 min — covers slow reasoning models (deepseek-reasoner)
    })
    this.tools = createTools(config.extraTools ?? [])
    this.allTools = this.tools  // will be updated with module tools in runTurn
    this.eventLog = config.eventLog

    // Resolve enabled modules
    const enabledNames = this.deriveEnabledModules()
    this.modules = enabledNames.length > 0
      ? globalModuleRegistry.resolve(enabledNames, {
          client: this.client,
          model: config.model,
          config,
        })
      : []
  }

  /**
   * Determine which modules to enable.
   * If config.enabledModules is explicitly set, use it.
   * Otherwise auto-derive from available config (backward compat).
   */
  private deriveEnabledModules(): string[] {
    if (this.config.enabledModules !== undefined) {
      return this.config.enabledModules
    }
    // Auto-derive for backward compatibility
    const auto: string[] = []
    if (this.config.semanticMemory && this.config.episodicMemory) {
      auto.push('memory')
    }
    if (this.config.sessionDir && !(this.config.planMode ?? false)) {
      auto.push('critic')
    }
    if (this.config.sessionDir) {
      auto.push('workspace')
    }
    return auto
  }

  /** Hard cancel — immediately aborts in-flight API calls and tool executions */
  abort(): void {
    this.currentTurnAbortController?.abort('user_cancelled')
  }

  /** Soft interrupt — pause after current tool, preserve history */
  softAbort(): void {
    this.softAbortRequested = true
  }

  // ── System prompt ───────────────────────────────────────────────────────

  private buildSystemPrompt(planMode: boolean, moduleSections: string[] = []): string {
    const baseSystemPrompt = this.config.systemPrompt ?? ''
    const sections = moduleSections.length > 0
      ? baseSystemPrompt + '\n\n---\n\n' + moduleSections.join('\n\n---\n\n')
      : baseSystemPrompt
    if (planMode) {
      return getPlanModePrefix() + sections
    }
    return sections
  }

  // ── Tool definitions ────────────────────────────────────────────────────

  private getToolDefinitions(planMode: boolean, moduleTools: Tool[] = []): ToolDefinition[] {
    // Merge base tools + module-provided tools
    const allTools = [...this.tools, ...moduleTools]
    let defs = getToolDefinitions(allTools)
    // Filter by agent tool whitelist (if configured)
    const whitelist = this.config.agent?.tools
    if (whitelist) {
      const allowed = new Set(whitelist)
      defs = defs.filter((t) => allowed.has(t.function.name))
    }
    // Filter by plan mode (read-only tools only)
    if (planMode) {
      defs = defs.filter((t) => PLAN_MODE_TOOLS.has(t.function.name))
    }
    return defs
  }

  // ── Context budget ──────────────────────────────────────────────────────

  private async evaluateContextBudget(messages: OpenAIMessage[]): Promise<void> {
    const maxCtxTokens =
      this.config.maxContextTokens ?? MODEL_MAX_CONTEXT_TOKENS
    // Count messages + system prompt for accurate budget
    const messageTokens = estimateTokens(messages)
    const totalTokens = messageTokens + this.systemPromptTokens
    const pct = totalTokens / maxCtxTokens
    const shouldWarn = pct >= 0.70
    const shouldCompact = pct >= 0.85
    const strategy = getCompressionStrategy(pct)

    if (this.config.sessionDir && shouldWarn) {
      this.renderer.contextWarning(totalTokens, maxCtxTokens, pct)
    }

    if (shouldCompact) {
      this.renderer.compactStart(totalTokens)
      this.eventLog?.append('context_compact', 'engine', {
        strategy,
        tokens_before: totalTokens,
        system_prompt_tokens: this.systemPromptTokens,
        pct,
      })

      const compactResult = await maybeCompact(
        this.client,
        this.config.model,
        messages,
      )

      if (compactResult.compacted) {
        messages.length = 0
        messages.push(...compactResult.messages)
        this.renderer.compactDone(
          compactResult.originalTokens,
          compactResult.summaryTokens,
        )
        this.eventLog?.append('context_compact', 'engine', {
          tokens_after: compactResult.summaryTokens,
          reduction: compactResult.originalTokens - compactResult.summaryTokens,
        })
        // Lifecycle hook: OnContextOverflow
        this.config.hookRunner?.runOnContextOverflow?.(
          compactResult.originalTokens,
          compactResult.summaryTokens,
        )
      }
    }
  }

  // ── LLM call ────────────────────────────────────────────────────────────

  private async callLLM(
    systemPrompt: string,
    messages: OpenAIMessage[],
    toolDefs: ReturnType<typeof getToolDefinitions>,
    turnAbortSignal: AbortSignal,
  ): Promise<{
    assistantText: string
    finishReason: string | null
    rawToolCalls: StreamingToolCall[]
  }> {
    this.renderer.startSpinner()

    let stream: AsyncIterable<OpenAI.Chat.ChatCompletionChunk>
    try {
      stream = await this.client.chat.completions.create(
        {
          model: this.config.model,
          messages: [
            { role: 'system', content: systemPrompt },
            ...(messages as OpenAI.Chat.ChatCompletionMessageParam[]),
          ],
          tools: toolDefs,
          tool_choice: 'auto',
          temperature: this.config.temperature ?? 0,
          max_tokens: this.config.maxOutputTokens ?? 8192,
          stream: true,
        },
        { signal: turnAbortSignal },
      )
    } catch (err: unknown) {
      this.renderer.stopSpinner()
      throw err
    }

    return this.consumeStream(stream, turnAbortSignal)
  }

  /** Consume the streaming response, accumulating text and tool calls */
  private async consumeStream(
    stream: AsyncIterable<OpenAI.Chat.ChatCompletionChunk>,
    turnAbortSignal: AbortSignal,
  ): Promise<{
    assistantText: string
    finishReason: string | null
    rawToolCalls: StreamingToolCall[]
  }> {
    let assistantText = ''
    let finishReason: string | null = null
    const toolCallsMap = new Map<number, StreamingToolCall>()
    let firstToken = true

    try {
      for await (const chunk of stream) {
        if (turnAbortSignal.aborted) break

        const delta = chunk.choices[0]?.delta
        if (!delta) continue

        if (delta.content) {
          if (firstToken) {
            this.renderer.stopSpinner()
            this.renderer.beginAssistantText()
            firstToken = false
          }
          this.renderer.streamToken(delta.content)
          assistantText += delta.content
        }

        if (delta.tool_calls) {
          for (const tc of delta.tool_calls) {
            const idx = tc.index
            if (!toolCallsMap.has(idx)) {
              toolCallsMap.set(idx, {
                index: idx,
                id: '',
                name: '',
                arguments: '',
              })
            }
            const acc = toolCallsMap.get(idx)!
            if (tc.id) acc.id = tc.id
            if (tc.function?.name) acc.name += tc.function.name
            if (tc.function?.arguments) acc.arguments += tc.function.arguments
          }
        }

        if (chunk.choices[0]?.finish_reason) {
          finishReason = chunk.choices[0].finish_reason
        }
      }
    } catch (err: unknown) {
      this.renderer.stopSpinner()
      throw err
    }

    this.renderer.stopSpinner()

    if (assistantText) {
      this.renderer.endAssistantText()
    }

    const rawToolCalls = Array.from(toolCallsMap.values()).sort(
      (a, b) => a.index - b.index,
    )

    return { assistantText, finishReason, rawToolCalls }
  }

  // ── Tool execution ──────────────────────────────────────────────────────

  private async executeToolCall(
    toolName: string,
    input: Record<string, unknown>,
    context: ToolContext,
    planMode: boolean,
    turnNumber: number,
  ): Promise<ToolResult> {
    // In plan mode, block write tools (defence in depth)
    if (planMode && !PLAN_MODE_TOOLS.has(toolName)) {
      return {
        content: `Tool "${toolName}" is not available in plan mode. Only read-only tools are allowed. Output your plan as text.`,
        isError: true,
      }
    }

    // Enforce agent tool whitelist (defence in depth — LLM shouldn't see non-whitelisted tools)
    const whitelist = this.config.agent?.tools
    if (whitelist && !whitelist.includes(toolName)) {
      return {
        content: `Tool "${toolName}" is not available to this agent.`,
        isError: true,
      }
    }

    const tool = findTool(this.allTools, toolName)
    if (!tool) {
      return { content: `Unknown tool: ${toolName}`, isError: true }
    }

    const result = await tool.execute(input, context)

    // Notify modules of tool execution (e.g. episodic memory write)
    for (const module of this.modules) {
      module.onToolCall?.(toolName, input, result, turnNumber)
    }

    return result
  }

  // ── Tool scheduling ─────────────────────────────────────────────────────

  /**
   * Schedule tool calls: parallel batches for safe tools, serial for
   * state-mutating ones. Returns true if a soft abort was requested
   * during execution.
   */
  private async scheduleToolCalls(
    parsedCalls: ParsedToolCall[],
    toolContext: ToolContext,
    planMode: boolean,
    turnAbortSignal: AbortSignal,
    messages: OpenAIMessage[],
    turnNumber: number,
  ): Promise<{ aborted: boolean }> {
    const batches = partitionToolCalls(parsedCalls)

    for (const batch of batches) {
      if (turnAbortSignal.aborted) return { aborted: true }

      if (batch.safe && batch.calls.length > 1) {
        // ── Parallel batch ───────────────────────────────────
        for (const { tc, input } of batch.calls) {
          this.renderer.toolStart(tc.name, input)
          this.config.hookRunner?.runPreToolCall(tc.name, input)
          this.eventLog?.append('tool_call', tc.name, { input }, [tc.name])
        }

        const results = await Promise.all(
          batch.calls.map(({ tc, input }) =>
            this.executeToolCall(tc.name, input, toolContext, planMode, turnNumber),
          ),
        )

        for (let i = 0; i < batch.calls.length; i++) {
          const { tc } = batch.calls[i]
          const result = results[i]
          this.config.hookRunner?.runPostToolCall(
            tc.name,
            result.content,
            result.isError,
          )
          this.renderer.toolResult(tc.name, result.content, result.isError)
          this.eventLog?.append(
            'tool_result',
            tc.name,
            {
              content: result.content.slice(0, 500),
              isError: result.isError,
            },
            [tc.name, result.isError ? 'error' : 'success'],
          )
          messages.push({
            role: 'tool',
            tool_call_id: tc.id,
            content: truncateToolResult(result.content),
            name: tc.name,
          })
        }
      } else {
        // ── Serial batch ─────────────────────────────────────
        for (const { tc, input } of batch.calls) {
          if (turnAbortSignal.aborted) return { aborted: true }

          this.renderer.toolStart(tc.name, input)
          this.config.hookRunner?.runPreToolCall(tc.name, input)
          this.eventLog?.append('tool_call', tc.name, { input }, [tc.name])

          const result = await this.executeToolCall(
            tc.name,
            input,
            toolContext,
            planMode,
            turnNumber,
          )

          this.config.hookRunner?.runPostToolCall(
            tc.name,
            result.content,
            result.isError,
          )
          this.renderer.toolResult(tc.name, result.content, result.isError)
          this.eventLog?.append(
            'tool_result',
            tc.name,
            {
              content: result.content.slice(0, 500),
              isError: result.isError,
            },
            [tc.name, result.isError ? 'error' : 'success'],
          )

          messages.push({
            role: 'tool',
            tool_call_id: tc.id,
            content: truncateToolResult(result.content),
            name: tc.name,
          })

          // Soft-interrupt check after each serial tool
          if (this.softAbortRequested) {
            this.softAbortRequested = false
            return { aborted: true }
          }
        }
      }

      // Soft-interrupt check after each batch (parallel too)
      if (this.softAbortRequested) {
        this.softAbortRequested = false
        return { aborted: true }
      }
    }

    return { aborted: false }
  }

  // ── Build tool context ──────────────────────────────────────────────────

  private buildToolContext(
    turnAbortSignal: AbortSignal,
    modulePatches: Partial<ToolContext> = {},
  ): ToolContext {
    return {
      cwd: this.config.cwd,
      permissionMode: this.config.permissionMode,
      signal: turnAbortSignal,
      apiConfig: {
        apiKey: this.config.apiKey,
        baseURL: this.config.baseURL,
        model: this.config.model,
      },
      eventLog: this.eventLog,
      // Module patches override/extend the base context (incl. availableToolNames)
      ...modulePatches,
    }
  }

  // ── Main loop ───────────────────────────────────────────────────────────

  /**
   * Execute a single user turn with streaming output.
   * Full Think → Act → Observe loop with module lifecycle hooks.
   */
  async runTurn(
    userMessage: string,
    history: OpenAIMessage[],
  ): Promise<{ result: TurnResult; newHistory: OpenAIMessage[] }> {
    const planMode = this.config.planMode ?? false

    // Clear file read state for this turn (read-before-edit is per-turn, not cross-turn)
    clearFileState()

    // ── Boot Sequence: resolve + boot modules ──
    const bootCtx: ModuleBootContext = {
      cwd: this.config.cwd,
      sessionDir: this.config.sessionDir,
      config: this.config,
      userMessage,
    }
    this.moduleBootResults = await Promise.all(
      this.modules.map(m => Promise.resolve(m.boot(bootCtx))),
    )
    const moduleSections = this.moduleBootResults.flatMap(r => r.systemPromptSections ?? [])
    const toolContextPatch = this.moduleBootResults.reduce(
      (acc, r) => ({ ...acc, ...r.toolContextPatch }),
      {} as Partial<ToolContext>,
    )
    // Collect tools provided by modules
    const moduleTools = this.moduleBootResults.flatMap(r => r.tools ?? [])
    this.allTools = [...this.tools, ...moduleTools]

    // Record boot trajectory (AgentOS pattern)
    this.eventLog?.append('boot_context', 'engine', {
      trajectory: 'boot_context',
      modules: this.modules.map(m => m.name),
      module_sections: moduleSections.length,
      module_tools: moduleTools.length,
      user_message_length: userMessage.length,
    })

    // Build system prompt (with module sections) and tool definitions
    const systemPrompt = this.buildSystemPrompt(planMode, moduleSections)
    // Estimate system prompt tokens for accurate context budget
    this.systemPromptTokens = Math.ceil(systemPrompt.length / 3.5) + 20
    const toolDefs = this.getToolDefinitions(planMode, moduleTools)

    // Per-turn AbortController
    const turnAbortController = new AbortController()
    this.currentTurnAbortController = turnAbortController

    // Initialize messages
    const messages: OpenAIMessage[] = [...history, { role: 'user', content: userMessage }]

    let iterations = 0
    let finalOutput = ''
    let turnNumber = 0
    const toolContext = this.buildToolContext(
      turnAbortController.signal,
      { ...toolContextPatch, availableToolNames: toolDefs.map(t => t.function.name) },
    )

    let result: TurnResult
    let lastToolName: string | undefined
    try {
      while (iterations < this.config.maxIterations) {
        // Check for cancellation
        if (turnAbortController.signal.aborted) {
          result = { stopped: true, reason: 'error', output: finalOutput }
          break
        }

        iterations++
        turnNumber++

        // Soft-interrupt check
        if (this.softAbortRequested) {
          this.softAbortRequested = false
          result = { stopped: true, reason: 'interrupted', output: finalOutput }
          break
        }

        // Context budget + auto-compact
        await this.evaluateContextBudget(messages)

        // Module iteration hooks (critic, etc.)
        for (const module of this.modules) {
          if (!module.onIteration) continue
          const iterResult = await module.onIteration({
            iteration: iterations,
            messages,
            abortSignal: turnAbortController.signal,
          })
          if (iterResult?.injectMessage) {
            const msg = iterResult.injectMessage
            this.renderer.warn(`[${module.name}] ${msg.split('\n')[0]}`)
            this.eventLog?.append('module_flag', module.name, {
              message: msg.slice(0, 500),
              iteration: iterations,
            })
            messages.push({ role: 'user', content: msg })
          }
        }

        // ── Streaming LLM call ───────────────────────────────────
        const { assistantText, finishReason, rawToolCalls } =
          await this.callLLM(
            systemPrompt,
            messages,
            toolDefs,
            turnAbortController.signal,
          )

        if (assistantText) {
          finalOutput = assistantText
        }

        // Build assistant message
        const assistantMsg: OpenAIMessage = {
          role: 'assistant',
          content: assistantText || null,
          tool_calls:
            rawToolCalls.length > 0
              ? rawToolCalls.map((tc) => ({
                  id: tc.id,
                  type: 'function' as const,
                  function: { name: tc.name, arguments: tc.arguments },
                }))
              : undefined,
        }
        messages.push(assistantMsg)

        // Check if we're done (no tool calls)
        if (finishReason === 'stop' || rawToolCalls.length === 0) {
          result = { stopped: true, reason: 'stop_sequence', output: finalOutput }
          break
        }

        // Parse tool calls
        const parsedCalls: ParsedToolCall[] = rawToolCalls.map((tc) => {
          let input: Record<string, unknown>
          try {
            input = JSON.parse(tc.arguments || '{}') as Record<string, unknown>
          } catch {
            input = {}
          }
          return { tc, input }
        })

        // Track last tool name for OnError hook
        if (parsedCalls.length > 0) {
          lastToolName = parsedCalls[parsedCalls.length - 1].tc.name
        }

        // Schedule and execute tool calls
        const { aborted } = await this.scheduleToolCalls(
          parsedCalls,
          toolContext,
          planMode,
          turnAbortController.signal,
          messages,
          turnNumber,
        )

        if (aborted || turnAbortController.signal.aborted) {
          result = { stopped: true, reason: 'error', output: finalOutput }
          break
        }
      }

      // If loop completed without break (max iterations)
      if (!result!) {
        this.renderer.warn(
          `Max iterations (${this.config.maxIterations}) reached`,
        )
        result = { stopped: true, reason: 'max_iterations', output: finalOutput }
      }
    } catch (err) {
      // Lifecycle hook: OnError
      const errMsg = (err as Error).message || String(err)
      this.config.hookRunner?.runOnError?.(err as Error, {
        turnNumber: iterations,
        lastToolName,
      })
      // Surface the error to the user — don't swallow it silently
      this.renderer.error(`Engine error: ${errMsg}`)
      // Don't re-throw — construct error result so onComplete hooks still fire
      result = { stopped: true, reason: 'error', output: finalOutput || `[Error: ${errMsg}]` }
    } finally {
      this.currentTurnAbortController = null
    }

    // ── Module onComplete hooks (reflection, etc.) ──
    for (const module of this.modules) {
      try {
        await module.onComplete?.({
          cwd: this.config.cwd,
          sessionDir: this.config.sessionDir,
          turnResult: result,
          messages,
          eventLog: this.eventLog,
        })
      } catch {
        // module onComplete failures must never break the engine
      }
    }

    // ── Lifecycle hook: OnComplete ──
    this.config.hookRunner?.runOnComplete?.(result)

    return { result, newHistory: messages }
  }

  getModel(): string {
    return this.config.model
  }
}

// Export partitionToolCalls for testing
export { partitionToolCalls }
