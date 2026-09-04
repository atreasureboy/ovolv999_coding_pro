/**
 * builtin command group 3/7 — split from builtin.ts (Round 29).
 * Registration is side-effectful: importing this file registers its commands.
 */

/*
 * Lazy-require pattern (inherited from builtin.ts): command handlers
 * require rarely-used modules at dispatch time to keep CLI startup lean.
 * The pattern is intentional; these rules would fire on every require.
 */
/* eslint-disable @typescript-eslint/consistent-type-imports */


import { homedir } from 'os'
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
import { registerCommand } from '../index.js'
import { calculateContextState } from '../../core/compact.js'
import { execFileSync } from 'child_process'
import { copyToClipboard } from '../../utils/clipboard.js'
import { text } from '../shared.js'

// ── /review — trigger code review ───────────────────────────────────────────

registerCommand({
  name: 'review',
  description: 'Review code changes in the working directory',
  handler: (_args, _ctx) => {
    return { type: 'prompt', value: 'Review all uncommitted changes in this repository. Analyze each modified file for bugs, security issues, performance problems, and convention violations. Group findings by severity: [CRITICAL] / [HIGH] / [MEDIUM] / [LOW]. Use git diff to see changes.' }
  },
})

// ── /security-review — security audit ───────────────────────────────────────

// ── /security-review — security audit ───────────────────────────────────────

registerCommand({
  name: 'security-review',
  description: 'Run a security audit on the codebase',
  aliases: ['sec'],
  handler: (_args, _ctx) => {
    return { type: 'prompt', value: 'Perform a comprehensive security review of this codebase. Check for: OWASP Top 10 vulnerabilities, injection risks (SQL/command/XSS), authentication/authorization issues, secrets/keys in code, insecure dependencies, input validation gaps, and unsafe file operations. Report findings with severity, location (file:line), and remediation steps.' }
  },
})

// ── /branch — git branch operations ─────────────────────────────────────────

// ── /branch — git branch operations ─────────────────────────────────────────

registerCommand({
  name: 'branch',
  description: 'Show git branches or create a new one',
  usage: '/branch [name]  (no args = list branches)',
  handler: (args, ctx) => {
    try {
      if (args.trim()) {
        execFileSync('git', ['checkout', '-b', args.trim()], { cwd: ctx.cwd, timeout: 10_000 })
        return text('Created and switched to branch: ' + args.trim())
      }
      const branches = execFileSync('git', ['branch', '-v'], { cwd: ctx.cwd, encoding: 'utf8', timeout: 10_000 }).trim()
      return text('Git branches:\n' + branches)
    } catch {
      return text('Not a git repository or git not available.')
    }
  },
})

// ── /resume — resume a saved session ────────────────────────────────────────

// ── /resume — resume a saved session ────────────────────────────────────────

registerCommand({
  name: 'resume',
  description: 'List saved sessions, or resume one by name/prefix/path',
  usage: '/resume [session_name]',
  handler: (args, ctx) => {
    const name = args.trim()
    if (!name) {
      // No arg → list available sessions so the user can pick one.
      return text(ctx.getSessionsText?.() ?? 'No saved sessions found.')
    }
    if (!ctx.loadSession) {
      return text('In-session resume is not available in this context. Use ovolv999 --resume <session_name>  or  ovolv999 --continue from the command line.')
    }
    const loaded = ctx.loadSession(name)
    if (!loaded) {
      return text(`Session not found: "${name}". Use /resume with no args to list available sessions.`)
    }
    ctx.setHistory(loaded)
    return text(`Resumed session: ${loaded.length} messages loaded.`)
  },
})

// ── /sessions — list saved sessions ─────────────────────────────────────────

// ── /sessions — list saved sessions ─────────────────────────────────────────

registerCommand({
  name: 'sessions',
  description: 'List saved sessions for this project',
  handler: (_args, ctx) => text(ctx.getSessionsText?.() ?? 'No saved sessions found.'),
})

// ── /status — show session status ───────────────────────────────────────────

// ── /status — show session status ───────────────────────────────────────────

registerCommand({
  name: 'status',
  description: 'Show current session status',
  aliases: ['st', 'info'],
  handler: (_args, ctx) => {
    const cost = ctx.engine.getCostTracker()
    const state = calculateContextState(ctx.history)
    const fh = ctx.engine.getFileHistory()
    const mgr = ctx.engine.getBackgroundTaskManager()
    const tasks = mgr.listTasks()
    const running = tasks.filter(t => t.status === 'running').length

    const lines = [
      'Model: ' + ctx.engine.getModel(),
      'Messages: ' + ctx.history.length,
      'Context: ' + (state.pct * 100).toFixed(0) + '% (' + state.currentTokens.toLocaleString() + '/' + state.maxTokens.toLocaleString() + ' tokens)',
      'API calls: ' + cost.getTotalAPICalls(),
      'Cost: $' + cost.getTotalCost().toFixed(4),
      'Plan mode: ' + (ctx.engine.isPlanMode() ? 'ON' : 'OFF'),
    ]
    if (fh) {
      const files = fh.getEditedFiles()
      if (files.length > 0) lines.push('Files edited: ' + files.length)
    }
    if (tasks.length > 0) lines.push('Background tasks: ' + tasks.length + ' (' + running + ' running)')

    return text('Session Status:\n  ' + lines.join('\n  '))
  },
})

// ── /files — show file edit history ─────────────────────────────────────────

// ── /files — show file edit history ─────────────────────────────────────────

registerCommand({
  name: 'files',
  description: 'Show files edited in this session',
  aliases: ['fl'],
  handler: (_args, ctx) => {
    const fh = ctx.engine.getFileHistory()
    if (!fh) return text('File history tracking not available.')
    return text(fh.getSummary())
  },
})

// ── /config — show current configuration ────────────────────────────────────

// ── /config — show current configuration ────────────────────────────────────

registerCommand({
  name: 'config',
  description: 'Show current configuration',
  handler: (_args, ctx) => {
    const lines = [
      'API key: ' + (process.env.OPENAI_API_KEY ? 'set' : 'NOT SET'),
      'Base URL: ' + (process.env.OPENAI_BASE_URL || 'default'),
      'Model: ' + ctx.engine.getModel(),
      'CWD: ' + ctx.cwd,
      'Session: ' + (ctx.sessionDir || 'none'),
    ]
    const temp = process.env.OVOGO_TEMPERATURE
    if (temp) lines.push('Temperature: ' + temp)
    const maxTok = process.env.OVOGO_MAX_OUTPUT_TOKENS
    if (maxTok) lines.push('Max output tokens: ' + maxTok)

    return text('Configuration:\n  ' + lines.join('\n  '))
  },
})

// ── /cwd — show working directory ───────────────────────────────────────────

// ── /cwd — show working directory ───────────────────────────────────────────

registerCommand({
  name: 'cwd',
  description: 'Show current working directory',
  handler: (_args, ctx) => text('Working directory: ' + ctx.cwd),
})

// ── /search — search conversation history ───────────────────────────────────

// ── /search — search conversation history ───────────────────────────────────

registerCommand({
  name: 'search',
  description: 'Search conversation history for a keyword',
  usage: '/search <keyword>',
  handler: (args, ctx) => {
    const query = args.trim().toLowerCase()
    if (!query) return text('Usage: /search <keyword>')
    if (ctx.history.length === 0) return text('No conversation to search.')

    const results: Array<{ role: string; preview: string; idx: number }> = []
    for (let i = 0; i < ctx.history.length; i++) {
      const msg = ctx.history[i]
      if (msg.role === 'system') continue
      const content = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content)
      if (content.toLowerCase().includes(query)) {
        const preview = content.slice(0, 100).replace(/\n/g, ' ')
        results.push({ role: msg.role, preview, idx: i })
      }
    }

    if (results.length === 0) return text(`No matches for "${args.trim()}".`)

    const lines = results.slice(0, 15).map((r) =>
      `  [${r.idx}] ${r.role}: ${r.preview}${r.preview.length >= 100 ? '...' : ''}`
    )
    let out = `Found ${results.length} match${results.length === 1 ? '' : 'es'} for "${args.trim()}":\n`
    out += lines.join('\n')
    if (results.length > 15) out += `\n  ... and ${results.length - 15} more`
    return text(out)
  },
})

// ── /version — show version ─────────────────────────────────────────────────

// ── /version — show version ─────────────────────────────────────────────────

registerCommand({
  name: 'version',
  description: 'Show ovolv999 version',
  aliases: ['v'],
  handler: () => {
    try {
      // Round 41 audit fix: the Round-29-split path '../../package.json'
      // resolves to src/package.json (missing) in dev — the fallback then
      // reported a stale hardcoded version. '../../../package.json' is
      // correct for BOTH src/ and dist/ layouts.
      const pkg = require('../../../package.json') as { version: string }
      return text(`ovolv999 v${pkg.version}`)
    } catch {
      return text('ovolv999 v0.6.0')
    }
  },
})

registerCommand({
  name: 'copy',
  description: 'Copy last assistant reply to clipboard',
  handler: (_args, ctx) => {
    // Walk history backward to find the last assistant message
    for (let i = ctx.history.length - 1; i >= 0; i--) {
      const m = ctx.history[i]
      if (m.role === 'assistant' && typeof m.content === 'string' && m.content) {
        const ok = copyToClipboard(m.content)
        return ok
          ? text('✓ Copied to clipboard')
          : text('⚠ No clipboard tool found (install xclip or wl-copy)')
      }
    }
    return text('No assistant reply to copy')
  },
})

registerCommand({
  name: 'retry',
  description: 'Retry the last turn (re-submit last prompt)',
  handler: (_args, ctx) => {
    if (ctx.history.length === 0) return text('No previous turn to retry')
    // Find last user message
    for (let i = ctx.history.length - 1; i >= 0; i--) {
      const m = ctx.history[i]
      if (m.role === 'user' && typeof m.content === 'string') {
        ctx.runPrompt(m.content)
        return { type: 'noop' }
      }
    }
    return text('No previous prompt found')
  },
})

registerCommand({
  name: 'keybindings',
  aliases: ['keys', 'kb'],
  description: 'Show or reset keyboard shortcuts. Usage: /keybindings [reset]',
  handler: (args, ctx) => {
    const trimmed = args.trim().toLowerCase()
    // Lazy import to avoid circular dependency in UI layer
    const { loadKeybindings, writeDefaultConfig, DEFAULT_BINDINGS, ACTION_DESCRIPTIONS, ALL_KEY_ACTIONS } =
      require('../../ui/keybindings.js') as typeof import('../../ui/keybindings.js')

    if (trimmed === 'reset' || trimmed === 'default') {
      const path = writeDefaultConfig(ctx.cwd)
      return text(`✓ Reset keybindings to defaults.\nWritten to: ${path}`)
    }

    const result = loadKeybindings(ctx.cwd)

    const lines: string[] = ['Keyboard Shortcuts:', '']

    // Show warnings for conflicts/errors first
    if (result.errors.length > 0) {
      lines.push('⚠ Config errors:')
      for (const e of result.errors) lines.push(`  ${e}`)
      lines.push('')
    }
    if (result.conflicts.length > 0) {
      lines.push('⚠ Conflicting key combos (using defaults instead):')
      for (const c of result.conflicts) {
        lines.push(`  ${c.key} → ${c.actions.join(', ')}`)
      }
      lines.push('')
    }

    // Build a reverse map: action → combo (from resolved bindings)
    const actionToCombo = new Map<string, string>()
    for (const [combo, action] of result.bindings) {
      actionToCombo.set(action, combo)
    }

    for (const action of ALL_KEY_ACTIONS) {
      const combo = actionToCombo.get(action) ?? DEFAULT_BINDINGS[action]
      const isUserOverride = result.hasUserConfig && combo !== DEFAULT_BINDINGS[action]
      const marker = isUserOverride ? ' *' : '  '
      const desc = ACTION_DESCRIPTIONS[action]
      lines.push(`${marker} ${combo.padEnd(18)} ${action.padEnd(20)} ${desc}`)
    }

    lines.push('')
    lines.push(result.hasUserConfig
      ? '* = user override (from .ovolv999/keybindings.json)'
      : 'Edit .ovolv999/keybindings.json to customize. Run /keybindings reset to create a template.')

    return text(lines.join('\n'))
  },
})

registerCommand({
  name: 'workflow',
  aliases: ['wf'],
  description: 'Run or list workflows. Usage: /workflow [list|run <name>|init <name>]',
  handler: async (args, ctx) => {
    const parts = args.trim().split(/\s+/)
    const subcommand = parts[0] ?? 'list'
    const { loadWorkflows, loadWorkflow, executeWorkflow, writeSampleWorkflow } =
      require('../../core/workflow.js') as typeof import('../../core/workflow.js')

    if (subcommand === 'list' || subcommand === '' || !subcommand) {
      const workflows = loadWorkflows(ctx.cwd)
      if (workflows.size === 0) {
        return text('No workflows found. Create one with: /workflow init <name>\nLocation: .ovolv999/workflows/*.json')
      }
      const lines: string[] = [`Workflows (${workflows.size}):`]
      for (const [name, wf] of workflows) {
        const desc = wf.description ? ` — ${wf.description}` : ''
        const stepCount = wf.steps.length
        lines.push(`  ${name.padEnd(20)} ${stepCount} step(s)${desc}`)
      }
      return text(lines.join('\n'))
    }

    if (subcommand === 'init' || subcommand === 'create') {
      const name = parts[1]
      if (!name) return text('Usage: /workflow init <name>')
      const path = writeSampleWorkflow(ctx.cwd, name)
      return text(`✓ Created sample workflow: ${path}\nEdit it to define your steps, then run with: /workflow run ${name}`)
    }

    if (subcommand === 'run') {
      const name = parts[1]
      if (!name) return text('Usage: /workflow run <name>')
      const wf = loadWorkflow(ctx.cwd, name)
      if (!wf) {
        const available = loadWorkflows(ctx.cwd)
        const names = [...available.keys()]
        return text(`Workflow "${name}" not found.${names.length ? `\nAvailable: ${names.join(', ')}` : ''}`)
      }
      // Execute synchronously (shell steps) with basic context
      const result = await executeWorkflow(wf, {
        cwd: ctx.cwd,
        runSlash: async (cmd: string) => {
          // Dispatch slash command through the context's dispatcher if available
          const dispatch = ctx.dispatchSlash
          if (typeof dispatch === 'function') {
            await dispatch(cmd)
            return `(executed: ${cmd})`
          }
          return `(slash not available: ${cmd})`
        },
      })
      const lines: string[] = [
        `Workflow "${result.workflowName}" ${result.success ? '✓ completed' : '✗ failed'} (${result.durationMs}ms)`,
        '',
      ]
      for (const step of result.steps) {
        const status = step.success ? '✓' : '✗'
        const out = step.output ? ` → ${step.output.slice(0, 80)}${step.output.length > 80 ? '...' : ''}` : ''
        const err = step.error ? ` [${step.error.slice(0, 80)}]` : ''
        lines.push(`  ${status} ${step.name} (${step.durationMs}ms)${out}${err}`)
      }
      return text(lines.join('\n'))
    }

    // If no subcommand matched, try to run as workflow name
    const wf = loadWorkflow(ctx.cwd, subcommand)
    if (wf) {
      const result = await executeWorkflow(wf, { cwd: ctx.cwd })
      return text(`Workflow "${result.workflowName}" ${result.success ? '✓' : '✗'} — ${result.steps.length} steps in ${result.durationMs}ms`)
    }

    return text(`Unknown subcommand: ${subcommand}\nUsage: /workflow [list|run <name>|init <name>]`)
  },
})

registerCommand({
  name: 'providers',
  description: 'List known LLM providers and their static model metadata. Usage: /providers [provider]',
  handler: (args) => {
    const { MODELS, PROVIDERS, listProviders, detectProviderFromModel, getModelInfo } =
      require('../../core/providers.js') as typeof import('../../core/providers.js')

    const trimmed = args.trim().toLowerCase()

    // Show specific provider's models
    if (trimmed && PROVIDERS[trimmed as keyof typeof PROVIDERS]) {
      const provider = PROVIDERS[trimmed as keyof typeof PROVIDERS]
      const models = MODELS.filter((m: typeof MODELS[0]) => m.provider === trimmed)
      const lines: string[] = [
        `${provider.name} (${provider.id})`,
        provider.baseURL ? `  Base URL: ${provider.baseURL}` : '',
        provider.apiKeyEnv ? `  API Key:  $${provider.apiKeyEnv}` : '',
        `  OpenAI-compatible: ${provider.openAICompatible ? 'yes' : 'no'}`,
        '',
        `  Models (${models.length}):`,
      ]
      for (const m of models) {
        const ctx = `${(m.contextWindow / 1000).toFixed(0)}k`
        const price = `$${m.pricing.inputPer1M}/$${m.pricing.outputPer1M}/1M`
        const caps = [
          m.supportsVision ? 'vision' : '',
          m.supportsTools ? 'tools' : '',
          m.supportsReasoning ? 'reasoning' : '',
        ].filter(Boolean).join(',')
        lines.push(`    ${m.id.padEnd(35)} ${ctx.padEnd(8)} ${price.padEnd(16)} ${caps}`)
      }
      return text(lines.filter(Boolean).join('\n'))
    }

    // Show all providers
    const lines: string[] = ['LLM Providers:', '']
    for (const id of listProviders()) {
      const p = PROVIDERS[id]
      const modelCount = MODELS.filter((m: typeof MODELS[0]) => m.provider === id).length
      lines.push(`  ${p.name.padEnd(20)} ${modelCount} model(s)${p.baseURL ? `  ${p.baseURL}` : ''}`)
    }

    lines.push('', 'Current model: ' + (process.env.OVOLV_MODEL ?? 'gpt-4o'))
    const detected = detectProviderFromModel(process.env.OVOLV_MODEL ?? 'gpt-4o')
    if (detected !== 'unknown') {
      lines.push(`  Detected provider: ${PROVIDERS[detected].name}`)
    }

    const info = getModelInfo(process.env.OVOLV_MODEL ?? 'gpt-4o')
    if (info) {
      lines.push(`  Context window: ${(info.contextWindow / 1000).toFixed(0)}k`)
      lines.push(`  Pricing: $${info.pricing.inputPer1M}/$${info.pricing.outputPer1M} per 1M tokens`)
    }

    lines.push('', 'Usage: /models <provider> to see models for a specific provider')
    return text(lines.join('\n'))
  },
})

registerCommand({
  name: 'skill-save',
  description: 'Extract a reusable skill from the current session. Usage: /skill-save <name> [description]',
  handler: (args, ctx) => {
    const parts = args.trim().split(/\s+/)
    const name = parts[0]
    const description = parts.slice(1).join(' ')

    if (!name) {
      return text('Usage: /skill-save <name> [description]\n\nThe skill will be extracted from the current session and saved to .ovogo/skills/<name>.md')
    }

    const { extractSkill, saveSkill, skillExists } =
      require('../../skills/extractor.js') as typeof import('../../skills/extractor.js')

    if (skillExists(ctx.cwd, name)) {
      return text(`⚠ Skill "${name}" already exists. Use a different name or delete the file first.`)
    }

    if (ctx.history.length === 0) {
      return text('No conversation history to extract from. Have a conversation first, then save.')
    }

    try {
      const extraction = extractSkill(ctx.history, { name, description: description || undefined })
      const path = saveSkill(ctx.cwd, extraction)

      const lines = [
        `✓ Saved skill: ${name}`,
        `  File: ${path}`,
        `  Category: ${extraction.category}`,
        `  Tools used: ${extraction.toolSequence.length} call(s) across ${extraction.turnCount} turn(s)`,
        '',
        `Description: ${extraction.description}`,
        '',
        `Use /${name} to invoke it. Edit the file to customize the prompt.`,
      ]
      return text(lines.join('\n'))
    } catch (err) {
      return text(`Failed to save skill: ${(err as Error).message}`)
    }
  },
})

// v0.4.1 (golden-path closure): /style + core/outputStyles.ts removed — a
// third parallel brevity system that was never wired into the engine prompt
// (only persisted a config file). The single output contract now lives in
// prompts/system.ts getOutcomeReportSection(); explicit user verbosity
// preference stays in modes.ts getVerbosityPrompt (appended last, wins).

// v0.3.1 (runtime truth contract §八): the second /export registration was removed
// to keep the registry clean. The first registration (line 955) is
// the canonical handler with secret-masking.

// v0.4.1 (golden-path closure): /style + core/outputStyles.ts removed — a
// third parallel brevity system that was never wired into the engine prompt
// (only persisted a config file). The single output contract now lives in
// prompts/system.ts getOutcomeReportSection(); explicit user verbosity
// preference stays in modes.ts getVerbosityPrompt (appended last, wins).

// v0.3.1 (runtime truth contract §八): the second /export registration was removed
// to keep the registry clean. The first registration (line 955) is
// the canonical handler with secret-masking.

registerCommand({
  name: 'audit',
  description: 'Validate all .ovolv999/ configuration files (keybindings, workflows, skills)',
  handler: (_args, ctx) => {
    const { runDoctorChecks, formatDoctorReport } =
      require('../doctor.js') as typeof import('../doctor.js')
    const report = runDoctorChecks(ctx.cwd)
    return text(formatDoctorReport(report))
  },
})

registerCommand({
  name: 'plugins',
  aliases: ['plugin'],
  description: 'Manage plugins. Usage: /plugins [list|enable <id>|disable <id>|init <name>]',
  handler: (args, ctx) => {
    const parts = args.trim().split(/\s+/)
    const subcommand = parts[0] ?? 'list'
    const {
      loadPlugins, formatPluginList, enablePlugin, disablePlugin, createPluginScaffold,
    } = require('../../core/plugins.js') as typeof import('../../core/plugins.js')

    // v0.3.3: register built-in plugins so /plugins shows them.
    const { initBuiltinPlugins } = require('../../core/builtinPlugins.js') as typeof import('../../core/builtinPlugins.js')
    initBuiltinPlugins()

    if (subcommand === 'list' || subcommand === '' || !subcommand) {
      const home = homedir()
      const registry = loadPlugins(ctx.cwd, home)
      return text(formatPluginList(registry))
    }

    if (subcommand === 'enable') {
      const id = parts[1]
      if (!id) return text('Usage: /plugins enable <id>')
      const result = enablePlugin(ctx.cwd, id)
      if (!result.success) return text(`⚠ ${result.error}`)
      return text(`✓ Plugin "${id}" enabled`)
    }

    if (subcommand === 'disable') {
      const id = parts[1]
      if (!id) return text('Usage: /plugins disable <id>')
      const result = disablePlugin(ctx.cwd, id)
      if (!result.success) return text(`⚠ ${result.error}`)
      return text(`✓ Plugin "${id}" disabled`)
    }

    if (subcommand === 'init' || subcommand === 'create') {
      const name = parts[1]
      if (!name) return text('Usage: /plugins init <name> [tools|commands]')
      const withTools = parts.includes('tools')
      const withCommands = parts.includes('commands')
      const path = createPluginScaffold(ctx.cwd, name, {
        tools: withTools || (!withTools && !withCommands),
        commands: withCommands,
      })
      return text(`✓ Created plugin scaffold: ${path}\nEdit plugin.json to configure, then run /plugins to see it.`)
    }

    return text(`Unknown subcommand: ${subcommand}\nUsage: /plugins [list|enable <id>|disable <id>|init <name>]`)
  },
})

registerCommand({
  name: 'suggest',
  aliases: ['suggestions'],
  description: 'Show proactive suggestions based on current context',
  handler: (_args, ctx) => {
    const {
      generateSuggestions, enrichContext, formatSuggestionList,
    } = require('../../core/suggestions.js') as typeof import('../../core/suggestions.js')

    const enriched = enrichContext({
      conversationLength: ctx.history.length,
      lastTurnCompleted: true,
      recentToolResults: [],
    }, ctx.cwd)

    const suggestions = generateSuggestions(enriched)
    if (suggestions.length === 0) {
      return text('No suggestions at this time.')
    }
    const list = formatSuggestionList(suggestions)
    const hints = suggestions.map((s: { actionCommand?: string; actionPrompt?: string; label: string }, i: number) => {
      if (s.actionCommand) return `  ${i + 1}. Run: ${s.actionCommand}`
      if (s.actionPrompt) return `  ${i + 1}. Prompt: "${s.actionPrompt.slice(0, 60)}"`
      return null
    }).filter(Boolean).join('\n')
    return text(`${list}\n\n${hints}`)
  },
})
