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
 * consistent error handling:
 *   - boot: critical modules throw (abort runtime); best_effort are
 *     isolated and dropped from subsequent iteration/complete hooks.
 *   - iteration: throw (matches pre-existing contract).
 *   - complete / dispose: isolate.
 */

import type { AgentModule, ModuleBootContext, ModuleBootResult } from '../module.js'
import type { OpenAIMessage, Tool, ToolContext, ToolResult, TurnResult } from '../types.js'
import type { EventLog } from '../eventLog.js'
import type { Renderer } from '../../ui/renderer.js'

export interface ModuleManagerDeps {
  modules: AgentModule[]
  renderer: Renderer
  eventLog?: EventLog
}

export interface ModuleBootOutput {
  systemPromptSections: string[]
  tools: Tool[]
  toolContextPatch: Partial<ToolContext>
}

/**
 * P0-7: group modules into topological layers so each layer's modules
 * can boot in parallel, but layer N+1 does not start until every
 * surviving module in layer N has resolved. Modules with no
 * dependencies (or whose dependencies were filtered out) land in
 * layer 0. Cycles are broken by treating a node currently being
 * visited as already-resolved — emitting a stderr warning so the
 * operator notices (intentionally not a hard throw, to preserve
 * backwards compatibility with existing module sets).
 *
 * Returns an array of layers (each an AgentModule[]); layers run
 * strictly in order, modules within a layer run concurrently.
 */
export function groupByDependencyDepth(modules: AgentModule[]): AgentModule[][] {
  const remaining = new Map<string, AgentModule>()
  const depthById = new Map<string, number>()
  const byName = new Map<string, AgentModule>()
  for (const m of modules) {
    if (byName.has(m.name)) continue
    byName.set(m.name, m)
    remaining.set(m.name, m)
  }
  // Iteratively peel zero-residual layers. A module is "ready" when
  // every dependency in its list is either unknown to this registry
  // (treated as external/satisfied — preserves previous behavior of
  // silently skipping unknown deps) or has already been assigned a
  // depth in a PRIOR layer. We must NOT assign depths to ready
  // modules until after their entire layer is collected, otherwise
  // a sibling in the same layer could see its co-dependent as
  // "already resolved" and end up in the wrong layer.
  const layers: AgentModule[][] = []
  let progress = true
  while (remaining.size > 0 && progress) {
    progress = false
    const ready: AgentModule[] = []
    for (const [name, m] of remaining) {
      const deps = m.dependencies ?? []
      const readyForLayer = deps.every(d => !byName.has(d) || depthById.has(d))
      if (readyForLayer) {
        ready.push(m)
        remaining.delete(name)
      }
    }
    if (ready.length > 0) {
      // Assign depths AFTER collecting the layer so siblings don't
      // see each other as resolved mid-pass.
      const depth = layers.length
      for (const m of ready) depthById.set(m.name, depth)
      layers.push(ready)
      progress = true
    }
  }
  if (remaining.size > 0) {
    // Cyclic or unsatisfiable dependencies. Emit a warning so the
    // operator can investigate, then put the stragglers in a final
    // layer so they still boot (preserves the prior Promise.all
    // behavior rather than bricking the runtime).
    const stranded = Array.from(remaining.values()).map(m => m.name).join(', ')
    process.stderr.write(
      `[ModuleManager] could not fully resolve module dependencies; booting remaining as best-effort layer: ${stranded}\n`,
    )
    layers.push(Array.from(remaining.values()))
  }
  return layers
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

  /**
   * Boot modules in topological layers (P0-7). Within a layer all
   * modules boot in parallel; between layers we strictly await.
   *
   * Criticality policy (P0-7):
   *   - critical (default): boot failure aborts the engine (throws).
   *   - best_effort: boot failure is logged and the module is dropped
   *     from this manager's `modules` list so subsequent iteration
   *     and complete hooks skip it.
   */
  async boot(bootCtx: ModuleBootContext): Promise<ModuleBootOutput> {
    this.bootResults = []
    const stranded: string[] = []
    const layers = groupByDependencyDepth(this.modules)
    for (const layer of layers) {
      // Note: async arrow (not Promise.resolve(m.boot(...))) so a
      // SYNCHRONOUS throw from boot() rejects the promise instead of
      // escaping allSettled and aborting the layer.
      const results = await Promise.allSettled(
        layer.map(async m => m.boot(bootCtx)),
      )
      results.forEach((r, i) => {
        const m = layer[i]
        if (r.status === 'fulfilled') {
          this.bootResults.push(r.value)
        } else {
          const criticality = m.criticality ?? 'critical'
          const err = r.reason instanceof Error ? r.reason.message : String(r.reason)
          if (criticality === 'best_effort') {
            this.renderer.warn(`[module:${m.name}] best-effort boot failed — dropping. (${err})`)
            this.eventLog?.append('module_flag', m.name, {
              boot_failed: true,
              criticality: 'best_effort',
              error: err,
            })
            stranded.push(m.name)
          } else {
            // critical: surface immediately. Wrap in a descriptive
            // error so callers can tell which module aborted.
            throw new Error(`[module:${m.name}] critical boot failed: ${err}`)
          }
        }
      })
    }
    if (stranded.length > 0) {
      const strandedSet = new Set(stranded)
      this.modules = this.modules.filter(m => !strandedSet.has(m.name))
    }

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

  /**
   * P0-1 (transactional model switch): propagate the new model to
   * every module that captures model state. Best-effort: a throwing
   * onModelChanged hook is logged but does not abort subsequent
   * modules or the runtime — losing one module's model tracking is
   * strictly better than wedging the whole engine.
   */
  notifyModelChanged(model: string): void {
    for (const module of this.modules) {
      if (!module.onModelChanged) continue
      try {
        module.onModelChanged(model)
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        this.renderer.warn(`[module:${module.name}] onModelChanged failed: ${msg}`)
        this.eventLog?.append('module_flag', module.name, {
          on_model_changed_failed: true,
          error: msg,
        })
      }
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

  /**
   * P0-9: async dispose that awaits each module's disposer in turn.
   * Sync `dispose()` is fire-and-forget (kept for SIGTERM / fast-path
   * shutdown where we can't block); `disposeAsync()` is for graceful
   * shutdown where the caller can wait for MCP child processes, file
   * handles, and other async resources to be fully reaped before the
   * process exits.
   *
   * Failure isolation matches `dispose()`: a throwing disposer is
   * logged but does not abort subsequent modules.
   */
  async disposeAsync(): Promise<void> {
    for (const module of this.modules) {
      const dispose = (module as { dispose?: () => void | Promise<void> }).dispose
      if (typeof dispose !== 'function') continue
      try {
        await Promise.resolve(dispose.call(module))
      } catch {
        // module dispose failures must never break engine disposal
      }
    }
  }
}
