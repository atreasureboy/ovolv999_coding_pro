/**
 * builtin command group 5/7 — split from builtin.ts (Round 29).
 * Registration is side-effectful: importing this file registers its commands.
 */

/*
 * Lazy-require pattern (inherited from builtin.ts): command handlers
 * require rarely-used modules at dispatch time to keep CLI startup lean.
 * The pattern is intentional; these rules would fire on every require.
 */
/* eslint-disable @typescript-eslint/consistent-type-imports,
   @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment,
   @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-argument,
   @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-return */


import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
import { registerCommand } from '../index.js'
import { saveProjectSettings } from '../../config/settings.js'
import { join } from 'path'
import { existsSync } from 'fs'
import { text } from '../shared.js'
import { loadProfilesRaw } from './common.js'

registerCommand({
  name: 'snapshot',
  aliases: ['snap', 'ws'],
  description: 'Manage workspace snapshots. Usage: /snapshot [save|list|show|remove|add-file|add-todo|diff]',
  handler: (args, ctx) => {
    const {
      createSnapshot, removeSnapshot, getSnapshot, listSnapshots,
      addFileToSnapshot, addTodoToSnapshot, toggleTodoInSnapshot,
      diffSnapshots, formatSnapshot, formatSnapshotList, formatSnapshotDiff,
    } = require('../../core/workspace.js') as typeof import('../../core/workspace.js')

    const parts = args.trim().split(/\s+/)
    const sub = parts[0] ?? 'list'

    if (sub === 'save' || sub === 'create') {
      const name = parts[1]
      if (!name) return text('Usage: /snapshot save <name> [notes...]')
      const notes = parts.slice(2).join(' ') || undefined
      const snap = createSnapshot(ctx.cwd, name, { notes })
      return text(`✓ Snapshot saved: ${snap.name} (id: ${snap.id})`)
    }

    if (sub === 'remove' || sub === 'rm') {
      const target = parts[1]
      if (!target) return text('Usage: /snapshot remove <id|name>')
      return text(removeSnapshot(ctx.cwd, target) ? '✓ Snapshot removed' : 'Snapshot not found')
    }

    if (sub === 'show') {
      const target = parts[1]
      if (!target) return text('Usage: /snapshot show <id|name>')
      const snap = getSnapshot(ctx.cwd, target)
      if (!snap) return text('Snapshot not found')
      return text(formatSnapshot(snap))
    }

    if (sub === 'add-file') {
      const target = parts[1]
      const file = parts[2]
      if (!target || !file) return text('Usage: /snapshot add-file <id|name> <path>')
      const snap = addFileToSnapshot(ctx.cwd, target, file)
      return snap ? text(`✓ Added ${file} to "${snap.name}"`) : text('Snapshot not found')
    }

    if (sub === 'add-todo') {
      const target = parts[1]
      const todo = parts.slice(2).join(' ')
      if (!target || !todo) return text('Usage: /snapshot add-todo <id|name> <text>')
      const snap = addTodoToSnapshot(ctx.cwd, target, todo)
      return snap ? text(`✓ Added todo to "${snap.name}"`) : text('Snapshot not found')
    }

    if (sub === 'toggle-todo') {
      const target = parts[1]
      const idx = parseInt(parts[2] ?? '', 10)
      if (!target || isNaN(idx)) return text('Usage: /snapshot toggle-todo <id|name> <index>')
      const snap = toggleTodoInSnapshot(ctx.cwd, target, idx)
      return snap ? text(`✓ Toggled todo ${idx} in "${snap.name}"`) : text('Snapshot or todo index not found')
    }

    if (sub === 'diff') {
      const [oldName, newName] = parts.slice(1)
      if (!oldName || !newName) return text('Usage: /snapshot diff <old> <new>')
      const old = getSnapshot(ctx.cwd, oldName)
      const cur = getSnapshot(ctx.cwd, newName)
      if (!old || !cur) return text('One or both snapshots not found')
      const diff = diffSnapshots(old, cur)
      return text(formatSnapshotDiff(diff, oldName, newName))
    }

    if (sub === 'list' || !sub) {
      const snaps = listSnapshots(ctx.cwd)
      return text(formatSnapshotList(snaps))
    }

    return text(`Usage: /snapshot [save|list|show|remove|add-file|add-todo|toggle-todo|diff]`)
  },
})

registerCommand({
  name: 'snippet',
  aliases: ['code'],
  description: 'Manage code snippets. Usage: /snippet [add|list|use|search|show|remove|fav|stats]',
  handler: (args, ctx) => {
    const {
      addSnippet, removeSnippet, getSnippet, listSnippets,
      useSnippet, toggleFavorite, searchSnippets,
      getCategories, getSnippetStats,
      formatSnippet, formatSnippetList, formatSnippetStats,
    } = require('../../core/snippets.js') as typeof import('../../core/snippets.js')

    const parts = args.trim().split(/\s+/)
    const sub = parts[0] ?? 'list'

    if (sub === 'add') {
      const name = parts[1]
      const language = parts[2] ?? 'text'
      const body = parts.slice(3).join(' ')
      if (!name || !body) {
        return text('Usage: /snippet add <name> <language> <body...>\nVariables: {{varName}}')
      }
      const s = addSnippet(ctx.cwd, { name, language, body })
      return text(`✓ Snippet saved: ${s.name} (${s.language})`)
    }

    if (sub === 'use') {
      const name = parts[1]
      if (!name) return text('Usage: /snippet use <name> [key=value ...]')
      // Parse variables: key=value
      const vars: Record<string, string> = {}
      for (const part of parts.slice(2)) {
        const [k, ...v] = part.split('=')
        if (k && v.length) vars[k] = v.join('=')
      }
      const body = useSnippet(ctx.cwd, name, vars)
      if (!body) return text('Snippet not found')
      return text(body)
    }

    if (sub === 'remove' || sub === 'rm') {
      const target = parts[1]
      if (!target) return text('Usage: /snippet remove <name>')
      return text(removeSnippet(ctx.cwd, target) ? '✓ Removed' : 'Not found')
    }

    if (sub === 'show') {
      const target = parts[1]
      if (!target) return text('Usage: /snippet show <name>')
      const s = getSnippet(ctx.cwd, target)
      if (!s) return text('Snippet not found')
      return text(formatSnippet(s))
    }

    if (sub === 'search') {
      const query = parts.slice(1).join(' ')
      const results = searchSnippets(ctx.cwd, query)
      return text(formatSnippetList(results))
    }

    if (sub === 'fav' || sub === 'favorite') {
      const target = parts[1]
      if (!target) return text('Usage: /snippet fav <name>')
      const s = toggleFavorite(ctx.cwd, target)
      return s ? text(`✓ ${s.name}: ${s.favorite ? '★ favorited' : 'unfavorited'}`) : text('Not found')
    }

    if (sub === 'stats') {
      return text(formatSnippetStats(getSnippetStats(ctx.cwd)))
    }

    if (sub === 'categories') {
      const cats = getCategories(ctx.cwd)
      return text(cats.length > 0 ? `Categories: ${cats.join(', ')}` : 'No categories.')
    }

    if (sub === 'list' || !sub) {
      const filter: { favoriteOnly?: boolean } = {}
      if (parts[1] === '--fav' || parts[1] === '-f') filter.favoriteOnly = true
      return text(formatSnippetList(listSnippets(ctx.cwd, filter)))
    }

    return text(`Usage: /snippet [add|list|use|search|show|remove|fav|stats|categories]`)
  },
})

registerCommand({
  name: 'profile',
  aliases: ['profiles', 'prof'],
  description: 'Manage config profiles. Usage: /profile [create|list|switch|show|remove|clone|export|import|config]',
  handler: (args, ctx) => {
    const {
      createProfile, removeProfile, getProfile, getActiveProfile,
      setActiveProfile, listProfiles, cloneProfile,
      exportProfile, importProfile, getEffectiveConfig,
      initializeBuiltinProfiles,
      formatProfile, formatProfileList, formatEffectiveConfig,
    } = require('../../core/profiles.js') as typeof import('../../core/profiles.js')

    const parts = args.trim().split(/\s+/)
    const sub = parts[0] ?? 'list'

    if (sub === 'create' || sub === 'add') {
      const name = parts[1]
      if (!name) return text('Usage: /profile create <name>')
      const p = createProfile(ctx.cwd, name, {
        description: parts.slice(2).join(' ') || undefined,
      })
      return text(`✓ Profile created: ${p.name}`)
    }

    if (sub === 'switch' || sub === 'use') {
      const name = parts[1]
      if (!name) return text('Usage: /profile switch <name>')
      if (!setActiveProfile(ctx.cwd, name)) return text('Profile not found')
      return text(`✓ Switched to profile: ${name}`)
    }

    if (sub === 'remove' || sub === 'rm') {
      const name = parts[1]
      if (!name) return text('Usage: /profile remove <name>')
      return text(removeProfile(ctx.cwd, name) ? `✓ Removed profile "${name}"` : 'Profile not found')
    }

    if (sub === 'show') {
      const name = parts[1]
      const profile = name ? getProfile(ctx.cwd, name) : getActiveProfile(ctx.cwd)
      if (!profile) return text('Profile not found')
      return text(formatProfile(profile))
    }

    if (sub === 'clone') {
      const src = parts[1]
      const dst = parts[2]
      if (!src || !dst) return text('Usage: /profile clone <source> <new-name>')
      const cloned = cloneProfile(ctx.cwd, src, dst)
      return cloned ? text(`✓ Cloned "${src}" → "${dst}"`) : text('Source profile not found')
    }

    if (sub === 'export') {
      const name = parts[1]
      if (!name) return text('Usage: /profile export <name>')
      const json = exportProfile(ctx.cwd, name)
      return json ? text(json) : text('Profile not found')
    }

    if (sub === 'import') {
      const json = parts.slice(1).join(' ')
      if (!json) return text('Usage: /profile import <json>')
      const p = importProfile(ctx.cwd, json)
      return p ? text(`✓ Imported profile: ${p.name}`) : text('Invalid JSON')
    }

    if (sub === 'config') {
      const config = getEffectiveConfig(ctx.cwd)
      return text(formatEffectiveConfig(config))
    }

    if (sub === 'init') {
      const profiles = initializeBuiltinProfiles(ctx.cwd)
      return text(`✓ Initialized ${profiles.length} builtin profiles`)
    }

    if (sub === 'list' || !sub) {
      const store = loadProfilesRaw(ctx.cwd)
      return text(formatProfileList(listProfiles(ctx.cwd), store.activeProfile))
    }

    return text(`Usage: /profile [create|list|switch|show|remove|clone|export|import|config|init]`)
  },
})

registerCommand({
  name: 'metrics',
  aliases: ['complexity'],
  description: 'Analyze code metrics and health. Usage: /metrics [file <path> | project <paths...> | health <path>]',
  handler: (args, ctx) => {
    const {
      analyzeFile, analyzeProjectFiles,
      formatFileMetrics, formatProjectMetrics,
      assessHealth, formatHealthAssessment,
    } = require('../../core/codeMetrics.js') as typeof import('../../core/codeMetrics.js')

    const parts = args.trim().split(/\s+/)
    const sub = parts[0] ?? 'help'

    if (sub === 'file') {
      const filePath = parts[1]
      if (!filePath) return text('Usage: /metrics file <path>')
      const resolved = require('path').resolve(ctx.cwd, filePath)
      const m = analyzeFile(resolved)
      if (!m) return text('File not found')
      return text(formatFileMetrics(m))
    }

    if (sub === 'health') {
      const filePath = parts[1]
      if (!filePath) return text('Usage: /metrics health <path>')
      const resolved = require('path').resolve(ctx.cwd, filePath)
      const m = analyzeFile(resolved)
      if (!m) return text('File not found')
      return text(formatHealthAssessment(assessHealth(m)))
    }

    if (sub === 'project') {
      const paths = parts.slice(1).map((p: string) => require('path').resolve(ctx.cwd, p))
      if (paths.length === 0) return text('Usage: /metrics project <file1> [file2...]')
      const metrics = analyzeProjectFiles(paths)
      return text(formatProjectMetrics(metrics))
    }

    return text(`Usage: /metrics [file <path> | health <path> | project <paths...>]`)
  },
})

// ── /hooks ──────────────────────────────────────────────────────────────────
// Round 26 consolidation: /hooks now operates on the ONE unified hook
// system — the Claude-Code-compatible schema in .ovogo/settings.json
// (loaded/parsed by core/hooks/hooksConfig.ts). The legacy parallel
// system (~/.ovolv999/hooks.json + core/hooks.ts) was deleted.

// ── /hooks ──────────────────────────────────────────────────────────────────
// Round 26 consolidation: /hooks now operates on the ONE unified hook
// system — the Claude-Code-compatible schema in .ovogo/settings.json
// (loaded/parsed by core/hooks/hooksConfig.ts). The legacy parallel
// system (~/.ovolv999/hooks.json + core/hooks.ts) was deleted.

registerCommand({
  name: 'hooks',
  description: 'Manage lifecycle hooks (.ovogo/settings.json, CC-compatible). Usage: /hooks [list | add <event> <matcher> <command> | remove <event> <index> | clear <event> | test <event> <tool>]',
  handler: (args, ctx) => {
    const { loadHookConfig } = require('../../core/hooks/hooksConfig.js') as typeof import('../../core/hooks/hooksConfig.js')
    const { executeHookCommand } = require('../../core/hooks/hookExecutor.js') as typeof import('../../core/hooks/hookExecutor.js')
    const { loadProjectSettings, saveProjectSettings } = require('../../config/settings.js') as typeof import('../../config/settings.js')
    const { HOOK_EVENTS: PROTOCOL_EVENTS } = require('../../core/hooks/hookProtocol.js') as typeof import('../../core/hooks/hookProtocol.js')

    const formatConfig = (projHooks: Record<string, Array<{ matcher?: string; hooks: Array<{ command: string; timeout?: number }> }>>): string => {
      const lines: string[] = []
      const projectEvents = Object.keys(projHooks)
      if (projectEvents.length === 0 && Object.keys(merged).length === 0) {
        return 'No hooks configured. Add one: /hooks add PreToolUse Bash "echo $OVOGO_TOOL_NAME"'
      }
      // Project hooks are NUMBERED and mutable (/hooks remove|clear edit
      // the project file). User-level hooks are listed read-only — the
      // previous single merged numbering made `remove 0` delete the wrong
      // entry whenever user-level hooks shifted the indices.
      if (projectEvents.length > 0) {
        lines.push('── project (.ovogo/settings.json — editable here) ──')
        for (const ev of projectEvents) {
          projHooks[ev].forEach((m, mi) => {
            for (const h of m.hooks ?? []) {
              lines.push(`  [${ev}] ${mi}. ${m.matcher ?? '*'} → ${h.command}${h.timeout ? ` (timeout ${h.timeout}s)` : ''}`)
            }
          })
        }
      }
      const userOnly = Object.entries(merged).filter(([ev, list]) => (projHooks[ev]?.length ?? 0) !== (list?.length ?? 0))
      if (userOnly.length > 0) {
        lines.push('── user (~/.ovogo/settings.json — edit the file directly) ──')
        for (const [ev, list] of userOnly) {
          for (const m of list ?? []) {
            for (const h of m.hooks ?? []) {
              lines.push(`  [${ev}] ${m.matcher ?? '*'} → ${h.command} (read-only)`)
            }
          }
        }
      }
      lines.push('', `Events: ${PROTOCOL_EVENTS.join(', ')}`, 'Indices apply to PROJECT entries only; changes take effect after restart.')
      return lines.join('\n')
    }

    const parts = args.trim().split(/\s+/)
    const sub = parts[0] ?? 'list'
    const merged = (loadHookConfig(ctx.cwd) ?? {}) as Record<string, Array<{ matcher?: string; hooks: Array<{ command: string; timeout?: number }> }>>
    const projectHooks = () =>
      (loadProjectSettings(ctx.cwd).hooks ?? {}) as Record<string, Array<{ matcher?: string; hooks: Array<{ command: string; timeout?: number }> }>>

    if (sub === 'list' || sub === 'show') {
      return text(formatConfig(projectHooks()))
    }

    // All mutations target the PROJECT settings file (single, predictable)
    if (sub === 'add') {
      const event = parts[1]
      const matcher = parts[2] ?? '*'
      const command = parts.slice(3).join(' ')
      if (!event || !command) return text('Usage: /hooks add <event> <matcher> <command>')
      if (!(PROTOCOL_EVENTS as readonly string[]).includes(event)) return text(`Unknown event "${event}". Events: ${PROTOCOL_EVENTS.join(', ')}`)
      const proj = loadProjectSettings(ctx.cwd)
      const hooks = { ...(proj.hooks ?? {}) } as Record<string, Array<{ matcher?: string; hooks: Array<{ type: 'command'; command: string; timeout?: number }> }>>
      if (!hooks[event]) hooks[event] = []
      hooks[event].push({ matcher: matcher === '*' ? undefined : matcher, hooks: [{ type: 'command', command }] })
      saveProjectSettings(ctx.cwd, { hooks: hooks })
      return text(`Added hook: [${event}] ${matcher} → ${command}`)
    }

    if (sub === 'remove') {
      const event = parts[1]
      const idx = parseInt(parts[2] ?? '', 10)
      if (!event || isNaN(idx)) return text('Usage: /hooks remove <event> <index>')
      const proj = loadProjectSettings(ctx.cwd)
      const hooks = { ...(proj.hooks ?? {}) } as Record<string, Array<{ matcher?: string; hooks: Array<{ command: string }> }>>
      if (!hooks[event]) return text(`No hooks for ${event} in project settings. /hooks list shows the merged (project+user) view.`)
      if (idx < 0 || idx >= hooks[event].length) return text(`Index out of range (0-${hooks[event].length - 1})`)
      const removed = hooks[event].splice(idx, 1)[0]
      saveProjectSettings(ctx.cwd, { hooks: hooks })
      return text(`Removed hook: [${event}] ${removed.matcher ?? '*'} → ${removed.hooks?.[0]?.command ?? ''}`)
    }

    if (sub === 'clear') {
      const event = parts[1]
      if (!event) return text('Usage: /hooks clear <event>')
      const proj = loadProjectSettings(ctx.cwd)
      const hooks = { ...(proj.hooks ?? {}) } as Record<string, Array<{ matcher?: string; hooks: Array<unknown> }>>
      if (!hooks[event]) return text(`No hooks for ${event} in project settings.`)
      delete hooks[event]
      saveProjectSettings(ctx.cwd, { hooks: hooks })
      return text(`Cleared hooks for ${event}`)
    }

    if (sub === 'test') {
      const event = (parts[1] ?? 'PreToolUse')
      const toolName = parts[2] ?? 'Bash'
      const matchers = merged[event] ?? []
      if (matchers.length === 0) return text(`No hooks configured for ${event}`)
      const cmds = matchers.flatMap(m => m.hooks ?? [])
      if (cmds.length === 0) return text(`No commands under ${event}`)
      const input = {
        session_id: 'hooks-test', cwd: ctx.cwd, hook_event_name: event,
        tool_name: toolName, tool_input: {},
      } as never
      const lines: string[] = []
      for (let i = 0; i < cmds.length; i++) {
        void executeHookCommand(
          { type: 'command', command: cmds[i].command, timeout: cmds[i].timeout },
          input,
          { cwd: ctx.cwd, timeoutMs: 10_000 },
        ).catch(() => { /* best-effort test run */ })
        lines.push(`[${i}] ${cmds[i].command} → (running — check hook side effects)`)
      }
      return text(lines.join('\n'))
    }

    return text(formatConfig(projectHooks()))
  },
})

// ── /diagnostics ────────────────────────────────────────────────────────────

// ── /diagnostics ────────────────────────────────────────────────────────────

registerCommand({
  name: 'diagnostics',
  aliases: ['diag', 'lint', 'typecheck'],
  description: 'Run code diagnostics (tsc/ESLint/Biome/Ruff). Usage: /diagnostics [checker] [file <path>] [--clear]',
  handler: (args, ctx) => {
    const {
      runDiagnostics, filterDiagnostics, formatDiagnosticsResult, clearCache,
    } = require('../../core/diagnostics.js') as typeof import('../../core/diagnostics.js')

    const parts = args.trim().split(/\s+/)
    const clearFlag = parts.includes('--clear') || parts.includes('--fresh')
    if (clearFlag) clearCache()

    const validCheckers = ['auto', 'tsc', 'eslint', 'biome', 'ruff']
    const checker = parts.find(p => validCheckers.includes(p)) ?? 'auto'
    const fileIdx = parts.indexOf('file')
    const filePath = fileIdx >= 0 ? parts[fileIdx + 1] : undefined

    try {
      const result = runDiagnostics(ctx.cwd, checker as 'auto' | 'tsc' | 'eslint' | 'biome' | 'ruff')

      if (filePath) {
        const filtered = filterDiagnostics(result, { filePath })
        if (filtered.length === 0) return text(`✓ No diagnostics for "${filePath}"`)
        const lines = filtered.map(d => `${d.filePath}:${d.line}:${d.column} [${d.severity}] ${d.message}`)
        return text(lines.join('\n'))
      }

      return text(formatDiagnosticsResult(result))
    } catch (err) {
      return text(`Failed: ${err instanceof Error ? err.message : String(err)}`)
    }
  },
})

// ── /goal ───────────────────────────────────────────────────────────────────

// ── /goal ───────────────────────────────────────────────────────────────────

registerCommand({
  name: 'goal',
  aliases: ['goals'],
  description: 'Manage autonomous goals. Usage: /goal [list | create <objective> | show <id> | complete <id> | fail <id> <reason>]',
  handler: (args, _ctx) => {
    const {
      createGoal, getGoal, listGoals, startGoal, completeGoal, failGoal, pauseGoal, resumeGoal,
      addSubtask, updateSubtask, getProgress, formatGoal, formatGoalList, deleteGoal,
    } = require('../../core/goals.js') as typeof import('../../core/goals.js')

    const parts = args.trim().split(/\s+/)
    const sub = parts[0] ?? 'list'

    if (sub === 'list' || sub === 'ls') {
      return text(formatGoalList(listGoals()))
    }

    if (sub === 'create') {
      const objective = parts.slice(1).join(' ')
      if (!objective) return text('Usage: /goal create <objective>')
      const goal = createGoal(objective)
      return text(formatGoal(goal))
    }

    if (sub === 'show' || sub === 'get') {
      const id = parts[1]
      if (!id) return text('Usage: /goal show <id>')
      const goal = getGoal(id)
      if (!goal) return text('Goal not found')
      return text(formatGoal(goal))
    }

    if (sub === 'start') {
      const id = parts[1]
      const goal = startGoal(id)
      return text(goal ? formatGoal(goal) : 'Goal not found')
    }

    if (sub === 'complete') {
      const id = parts[1]
      const goal = completeGoal(id)
      return text(goal ? `Completed: ${goal.objective}` : 'Goal not found')
    }

    if (sub === 'fail') {
      const id = parts[1]
      const reason = parts.slice(2).join(' ')
      const goal = failGoal(id, reason)
      return text(goal ? `Failed: ${goal.objective}` : 'Goal not found')
    }

    if (sub === 'pause') {
      const id = parts[1]
      const goal = pauseGoal(id)
      return text(goal ? `Paused: ${goal.objective}` : 'Goal not found')
    }

    if (sub === 'resume') {
      const id = parts[1]
      const goal = resumeGoal(id)
      return text(goal ? `Resumed: ${goal.objective}` : 'Goal not found')
    }

    if (sub === 'add-subtask') {
      const id = parts[1]
      const desc = parts.slice(2).join(' ')
      const st = addSubtask(id, desc)
      return text(st ? `Added: ${st.description}` : 'Goal not found')
    }

    if (sub === 'done') {
      const goalId = parts[1]
      const subtaskId = parts[2]
      const st = updateSubtask(goalId, subtaskId, { status: 'done' })
      return text(st ? `Done: ${st.description}` : 'Not found')
    }

    if (sub === 'delete') {
      const id = parts[1]
      return text(deleteGoal(id) ? `Deleted: ${id}` : 'Goal not found')
    }

    if (sub === 'progress') {
      const id = parts[1]
      const p = getProgress(id)
      if (!p) return text('Goal not found')
      return text(`Progress: ${p.done}/${p.total} (${p.percentage}%) - ${p.pending} pending, ${p.inProgress} in progress, ${p.failed} failed`)
    }

    return text(`Usage: /goal [list | create <objective> | show <id> | start <id> | complete <id> | fail <id> <reason> | pause <id> | resume <id> | add-subtask <id> <desc> | done <goalId> <subId> | progress <id> | delete <id>]`)
  },
})

// ── /transcript ─────────────────────────────────────────────────────────────

// ── /transcript ─────────────────────────────────────────────────────────────

registerCommand({
  name: 'transcript',
  aliases: ['export-session'],
  description: 'Export session transcript. Usage: /transcript [markdown|json|text] [stats]',
  handler: (args, ctx) => {
    const transcriptModule = require('../../core/sessionTranscript.js') as typeof import('../../core/sessionTranscript.js')
    const { buildTranscript, exportTranscript, getTranscriptStats, formatStats } = transcriptModule

    const parts = args.trim().split(/\s+/)
    const formatArg = parts[0] ?? 'markdown'
    const format = (['markdown', 'json', 'text'].includes(formatArg) ? formatArg : 'markdown') as 'markdown' | 'json' | 'text'

    if (parts.includes('stats')) {
      // Build a minimal transcript from context
      const sessionId = ctx.sessionDir ?? 'current'
      const transcript = buildTranscript({
        sessionId,
        startTime: new Date().toISOString(),
      }, [])
      return text(formatStats(getTranscriptStats(transcript)))
    }

    // Build transcript from session messages if available
    const messages = (ctx as { messages?: Array<{ role: string; content: string }> }).messages ?? []
    const transcript = buildTranscript({
      sessionId: ctx.sessionDir ?? `session-${Date.now()}`,
      startTime: new Date().toISOString(),
      cwd: ctx.cwd,
    }, messages.map(m => ({
      role: m.role as 'user' | 'assistant',
      content: m.content,
      timestamp: new Date().toISOString(),
    })))

    const path = exportTranscript(transcript, format)
    return text(`Transcript exported to: ${path}\n\nStats:\n${formatStats(getTranscriptStats(transcript))}`)
  },
})

// ── /gc — session disk usage report + opt-in prune ─────────────────────────

registerCommand({
  name: 'gc',
  description: 'Report session disk usage; optionally prune sessions older than N days',
  usage: '/gc | /gc prune --days <N> [--yes]',
  handler: (args, ctx) => {
    const { readdirSync, statSync, rmSync } = require('fs') as typeof import('fs')
    const sessionsRoot = join(ctx.cwd, 'sessions')
    const dirSize = (dir: string): number => {
      let total = 0
      try {
        for (const e of readdirSync(dir)) {
          const p = join(dir, e)
          let st
          try { st = statSync(p) } catch { continue }
          if (st.isDirectory()) total += dirSize(p)
          else total += st.size
        }
      } catch { /* unreadable */ }
      return total
    }
    const fmt = (n: number): string =>
      n >= 1_048_576 ? `${(n / 1_048_576).toFixed(1)} MB` : n >= 1024 ? `${(n / 1024).toFixed(0)} KB` : `${n} B`

    if (!existsSync(sessionsRoot)) return text('No sessions directory.')

    type Row = { name: string; size: number; mtime: number }
    const rows: Row[] = []
    for (const name of readdirSync(sessionsRoot)) {
      const dir = join(sessionsRoot, name)
      try {
        if (!statSync(dir).isDirectory()) continue
        rows.push({ name, size: dirSize(dir), mtime: statSync(join(dir, 'history.json')).mtime.getTime() })
      } catch { /* history missing — use dir mtime */ 
        try { rows.push({ name, size: dirSize(dir), mtime: statSync(dir).mtime.getTime() }) } catch { /* skip */ }
      }
    }
    if (rows.length === 0) return text('No sessions found.')

    const total = rows.reduce((n, r) => n + r.size, 0)
    const parts = args.trim().split(/\s+/)
    const pruneIdx = parts.indexOf('prune')

    if (pruneIdx === -1) {
      const lines = [
        `Sessions: ${rows.length} · total ${fmt(total)}`,
        `  current: ${ctx.sessionDir?.split('/').pop() ?? '—'} (never pruned)`,
        '',
        'Oldest 5:',
        ...rows.slice().sort((a, b) => a.mtime - b.mtime).slice(0, 5)
          .map((r) => `  ${new Date(r.mtime).toISOString().slice(0, 10)}  ${fmt(r.size).padStart(9)}  ${r.name}`),
        '',
        'Prune sessions older than N days: /gc prune --days 30 [--yes]',
      ]
      return text(lines.join('\n'))
    }

    const daysIdx = parts.indexOf('--days')
    const days = daysIdx >= 0 ? parseInt(parts[daysIdx + 1] ?? '', 10) : NaN
    if (!Number.isFinite(days) || days <= 0) {
      return text('Usage: /gc prune --days <N> [--yes]')
    }
    const yes = parts.includes('--yes')
    const cutoff = Date.now() - days * 86_400_000
    const stale = rows.filter((r) => r.mtime < cutoff && join(sessionsRoot, r.name) !== ctx.sessionDir)
    if (stale.length === 0) return text(`Nothing older than ${days} day(s) to prune.`)
    if (!yes) {
      return text(
        `Would delete ${stale.length} session(s), freeing ${fmt(stale.reduce((n, r) => n + r.size, 0))}:\n` +
        stale.slice(0, 10).map((r) => `  ${r.name}`).join('\n') +
        (stale.length > 10 ? `\n  … +${stale.length - 10} more` : '') +
        `\n\nRun with --yes to actually delete.`,
      )
    }
    let deleted = 0
    let freed = 0
    for (const r of stale) {
      try {
        rmSync(join(sessionsRoot, r.name), { recursive: true, force: true })
        deleted++
        freed += r.size
      } catch { /* best-effort per dir */ }
    }
    return text(`Pruned ${deleted} session(s), freed ${fmt(freed)}.`)
  },
})

// ── /effort ─────────────────────────────────────────────────────────────────
