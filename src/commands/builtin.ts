/**
 * Built-in slash commands for the ovolv999 REPL.
 *
 * Each command is registered at module load. Import this file once
 * in bin/ovogogogo.ts to activate all commands.
 */

import { registerCommand } from './index.js'
import type { SlashCommandContext, SlashCommandResult } from './index.js'
import { listCommands } from './index.js'
import { getCurrentMode, setCurrentMode, cycleMode, getAllModes, type Mode } from '../core/modes.js'
import type { PermissionMode } from '../core/permissionSystem.js'
import { saveProjectSettings } from '../config/settings.js'
import { estimateTokens, calculateContextState, microCompact } from '../core/compact.js'
import type { OpenAIMessage } from '../core/types.js'
import { existsSync, writeFileSync } from 'fs'
import { join } from 'path'
import { execSync, execFileSync } from 'child_process'
import { homedir } from 'os'
import { ClaudeCodeWorkerManager } from '../core/claudeCodeWorkerManager.js'

// ── Helpers ─────────────────────────────────────────────────────────────────

const text = (value: string): SlashCommandResult => ({ type: 'text', value })
const exit = (): SlashCommandResult => ({ type: 'exit' })

/** Module-level singleton — overridable via {@link setWorkerManager} for tests. */
let workerManager: ClaudeCodeWorkerManager = new ClaudeCodeWorkerManager()

/** Replace the /workers manager. Used by tests; safe to call once at startup. */
export function setWorkerManager(manager: ClaudeCodeWorkerManager): void {
  workerManager = manager
}

/** Reset to a fresh default manager — restores production behavior in tests. */
export function resetWorkerManager(): void {
  workerManager = new ClaudeCodeWorkerManager()
}

function getWorkerManager(): ClaudeCodeWorkerManager {
  return workerManager
}

function persistPermissionState(ctx: SlashCommandContext): string {
  const path = ctx.persistPermissions?.(
    ctx.engine.getPermissionManager().getMode(),
    ctx.engine.getPermissionManager().getRules(),
  )
  return path ? '\nSaved to: ' + path : ''
}

// ── Session & History ──────────────────────────────────────────────────────

registerCommand({
  name: 'exit',
  description: 'Exit the REPL',
  aliases: ['quit', 'q'],
  handler: () => exit(),
})

registerCommand({
  name: 'clear',
  description: 'Clear conversation history',
  handler: (_args, ctx) => {
    ctx.setHistory([])
    return { type: 'clear-history' }
  },
})

function previewMessage(msg: OpenAIMessage, max: number): string {
  const raw = typeof msg.content === 'string'
    ? msg.content
    : JSON.stringify(msg.content ?? msg.tool_calls ?? '')
  const oneLine = raw.replace(/\s+/g, ' ').trim()
  return oneLine.length <= max ? oneLine : oneLine.slice(0, Math.max(0, max - 1)) + '…'
}

function roleLabel(role: string): string {
  if (role === 'user') return 'You'
  if (role === 'assistant') return 'AI'
  if (role === 'tool') return 'Tool'
  if (role === 'system') return 'Sys'
  return role
}

registerCommand({
  name: 'history',
  description: 'Show recent messages (default 10) and current session stats',
  usage: '/history [N]',
  handler: (args, ctx) => {
    const trimmed = args.trim()
    const parsed = trimmed ? Number.parseInt(trimmed, 10) : 10
    const n = Number.isInteger(parsed) && parsed > 0 ? parsed : 10

    const total = ctx.history.length
    const tokens = estimateTokens(ctx.history)
    const lines: string[] = []

    if (total === 0) {
      lines.push('No messages in this session yet.')
    } else {
      const recent = ctx.history.slice(-n)
      const skipped = total - recent.length
      if (skipped > 0) lines.push(`Showing last ${recent.length} of ${total} messages:`)
      else lines.push(`Showing all ${total} messages:`)
      for (const msg of recent) {
        lines.push('  [' + roleLabel(msg.role).padEnd(4) + '] ' + previewMessage(msg, 80))
      }
    }

    lines.push('', `Session: ${total} messages, ~${tokens.toLocaleString()} tokens estimated.`)
    return text(lines.join('\n'))
  },
})

// ── /compact — manually trigger compaction ─────────────────────────────────

registerCommand({
  name: 'compact',
  description: 'Summarize conversation to save context (manual trigger)',
  usage: '/compact [optional instructions]',
  handler: (args, ctx) => {
    if (ctx.history.length < 4) {
      return text('Not enough messages to compact (need at least 4).')
    }
    ctx.renderer.warn('Compacting conversation...')
    // Use microCompact first (free, no LLM call)
    const mc = microCompact([...ctx.history])
    if (mc.compacted) {
      ctx.setHistory(mc.messages)
      return text(`Micro-compacted: cleared ${mc.toolsCleared} old tool results (${mc.tokensBefore}→${mc.tokensAfter} tokens). Full LLM compaction will trigger automatically at 85% pressure.`)
    }
    return text('Nothing to micro-compact. Full LLM summarization will trigger automatically at 85% context pressure.')
  },
})

// ── /snip — manual context pruning (zero LLM cost) ─────────────────────────

registerCommand({
  name: 'snip',
  description: 'Manually remove old messages to free context (zero LLM cost, applies at start of next turn)',
  usage: '/snip [N]  (N = messages to keep, default 10)',
  handler: (args, ctx) => {
    const trimmed = args.trim()
    const keepRecent = trimmed ? Number.parseInt(trimmed, 10) : 10
    if (!Number.isFinite(keepRecent) || keepRecent < 0) {
      return text(`Invalid number of messages to keep: "${trimmed}". Usage: /snip [N]`)
    }
    ctx.engine.queueSnip(keepRecent)
    return text(`Queued: will snip to last ${keepRecent} messages at the start of the next turn.`)
  },
})

// ── /cost — show cost summary ───────────────────────────────────────────────

registerCommand({
  name: 'cost',
  description: 'Show token usage and cost summary',
  handler: (_args, ctx) => {
    const tracker = ctx.engine.getCostTracker()
    if (tracker.getTotalAPICalls() === 0) {
      return text('No API calls made yet in this session.')
    }
    return text(tracker.formatSummary())
  },
})

// ── /mode — switch persona/mode ─────────────────────────────────────────────

registerCommand({
  name: 'mode',
  description: 'Switch or list agent modes (personas)',
  usage: '/mode [slug]  or  /mode cycle  or  /mode list',
  handler: (args, ctx) => {
    const modesDir = ctx.sessionDir ? join(homedir(), '.ovogo', 'modes') : undefined
    if (args === 'list' || args === '') {
      const modes = getAllModes(modesDir)
      const current = getCurrentMode(modesDir)
      const lines = modes.map((m: Mode) =>
        '  ' + m.icon + ' ' + m.name.padEnd(14) + ' ' + m.slug.padEnd(14) + ' ' + (m.slug === current.slug ? '<- current ' : '') + m.description
      )
      return text('Available modes:\n' + lines.join('\n') + '\n\nUse /mode <slug> to switch, or /mode cycle to rotate.')
    }
    if (args === 'cycle') {
      const next = cycleMode(modesDir)
      return text(`${next.icon} Mode switched to: ${next.name} (${next.slug}) — ${next.description}`)
    }
    try {
      const mode = setCurrentMode(args, modesDir)
      return text(`${mode.icon} Mode switched to: ${mode.name} (${mode.slug}) — ${mode.description}`)
    } catch {
      return text(`Unknown mode: "${args}". Use /mode list to see available modes.`)
    }
  },
})

// ── /context — show context window usage ────────────────────────────────────

registerCommand({
  name: 'context',
  description: 'Show context window usage breakdown',
  handler: (_args, ctx) => {
    const state = calculateContextState(ctx.history)
    const bar_len = 30
    const filled = Math.round(state.pct * bar_len)
    const bar = '\u2588'.repeat(filled) + '\u2591'.repeat(bar_len - filled)
    const pct_str = (state.pct * 100).toFixed(1)

    const status =
      state.shouldCompact ? '!! COMPACTING' :
      state.shouldWarn ? '! HIGH' :
      'OK'

    return text(
      'Context Window:\n' +
      '  ' + bar + ' ' + pct_str + '%  ' + status + '\n' +
      '  Tokens: ' + state.currentTokens.toLocaleString() + ' / ' + state.maxTokens.toLocaleString() + '\n' +
      '  Strategy: ' + state.strategy + '\n' +
      '  Messages: ' + ctx.history.length
    )
  },
})

// ── /model — show or change model ───────────────────────────────────────────

registerCommand({
  name: 'model',
  description: 'Show current model',
  handler: (_args, ctx) => text(`Current model: ${ctx.engine.getModel()}`),
})

// ── /permissions — show permission mode ─────────────────────────────────────

registerCommand({
  name: 'permissions',
  description: 'Show permission configuration (default: full access, no restrictions)',
  aliases: ['perms'],
  usage: '/permissions [mode|cycle|rules|allow <Tool> <pattern>|deny <Tool> <pattern>|remove <index>|clear]',
  handler: (args, ctx) => {
    const mgr = ctx.engine.getPermissionManager()
    const parts = args.trim().split(/\s+/).filter(Boolean)
    const action = parts[0]

    if (!action) {
      return text(mgr.formatMode() + '\n\n' + mgr.formatRules())
    }
    if (action === 'rules') {
      return text(mgr.formatRules())
    }
    if (action === 'clear') {
      const count = mgr.getRules().length
      for (let i = count - 1; i >= 0; i--) mgr.removeRule(i)
      return text('Cleared ' + count + ' permission rule(s).' + persistPermissionState(ctx))
    }
    if (action === 'remove') {
      const index = Number.parseInt(parts[1] ?? '', 10)
      if (!Number.isInteger(index) || index < 0 || index >= mgr.getRules().length) {
        return text('Usage: /permissions remove <index>')
      }
      mgr.removeRule(index)
      return text('Removed permission rule [' + index + '].\n' + mgr.formatRules() + persistPermissionState(ctx))
    }
    if (action === 'cycle') {
      const next = mgr.cycleMode()
      return text('Permission mode: ' + mgr.formatMode() + `\nSwitched to ${next}.` + persistPermissionState(ctx))
    }
    if (action === 'mode') {
      const mode = parts[1] as PermissionMode | undefined
      if (!mode) return text(mgr.formatMode())
      if (!['default', 'acceptEdits', 'plan', 'auto', 'bypassPermissions'].includes(mode)) {
        return text('Unknown permission mode: ' + mode)
      }
      mgr.setMode(mode)
      return text('Permission mode: ' + mgr.formatMode() + persistPermissionState(ctx))
    }
    if (action === 'allow' || action === 'deny') {
      const toolName = parts[1]
      const ruleContent = parts.slice(2).join(' ')
      if (!toolName || !ruleContent) {
        return text('Usage: /permissions ' + action + ' <ToolName> <pattern>')
      }
      mgr.addRule({
        toolName,
        ruleContent,
        behavior: action,
        source: 'user',
      })
      return text('Added permission rule:\n' + mgr.formatRules() + persistPermissionState(ctx))
    }

    return text('Usage: /permissions [mode|cycle|rules|allow <Tool> <pattern>|deny <Tool> <pattern>|remove <index>|clear]')
  },
})

// ── /poor — toggle budget mode ───────────────────────────────────────

registerCommand({
  name: 'poor',
  description: 'Toggle Poor/Budget mode (skip critic + reflection LLM calls)',
  usage: '/poor [on|off]',
  handler: (args, ctx) => {
    const liveConfig = ctx.engine.getConfig()
    const action = args.trim().split(/\s+/)[0]
    const current = liveConfig.poor?.enabled === true

    if (!action) {
      return text('Poor mode: ' + (current ? 'ON' : 'OFF') + '\n\nUse /poor on or /poor off to toggle. Skips critic self-correction and reflection LLM calls.')
    }
    if (action !== 'on' && action !== 'off') {
      return text('Usage: /poor [on|off]')
    }
    const enabled = action === 'on'
    liveConfig.poor = { enabled }
    saveProjectSettings(ctx.cwd, { poor: { enabled } })
    return text('Poor mode: ' + (enabled ? 'ON' : 'OFF') + ' (saved to .ovogo/settings.json)')
  },
})

// ── /rewind — file history ─────────────────────────────────────────────────
//
// Audit note: the previous version advertised `/rewind [file_path] [version]`
// and hinted that you could "restoreVersion", but the implementation only
// returns a summary — there is no restoreVersion call wired through the
// engine, and exposing the file-history mutation API to a slash command
// would require a real versioned restore. Until that lands, we tell the
// truth: this command is a *list*, not a *restore*.

registerCommand({
  name: 'rewind',
  description: 'List file edits in this session (read-only — restore is not supported)',
  usage: '/rewind',
  handler: (_args, ctx) => {
    const fh = ctx.engine.getFileHistory()
    if (!fh) {
      return text('File history not available (no session directory configured).')
    }
    const files = fh.getEditedFiles()
    if (files.length === 0) {
      return text('No file edits tracked in this session.')
    }
    return text(fh.getSummary() + '\n\nRestore is not supported by this command. To roll back, use git or your editor\'s undo.')
  },
})

// ── /tasks — show background tasks ──────────────────────────────────────────

registerCommand({
  name: 'tasks',
  description: 'List background tasks',
  handler: (_args, ctx) => {
    const mgr = ctx.engine.getBackgroundTaskManager()
    const tasks = mgr.listTasks()
    if (tasks.length === 0) {
      return text('No background tasks.')
    }
    // Inline formatTaskList
    const lines = tasks.map(t => {
      const icon = t.status === 'running' ? '\u25C6' : t.status === 'completed' ? '\u2713' : t.status === 'failed' ? '\u2717' : '\u2299'
      const dur = t.durationMs !== null ? ' (' + (t.durationMs / 1000).toFixed(1) + 's)' : ''
      return '  ' + icon + ' ' + t.id + ' [' + t.status + ']' + dur + ' ' + t.description
    })
    return text('Background tasks (' + tasks.length + '):\n' + lines.join('\n'))
  },
})

// ── /workers — external Claude Code workers ────────────────────────────────

registerCommand({
  name: 'workers',
  description: 'Manage external Claude Code tmux workers',
  usage: '/workers [list|start [session]|capture [session] [lines]|stop <session>]',
  handler: async (args, ctx) => {
    const parts = args.trim().split(/\s+/).filter(Boolean)
    const action = parts[0] ?? 'list'
    const session = parts[1] ?? 'ovogo-claude-worker'
    const mgr = getWorkerManager()

    try {
      if (action === 'list') {
        const sessions = await mgr.list()
        const workers = sessions.filter((s) => s.startsWith('ovogo-'))
        if (workers.length === 0) return text('No ovogo worker sessions.')
        return text('Worker sessions:\n' + workers.map((s) => '  ' + s).join('\n'))
      }

      if (action === 'start') {
        const result = await mgr.start({ session, cwd: ctx.cwd })
        return text([
          `Worker: ${result.session}`,
          result.created ? 'Status: started' : 'Status: already running',
          `Synced env: ${result.syncedEnv.length ? result.syncedEnv.join(', ') : 'none'}`,
        ].join('\n'))
      }

      if (action === 'capture') {
        const rawLines = parts[2]
        const lines = rawLines === undefined ? 80 : Number(rawLines)
        const safeLines = Number.isFinite(lines) ? Math.max(0, Math.floor(lines)) : 80
        if (!await mgr.sessionExists(session)) {
          return text(`Worker session not found: ${session}. Use /workers list to see active workers.`)
        }
        const output = await mgr.capture(session, safeLines)
        return text(output || '(no output)')
      }

      if (action === 'stop') {
        if (!parts[1]) return text('Usage: /workers stop <session>')
        const result = await mgr.stop(session)
        return text(result.stopped ? `Stopped worker: ${session}` : `Worker not running: ${session}`)
      }

      return text('Usage: /workers [list|start [session]|capture [session] [lines]|stop <session>]')
    } catch (err) {
      return text(`Workers command failed: ${(err as Error).message}`)
    }
  },
})

// ── /doctor — health diagnostics ────────────────────────────────────────────

registerCommand({
  name: 'doctor',
  description: 'Run health diagnostics',
  handler: (_args, ctx) => {
    const OK = '\x1b[32m\u2713\x1b[0m'
    const FAIL = '\x1b[31m\u2717\x1b[0m'
    const INFO = '\x1b[36mi\x1b[0m'
    const checks: string[] = []

    // Detect the active provider. The CLI can run against either OpenAI
    // directly or a MiniMax (minimaxi.com / minimax.io) deployment. The
    // previous version only checked OPENAI_API_KEY / OPENAI_BASE_URL,
    // so a MiniMax user with ANTHROPIC_AUTH_TOKEN set would see
    // "API key: NOT SET" — a false negative that prompted users to set
    // a credential they don't actually need.
    const anthropicBaseURL = process.env.ANTHROPIC_BASE_URL
    const anthropicApiKey = process.env.ANTHROPIC_AUTH_TOKEN ?? process.env.ANTHROPIC_API_KEY
    const isMiniMax = Boolean(
      anthropicApiKey && anthropicBaseURL &&
      /^https:\/\/api\.(?:minimax\.io|minimaxi\.com)\/anthropic\/?$/i.test(anthropicBaseURL),
    )

    if (isMiniMax) {
      checks.push('  ' + OK + ' Provider: MiniMax (Anthropic-compatible endpoint)')
      checks.push('  ' + OK + ' API key: set (ANTHROPIC_AUTH_TOKEN)')
      checks.push('  ' + INFO + ' Base URL: ' + anthropicBaseURL)
    } else {
      // OpenAI / OpenAI-compatible path
      const apiKey = process.env.OPENAI_API_KEY
      if (apiKey && apiKey.length > 10) {
        checks.push('  ' + OK + ' API key: set (' + apiKey.slice(0, 6) + '...' + apiKey.slice(-4) + ')')
      } else {
        checks.push('  ' + FAIL + ' API key: NOT SET (export OPENAI_API_KEY=...)')
      }
      const baseURL = process.env.OPENAI_BASE_URL
      checks.push('  ' + INFO + ' Base URL: ' + (baseURL || 'default (OpenAI)'))
    }

    // Model
    checks.push('  ' + INFO + ' Model: ' + ctx.engine.getModel())

    // Working directory
    checks.push('  ' + INFO + ' CWD: ' + ctx.cwd)

    // Session dir
    checks.push('  ' + INFO + ' Session: ' + (ctx.sessionDir || 'none'))

    // Plan mode
    checks.push('  ' + INFO + ' Plan mode: ' + (ctx.engine.isPlanMode() ? 'ON' : 'OFF'))

    // Cost
    const cost = ctx.engine.getCostTracker()
    checks.push('  ' + INFO + ' API calls: ' + cost.getTotalAPICalls())
    if (cost.getTotalAPICalls() > 0) {
      checks.push('  ' + INFO + ' Cost: $' + cost.getTotalCost().toFixed(4))
    }

    // File history
    const fh = ctx.engine.getFileHistory()
    if (fh) {
      const files = fh.getEditedFiles()
      checks.push('  ' + INFO + ' File history: ' + files.length + ' file(s) tracked')
    }

    // Background tasks
    const mgr = ctx.engine.getBackgroundTaskManager()
    const tasks = mgr.listTasks()
    if (tasks.length > 0) {
      const running = tasks.filter(t => t.status === 'running').length
      checks.push('  ' + INFO + ' Background tasks: ' + tasks.length + ' (' + running + ' running)')
    }

    // Context
    const state = calculateContextState(ctx.history)
    const pct = (state.pct * 100).toFixed(0)
    checks.push('  ' + INFO + ' Context: ' + pct + '% used (' + state.currentTokens.toLocaleString() + '/' + state.maxTokens.toLocaleString() + ' tokens)')

    // Node version
    checks.push('  ' + INFO + ' Node: ' + process.version)

    // Platform
    checks.push('  ' + INFO + ' Platform: ' + process.platform + ' ' + process.arch)

    return text('Health Check:\n' + checks.join('\n'))
  },
})

// ── /diff — show git diff ───────────────────────────────────────────────────

registerCommand({
  name: 'diff',
  description: 'Show git diff (unstaged changes)',
  handler: (_args, ctx) => {
    try {
      const diff = execSync('git diff --stat', { cwd: ctx.cwd, encoding: 'utf8', timeout: 10_000 }).trim()
      if (!diff) {
        return text('No unstaged changes.')
      }
      return text(`Git diff (unstaged):\n\n${diff}`)
    } catch {
      return text('Not a git repository or git not available.')
    }
  },
})

// ── /commit — git commit helper ─────────────────────────────────────────────

registerCommand({
  name: 'commit',
  description: 'Stage all changes and create a git commit',
  usage: '/commit <message>',
  handler: (args, ctx) => {
    if (!args.trim()) {
      return text('Usage: /commit <commit message>')
    }
    try {
      execFileSync('git', ['add', '-A'], { cwd: ctx.cwd, timeout: 10_000 })
      execFileSync('git', ['commit', '-m', args], { cwd: ctx.cwd, encoding: 'utf8', timeout: 30_000 })
      return text(`Committed: ${args}`)
    } catch (err) {
      return text(`Commit failed: ${(err as Error).message}`)
    }
  },
})

// ── /init — initialize project config ───────────────────────────────────────

registerCommand({
  name: 'init',
  description: 'Create OVOGO.md project config file',
  handler: (_args, ctx) => {
    const configPath = join(ctx.cwd, 'OVOGO.md')
    if (existsSync(configPath)) {
      return text(`OVOGO.md already exists at ${configPath}`)
    }
    const template = `# Project Instructions

## Overview
Describe your project here.

## Conventions
- Coding style and patterns
- Testing approach
- Build commands

## Important Notes
- Architecture decisions
- Known issues
- Security constraints
`
    writeFileSync(configPath, template, 'utf8')
    return text(`Created ${configPath} — edit it to add project-specific instructions.`)
  },
})

// ── /skills — list available skills ─────────────────────────────────────────

registerCommand({
  name: 'skills',
  description: 'List available skills',
  handler: (_args, ctx) => text(ctx.getSkillsText?.() ?? 'No skills available.'),
})

// ── /help — show available commands ─────────────────────────────────────────

registerCommand({
  name: 'help',
  description: 'Show all available commands',
  aliases: ['h', '?'],
  handler: (_args, _ctx) => {
    // Build help text directly — list all registered commands
    const cmds = listCommands()
    const lines = cmds.map(cmd =>
      '  /' + cmd.name.padEnd(16) + ' ' + cmd.description
    )
    return text(
      'Available commands:\n' +
      lines.join('\n') +
      '\n\n  /plan <task>       Plan mode — analyze then confirm before execute\n' +
      '  /<skill_name>      Run a loaded skill\n\n' +
      'Type / for quick command list. ESC to interrupt. Ctrl+D to exit.'
    )
  },
})

// ── /export — export conversation transcript ────────────────────────────────

registerCommand({
  name: 'export',
  description: 'Export conversation transcript to a file',
  usage: '/export [format: text|json|markdown] (default: markdown)',
  handler: (args, ctx) => {
    if (ctx.history.length === 0) {
      return text('No conversation to export.')
    }
    const format = args.trim() || 'markdown'
    let content = ''
    let ext = 'md'

    if (format === 'json') {
      ext = 'json'
      content = JSON.stringify(ctx.history, null, 2)
    } else if (format === 'text') {
      ext = 'txt'
      for (const msg of ctx.history) {
        const role = msg.role.toUpperCase()
        const body = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.tool_calls ?? '')
        content += '[' + role + ']\n' + body + '\n\n'
      }
    } else {
      // markdown
      content = '# Conversation Export\n\n'
      content += 'Exported: ' + new Date().toISOString() + '\n'
      content += 'Messages: ' + ctx.history.length + '\n\n---\n\n'
      for (const msg of ctx.history) {
        if (msg.role === 'system') continue
        const header = msg.role === 'user' ? '**User:**' :
                       msg.role === 'assistant' ? '**Assistant:**' :
                       msg.role === 'tool' ? '**Tool:**' : '**' + (msg.role as string) + ':**'
        const body = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.tool_calls ?? '', null, 2)
        content += header + '\n\n' + body + '\n\n---\n\n'
      }
    }

    const exportPath = ctx.sessionDir
      ? join(ctx.sessionDir, 'transcript.' + ext)
      : join(ctx.cwd, 'transcript.' + ext)
    try {
      writeFileSync(exportPath, content, 'utf8')
      return text('Exported ' + ctx.history.length + ' messages to: ' + exportPath)
    } catch (err) {
      return text('Export failed: ' + (err as Error).message)
    }
  },
})

// ── /review — trigger code review ───────────────────────────────────────────

registerCommand({
  name: 'review',
  description: 'Review code changes in the working directory',
  handler: (_args, _ctx) => {
    return { type: 'prompt', value: 'Review all uncommitted changes in this repository. Analyze each modified file for bugs, security issues, performance problems, and convention violations. Group findings by severity: [CRITICAL] / [HIGH] / [MEDIUM] / [LOW]. Use git diff to see changes.' }
  },
})

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

registerCommand({
  name: 'sessions',
  description: 'List saved sessions for this project',
  handler: (_args, ctx) => text(ctx.getSessionsText?.() ?? 'No saved sessions found.'),
})

// ── /status — show session status ───────────────────────────────────────────

registerCommand({
  name: 'status',
  description: 'Show current session status',
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

registerCommand({
  name: 'cwd',
  description: 'Show current working directory',
  handler: (_args, ctx) => text('Working directory: ' + ctx.cwd),
})

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

registerCommand({
  name: 'version',
  description: 'Show ovolv999 version',
  aliases: ['v'],
  handler: () => text('ovolv999 v0.1.0'),
})

// ── Export for REPL ─────────────────────────────────────────────────────────

export { registerCommand } from './index.js'
export type { Command, SlashCommandContext, SlashCommandResult } from './index.js'
