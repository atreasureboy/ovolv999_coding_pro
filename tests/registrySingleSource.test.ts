/**
 * v0.4.1 C3 (Registry single-source) — every command listing reads the
 * registerCommand registry; the hardcoded drift lists are gone.
 *
 * The canonical drift was "/plan <task> — Plan mode", hand-written into
 * /help, the bin --help text, and the bare-"/" listing. It contradicted the
 * REGISTERED /plan (task-plan graph viewer) and the real plan-mode entry
 * (the Ctrl+P keybinding). Audit result pinned here: /help, the HelpOverlay,
 * the slash menu (PromptInput), and the bare-"/" listing all consume
 * listCommands(); /models consumes router.listProfiles().
 */
import { describe, it, expect } from 'vitest'
import '../src/commands/builtin.js' // register all built-in commands
import { listCommands, dispatchSlashCommand, type SlashCommandContext } from '../src/commands/index.js'

// /help's handler ignores the context; a minimal stub satisfies the dispatcher.
const stubCtx = {
  history: [],
  cwd: '/tmp',
  setHistory: () => {},
  runPrompt: () => {},
} as unknown as SlashCommandContext

describe('Registry single-source (v0.4.1 C3)', () => {
  it('/help lists every registered command — no hardcoded command list survives', async () => {
    const result = await dispatchSlashCommand('/help', stubCtx)
    expect(result?.type).toBe('text')
    if (result?.type !== 'text') return
    const out = result.value
    for (const cmd of listCommands()) {
      expect(out).toContain('/' + cmd.name)
    }
    // Pre-C3 drift, gone: /plan is the task graph viewer, NOT a plan-mode
    // launcher — plan mode is a keybinding.
    expect(out).not.toContain('/plan <task>')
    expect(out).not.toContain('analyze then confirm')
    expect(out).toContain('Ctrl+P')
    // C2 truth rides along in the footer:
    expect(out).toContain('ESC stops a running turn')
  })

  it('the registry is the truth about what /plan is', () => {
    const plan = listCommands().find((c) => c.name === 'plan')
    expect(plan).toBeDefined()
    expect(plan?.description.toLowerCase()).toContain('task plan graph')
    expect(plan?.description).not.toContain('Plan mode')
  })
})
