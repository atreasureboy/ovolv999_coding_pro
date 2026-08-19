/**
 * PluginsModule — real runtime loading of user plugins.
 *
 * Before this module existed, the plugin system was registry-only:
 * manifests were discovered, validated, and toggled, but no plugin code
 * was ever imported or executed. This module closes that gap at engine
 * boot:
 *
 *   .ovolv999/plugins/<name>/plugin.json  → provides.tools   → Tool[]
 *                                          → provides.commands → slash commands
 *
 * Discovery reuses loadPlugins() (project + global dirs, enabled flag,
 * manifest validation). Every enabled non-builtin plugin's declared JS
 * files are dynamic-imported; the exports are adapted to the engine's
 * Tool / Command contracts with strict shape validation. A broken plugin
 * logs to stderr and is skipped — plugin failures never block engine boot.
 *
 * Accepted export shapes (tools files):
 *   - default export: Tool | Tool[] | () => Tool | Tool[]
 *   - `tools` export: Tool[]
 *   - any named export that satisfies the Tool shape
 *
 * Accepted export shapes (commands files):
 *   - default export: Command | Command[]
 *   - `commands` export: Command[]
 *
 * Security: plugin code runs with full host privileges — the same trust
 * model as MCP stdio servers and Claude Code plugins. Only enable plugins
 * you trust.
 */

import { join } from 'path'
import { homedir } from 'os'
import { pathToFileURL } from 'url'
import type { AgentModule, ModuleBootContext, ModuleBootResult } from '../core/module.js'
import type { Tool } from '../core/types.js'
import { loadPlugins } from '../core/plugins.js'
import { registerCommand, type Command } from '../commands/index.js'

function isTool(value: unknown): value is Tool {
  if (!value || typeof value !== 'object') return false
  const t = value as Record<string, unknown>
  return (
    typeof t.name === 'string'
    && t.name.trim().length > 0
    && !!t.definition
    && typeof t.definition === 'object'
    && typeof t.execute === 'function'
  )
}

function isCommand(value: unknown): value is Command {
  if (!value || typeof value !== 'object') return false
  const c = value as Record<string, unknown>
  return (
    typeof c.name === 'string'
    && c.name.trim().length > 0
    && typeof c.description === 'string'
    && typeof c.handler === 'function'
  )
}

/** Collect Tool instances from any accepted export shape. */
function extractTools(mod: Record<string, unknown>): Tool[] {
  const out: Tool[] = []
  const push = (value: unknown, allowFactory: boolean): void => {
    if (isTool(value)) {
      out.push(value)
    } else if (allowFactory && typeof value === 'function') {
      // Round 41 audit fix: ONLY the default export may be a factory —
      // invoking arbitrary named function exports meant a plugin's
      // utility functions ran as side effects at boot. Named exports
      // must be Tool objects (arrays traverse, functions are ignored).
      try {
        const produced = (value as () => unknown)()
        if (Array.isArray(produced)) produced.forEach((v) => push(v, false))
        else push(produced, false)
      } catch {
        /* factory threw — skip, reported by caller */
      }
    } else if (Array.isArray(value)) {
      value.forEach((v) => push(v, false))
    }
  }
  if (mod.default !== undefined) push(mod.default, true)
  if (mod.tools !== undefined) push(mod.tools, false)
  for (const [key, value] of Object.entries(mod)) {
    if (key === 'default' || key === 'tools' || key === '__esModule') continue
    if (isTool(value)) out.push(value)
  }
  // Deduplicate by tool name — first registration wins.
  const seen = new Set<string>()
  return out.filter((t) => {
    if (seen.has(t.name)) return false
    seen.add(t.name)
    return true
  })
}

function extractCommands(mod: Record<string, unknown>): Command[] {
  const out: Command[] = []
  const push = (value: unknown): void => {
    if (isCommand(value)) out.push(value)
    else if (Array.isArray(value)) value.forEach(push)
  }
  if (mod.default !== undefined) push(mod.default)
  if (mod.commands !== undefined) push(mod.commands)
  const seen = new Set<string>()
  return out.filter((c) => {
    if (seen.has(c.name)) return false
    seen.add(c.name)
    return true
  })
}

export class PluginsModule implements AgentModule {
  readonly name = 'plugins'
  criticality = 'best_effort' as const

  async boot(ctx: ModuleBootContext): Promise<ModuleBootResult> {
    let registry
    try {
      registry = loadPlugins(ctx.cwd, homedir())
    } catch (err) {
      process.stderr.write(`[plugins] discovery failed: ${(err as Error).message}\n`)
      return {}
    }

    const tools: Tool[] = []
    let commandCount = 0

    for (const plugin of registry.plugins.values()) {
      if (!plugin.enabled || !plugin.path || plugin.source === 'builtin') continue
      const provides = plugin.manifest.provides
      if (!provides) continue

      for (const file of provides.tools ?? []) {
        try {
          const mod = (await import(pathToFileURL(join(plugin.path, file)).href)) as Record<string, unknown>
          const loaded = extractTools(mod)
          if (loaded.length === 0) {
            process.stderr.write(`[plugins] "${plugin.name}": ${file} exported no valid tools\n`)
            continue
          }
          tools.push(...loaded)
        } catch (err) {
          process.stderr.write(`[plugins] "${plugin.name}" failed to load ${file}: ${(err as Error).message}\n`)
        }
      }

      for (const file of provides.commands ?? []) {
        try {
          const mod = (await import(pathToFileURL(join(plugin.path, file)).href)) as Record<string, unknown>
          for (const cmd of extractCommands(mod)) {
            try {
              registerCommand(cmd)
              commandCount++
            } catch (err) {
              process.stderr.write(`[plugins] "${plugin.name}": command "/${cmd.name}" rejected: ${(err as Error).message}\n`)
            }
          }
        } catch (err) {
          process.stderr.write(`[plugins] "${plugin.name}" failed to load ${file}: ${(err as Error).message}\n`)
        }
      }
    }

    if (tools.length > 0 || commandCount > 0) {
      process.stderr.write(
        `[plugins] loaded ${tools.length} tool(s), ${commandCount} command(s) from user plugins\n`,
      )
    }
    return tools.length > 0 ? { tools } : {}
  }
}
