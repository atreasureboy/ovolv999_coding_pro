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
import { copyToClipboard } from '../utils/clipboard.js'
import type { EditedFileInfo } from '../core/fileHistory.js'

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

registerCommand({
  name: 'reset',
  description: 'Reset everything: history + cost + context (fresh start)',
  handler: (_args, ctx) => {
    ctx.setHistory([])
    ctx.engine.getCostTracker().reset()
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
  aliases: ['c'],
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
  aliases: ['co', '$'],
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
  aliases: ['ctx'],
  usage: '/context [top N]  (show top N token consumers)',
  handler: (args, ctx) => {
    const state = calculateContextState(ctx.history)
    const bar_len = 30
    const filled = Math.round(state.pct * bar_len)
    const bar = '\u2588'.repeat(filled) + '\u2591'.repeat(bar_len - filled)
    const pct_str = (state.pct * 100).toFixed(1)

    const status =
      state.shouldCompact ? '!! COMPACTING' :
      state.shouldWarn ? '! HIGH' :
      'OK'

    const lines: string[] = [
      'Context Window:',
      '  ' + bar + ' ' + pct_str + '%  ' + status,
      '  Tokens: ' + state.currentTokens.toLocaleString() + ' / ' + state.maxTokens.toLocaleString(),
      '  Strategy: ' + state.strategy,
      '  Messages: ' + ctx.history.length,
    ]

    // Show top N token consumers if requested or context is high
    const topN = args.trim() ? Math.min(20, Math.max(1, parseInt(args.trim(), 10) || 5)) : (state.pct > 0.5 ? 5 : 0)
    if (topN > 0 && ctx.history.length > 0) {
      const consumers = ctx.history
        .map((m, i) => {
          const content = typeof m.content === 'string'
            ? m.content
            : JSON.stringify(m.content ?? m.tool_calls ?? '')
          return { idx: i, role: m.role, tokens: Math.ceil(content.length / 4), preview: content.slice(0, 60).replace(/\n/g, ' ') }
        })
        .sort((a, b) => b.tokens - a.tokens)
        .slice(0, topN)

      lines.push('', 'Top token consumers:')
      for (const c of consumers) {
        lines.push(`  [${c.idx.toString().padStart(3)}] ${c.role.padEnd(9)} ${c.tokens.toString().padStart(6)} tok  ${c.preview}${c.preview.length >= 60 ? '…' : ''}`)
      }
    }

    return text(lines.join('\n'))
  },
})

// ── /model — show or change model ───────────────────────────────────────────

registerCommand({
  name: 'model',
  description: 'Show current model',
  aliases: ['m'],
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
    return text(fh.getSummary() + '\n\nUse /undo to restore a file to its pre-edit state.')
  },
})

// ── /undo — restore the most recently edited file ───────────────────────────

registerCommand({
  name: 'undo',
  description: 'Undo the last file edit (restore previous version)',
  usage: '/undo [file path]',
  handler: (args, ctx) => {
    const fh = ctx.engine.getFileHistory()
    if (!fh) {
      return text('File history not available (no session directory configured).')
    }
    const files = fh.getEditedFiles()
    if (files.length === 0) {
      return text('No file edits to undo.')
    }

    // If a specific file is given, undo that one
    const target = args.trim()
    let file: EditedFileInfo | undefined

    if (target) {
      // Resolve to absolute path for matching
      file = files.find(f => f.path === target || f.path.endsWith('/' + target))
      if (!file) {
        return text(`No edits tracked for: ${target}\nEdited files:\n${files.map(f => '  ' + f.path).join('\n')}`)
      }
    } else {
      // Find the most recently modified file
      file = files
        .slice()
        .sort((a, b) => (b.lastModified ?? 0) - (a.lastModified ?? 0))[0]
    }

    const versions = fh.getVersions(file.path)
    if (versions.length === 0) {
      return text(`No versions available for ${file.path}`)
    }

    // Restore to version 0 (original pre-edit state)
    const ok = fh.restoreOriginal(file.path)
    if (ok) {
      return text(`✓ Restored ${file.path} to original (pre-edit) state.\n  ${versions.length} version(s) were tracked.`)
    }
    return text(`✗ Failed to restore ${file.path}. The backup may be missing.`)
  },
})

// ── /tasks — show background tasks ──────────────────────────────────────────

registerCommand({
  name: 'tasks',
  description: 'List background tasks',
  aliases: ['t'],
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
  description: 'Show git diff (unstaged, staged, or full)',
  usage: '/diff [staged|full|stat]',
  handler: (args, ctx) => {
    const subcmd = args.trim().toLowerCase()
    try {
      let output: string
      if (subcmd === 'staged') {
        output = execSync('git diff --cached --stat', { cwd: ctx.cwd, encoding: 'utf8', timeout: 10_000 }).trim()
        if (!output) return text('No staged changes.')
        return text(`Git diff (staged):\n\n${output}`)
      }
      if (subcmd === 'full') {
        output = execSync('git diff', { cwd: ctx.cwd, encoding: 'utf8', timeout: 10_000 }).trim()
        if (!output) return text('No unstaged changes.')
        // Truncate very large diffs
        const lines = output.split('\n')
        if (lines.length > 200) {
          return text(`Git diff (unstaged, first 200 of ${lines.length} lines):\n\n${lines.slice(0, 200).join('\n')}\n... +${lines.length - 200} more lines (use /diff stat for summary)`)
        }
        return text(`Git diff (unstaged):\n\n${output}`)
      }
      // Default: stat summary
      output = execSync('git diff --stat', { cwd: ctx.cwd, encoding: 'utf8', timeout: 10_000 }).trim()
      if (!output) return text('No unstaged changes. Try /diff staged or /diff full')
      return text(`Git diff (unstaged):\n\n${output}\n\nUse /diff full for complete diff, /diff staged for staged changes.`)
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

// ── /git — general-purpose git command ──────────────────────────────────────

registerCommand({
  name: 'git',
  description: 'Run git commands: /git status|log|stash|add|push|pull',
  usage: '/git <subcommand> [args]',
  handler: (args, ctx) => {
    const [subcmd, ...rest] = args.trim().split(/\s+/)
    const sub = (subcmd ?? '').toLowerCase()

    const safeRun = (cmd: string, params: string[], label: string): SlashCommandResult => {
      try {
        const out = execFileSync(cmd, params, { cwd: ctx.cwd, encoding: 'utf8', timeout: 15_000 }).trim()
        return text(out ? `${label}:\n\n${out}` : `${label}: (no output)`)
      } catch (err) {
        return text(`${label} failed: ${(err as Error).message.slice(0, 200)}`)
      }
    }

    try {
      switch (sub) {
        case '':
        case 'status':
          return safeRun('git', ['status', '--short'], 'Git status')
        case 'log': {
          const n = rest[0] && /^\d+$/.test(rest[0]) ? rest[0] : '10'
          return safeRun('git', ['log', `--oneline`, `-${n}`, '--graph'], `Git log (last ${n})`)
        }
        case 'stash':
          if (rest[0] === 'pop' || rest[0] === 'apply') {
            return safeRun('git', ['stash', rest[0]], `Git stash ${rest[0]}`)
          }
          if (rest[0] === 'list') {
            return safeRun('git', ['stash', 'list'], 'Git stash list')
          }
          if (rest[0] === 'drop') {
            return safeRun('git', ['stash', 'drop', rest[1] ?? ''], 'Git stash drop')
          }
          return safeRun('git', ['stash', 'push', '-m', rest.join(' ') || 'ovolv999 stash'], 'Git stash')
        case 'add':
          return safeRun('git', ['add', ...(rest.length > 0 ? rest : ['.'])], 'Git add')
        case 'push':
          return safeRun('git', ['push', ...rest], 'Git push')
        case 'pull':
          return safeRun('git', ['pull', ...rest], 'Git pull')
        case 'fetch':
          return safeRun('git', ['fetch', ...rest], 'Git fetch')
        case 'remote':
          return safeRun('git', ['remote', '-v'], 'Git remotes')
        case 'tag':
          if (rest.length === 0) {
            return safeRun('git', ['tag', '-l'], 'Git tags')
          }
          return safeRun('git', ['tag', ...rest], 'Git tag')
        default:
          return text(`Unknown git subcommand: ${sub}\nAvailable: status, log, stash, add, push, pull, fetch, remote, tag`)
      }
    } catch {
      return text('Not a git repository or git not available.')
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
    const cmds = listCommands()
    const lines = cmds.map(cmd => {
      const aliases = cmd.aliases && cmd.aliases.length > 0
        ? ` (${cmd.aliases.map(a => '/' + a).join(', ')})`
        : ''
      return '  /' + cmd.name.padEnd(16) + ' ' + cmd.description + aliases
    })
    return text(
      'Available commands:\n' +
      lines.join('\n') +
      '\n\n  /plan <task>       Plan mode — analyze then confirm before execute\n' +
      '  /<skill_name>      Run a loaded skill\n\n' +
      'Type / for autocomplete. ? for keyboard shortcuts. ESC to interrupt.'
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
      // Scan for secrets before writing
      const { maskSecrets, formatScanSummary } =
        require('../utils/secretScanner.js') as typeof import('../utils/secretScanner.js')
      const scan = maskSecrets(content)
      const finalContent = scan.masked
      writeFileSync(exportPath, finalContent, 'utf8')
      let msg = 'Exported ' + ctx.history.length + ' messages to: ' + exportPath
      if (scan.found) {
        msg += '\n⚠ ' + formatScanSummary(scan)
      }
      return text(msg)
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
      require('../ui/keybindings.js') as typeof import('../ui/keybindings.js')

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
      require('../core/workflow.js') as typeof import('../core/workflow.js')

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
          const dispatch = (ctx as unknown as { dispatchSlash?: (s: string) => Promise<boolean> }).dispatchSlash
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
  name: 'vim',
  description: 'Toggle vim editing mode for the prompt input',
  handler: () => {
    // This is handled by the Ink REPL via a global flag — the command just toggles it.
    // The actual mode switching happens in PromptInput via a vimState hook.
    return { type: 'text', value: 'Vim mode is a UI-level toggle — use Ctrl+\\ or the status bar to switch modes.' }
  },
})

registerCommand({
  name: 'models',
  aliases: ['providers'],
  description: 'List known LLM providers and models. Usage: /models [provider]',
  handler: (args) => {
    const { MODELS, PROVIDERS, listProviders, detectProviderFromModel, getModelInfo } =
      require('../core/providers.js') as typeof import('../core/providers.js')

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
      return text('Usage: /skill-save <name> [description]\n\nThe skill will be extracted from the current session and saved to .ovolv999/skills/<name>.md')
    }

    const { extractSkill, saveSkill, skillExists } =
      require('../skills/extractor.js') as typeof import('../skills/extractor.js')

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

registerCommand({
  name: 'style',
  aliases: ['output-style'],
  description: 'Set or show output style. Usage: /style [concise|verbose|structured|socratic|code-focused|teaching|default]',
  handler: (args, ctx) => {
    const { loadOutputStyles, setActiveStyle } =
      require('../core/outputStyles.js') as typeof import('../core/outputStyles.js')

    const trimmed = args.trim().toLowerCase()

    if (trimmed) {
      const result = setActiveStyle(ctx.cwd, trimmed)
      if (!result.success) {
        return text(`⚠ ${result.error}`)
      }
      const active = loadOutputStyles(ctx.cwd).active
      return text(`✓ Output style: ${active.name}\n${active.description}`)
    }

    // Show all styles
    const result = loadOutputStyles(ctx.cwd)
    const lines: string[] = ['Output Styles:', '']

    if (result.errors.length > 0) {
      lines.push('⚠ Config errors:')
      for (const e of result.errors) lines.push(`  ${e}`)
      lines.push('')
    }

    for (const s of result.styles) {
      const marker = s.id === result.active.id ? '▶' : ' '
      lines.push(`${marker} ${s.id.padEnd(15)} ${s.name.padEnd(15)} ${s.description}`)
    }

    lines.push('', `Active: ${result.active.name} (${result.active.id})`)
    lines.push('Usage: /style <id> to switch')
    return text(lines.join('\n'))
  },
})

registerCommand({
  name: 'export',
  description: 'Export conversation. Usage: /export [md|json|text|transcript] [filename]',
  handler: (args, ctx) => {
    if (ctx.history.length === 0) {
      return text('No conversation to export.')
    }

    const parts = args.trim().split(/\s+/)
    const formatArg = parts[0]?.toLowerCase()
    const { exportSession, exportSessionToFile, defaultFilename } =
      require('../utils/sessionExport.js') as typeof import('../utils/sessionExport.js')

    const validFormats = ['md', 'markdown', 'json', 'text', 'transcript']
    let format: 'markdown' | 'json' | 'text' | 'transcript'
    let filename: string | undefined

    if (formatArg && validFormats.includes(formatArg)) {
      format = formatArg === 'md' ? 'markdown' : (formatArg as 'markdown' | 'json' | 'text' | 'transcript')
      filename = parts[1]
    } else if (formatArg) {
      // Treat as filename, default to markdown
      filename = parts[0]
      format = 'markdown'
    } else {
      format = 'markdown'
    }

    filename = filename ?? defaultFilename(format)

    try {
      const path = exportSessionToFile(ctx.history, ctx.cwd, filename, { format })
      const result = exportSession(ctx.history, { format })
      return text(
        `✓ Exported ${result.messageCount} messages to: ${path}\n` +
        `Format: ${format} (${result.charCount} chars)`
      )
    } catch (err) {
      return text(`Failed to export: ${(err as Error).message}`)
    }
  },
})

registerCommand({
  name: 'audit',
  description: 'Validate all .ovolv999/ configuration files (keybindings, styles, workflows, skills)',
  handler: (_args, ctx) => {
    const { runDoctorChecks, formatDoctorReport } =
      require('../utils/doctor.js') as typeof import('../utils/doctor.js')
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
    } = require('../core/plugins.js') as typeof import('../core/plugins.js')

    if (subcommand === 'list' || subcommand === '' || !subcommand) {
      const home = require('os').homedir() as string
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
    } = require('../core/suggestions.js') as typeof import('../core/suggestions.js')

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

registerCommand({
  name: 'scan',
  description: 'Scan conversation history for secrets/API keys',
  handler: (_args, ctx) => {
    if (ctx.history.length === 0) {
      return text('No conversation to scan.')
    }
    const { maskSecrets, formatScanSummary } =
      require('../utils/secretScanner.js') as typeof import('../utils/secretScanner.js')
    const allText = ctx.history.map(m => {
      if (typeof m.content === 'string') return m.content
      return JSON.stringify(m.tool_calls ?? '')
    }).join('\n')
    const result = maskSecrets(allText)
    if (!result.found) {
      return text('✓ No secrets detected in conversation history.')
    }
    return text('⚠ ' + formatScanSummary(result))
  },
})

registerCommand({
  name: 'share',
  description: 'Export conversation (masked) and show the path for sharing',
  handler: (args, ctx) => {
    if (ctx.history.length === 0) {
      return text('No conversation to share.')
    }
    const { maskSecrets } =
      require('../utils/secretScanner.js') as typeof import('../utils/secretScanner.js')
    const { exportSessionToFile, defaultFilename } =
      require('../utils/sessionExport.js') as typeof import('../utils/sessionExport.js')

    const format = args.trim() || 'markdown'
    const maskedHistory = ctx.history.map(msg => {
      if (typeof msg.content === 'string') {
        return { ...msg, content: maskSecrets(msg.content).masked }
      }
      return msg
    })

    const filename = defaultFilename(format as 'markdown' | 'json' | 'text')
    const exportPath = ctx.sessionDir
      ? join(ctx.sessionDir, filename)
      : join(ctx.cwd, filename)

    try {
      exportSessionToFile(maskedHistory, ctx.cwd, filename, {
        format: format as 'markdown' | 'json' | 'text',
        includeReasoning: false,
      })
      return text(`✓ Shared (secrets masked): ${exportPath}\nReview the file before sharing externally.`)
    } catch (err) {
      return text('Share failed: ' + (err as Error).message)
    }
  },
})

registerCommand({
  name: 'notify',
  description: 'Test desktop notification. Usage: /notify [title] [body]',
  handler: (args) => {
    const { notify } = require('../utils/notifier.js') as typeof import('../utils/notifier.js')
    const parts = args.trim().split(/\s+/)
    const title = parts[0] ?? 'ovolv999'
    const body = parts.slice(1).join(' ') || 'Notification test'
    const result = notify({ title, body, sound: true })
    if (result.success) {
      return text(`✓ Notification sent via ${result.channel}`)
    }
    return text(`⚠ Notification failed: ${result.error ?? 'unknown error'}`)
  },
})

registerCommand({
  name: 'debug-tool-call',
  aliases: ['dtc'],
  description: 'Inspect recent tool calls and results from conversation. Usage: /debug-tool-call [n]',
  handler: (args, ctx) => {
    const n = parseInt(args.trim(), 10) || 5
    // Extract tool calls and results from history
    const toolCalls: Array<{
      index: number
      name: string
      args: string
      result: string | null
      isError: boolean
      toolCallId: string
    }> = []

    for (let i = 0; i < ctx.history.length; i++) {
      const msg = ctx.history[i]
      if (msg.role === 'assistant' && msg.tool_calls) {
        for (const tc of msg.tool_calls) {
          toolCalls.push({
            index: i,
            name: tc.function.name,
            args: tc.function.arguments,
            result: null,
            isError: false,
            toolCallId: tc.id,
          })
        }
      }
      if (msg.role === 'tool' && msg.tool_call_id) {
        const tc = toolCalls.find(t => t.toolCallId === msg.tool_call_id)
        if (tc) {
          tc.result = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content)
          // Detect errors from content
          if (typeof msg.content === 'string') {
            tc.isError = msg.content.toLowerCase().includes('error') ||
                         msg.content.toLowerCase().includes('failed')
          }
        }
      }
    }

    if (toolCalls.length === 0) {
      return text('No tool calls in conversation history.')
    }

    const recent = toolCalls.slice(-n)
    const lines: string[] = [`Recent ${recent.length} tool call(s) (of ${toolCalls.length} total):`]
    lines.push('')

    for (let i = 0; i < recent.length; i++) {
      const tc = recent[i]
      const status = tc.isError ? '✗ ERROR' : '✓ OK'
      lines.push(`── #${i + 1} [msg ${tc.index}] ${tc.name} ${status} ──`)
      lines.push(`  Args: ${truncate(tc.args, 200)}`)
      if (tc.result) {
        lines.push(`  Result: ${truncate(tc.result, 300)}`)
      } else {
        lines.push('  Result: (none)')
      }
      lines.push('')
    }

    return text(lines.join('\n'))
  },
})

function truncate(s: string, max: number): string {
  if (s.length <= max) return s
  return s.slice(0, max) + `... (${s.length - max} more chars)`
}

registerCommand({
  name: 'schedule',
  aliases: ['cron'],
  description: 'Manage scheduled tasks. Usage: /schedule [list|create <cron> <prompt>|remove <id>|enable <id>|disable <id>]',
  handler: (args, ctx) => {
    const parts = args.trim().split(/\s+/)
    const subcommand = parts[0] ?? 'list'

    const {
      loadSchedules, addTask, removeTask, enableTask, disableTask,
      createTask, formatTaskList, parseCron, parseEveryDuration,
    } = require('../core/cron.js') as typeof import('../core/cron.js')

    if (subcommand === 'list' || !subcommand) {
      const store = loadSchedules(ctx.cwd)
      return text(formatTaskList(store.tasks))
    }

    if (subcommand === 'create' || subcommand === 'add') {
      // Format: /schedule create <cron> "prompt text"
      const remaining = args.trim().slice(parts[0].length).trim()
      // Try to extract cron + prompt
      const cronMatch = remaining.match(/^(@\w+|"[^"]+"|\S+)\s+(.*)$/)
      if (!cronMatch) {
        return text('Usage: /schedule create <cron> <prompt>\nExample: /schedule create "0 9 * * 1-5" "run tests"')
      }
      let cronExpr = cronMatch[1].replace(/^"(.*)"$/, '$1')
      const prompt = cronMatch[2].replace(/^["'](.*)["']$/, '$1')

      // Validate cron
      try {
        if (cronExpr.startsWith('@every')) {
          parseEveryDuration(cronExpr)
        } else {
          parseCron(cronExpr)
        }
      } catch (err) {
        return text(`Invalid cron expression: ${(err as Error).message}`)
      }

      const name = `task_${Date.now().toString(36)}`
      const task = createTask(name, cronExpr, prompt)
      addTask(ctx.cwd, task)
      return text(`✓ Scheduled task created: ${name}\n  Cron: ${cronExpr}\n  Prompt: "${prompt}"\n  Next: ${task.nextRun ?? 'N/A'}`)
    }

    if (subcommand === 'remove' || subcommand === 'delete' || subcommand === 'rm') {
      const id = parts[1]
      if (!id) return text('Usage: /schedule remove <id or name>')
      const success = removeTask(ctx.cwd, id)
      return text(success ? `✓ Removed task: ${id}` : `⚠ Task not found: ${id}`)
    }

    if (subcommand === 'enable') {
      const id = parts[1]
      if (!id) return text('Usage: /schedule enable <id or name>')
      const success = enableTask(ctx.cwd, id)
      return text(success ? `✓ Enabled task: ${id}` : `⚠ Task not found: ${id}`)
    }

    if (subcommand === 'disable') {
      const id = parts[1]
      if (!id) return text('Usage: /schedule disable <id or name>')
      const success = disableTask(ctx.cwd, id)
      return text(success ? `✓ Disabled task: ${id}` : `⚠ Task not found: ${id}`)
    }

    return text(`Unknown subcommand: ${subcommand}\nUsage: /schedule [list|create|remove|enable|disable]`)
  },
})

registerCommand({
  name: 'stats',
  description: 'Show comprehensive session statistics (messages, tokens, tools, files)',
  handler: (_args, ctx) => {
    const { analyzeSession, formatSessionStats } =
      require('../core/sessionStats.js') as typeof import('../core/sessionStats.js')
    const stats = analyzeSession(ctx.history)
    return text(formatSessionStats(stats))
  },
})

registerCommand({
  name: 'diff-browser',
  aliases: ['difftree'],
  description: 'Browse changes as a structured file list. Usage: /diff-browser [n]',
  handler: (args, ctx) => {
    const { getGitDiff, parseGitDiff, formatFileList, formatFileDetail } =
      require('../ui/diffBrowser.js') as typeof import('../ui/diffBrowser.js')

    const n = parseInt(args.trim(), 10)
    const diffOutput = getGitDiff(ctx.cwd)
    const diff = parseGitDiff(diffOutput)

    if (isNaN(n)) {
      return text(formatFileList(diff))
    }
    return text(formatFileDetail(diff, n - 1))
  },
})

registerCommand({
  name: 'knowledge',
  aliases: ['kb'],
  description: 'Project knowledge base. Usage: /knowledge [add <cat> <key> <val> | search <q> | remove <key> | list | stats]',
  handler: (args, ctx) => {
    const parts = args.trim().split(/\s+/)
    const sub = parts[0] ?? 'list'

    const {
      loadKnowledge, addEntry, removeEntry, searchKnowledge,
      formatKnowledgeList, formatSearchResults, formatStats,
      extractKnowledgeFromText,
    } = require('../core/knowledgeBase.js') as typeof import('../core/knowledgeBase.js')

    if (sub === 'list' || !sub) {
      const store = loadKnowledge(ctx.cwd)
      return text(formatKnowledgeList(store.entries))
    }

    if (sub === 'stats') {
      const store = loadKnowledge(ctx.cwd)
      return text(formatStats(store))
    }

    if (sub === 'add') {
      const category = parts[1] as any
      const key = parts[2]
      const value = parts.slice(3).join(' ')
      if (!category || !key || !value) {
        return text('Usage: /knowledge add <category> <key> <value>\nCategories: file, pattern, decision, gotcha, dependency, convention, architecture, general')
      }
      const entry = addEntry(ctx.cwd, category, key, value)
      return text(`✓ ${entry.category} entry saved: ${entry.key}`)
    }

    if (sub === 'search') {
      const query = parts.slice(1).join(' ')
      if (!query) return text('Usage: /knowledge search <query>')
      const results = searchKnowledge(ctx.cwd, query)
      return text(formatSearchResults(results, query))
    }

    if (sub === 'remove' || sub === 'delete') {
      const key = parts[1]
      if (!key) return text('Usage: /knowledge remove <key or id>')
      const success = removeEntry(ctx.cwd, key)
      return text(success ? `✓ Removed: ${key}` : `⚠ Not found: ${key}`)
    }

    if (sub === 'extract') {
      const text_content = ctx.history.map(m =>
        typeof m.content === 'string' ? m.content : '',
      ).join('\n')
      const suggestions = extractKnowledgeFromText(text_content)
      if (suggestions.length === 0) return text('No knowledge patterns found in conversation.')
      const lines = suggestions.map((s, i) =>
        `${i + 1}. [${s.category}] ${s.key}: ${s.value.slice(0, 80)} (${Math.round(s.confidence * 100)}%)`)
      return text(`Found ${suggestions.length} potential knowledge:\n${lines.join('\n')}`)
    }

    return text(`Unknown subcommand: ${sub}\nUsage: /knowledge [list|add|search|remove|stats|extract]`)
  },
})

registerCommand({
  name: 'onboard',
  aliases: ['overview', 'project-info'],
  description: 'Generate a comprehensive project overview (structure, deps, tests, stats)',
  handler: (_args, ctx) => {
    const { analyzeProject, formatOverview } =
      require('../core/onboarding.js') as typeof import('../core/onboarding.js')
    const overview = analyzeProject(ctx.cwd)
    return text(formatOverview(overview))
  },
})

// ── Export for REPL ─────────────────────────────────────────────────────────

export { registerCommand } from './index.js'
export type { Command, SlashCommandContext, SlashCommandResult } from './index.js'
