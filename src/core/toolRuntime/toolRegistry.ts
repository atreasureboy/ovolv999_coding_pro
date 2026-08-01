/**
 * ToolRegistry — owns tool registration, lookup, and name-collision handling.
 *
 * Responsibilities (from architecture plan §5.5):
 *   - Tool registration (base + extra + module tools)
 *   - Tool lookup by name
 *   - Module Tool and extra Tool merging
 *   - Name collision detection + warning
 *
 * Collision policy: first-registered wins. Base tools are registered before
 * module tools, so a module tool with the same name as a base tool is silently
 * shadowed — but a warning is emitted so the developer knows. This preserves
 * the pre-refactor `Array.find()` first-match behavior.
 *
 * Does NOT handle: policy filtering (ToolPolicy's job), execution
 * (ToolExecutor's job), or scheduling (ToolScheduler's job).
 */

import type { Tool } from '../types.js'
import type { Renderer } from '../../ui/renderer.js'

export class ToolRegistry {
  private readonly tools = new Map<string, Tool>()
  private readonly discovered = new Set<string>()
  private readonly renderer?: Renderer

  constructor(renderer?: Renderer) {
    this.renderer = renderer
  }

  /**
   * Register a single tool. If a tool with the same name already exists,
   * the existing entry wins (first-registered-wins) and a warning is emitted.
   */
  register(tool: Tool): void {
    const existing = this.tools.get(tool.name)
    if (existing) {
      this.renderer?.warn(
        `ToolRegistry: name collision — "${tool.name}" is already registered. ` +
        `The existing tool (${existing.constructor?.name ?? 'unknown'}) wins; ` +
        `the new tool (${tool.constructor?.name ?? 'unknown'}) is ignored.`,
      )
      return
    }
    this.tools.set(tool.name, tool)
  }

  /** Register multiple tools in order. */
  registerMany(tools: Tool[]): void {
    for (const tool of tools) {
      this.register(tool)
    }
  }

  /**
   * Reset the registry to base + module tools. Called during boot when
   * module tools are re-collected each turn. Discovery set is preserved
   * across resets so the LLM's prior discoveries stay valid.
   */
  reset(baseTools: Tool[], moduleTools: Tool[] = []): void {
    this.tools.clear()
    this.registerMany(baseTools)
    this.registerMany(moduleTools)
  }

  /** Look up a tool by name. Returns undefined if not found. */
  get(name: string): Tool | undefined {
    return this.tools.get(name)
  }

  /** Get all registered tools as an array. */
  getAll(): Tool[] {
    return Array.from(this.tools.values())
  }

  /** Number of registered tools. */
  get size(): number {
    return this.tools.size
  }

  /**
   * Mark a tool as discovered this session — its schema will be exposed
   * in the LLM request even if it was originally deferred. Idempotent.
   */
  markDiscovered(name: string): void {
    this.discovered.add(name)
  }

  /** Get the read-only discovered set (used by ToolPolicy defer filter). */
  getDiscovered(): ReadonlySet<string> {
    return this.discovered
  }

  /** Clear the discovery cache (rare — e.g. session reset). */
  clearDiscovered(): void {
    this.discovered.clear()
  }
}
