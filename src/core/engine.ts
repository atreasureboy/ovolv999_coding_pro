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
import { writeFileSync, mkdirSync } from 'fs'
import { join } from 'path'
import { randomUUID } from 'crypto'
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
  microCompact,
  estimateTokens,
  getCompressionStrategy,
  MODEL_MAX_CONTEXT_TOKENS,
} from './compact.js'
import type { AgentModule, ModuleBootResult, ModuleBootContext } from './module.js'
import { globalModuleRegistry } from './moduleRegistry.js'
import { applyAgentToConfig } from './agentPresets.js'
import { clearFileState } from './fileState.js'
import {
  transitionQueryState,
  isTerminal,
  createBudgetTracker,
  checkTokenBudget,
  type QueryState,
} from './queryStateMachine.js'
import { CostTracker, type TokenUsage } from './costTracker.js'
import { BackgroundTaskManager } from './backgroundTaskManager.js'
import { FileHistory } from './fileHistory.js'

// ── Constants ────────────────────────────────────────────────────────────────

const MAX_TOOL_RESULT_LENGTH = 20_000
/** Aggregate budget for all tool results in a single LLM response.
 * When the total exceeds this, the largest results are persisted to disk
 * individually until the aggregate fits. Prevents parallel tool calls
 * (e.g. 10× Grep returning 15K each = 150K total) from blowing context.
 * Inspired by claude-code-best's enforceToolResultBudget.
 */
const MAX_AGGREGATE_TOOL_RESULTS = 60_000

/**
 * Truncate or persist a tool result to stay within context budget.
 * Claude Code approach: large results → save to disk, inject preview + file path.
 */
function truncateToolResult(result: string, sessionDir?: string): string {
  if (result.length <= MAX_TOOL_RESULT_LENGTH) return result

  // Persist to disk if sessionDir available (saves context tokens)
  if (sessionDir) {
    try {
      const dir = join(sessionDir, 'tool-results')
      mkdirSync(dir, { recursive: true })
      const fileName = `result_${Date.now()}_${Math.random().toString(36).slice(2, 8)}.txt`
      const filePath = join(dir, fileName)
      writeFileSync(filePath, result, 'utf8')
      const preview = result.slice(0, 2000)
      return `${preview}\n\n[... Full output (${result.length} chars) saved to: ${filePath} ...]`
    } catch {
      // Fall through to truncation
    }
  }

  // Fallback: head + tail truncation
  const half = MAX_TOOL_RESULT_LENGTH / 2
  return (
    result.slice(0, half) +
    `\n\n[... ${result.length - MAX_TOOL_RESULT_LENGTH} chars truncated ...]\n\n` +
    result.slice(result.length - half)
  )
}

/**
 * Enforce an aggregate budget across all tool results in a single batch.
 * When the total character count exceeds MAX_AGGREGATE_TOOL_RESULTS,
 * the largest results are individually persisted to disk (replaced with
 * preview + file path) until the aggregate fits.
 *
 * This solves the "10 parallel Grep calls each returning 15K = 150K total"
 * problem that per-result truncation cannot catch.
 *
 * Inspired by claude-code-best's enforceToolResultBudget.
 */
function enforceAggregateToolResultBudget(
  results: { content: string; tc: { id: string; name: string } }[],
  sessionDir?: string,
): void {
  const totalChars = results.reduce((sum, r) => sum + r.content.length, 0)
  if (totalChars <= MAX_AGGREGATE_TOOL_RESULTS) return
  if (!sessionDir) return // can't persist without sessionDir

  // Sort by size descending — persist the largest first
  const indexed = results.map((r, i) => ({ r, i, size: r.content.length }))
  indexed.sort((a, b) => b.size - a.size)

  let currentTotal = totalChars
  for (const item of indexed) {
    if (currentTotal <= MAX_AGGREGATE_TOOL_RESULTS) break
    if (item.size <= MAX_TOOL_RESULT_LENGTH) break // already small enough

    // Persist this result to disk
    const original = item.r.content
    try {
      const dir = join(sessionDir, 'tool-results')
      mkdirSync(dir, { recursive: true })
      const fileName = `result_${Date.now()}_${Math.random().toString(36).slice(2, 8)}.txt`
      const filePath = join(dir, fileName)
      writeFileSync(filePath, original, 'utf8')
      const preview = original.slice(0, 2000)
      results[item.i].content =
        `${preview}\n\n[... Full output (${original.length} chars) saved to: ${filePath} ...]`
      currentTotal -= original.length - results[item.i].content.length
    } catch {
      break // can't persist — stop trying
    }
  }
}

/** Plan mode — only read-only tools are exposed */
const PLAN_MODE_TOOLS = new Set([
  'Read',
  'Glob',
  'Grep',
  'WebFetch',
  'WebSearch',
  'ExitPlanMode', // the tool to exit plan mode is always available in plan mode
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
 *
 * Uses per-input isConcurrencySafe(input) when available (Claude Code pattern),
 * falls back to static CONCURRENCY_SAFE_TOOLS set.
 */
function partitionToolCalls(calls: ParsedToolCall[], tools?: Tool[]): ToolBatch[] {
  const batches: ToolBatch[] = []

  for (const call of calls) {
    // Per-input check: if the tool implements isConcurrencySafe, use it
    const tool = tools?.find(t => t.name === call.tc.name)
    const safe = tool?.isConcurrencySafe
      ? tool.isConcurrencySafe(call.input)
      : CONCURRENCY_SAFE_TOOLS.has(call.tc.name)
    const last = batches[batches.length - 1]

    if (last && last.safe && safe) {
      last.calls.push(call) // extend existing parallel batch
    } else {
      batches.push({ safe, calls: [call] }) // new batch
    }
  }

  return batches
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
  /** Cost tracker — accumulates real API token usage and USD cost */
  private costTracker: CostTracker
  /** Background task manager — async long-running task lifecycle */
  private backgroundTaskManager: BackgroundTaskManager
  /** Mutable plan-mode flag — can be toggled off by ExitPlanMode tool */
  private planModeActive: boolean
  /** File history — backs up files before edits for undo/checkpoint */
  private fileHistory: FileHistory | null
  /** Whether the endpoint supports stream_options.include_usage (most do) */
  private _streamUsageSupported = true
  /** Consecutive compact failure counter — stops retrying after 3 */
  private _consecutiveCompactFailures = 0
  /** Suppress compact warning after successful compaction (next turn only) */
  private _suppressCompactWarning = false

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
    this.costTracker = new CostTracker()
    this.backgroundTaskManager = new BackgroundTaskManager()
    this.planModeActive = config.planMode ?? false
    this.fileHistory = config.sessionDir ? new FileHistory(config.sessionDir) : null

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
    if (this.config.sessionDir && !this.planModeActive) {
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
    // Clear the compact-warning suppression flag from last turn
    this._suppressCompactWarning = false

    const maxCtxTokens =
      this.config.maxContextTokens ?? MODEL_MAX_CONTEXT_TOKENS
    // Count messages + system prompt for accurate budget
    const messageTokens = estimateTokens(messages)
    const totalTokens = messageTokens + this.systemPromptTokens
    const pct = totalTokens / maxCtxTokens
    const shouldMicroCompact = pct >= 0.50
    const shouldWarn = pct >= 0.70
    const shouldCompact = pct >= 0.85
    const strategy = getCompressionStrategy(pct)

    // ── Time-based microCompact: when the session was idle for >5 min,
    // the prompt cache is guaranteed cold — clearing old tool results
    // costs nothing (the full prefix will be rewritten anyway).
    if (!shouldCompact) {
      let lastAssistantIdx = -1
      for (let i = messages.length - 1; i >= 0; i--) {
        if (messages[i].role === 'assistant') { lastAssistantIdx = i; break }
      }
      if (lastAssistantIdx >= 0) {
        // Heuristic: if there are many messages since the last assistant turn,
        // the session was likely idle. We can't know the wall-clock from messages
        // alone, so we use message count as a proxy for elapsed time.
        const messagesSinceLastTurn = messages.length - lastAssistantIdx
        if (messagesSinceLastTurn > 20) {
          const mcResult = microCompact(messages)
          if (mcResult.compacted) {
            this.eventLog?.append('context_compact', 'engine', {
              type: 'time_based_microcompact',
              tokens_before: mcResult.tokensBefore,
              tokens_after: mcResult.tokensAfter,
              tools_cleared: mcResult.toolsCleared,
            })
          }
        }
      }
    }

    // ── Pressure-based microCompact: clear old tool results at 50% pressure ──
    // Clear old tool results at 50% pressure, before resorting to full
    // LLM-summarization compact at 85%.
    if (shouldMicroCompact && !shouldCompact) {
      const mcResult = microCompact(messages)
      if (mcResult.compacted) {
        this.eventLog?.append('context_compact', 'engine', {
          type: 'microcompact',
          tokens_before: mcResult.tokensBefore,
          tokens_after: mcResult.tokensAfter,
          tools_cleared: mcResult.toolsCleared,
        })
      }
    }

    if (this.config.sessionDir && shouldWarn && !this._suppressCompactWarning) {
      this.renderer.contextWarning(totalTokens, maxCtxTokens, pct)
    }

    if (shouldCompact && this._consecutiveCompactFailures < 3) {
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
        this._consecutiveCompactFailures = 0  // reset on success
        this._suppressCompactWarning = true   // suppress warning next turn
        // Lifecycle hook: OnContextOverflow
        this.config.hookRunner?.runOnContextOverflow?.(
          compactResult.originalTokens,
          compactResult.summaryTokens,
        )
      } else {
        // Compaction failed — increment circuit breaker
        this._consecutiveCompactFailures++
        if (this._consecutiveCompactFailures >= 3) {
          this.renderer.warn(
            `Auto-compact failed ${this._consecutiveCompactFailures} consecutive times — skipping further attempts. Consider starting a new session.`,
          )
        }
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
    usage: TokenUsage | null
  }> {
    this.renderer.startSpinner()

    const callStartMs = Date.now()

    let stream: AsyncIterable<OpenAI.Chat.ChatCompletionChunk>
    try {
      stream = await this.client.chat.completions.create(
        {
          model: this.config.model,
          messages: [
            { role: 'system', content: systemPrompt },
            ...(messages as OpenAI.Chat.ChatCompletionMessageParam[]),
          ],
          tools: toolDefs.length > 0 ? toolDefs : undefined,
          tool_choice: toolDefs.length > 0 ? 'auto' : undefined,
          temperature: this.config.temperature ?? 0,
          max_tokens: this.config.maxOutputTokens ?? 8192,
          stream: true,
          ...(this._streamUsageSupported ? { stream_options: { include_usage: true } } : {}),
        },
        { signal: turnAbortSignal },
      )
    } catch (err: unknown) {
      this.renderer.stopSpinner()

      const errMsg = (err as Error).message || ''

      // Fallback: some endpoints reject stream_options with 400 — retry without it
      if (errMsg.includes('stream_options') || errMsg.includes('stream_options is not supported')) {
        this._streamUsageSupported = false
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
        const result = await this.consumeStream(stream, turnAbortSignal)
        this.recordUsage(result.usage, callStartMs)
        return result
      }

      // Reactive compact: if API rejected due to context length, auto-compact and retry once
      const compactErrMsg = (err as Error).message || ''
      if (compactErrMsg.includes('context_length_exceeded') || compactErrMsg.includes('maximum context length') || compactErrMsg.includes('too long')) {
        this.renderer.warn('Context too long — auto-compacting and retrying...')
        const compactResult = await maybeCompact(this.client, this.config.model, messages)
        if (compactResult.compacted) {
          messages.length = 0
          messages.push(...compactResult.messages)
          this.renderer.compactDone(compactResult.originalTokens, compactResult.summaryTokens)
          // Retry the call with compacted messages
          stream = await this.client.chat.completions.create(
            {
              model: this.config.model,
              messages: [
                { role: 'system', content: systemPrompt },
                ...(messages as OpenAI.Chat.ChatCompletionMessageParam[]),
              ],
              tools: toolDefs.length > 0 ? toolDefs : undefined,
              tool_choice: toolDefs.length > 0 ? 'auto' : undefined,
              temperature: this.config.temperature ?? 0,
          max_tokens: this.config.maxOutputTokens ?? 16_384,  // higher default: reasoning models (deepseek-reasoner) include reasoning in max_tokens
              stream: true,
              ...(this._streamUsageSupported ? { stream_options: { include_usage: true } } : {}),
            },
            { signal: turnAbortSignal },
          )
          const result = await this.consumeStream(stream, turnAbortSignal)
          this.recordUsage(result.usage, callStartMs)
          return result
        }
      }
      throw err
    }

    const result = await this.consumeStream(stream, turnAbortSignal)
    this.recordUsage(result.usage, callStartMs)
    return result
  }

  /** Feed API usage into the cost tracker (if present) */
  private recordUsage(usage: TokenUsage | null, callStartMs: number): void {
    if (usage) {
      const durationMs = Date.now() - callStartMs
      this.costTracker.addUsage(this.config.model, usage, durationMs)
      this.eventLog?.append('tool_call', 'llm_api', {
        input_tokens: usage.inputTokens,
        output_tokens: usage.outputTokens,
        duration_ms: durationMs,
      })
    }
  }

  /** Consume the streaming response, accumulating text and tool calls */
  private async consumeStream(
    stream: AsyncIterable<OpenAI.Chat.ChatCompletionChunk>,
    turnAbortSignal: AbortSignal,
  ): Promise<{
    assistantText: string
    finishReason: string | null
    rawToolCalls: StreamingToolCall[]
    usage: TokenUsage | null
  }> {
    let assistantText = ''
    let finishReason: string | null = null
    let usage: TokenUsage | null = null
    const toolCallsMap = new Map<number, StreamingToolCall>()
    let firstToken = true

    // Stream-level timeout — if no chunk arrives for 120s, abort (prevents API hang)
    const STREAM_TIMEOUT_MS = 120_000
    let lastChunkTime = Date.now()
    const turnController = this.currentTurnAbortController

    // Watchdog: checks every 10s if stream has stalled
    const watchdog = setInterval(() => {
      if (Date.now() - lastChunkTime > STREAM_TIMEOUT_MS) {
        // Force-abort the AbortController (not just dispatch event)
        if (turnController) {
          turnController.abort('stream_timeout')
        }
      }
    }, 10_000)

    try {
      for await (const chunk of stream) {
        if (turnAbortSignal.aborted) break

        lastChunkTime = Date.now()  // reset watchdog on each chunk

        // Capture usage from the final chunk (stream_options.include_usage)
        // The usage chunk often has an empty choices array, so check before delta.
        if (chunk.usage) {
          usage = {
            inputTokens: chunk.usage.prompt_tokens,
            outputTokens: chunk.usage.completion_tokens,
          }
        }

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
      clearInterval(watchdog)
      this.renderer.stopSpinner()
      throw err
    }

    clearInterval(watchdog)
    this.renderer.stopSpinner()

    // Stream-timeout watchdog: if the stream was aborted due to stall,
    // throw so the engine's error path fires (instead of looking like success)
    if (turnAbortSignal.aborted && !finishReason) {
      throw new Error('Stream timed out — no data received for 120s')
    }

    if (assistantText) {
      this.renderer.endAssistantText()
    }

    const rawToolCalls = Array.from(toolCallsMap.values()).sort(
      (a, b) => a.index - b.index,
    ).map((tc) => {
      // Some providers (vLLM, LM Studio, Ollama) omit tool_call id;
      // synthesize one to prevent "tool_call_id does not match" on next turn
      if (!tc.id) {
        tc.id = `call_${randomUUID()}`
      }
      return tc
    })

    return { assistantText, finishReason, rawToolCalls, usage }
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
    const batches = partitionToolCalls(parsedCalls, this.allTools)

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

        // Enforce aggregate budget: if the total of all parallel results
        // exceeds the limit, persist the largest to disk before pushing
        const aggregateResults = batch.calls.map((call, i) => ({
          content: results[i].content,
          tc: { id: call.tc.id, name: call.tc.name },
        }))
        enforceAggregateToolResultBudget(aggregateResults, this.config.sessionDir)
        // Write back any persisted replacements
        for (let i = 0; i < results.length; i++) {
          results[i] = { ...results[i], content: aggregateResults[i].content }
        }

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
          // Prevent empty tool-result content — some models emit stop sequence
          // and end their turn with zero output when tool_result is empty
          const safeContent = result.content.trim() || `(${tc.name} completed with no output)`
          messages.push({
            role: 'tool',
            tool_call_id: tc.id,
            content: truncateToolResult(safeContent, this.config.sessionDir),
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

          const serialSafeContent = result.content.trim() || `(${tc.name} completed with no output)`
          messages.push({
            role: 'tool',
            tool_call_id: tc.id,
            content: truncateToolResult(serialSafeContent, this.config.sessionDir),
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
      backgroundTaskManager: this.backgroundTaskManager,
      askUserQuestion: this.config.askUserQuestion,
      exitPlanMode: async (plan: string): Promise<boolean> => {
        const approved = await this.config.exitPlanMode?.(plan) ?? true
        if (approved) this.exitPlanMode()
        return approved
      },
      fileHistory: this.fileHistory ?? undefined,
      // Module patches override/extend the base context (incl. availableToolNames)
      ...modulePatches,
    }
  }

  // ── Main loop ───────────────────────────────────────────────────────────

  /**
   * Execute a single user turn with streaming output.
   *
   * State-machine-driven Think → Act → Observe loop with module lifecycle hooks.
   * The loop drives a pure reducer (transitionQueryState) — each iteration
   * inspects the current state, performs its side effects, and emits the next
   * event. This replaces the legacy inline while-loop with explicit, testable
   * states: boot → check_abort → budget_check → module_iteration → llm_call →
   * continuation_check → parse_response → tool_execution → check_abort …
   */
  async runTurn(
    userMessage: string,
    history: OpenAIMessage[],
  ): Promise<{ result: TurnResult; newHistory: OpenAIMessage[] }> {
    const planMode = this.planModeActive

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

    const toolContext = this.buildToolContext(
      turnAbortController.signal,
      { ...toolContextPatch, availableToolNames: toolDefs.map(t => t.function.name) },
    )

    // ── State machine driver ───────────────────────────────────────────
    let state: QueryState = transitionQueryState({ kind: 'boot' }, { type: 'booted' })

    let finalOutput = ''
    let lastToolName: string | undefined
    // Tool calls pending parse — stashed in llm_call, consumed in parse_response
    let pendingToolCalls: StreamingToolCall[] = []
    // Parsed tool calls — stashed in parse_response, consumed in tool_execution
    let pendingParsedCalls: ParsedToolCall[] = []
    // Continuation budget tracking (opt-in via config.enableContinuation)
    const enableContinuation = this.config.enableContinuation ?? false
    const turnTokenBudget =
      this.config.turnTokenBudget ?? (this.config.maxOutputTokens ?? 8192) * 4
    const budgetTracker = createBudgetTracker()
    let turnTokensProduced = 0
    let emptyResponseCount = 0
    const MAX_EMPTY_RETRIES = 2
    let lengthRetryCount = 0
    const MAX_LENGTH_RETRIES = 3

    let result: TurnResult
    try {
      while (!isTerminal(state)) {
        switch (state.kind) {
          case 'check_abort': {
            if (turnAbortController.signal.aborted) {
              state = transitionQueryState(state, { type: 'hard_abort', output: finalOutput })
            } else if (this.softAbortRequested) {
              this.softAbortRequested = false
              state = transitionQueryState(state, { type: 'soft_abort', output: finalOutput })
            } else if (state.iteration > this.config.maxIterations) {
              this.renderer.warn(
                `Max iterations (${this.config.maxIterations}) reached`,
              )
              state = transitionQueryState(state, { type: 'max_iterations', output: finalOutput })
            } else {
              state = transitionQueryState(state, { type: 'continue' })
            }
            break
          }

          case 'budget_check': {
            await this.evaluateContextBudget(messages)
            state = transitionQueryState(state, { type: 'continue' })
            break
          }

          case 'module_iteration': {
            for (const module of this.modules) {
              if (!module.onIteration) continue
              const iterResult = await module.onIteration({
                iteration: state.iteration,
                messages,
                abortSignal: turnAbortController.signal,
              })
              if (iterResult?.injectMessage) {
                const msg = iterResult.injectMessage
                // Show full critic output to user via renderer (not raw stdout)
                const lines = msg.split('\n').filter(l => l.trim())
                for (const line of lines) {
                  this.renderer.warn(`[${module.name}] ${line}`)
                }
                this.eventLog?.append('module_flag', module.name, {
                  message: msg.slice(0, 500),
                  iteration: state.iteration,
                })
                messages.push({ role: 'user', content: msg })
              }
            }
            state = transitionQueryState(state, { type: 'continue' })
            break
          }

          case 'llm_call': {
            const { assistantText, finishReason, rawToolCalls } =
              await this.callLLM(
                systemPrompt,
                messages,
                toolDefs,
                turnAbortController.signal,
              )

            if (assistantText) {
              finalOutput = assistantText
              turnTokensProduced += Math.ceil(assistantText.length / 3.5)
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

            // Detect empty response (no text AND no tool calls) — nudge the model
            if (!assistantText && rawToolCalls.length === 0 && emptyResponseCount < MAX_EMPTY_RETRIES) {
              emptyResponseCount++
              messages.push({
                role: 'user',
                content: 'Your previous response was empty (no text, no tool call). Please respond with text or invoke a tool.',
              })
              // Re-enter budget_check to loop back to llm_call
              state = transitionQueryState(state, { type: 'continue' })
              break
            }

            // Detect truncated response (finish_reason='length') — the model
            // hit max_tokens mid-response. Inject "continue" and retry up to 3x.
            if (finishReason === 'length' && rawToolCalls.length === 0 && lengthRetryCount < MAX_LENGTH_RETRIES) {
              lengthRetryCount++
              this.eventLog?.append('module_flag', 'length_retry', {
                retry: lengthRetryCount,
                max: MAX_LENGTH_RETRIES,
                partial_length: assistantText.length,
              })
              messages.push({
                role: 'user',
                content: 'Continue your previous response from where it was cut off. Do not repeat what you already wrote — just continue.',
              })
              state = transitionQueryState(state, { type: 'continue' })
              break
            }

            pendingToolCalls = rawToolCalls
            state = transitionQueryState(state, {
              type: 'llm_done',
              finishReason,
              hasToolCalls: rawToolCalls.length > 0,
              output: finalOutput,
            })
            break
          }

          case 'continuation_check': {
            // When continuation is enabled and budget remains, nudge the model
            // to keep producing instead of stopping on finish_reason=stop.
            if (enableContinuation) {
              const decision = checkTokenBudget(budgetTracker, turnTokenBudget, turnTokensProduced)
              if (decision.action === 'continue') {
                this.eventLog?.append('module_flag', 'continuation', {
                  continuation_count: decision.continuationCount,
                  pct: decision.pct,
                  turn_tokens: decision.turnTokens,
                  budget: decision.budget,
                })
                messages.push({ role: 'user', content: decision.nudgeMessage })
                state = transitionQueryState(state, { type: 'continue' })
                break
              }
            }
            // Default: stop and complete
            state = transitionQueryState(state, { type: 'stop' })
            break
          }

          case 'parse_response': {
            const validCalls: ParsedToolCall[] = []
            for (const tc of pendingToolCalls) {
              let input: Record<string, unknown>
              try {
                input = JSON.parse(tc.arguments || '{}') as Record<string, unknown>
              } catch {
                // Malformed JSON — do NOT execute the tool. Push a synthetic
                // error result so the LLM knows its arguments were bad.
                this.renderer.warn(`Warning: malformed tool arguments for ${tc.name} (JSON parse failed, likely truncated).`)
                this.eventLog?.append('tool_call', tc.name, { parse_error: true, raw_args: tc.arguments.slice(0, 200) })
                messages.push({
                  role: 'tool',
                  tool_call_id: tc.id,
                  name: tc.name,
                  content: `Could not parse tool arguments as valid JSON (likely truncated by max_tokens). Raw args (first 200 chars): ${tc.arguments.slice(0, 200)}. Retry with shorter or simpler arguments.`,
                })
                continue  // skip this call — don't add to validCalls
              }
              validCalls.push({ tc, input })
            }

            pendingParsedCalls = validCalls

            // Track last tool name for OnError hook
            if (pendingParsedCalls.length > 0) {
              lastToolName = pendingParsedCalls[pendingParsedCalls.length - 1].tc.name
            }

            state = transitionQueryState(state, { type: 'continue' })
            break
          }

          case 'tool_execution': {
            const { aborted } = await this.scheduleToolCalls(
              pendingParsedCalls,
              toolContext,
              planMode,
              turnAbortController.signal,
              messages,
              state.iteration,
            )

            const hardAborted = turnAbortController.signal.aborted
            state = transitionQueryState(state, {
              type: 'tools_done',
              aborted: aborted || hardAborted,
              hardAborted,
              output: finalOutput,
            })
            break
          }

          case 'boot':
            // Unreachable — boot transitions to check_abort before the loop
            state = transitionQueryState(state, { type: 'booted' })
            break
        }
      }

      // State machine reached a terminal state
      if (state.kind === 'complete') {
        result = { stopped: true, reason: state.reason, output: state.output }
      } else {
        // Defensive fallback — should never happen
        result = { stopped: true, reason: 'error', output: finalOutput }
      }
    } catch (err) {
      // Lifecycle hook: OnError
      const errMsg = (err as Error).message || String(err)
      const errorIteration = 'iteration' in state ? state.iteration : 0
      this.config.hookRunner?.runOnError?.(err as Error, {
        turnNumber: errorIteration,
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

  /** Expose the cost tracker for end-of-session cost display */
  getCostTracker(): CostTracker {
    return this.costTracker
  }

  /** Expose the background task manager for cleanup / inspection */
  getBackgroundTaskManager(): BackgroundTaskManager {
    return this.backgroundTaskManager
  }

  /** Whether plan mode is currently active */
  isPlanMode(): boolean {
    return this.planModeActive
  }

  /** Exit plan mode — called by the ExitPlanMode tool after user approval */
  exitPlanMode(): void {
    this.planModeActive = false
  }

  /** Get the file history tracker (null if no sessionDir) */
  getFileHistory(): FileHistory | null {
    return this.fileHistory
  }
}

// Export partitionToolCalls for testing
export { partitionToolCalls }
