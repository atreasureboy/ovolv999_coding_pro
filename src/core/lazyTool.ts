/**
 * LazyTool — defers tool creation until first use.
 *
 * Inspired by Codex's lazy tool loading: heavy tools (LSP, MCP, ClaudeCode,
 * large tool definitions) are only instantiated when the model actually
 * invokes them. Without this, every tool is created eagerly in createTools(),
 * adding ~200ms of startup cost for tools that may never be called.
 *
 * Contract:
 *   - `definition` is always available (metadata-only, no heavy init).
 *   - `execute()` calls the factory on first invocation, caching the result.
 *   - The factory may throw; errors are surfaced as tool results with isError.
 *   - Thread-safe: the factory is called at most once (atomic latch).
 */

import type { Tool, ToolContext, ToolDefinition, ToolResult, ToolMetadata } from '../core/types.js'
import type { ResourceClaim } from '../core/executionRun.js'

export interface LazyToolOptions {
  name: string
  definition: ToolDefinition
  metadata?: ToolMetadata
  /** Called once on first execute(). Must return a fully-constructed Tool. */
  factory: () => Tool | Promise<Tool>
}

export class LazyTool implements Tool {
  name: string
  definition: ToolDefinition
  metadata: ToolMetadata

  private readonly factory: () => Tool | Promise<Tool>
  private _real: Tool | null = null
  private _loading: Promise<Tool> | null = null
  private _loadError: Error | null = null

  constructor(opts: LazyToolOptions) {
    this.name = opts.name
    this.definition = opts.definition
    this.metadata = opts.metadata ?? { readOnly: false, concurrencySafe: false }
    this.factory = opts.factory
  }

  async execute(
    input: Record<string, unknown>,
    context: ToolContext,
  ): Promise<ToolResult> {
    const real = await this.ensureLoaded()
    return real.execute(input, context)
  }

  private async ensureLoaded(): Promise<Tool> {
    if (this._real) return this._real
    if (this._loadError) throw this._loadError

    // Atomic latch: only one concurrent call runs the factory.
    if (this._loading) return this._loading

    this._loading = (async () => {
      try {
        const tool = await this.factory()
        this._real = tool
        // Merge any late-bound metadata (the factory may return richer
        // metadata than the stub definition).
        if (tool.metadata) {
          this.metadata = { ...this.metadata, ...tool.metadata }
        }
        return tool
      } catch (err) {
        this._loadError = err instanceof Error ? err : new Error(String(err))
        throw this._loadError
      } finally {
        this._loading = null
      }
    })()

    return this._loading
  }

  /** Force preload (e.g. for warmup in background). */
  async preload(): Promise<Tool> {
    return this.ensureLoaded()
  }

  /** True if the real tool has been loaded. */
  get loaded(): boolean {
    return this._real !== null
  }
}

/**
 * Create a lazy tool that shows a helpful error if the factory fails.
 * The error message includes the tool name so the model can fall back
 * gracefully.
 */
export function createLazyTool(opts: LazyToolOptions): LazyTool {
  return new LazyTool(opts)
}