/**
 * builtin command group 2/7 — split from builtin.ts (Round 29).
 * Registration is side-effectful: importing this file registers its commands.
 */

/*
 * Lazy-require pattern (inherited from builtin.ts): command handlers
 * require rarely-used modules at dispatch time to keep CLI startup lean.
 * The pattern is intentional; these rules would fire on every require.
 */
/* eslint-disable @typescript-eslint/consistent-type-imports */


import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
import { registerCommand } from '../index.js'
import type { SlashCommandResult } from '../index.js'
import { listCommands } from '../index.js'
import { saveProjectSettings } from '../../config/settings.js'
import { calculateContextState } from '../../core/compact.js'
import { existsSync, writeFileSync } from 'fs'
import { join } from 'path'
import { execSync, execFileSync } from 'child_process'
import type { EditedFileInfo } from '../../core/fileHistory.js'
import { getWorkerManager, text } from '../shared.js'

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

// ── /rewind — versioned file restore + conversation checkpoints ────────────
//
// Round 27/28: real restore (the previous version's own audit note
// admitted restore was never wired). Forms:
//   /rewind                      → list edited files + version counts
//   /rewind <file>               → list that file's versions
//   /rewind <file> <n>           → restore file to version n
//   /rewind <file> original      → restore file to its pre-first-edit state
//   /rewind all                  → restore EVERY edited file to original
//   /rewind turn                 → list conversation checkpoints
//   /rewind turn <n>             → restore BOTH conversation + files to
//                                  the end of turn n (CC /rewind parity)
// Version 0 = the file as it was before this session's first edit; higher
// versions are progressively LATER snapshots (restoreVersion rewinds).

// ── /rewind — versioned file restore + conversation checkpoints ────────────
//
// Round 27/28: real restore (the previous version's own audit note
// admitted restore was never wired). Forms:
//   /rewind                      → list edited files + version counts
//   /rewind <file>               → list that file's versions
//   /rewind <file> <n>           → restore file to version n
//   /rewind <file> original      → restore file to its pre-first-edit state
//   /rewind all                  → restore EVERY edited file to original
//   /rewind turn                 → list conversation checkpoints
//   /rewind turn <n>             → restore BOTH conversation + files to
//                                  the end of turn n (CC /rewind parity)
// Version 0 = the file as it was before this session's first edit; higher
// versions are progressively LATER snapshots (restoreVersion rewinds).

registerCommand({
  name: 'rewind',
  description: 'Rewind files/conversation to earlier states. Usage: /rewind [<file>|all|turn] [<n>|original]',
  usage: '/rewind [<file> [<n>|original]] | /rewind all | /rewind turn [<n>]',
  handler: (args, ctx) => {
    const fh = ctx.engine.getFileHistory()

    // ── Conversation checkpoints (Round 28) ──
    if (args.trim() === 'turn' || args.trim().startsWith('turn ')) {
      const turnArg = args.trim().split(/\s+/)[1]
      if (!ctx.sessionDir) {
        return text('Conversation checkpoints need a session directory (not available in this context).')
      }
      const { listCheckpoints, rewindToCheckpoint } =
        require('../../core/conversationCheckpoints.js') as typeof import('../../core/conversationCheckpoints.js')
      const checkpoints = listCheckpoints(ctx.sessionDir)
      if (!turnArg) {
        if (checkpoints.length === 0) {
          return text('No checkpoints recorded yet — one is saved after every completed turn.')
        }
        const lines = ['Conversation checkpoints (end-of-turn anchors):', '']
        for (const cp of checkpoints.slice(-20)) {
          const when = cp.at ? new Date(cp.at).toLocaleTimeString() : '?'
          const nFiles = Object.keys(cp.files).length
          const filesHint = nFiles > 0 ? `, ${nFiles} file(s)` : ''
          lines.push(`  turn ${cp.turn}: ${cp.historyLength} msgs${filesHint} @ ${when} — ${cp.prompt || '(no prompt)'}`)
        }
        lines.push('', 'Restore BOTH conversation and files: /rewind turn <n>')
        return text(lines.join('\n'))
      }
      const n = parseInt(turnArg, 10)
      if (Number.isNaN(n)) {
        return text(`Invalid turn "${turnArg}" — use a number, e.g. /rewind turn 3.`)
      }
      const r = rewindToCheckpoint(ctx.sessionDir, n, ctx.history, fh)
      if (!r.ok) {
        return text(r.message ?? `No checkpoint for turn ${n}.`)
      }
      ctx.setHistory(ctx.history.slice(0, r.historyLength))
      let out = `Rewound to end of turn ${n}: conversation truncated to ${r.historyLength} messages.`
      if (r.restoredFiles.length > 0) out += `\nRestored ${r.restoredFiles.length} file(s) to their turn-${n} state.`
      if (r.deletedFiles.length > 0) out += `\nDeleted ${r.deletedFiles.length} file(s) created after turn ${n}.`
      if (r.failedFiles.length > 0) out += `\nFailed to restore: ${r.failedFiles.join(', ')}`
      if (r.truncatedCheckpoints > 0) out += `\nDropped ${r.truncatedCheckpoints} future checkpoint(s) from the rewound branch.`
      else if (r.message) out += '\n' + r.message
      if (r.skippedPaths.length > 0) out += `\nSkipped (outside workspace boundary): ${r.skippedPaths.join(', ')}`
      if (r.degradedFiles.length > 0) out += `\nDegraded restore (exact snapshot unavailable): ${r.degradedFiles.join(', ')}`
      out += '\nFuture turns append fresh anchors from this point.'
      return text(out)
    }

    if (!fh) {
      return text('File history not available (no session directory configured).')
    }
    const files = fh.getEditedFiles()
    if (files.length === 0) {
      return text('No file edits tracked in this session.')
    }

    const parts = args.trim().split(/\s+/).filter(Boolean)

    if (parts.length === 0) {
      const lines = ['Edited files this session:', '']
      for (const f of files) {
        const versions = fh.getVersions(f.path)
        lines.push(`  ${f.path}  (${versions.length} version${versions.length === 1 ? '' : 's'})`)
      }
      lines.push('', 'Usage: /rewind <file> to list versions, /rewind <file> <n> to restore, /rewind all for everything, /rewind turn for conversation checkpoints.')
      return text(lines.join('\n'))
    }

    if (parts[0] === 'all') {
      let restored = 0
      const failures: string[] = []
      for (const f of files) {
        if (fh.restoreOriginal(f.path)) restored++
        else failures.push(f.path)
      }
      let out = `Restored ${restored}/${files.length} file(s) to pre-session state.`
      if (failures.length > 0) out += `\nFailed: ${failures.join(', ')}`
      out += '\nNote: conversation history is unaffected — only files.'
      return text(out)
    }

    const target = parts[0]
    const file = files.find(f => f.path === target || f.path.endsWith('/' + target))
    if (!file) {
      return text(`No edits tracked for: ${target}\nEdited files:\n${files.map(f => '  ' + f.path).join('\n')}`)
    }

    const versions = fh.getVersions(file.path)
    if (parts.length === 1) {
      const lines = [`Versions of ${file.path}:`, '']
      for (const v of versions) {
        const when = v.timestamp > 0 ? new Date(v.timestamp).toLocaleTimeString() : 'unknown time'
        lines.push(`  ${v.version}: ${when}  (${v.size} bytes)${v.version === 0 ? '  ← pre-session original' : ''}`)
      }
      lines.push('', `Restore: /rewind ${target} <n>  (higher n = more recent snapshot)`)
      return text(lines.join('\n'))
    }

    const versionArg = parts[1]
    if (versionArg === 'original') {
      const ok = fh.restoreOriginal(file.path)
      return text(ok
        ? `Restored ${file.path} to its pre-session original.`
        : `Failed to restore ${file.path} (backup missing or unwritable).`)
    }

    const n = parseInt(versionArg, 10)
    if (Number.isNaN(n) || n < 0 || n >= versions.length) {
      return text(`Invalid version "${versionArg}" — valid range: 0-${versions.length - 1}.`)
    }
    const ok = fh.restoreVersion(file.path, n)
    return text(ok
      ? `Restored ${file.path} to version ${n} (${new Date(versions[n].timestamp).toLocaleTimeString()}).`
      : `Failed to restore ${file.path} to version ${n}.`)
  },
})

// ── /undo — restore the most recently edited file ───────────────────────────

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

    // Single-step undo: restore the most recent backup and record the
    // replaced state on the redo stack (pairs with /redo). Use
    // `/rewind <file> original` to jump straight to the pre-session state.
    const ok = fh.undoEdit(file.path)
    if (ok) {
      const remaining = fh.getVersions(file.path).length
      const redoDepth = fh.getRedoDepth(file.path)
      return text(
        `✓ Undid last edit of ${file.path} (${remaining} version(s) still tracked).\n` +
        `  /redo to step forward again (${redoDepth} redo step(s) available).`,
      )
    }
    return text(`✗ Failed to undo ${file.path}. The backup may be missing.`)
  },
})

// ── /redo — re-apply the most recently undone edit ──────────────────────────

registerCommand({
  name: 'redo',
  description: 'Redo the last undone file edit (step forward after /undo)',
  usage: '/redo [file path]',
  handler: (args, ctx) => {
    const fh = ctx.engine.getFileHistory()
    if (!fh) {
      return text('File history not available (no session directory configured).')
    }

    const target = args.trim()
    if (target) {
      const ok = fh.redoEdit(target)
      return ok
        ? text(`✓ Redid ${target}. /undo steps back again.`)
        : text(`No redo steps available for ${target} (only /undo creates redo steps).`)
    }

    // No argument: pick the file with the deepest redo stack, breaking
    // ties deterministically by path so repeated /redo calls walk one
    // file's timeline before moving to the next.
    const edited = fh.getEditedFiles()
    const candidates = edited
      .map((f) => ({ path: f.path, depth: fh.getRedoDepth(f.path) }))
      .filter((c) => c.depth > 0)
      .sort((a, b) => b.depth - a.depth || a.path.localeCompare(b.path))
    if (candidates.length === 0) {
      return text('Nothing to redo — use /undo first to create redo steps.')
    }
    const best = candidates[0]
    const ok = fh.redoEdit(best.path)
    return ok
      ? text(`✓ Redid ${best.path}. /undo steps back again.`)
      : text(`Failed to redo ${best.path}.`)
  },
})

// ── /title — name this session (persisted, shown in /sessions) ─────────────

registerCommand({
  name: 'title',
  description: 'Set this session\'s title (no args = generate from the conversation)',
  usage: '/title [text]',
  handler: async (args, ctx) => {
    if (!ctx.sessionDir) {
      return text('Titles need a session directory (not available in pipe/scratch mode).')
    }
    const sm = require('../../core/sessionManager.js') as typeof import('../../core/sessionManager.js')
    const { buildTitlePrompt, cleanGeneratedTitle, deriveFallbackTitle } =
      require('../../core/sessionTitle.js') as typeof import('../../core/sessionTitle.js')

    const manual = args.trim()
    if (manual) {
      sm.setSessionTitle(ctx.sessionDir, manual)
      return text(`Session title set: "${manual}"`)
    }

    const fallback = deriveFallbackTitle(ctx.history)
    let generated = ''
    try {
      const client = ctx.engine.getClient()
      const completion = await client.chat.completions.create({
        model: ctx.engine.getModel(),
        messages: [{ role: 'user', content: buildTitlePrompt(ctx.history) }],
        max_tokens: 40,
        temperature: 0,
      })
      generated = cleanGeneratedTitle(completion.choices[0]?.message?.content ?? '')
    } catch {
      /* model path failed — fall back to the heuristic below */
    }

    const title = generated || fallback
    if (!title) {
      return text('Nothing to title yet — send a message first, or set one explicitly: /title <text>')
    }
    sm.setSessionTitle(ctx.sessionDir, title)
    return text(`Session title ${generated ? 'generated' : 'derived'}: "${title}"`)
  },
})

// ── /fork — branch the current session into a new resumable session ─────────

registerCommand({
  name: 'fork',
  description: 'Fork the current session into a new independent session (optionally at a message index)',
  usage: '/fork [at <messageIndex>]',
  handler: (args, ctx) => {
    if (!ctx.sessionDir) {
      return text('Fork needs a session directory (not available in pipe/scratch mode).')
    }
    if (ctx.history.length === 0) {
      return text('Nothing to fork — the current session has no messages.')
    }

    const { forkSession, saveSession } =
      require('../../core/sessionManager.js') as typeof import('../../core/sessionManager.js')

    let atMessage: number | undefined
    const parts = args.trim().split(/\s+/).filter(Boolean)
    if (parts.length > 0) {
      if (parts[0] !== 'at' || parts.length < 2) {
        return text('Usage: /fork [at <messageIndex>]')
      }
      const n = parseInt(parts[1], 10)
      if (Number.isNaN(n) || n < 0) {
        return text(`Invalid message index "${parts[1]}" — use a non-negative number.`)
      }
      atMessage = n
    }

    try {
      // Persist live in-memory history first so the fork reflects the
      // conversation as it stands, not whatever was last flushed to disk.
      saveSession(ctx.sessionDir, ctx.history)
      const result = forkSession(ctx.cwd, ctx.sessionDir, atMessage)
      const name = result.forkDir.split('/').pop() ?? result.forkDir
      const lines = [
        `Forked session into ${name} (${result.messages} message${result.messages === 1 ? '' : 's'}).`,
      ]
      if (result.adjusted) {
        lines.push('The cut point was moved to a safe boundary (tool calls and their results stay together).')
      }
      lines.push('', `Continue the branch later with: /resume ${name}`)
      lines.push('The current session is unaffected.')
      return text(lines.join('\n'))
    } catch (err) {
      return text(`Fork failed: ${(err as Error).message}`)
    }
  },
})

// ── /workers — external Claude Code workers ────────────────────────────────

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

// ── /skills — list available skills ─────────────────────────────────────────

registerCommand({
  name: 'skills',
  description: 'List available skills',
  handler: (_args, ctx) => text(ctx.getSkillsText?.() ?? 'No skills available.'),
})

// ── /help — show available commands ─────────────────────────────────────────

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
      '\n\n  /<skill_name>      Run a loaded skill\n' +
      '  Plan mode          Ctrl+P (default) — read-only analysis, confirm before execute\n\n' +
      'Type / for autocomplete. ? for keyboard shortcuts. ESC stops a running turn (again: force kill).'
    )
  },
})

// ── /export — export conversation transcript ────────────────────────────────

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
        require('../../utils/secretScanner.js') as typeof import('../../utils/secretScanner.js')
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
