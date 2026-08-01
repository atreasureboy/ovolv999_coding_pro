/**
 * Deferred tools reminder — borrowed from claude-code's
 * `<available-deferred-tools>` system reminder.
 *
 * Returns the list of tool names marked `shouldDefer: true` in the
 * current ToolRegistry. Coordinator injects this once per turn into
 * the ControlMessageLog so the model can call
 * `search_extra_tools("select:<name>")` to load them.
 *
 * Why a separate helper:
 *   - Keeps coordinator free of ToolRegistry wiring (it's already a
 *     big file)
 *   - Easy to unit test independently
 */

import type { ToolRegistry } from '../toolRuntime/toolRegistry.js'

export function collectDeferredToolNames(registry: ToolRegistry | null | undefined): string[] {
  if (!registry) return []
  const all = registry.getAll()
  const out: string[] = []
  for (const tool of all) {
    if (tool.metadata?.shouldDefer === true && tool.metadata?.alwaysLoad !== true) {
      out.push(tool.name)
    }
  }
  return out.sort()
}
