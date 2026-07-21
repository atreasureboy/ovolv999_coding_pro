/**
 * ModuleManager — owns module lifecycle orchestration.
 *
 * Encapsulates the 5 module lifecycle call sites that were previously
 * scattered across engine.ts:
 *   1. Resolution (enabledModules → topological order)
 *   2. Boot (collect sections + tools + context patch)
 *   3. Iteration hooks (onIteration → inject messages)
 *   4. Tool call notification (onToolCall)
 *   5. Complete hooks (onComplete)
 *   6. Disposal (dispose?.() duck-typed on each module)
 *
 * State ownership:
 * - modules: AgentModule[] (resolved in constructor, settable for testing)
 * - bootResults: ModuleBootResult[] (per-turn, from boot)
 *
 * The engine delegates all module iteration to this manager, ensuring
 * consistent error handling (boot = throw, iteration = throw, complete
 * = isolate, dispose = fire-and-forget).
 */

import type { AgentModule, ModuleBootContext, ModuleBootResult } from '../module.js'
import type { OpenAIMessage, ToolContext, ToolResult, TurnResult } from '../types.js'
import type { EventLog } from '../eventLog.js'
import type { Renderer } from '../../ui/renderer.js'

export interface ModuleManagerDeps {
  modules: AgentModule[]
  renderer: Renderer
  eventLog?: EventLog
}

export interface ModuleBootOutput {
  systemPromptSections: string[]
  tools: import('../types.js').Tool[]
  toolContextPatch: Partial<ToolContext>
}

export class ModuleManager {
  private readonly renderer: Renderer
  private readonly eventLog?: EventLog
  /** Modules array — settable for testing (boot-throw regression tests) */
  modules: AgentModule[]
  private bootResults: ModuleBootResult[] = []

  constructor(deps: ModuleManagerDeps) {
    this.modules = deps.modules
    this.renderer = deps.renderer
    this.eventLog = deps.eventLog
  }

  get moduleNames(): string[] {
    return this.modules.map(m => m.name)
  }

  async boot(bootCtx: ModuleBootContext): Promise<ModuleBootOutput> {
    this.bootResults = await Promise.all(
      this.modules.map(m => Promise.resolve(m.boot(bootCtx))),
    )

    const systemPromptSections = this.bootResults.flatMap(r => r.systemPromptSections ?? [])
    const toolContextPatch = this.bootResults.reduce(
      (acc, r) => ({ ...acc, ...r.toolContextPatch }),
      {} as Partial<ToolContext>,
    )
    const tools = this.bootResults.flatMap(r => r.tools ?? [])

    return { systemPromptSections, tools, toolContextPatch }
  }

  async runIteration(params: {
    iteration: number
    messages: OpenAIMessage[]
    abortSignal: AbortSignal
  }): Promise<void> {
    const { iteration, messages, abortSignal } = params

    for (const module of this.modules) {
      if (!module.onIteration) continue
      const iterResult = await module.onIteration({
        iteration,
        messages,
        abortSignal,
      })
      if (iterResult?.injectMessage) {
        const msg = iterResult.injectMessage
        const lines = msg.split('\n').filter(l => l.trim())
        for (const line of lines) {
          this.renderer.warn(`[${module.name}] ${line}`)
        }
        this.eventLog?.append('module_flag', module.name, {
          message: msg.slice(0, 500),
          iteration,
        })
        messages.push({ role: 'user', content: msg })
      }
    }
  }

  notifyToolCall(
    toolName: string,
    input: Record<string, unknown>,
    result: ToolResult,
    turnNumber: number,
  ): void {
    for (const module of this.modules) {
      module.onToolCall?.(toolName, input, result, turnNumber)
    }
  }

  async runComplete(params: {
    cwd: string
    sessionDir?: string
    turnResult: TurnResult
    messages: OpenAIMessage[]
    eventLog?: EventLog
  }): Promise<void> {
    const { cwd, sessionDir, turnResult, messages, eventLog } = params

    for (const module of this.modules) {
      try {
        await module.onComplete?.({
          cwd,
          sessionDir,
          turnResult,
          messages,
          eventLog,
        })
      } catch {
        // module onComplete failures must never break the engine
      }
    }
  }

  dispose(): void {
    for (const module of this.modules) {
      const dispose = (module as { dispose?: () => void | Promise<void> }).dispose
      if (typeof dispose === 'function') {
        Promise.resolve(dispose.call(module)).catch(() => {
          // module dispose failures must never break engine disposal
        })
      }
    }
  }
}
