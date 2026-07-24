/**
 * Slash Command Framework — modular command system for the REPL
 *
 * Inspired by Claude Code's commands.ts (144 commands).
 * Each command is a self-contained module with metadata + handler.
 *
 * Architecture:
 *   - Command interface: { name, description, usage, enabled?, handler }
 *   - CommandRegistry: register/lookup/list
 *   - Handler receives SlashCommandContext (engine, renderer, history, etc.)
 *   - Handler returns: string (output) | 'exit' | { prompt: string } | true (no-op)
 */

import type { ExecutionEngine } from '../core/engine.js'
import type { Renderer } from '../ui/renderer.js'
import type { OpenAIMessage } from '../core/types.js'
import type { PermissionMode, PermissionRule } from '../core/permissionSystem.js'

// ── Types ───────────────────────────────────────────────────────────────────

export interface SlashCommandContext {
  engine: ExecutionEngine
  renderer: Renderer
  history: OpenAIMessage[]
  cwd: string
  sessionDir?: string
  /** Set new history (for /clear, /compact, etc.) */
  setHistory: (msgs: OpenAIMessage[]) => void
  /** Inject a prompt into the conversation (for /commit, /review, etc.) */
  runPrompt: (prompt: string) => void
  /** Optional REPL-provided dynamic text renderers */
  getSkillsText?: () => string
  getSessionsText?: () => string
  /** Persist current permission state; returns destination path when available. */
  persistPermissions?: (mode: PermissionMode, rules: PermissionRule[]) => string | undefined
  /** Resolve a dynamic skill slash command into an executable prompt. */
  resolveSkillPrompt?: (name: string, args: string) => string | null
  /**
   * Load a session's history into the current REPL. Returning a non-empty
   * array means success; returning `null`/`undefined` means no such session.
   * The REPL is responsible for swapping `history` and rebinding its save
   * target so future saves land in the resumed session directory.
   */
  loadSession?: (name: string) => OpenAIMessage[] | null | undefined
}

export type SlashCommandResult =
  | { type: 'text'; value: string }
  | { type: 'exit' }
  | { type: 'prompt'; value: string }
  | { type: 'clear-history' }
  | { type: 'noop' }

export interface Command {
  name: string
  description: string
  usage?: string
  /** Aliases (e.g. ['q'] for /exit) */
  aliases?: string[]
  enabled?: (ctx: SlashCommandContext) => boolean
  handler: (args: string, ctx: SlashCommandContext) => SlashCommandResult | Promise<SlashCommandResult>
}

// ── Registry ────────────────────────────────────────────────────────────────

const registry = new Map<string, Command>()

/** v0.3.1 (te_goal §八): duplicate command registrations throw in dev
 *  mode. The legacy behaviour (silent overwrite) is preserved when
 *  NODE_ENV === 'production' OR OVOLV999_NO_STRICT_SLASH=1. The
 *  goal-driven mode is enabled by default in dev. */
export function registerCommand(cmd: Command): void {
  const isDev = process.env.NODE_ENV !== 'production' && process.env.OVOLV999_NO_STRICT_SLASH !== '1'
  if (isDev) {
    const existing = registry.get(cmd.name)
    if (existing && existing.handler !== cmd.handler) {
      throw new Error(
        `Slash command "/${cmd.name}" is registered twice with different handlers. ` +
        `Existing: ${existing.description ?? '(no description)'}; new: ${cmd.description ?? '(no description)'}. ` +
        `Pick a distinct name or alias. Set OVOLV999_NO_STRICT_SLASH=1 to override.`,
      )
    }
    for (const alias of cmd.aliases ?? []) {
      const existingAlias = registry.get(alias)
      if (existingAlias && existingAlias.handler !== cmd.handler) {
        throw new Error(
          `Slash command alias "/${alias}" is registered twice with different handlers. ` +
          `Set OVOLV999_NO_STRICT_SLASH=1 to override.`,
        )
      }
    }
  }
  registry.set(cmd.name, cmd)
  for (const alias of cmd.aliases ?? []) {
    registry.set(alias, { ...cmd, name: alias })
  }
}

export function getCommand(name: string): Command | undefined {
  return registry.get(name)
}

export function listCommands(): Command[] {
  // Deduplicate by command name (not aliases)
  const seen = new Set<string>()
  const result: Command[] = []
  for (const cmd of registry.values()) {
    if (!seen.has(cmd.name)) {
      seen.add(cmd.name)
      result.push(cmd)
    }
  }
  return result.sort((a, b) => a.name.localeCompare(b.name))
}

export function clearRegistry(): void {
  registry.clear()
}

// ── Dispatcher ──────────────────────────────────────────────────────────────

/**
 * Parse and execute a slash command from user input.
 * Returns null if the input is not a slash command.
 */
export async function dispatchSlashCommand(
  input: string,
  ctx: SlashCommandContext,
): Promise<SlashCommandResult | null> {
  const trimmed = input.trim()
  if (!trimmed.startsWith('/')) return null

  const parts = trimmed.slice(1).split(/\s+/)
  const cmdName = parts[0]
  const args = parts.slice(1).join(' ')

  const cmd = getCommand(cmdName)
  if (!cmd) {
    const skillPrompt = ctx.resolveSkillPrompt?.(cmdName, args)
    return skillPrompt ? { type: 'prompt', value: skillPrompt } : null
  }
  if (cmd.enabled && !cmd.enabled(ctx)) {
    return { type: 'text', value: `Command /${cmdName} is not available in this context.` }
  }

  return cmd.handler(args, ctx)
}
