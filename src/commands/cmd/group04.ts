/**
 * builtin command group 4/7 — split from builtin.ts (Round 29).
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
import { join } from 'path'
import type { BudgetType, BudgetPeriod } from '../../core/budget.js'
import {
  loadSchedules, addTask, removeTask, enableTask, disableTask,
  createTask, formatTaskList, formatTaskDetail, parseCron, parseEveryDuration,
} from '../../core/cron.js'
import type { KnowledgeCategory } from '../../core/knowledgeBase.js'
import { text } from '../shared.js'
import { truncate } from './common.js'

registerCommand({
  name: 'scan',
  description: 'Scan conversation history for secrets/API keys',
  handler: (_args, ctx) => {
    if (ctx.history.length === 0) {
      return text('No conversation to scan.')
    }
    const { maskSecrets, formatScanSummary } =
      require('../../utils/secretScanner.js') as typeof import('../../utils/secretScanner.js')
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
      require('../../utils/secretScanner.js') as typeof import('../../utils/secretScanner.js')
    const { exportSessionToFile, defaultFilename } =
      require('../../utils/sessionExport.js') as typeof import('../../utils/sessionExport.js')

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
    const { notify } = require('../../utils/notifier.js') as typeof import('../../utils/notifier.js')
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

registerCommand({
  name: 'schedule',
  aliases: ['cron'],
  description: 'Manage scheduled tasks. Usage: /schedule [list|show <id>|create <cron> <prompt>|remove <id>|enable <id>|disable <id>]',
  handler: async (args, ctx) => {
    const parts = args.trim().split(/\s+/)
    const subcommand = parts[0] ?? 'list'

    if (subcommand === 'list' || !subcommand) {
      const store = loadSchedules(ctx.cwd)
      return text(formatTaskList(store.tasks))
    }

    if (subcommand === 'show' || subcommand === 'info') {
      const id = parts[1]
      if (!id) return text('Usage: /schedule show <id or name>')
      const task = loadSchedules(ctx.cwd).tasks.find(t => t.id === id || t.name === id)
      if (!task) return text(`⚠ Task not found: ${id}`)
      return text(formatTaskDetail(task))
    }

    if (subcommand === 'create' || subcommand === 'add') {
      // Format: /schedule create <cron> "prompt text"
      const remaining = args.trim().slice(parts[0].length).trim()
      // Try to extract cron + prompt
      const cronMatch = remaining.match(/^(@\w+|"[^"]+"|\S+)\s+(.*)$/)
      if (!cronMatch) {
        return text('Usage: /schedule create <cron> <prompt>\nExample: /schedule create "0 9 * * 1-5" "run tests"')
      }
      const cronExpr = cronMatch[1].replace(/^"(.*)"$/, '$1')
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

      // The name doubles as a removal/enable handle, so it must be unique —
      // two creates in the same millisecond would otherwise collide and a
      // remove-by-name would take out both tasks.
      const name = `task_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 5)}`
      const task = createTask(name, cronExpr, prompt)
      try {
        await addTask(ctx.cwd, task)
      } catch (err) {
        return text(`✗ Schedule store error: ${(err as Error).message}`)
      }
      return text(`✓ Scheduled task created: ${name}\n  Cron: ${cronExpr}\n  Prompt: "${prompt}"\n  Next: ${task.nextRun ?? 'N/A'}`)
    }

    if (subcommand === 'remove' || subcommand === 'delete' || subcommand === 'rm') {
      const id = parts[1]
      if (!id) return text('Usage: /schedule remove <id or name>')
      let success: boolean
      try {
        success = await removeTask(ctx.cwd, id)
      } catch (err) {
        return text(`✗ Schedule store error: ${(err as Error).message}`)
      }
      return text(success ? `✓ Removed task: ${id}` : `⚠ Task not found: ${id}`)
    }

    if (subcommand === 'enable') {
      const id = parts[1]
      if (!id) return text('Usage: /schedule enable <id or name>')
      let success: boolean
      try {
        success = await enableTask(ctx.cwd, id)
      } catch (err) {
        return text(`✗ Schedule store error: ${(err as Error).message}`)
      }
      return text(success ? `✓ Enabled task: ${id}` : `⚠ Task not found: ${id}`)
    }

    if (subcommand === 'disable') {
      const id = parts[1]
      if (!id) return text('Usage: /schedule disable <id or name>')
      let success: boolean
      try {
        success = await disableTask(ctx.cwd, id)
      } catch (err) {
        return text(`✗ Schedule store error: ${(err as Error).message}`)
      }
      return text(success ? `✓ Disabled task: ${id}` : `⚠ Task not found: ${id}`)
    }

    return text(`Unknown subcommand: ${subcommand}\nUsage: /schedule [list|show|create|remove|enable|disable]`)
  },
})

registerCommand({
  name: 'stats',
  description: 'Show comprehensive session statistics (messages, tokens, tools, files)',
  handler: (_args, ctx) => {
    const { analyzeSession, formatSessionStats } =
      require('../../core/sessionStats.js') as typeof import('../../core/sessionStats.js')
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
      require('../../ui/diffBrowser.js') as typeof import('../../ui/diffBrowser.js')

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
  description: 'Project knowledge base. Usage: /knowledge [add <cat> <key> <val> | search <q> | remove <key> | list | stats]',
  handler: (args, ctx) => {
    const parts = args.trim().split(/\s+/)
    const sub = parts[0] ?? 'list'

    const {
      loadKnowledge, addEntry, removeEntry, searchKnowledge,
      formatKnowledgeList, formatSearchResults, formatStats,
      extractKnowledgeFromText,
    } = require('../../core/knowledgeBase.js') as typeof import('../../core/knowledgeBase.js')

    if (sub === 'list' || !sub) {
      const store = loadKnowledge(ctx.cwd)
      return text(formatKnowledgeList(store.entries))
    }

    if (sub === 'stats') {
      const store = loadKnowledge(ctx.cwd)
      return text(formatStats(store))
    }

    if (sub === 'add') {
      const category = parts[1] as KnowledgeCategory
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
      require('../../core/onboarding.js') as typeof import('../../core/onboarding.js')
    const overview = analyzeProject(ctx.cwd)
    return text(formatOverview(overview))
  },
})

registerCommand({
  name: 'cmd-history',
  aliases: ['hist', 'cmdhist'],
  description: 'Search past commands/prompts. Usage: /cmd-history [search <query> | stats | clear]',
  handler: (args, ctx) => {
    const {
      getProjectHistoryPath, loadHistory, searchHistory,
      getHistoryStats, formatHistoryResults, formatHistoryStats, clearHistory,
    } = require('../../core/commandHistory.js') as typeof import('../../core/commandHistory.js')

    const path = getProjectHistoryPath(ctx.cwd)
    const parts = args.trim().split(/\s+/)
    const sub = parts[0] ?? 'recent'

    if (sub === 'stats') {
      const store = loadHistory(path)
      return text(formatHistoryStats(getHistoryStats(store)))
    }

    if (sub === 'clear') {
      const count = clearHistory(path)
      return text(`✓ Cleared ${count} history entries`)
    }

    if (sub === 'search') {
      const query = parts.slice(1).join(' ')
      const store = loadHistory(path)
      const results = searchHistory(store, query)
      return text(formatHistoryResults(results))
    }

    if (sub === 'recent' || !sub) {
      const store = loadHistory(path)
      const results = searchHistory(store, '', { limit: 20 })
      return text(formatHistoryResults(results))
    }

    return text(`Usage: /cmd-history [search <query> | stats | clear]`)
  },
})

registerCommand({
  name: 'bookmark',
  aliases: ['bm', 'mark'],
  description: 'Manage file/line bookmarks. Usage: /bookmark [add|list|search|remove|visit|stats|recent|file <path>]',
  handler: (args, ctx) => {
    const {
      addBookmark, removeBookmark, visitBookmark,
      getBookmarksByFile, searchBookmarks, getRecentBookmarks,
      formatBookmarkList, formatBookmarkDetail, formatBookmarkStats,
      loadBookmarks,
    } = require('../../core/bookmarks.js') as typeof import('../../core/bookmarks.js')

    const parts = args.trim().split(/\s+/)
    const sub = parts[0] ?? 'list'

    // /bookmark add <path:line> <note...>
    if (sub === 'add') {
      const loc = parts[1]
      const note = parts.slice(2).join(' ') || '(no note)'
      if (!loc) return text('Usage: /bookmark add <path:line> [note]')
      const match = loc.match(/^(.+?)(?::(\d+)(?:-(\d+))?)?$/)
      if (!match) return text('Invalid path format. Use file.ts:line')
      const filePath = match[1]
      const line = parseInt(match[2] ?? '1', 10)
      const endLine = match[3] ? parseInt(match[3], 10) : undefined
      const bm = addBookmark(ctx.cwd, filePath, line, note, { endLine })
      return text(`✓ Bookmark added: ${filePath}:${line}\n  "${note}"\n  id: ${bm.id}`)
    }

    // /bookmark remove <id|note>
    if (sub === 'remove' || sub === 'rm') {
      const target = parts.slice(1).join(' ')
      if (!target) return text('Usage: /bookmark remove <id|note>')
      const ok = removeBookmark(ctx.cwd, target)
      return text(ok ? '✓ Bookmark removed' : 'No matching bookmark found')
    }

    // /bookmark visit <id>
    if (sub === 'visit' || sub === 'go') {
      const id = parts[1]
      if (!id) return text('Usage: /bookmark visit <id>')
      const bm = visitBookmark(ctx.cwd, id)
      if (!bm) return text('Bookmark not found')
      return text(formatBookmarkDetail(bm, ctx.cwd))
    }

    // /bookmark search <query>
    if (sub === 'search') {
      const query = parts.slice(1).join(' ')
      const results = searchBookmarks(ctx.cwd, query)
      return text(formatBookmarkList(results, ctx.cwd))
    }

    // /bookmark file <path>
    if (sub === 'file') {
      const filePath = parts[1]
      if (!filePath) return text('Usage: /bookmark file <path>')
      const results = getBookmarksByFile(ctx.cwd, filePath)
      return text(formatBookmarkList(results, ctx.cwd))
    }

    // /bookmark recent
    if (sub === 'recent') {
      const results = getRecentBookmarks(ctx.cwd, 10)
      return text(formatBookmarkList(results, ctx.cwd))
    }

    // /bookmark stats
    if (sub === 'stats') {
      const store = loadBookmarks(ctx.cwd)
      return text(formatBookmarkStats(store))
    }

    // /bookmark list (default)
    if (sub === 'list' || !sub) {
      const store = loadBookmarks(ctx.cwd)
      return text(formatBookmarkList(store.bookmarks, ctx.cwd))
    }

    return text(`Usage: /bookmark [add|list|search|remove|visit|stats|recent|file]`)
  },
})

registerCommand({
  name: 'budget',
  description: 'Manage token/cost budgets. Usage: /budget [set|list|remove|reset|check|preset <name>|record]',
  handler: (args, ctx) => {
    const {
      setBudget, removeBudget, listBudgets, recordUsage,
      checkBudget, checkAllBudgets, resetUsage, getBudgetSnapshot,
      formatBudgetUsage, formatBudgetSummary, formatBudgetSnapshot,
      applyPreset, BUDGET_PRESETS,
    } = require('../../core/budget.js') as typeof import('../../core/budget.js')

    const parts = args.trim().split(/\s+/)
    const sub = parts[0] ?? 'list'

    // /budget set <name> <type> <period> <limit>
    if (sub === 'set') {
      const [name, type, period, limitStr] = parts.slice(1)
      if (!name || !type || !period || !limitStr) {
        return text('Usage: /budget set <name> <tokens|cost|requests> <session|daily|weekly|monthly> <limit>')
      }
      const limit = parseFloat(limitStr)
      if (isNaN(limit)) return text('Invalid limit number')
      const validTypes = ['tokens', 'cost', 'requests']
      const validPeriods = ['session', 'daily', 'weekly', 'monthly']
      if (!validTypes.includes(type)) return text(`Type must be one of: ${validTypes.join(', ')}`)
      if (!validPeriods.includes(period)) return text(`Period must be one of: ${validPeriods.join(', ')}`)
      const bm = setBudget(ctx.cwd, { name, type: type as BudgetType, period: period as BudgetPeriod, limit })
      return text(`✓ Budget set: ${bm.name} (${bm.type}/${bm.period}) limit=${bm.limit}`)
    }

    // /budget remove <name>
    if (sub === 'remove' || sub === 'rm') {
      const name = parts[1]
      if (!name) return text('Usage: /budget remove <name>')
      return text(removeBudget(ctx.cwd, name) ? `✓ Removed budget "${name}"` : 'Budget not found')
    }

    // /budget reset <name>
    if (sub === 'reset') {
      const name = parts[1]
      if (!name) return text('Usage: /budget reset <name>')
      return text(resetUsage(ctx.cwd, name) ? `✓ Reset usage for "${name}"` : 'Budget not found')
    }

    // /budget check [name]
    if (sub === 'check') {
      const name = parts[1]
      if (name) {
        const check = checkBudget(ctx.cwd, name)
        return text(check.reason)
      }
      const { allAllowed, results } = checkAllBudgets(ctx.cwd)
      const lines = results.map(r => `  ${r.config.name}: ${r.result.reason}`)
      lines.push('')
      lines.push(allAllowed ? 'All budgets OK' : '⚠ Some budgets exceeded!')
      return text(lines.join('\n'))
    }

    // /budget record <name> <amount>
    if (sub === 'record') {
      const name = parts[1]
      const amount = parseFloat(parts[2] ?? '')
      if (!name || isNaN(amount)) return text('Usage: /budget record <name> <amount>')
      const usage = recordUsage(ctx.cwd, name, amount)
      if (!usage) return text('Budget not found or disabled')
      const config = listBudgets(ctx.cwd).find(b => b.name === name)!
      return text(formatBudgetUsage(config, usage))
    }

    // /budget preset <name>
    if (sub === 'preset') {
      const presetName = parts[1] as keyof typeof BUDGET_PRESETS
      if (!presetName || !(presetName in BUDGET_PRESETS)) {
        return text(`Available presets: ${Object.keys(BUDGET_PRESETS).join(', ')}`)
      }
      const budgets = applyPreset(ctx.cwd, presetName)
      return text(`✓ Applied "${presetName}" preset:\n` + budgets.map(b => `  ${b.name}: ${b.type}/${b.period} = ${b.limit}`).join('\n'))
    }

    // /budget show <name>
    if (sub === 'show') {
      const name = parts[1]
      if (!name) return text('Usage: /budget show <name>')
      const snap = getBudgetSnapshot(ctx.cwd, name)
      if (!snap) return text('Budget not found')
      return text(formatBudgetSnapshot(snap))
    }

    // /budget list (default)
    if (sub === 'list' || !sub) {
      return text(formatBudgetSummary(ctx.cwd))
    }

    return text(`Usage: /budget [set|list|remove|reset|check|preset|record|show]`)
  },
})

registerCommand({
  name: 'timer',
  aliases: ['timers', 'tm'],
  description: 'Track task time. Usage: /timer [start <name> | stop <id> | pause <id> | resume <id> | list | stats | remove <id>]',
  handler: (args, ctx) => {
    const {
      startTimer, stopTimer, pauseTimer, resumeTimer, removeTimer,
      getAllTimers, getRunningTimers, getTimerStats,
      formatTimer, formatTimerList, formatTimerStats,
    } = require('../../core/taskTimer.js') as typeof import('../../core/taskTimer.js')

    const parts = args.trim().split(/\s+/)
    const sub = parts[0] ?? 'list'

    if (sub === 'start') {
      const name = parts.slice(1).join(' ')
      if (!name) return text('Usage: /timer start <task name>')
      const t = startTimer(ctx.cwd, name)
      return text(`✓ Timer started: "${name}" (id: ${t.id})`)
    }

    if (sub === 'stop' || sub === 'done') {
      const target = parts.slice(1).join(' ')
      if (!target) return text('Usage: /timer stop <id|name>')
      const t = stopTimer(ctx.cwd, target)
      if (!t) return text('No running timer found matching that id/name')
      return text(formatTimer(t))
    }

    if (sub === 'pause') {
      const target = parts.slice(1).join(' ')
      if (!target) return text('Usage: /timer pause <id|name>')
      const t = pauseTimer(ctx.cwd, target)
      if (!t) return text('No running timer found matching that id/name')
      return text(`⏸ Paused: "${t.name}"`)
    }

    if (sub === 'resume') {
      const target = parts.slice(1).join(' ')
      if (!target) return text('Usage: /timer resume <id|name>')
      const t = resumeTimer(ctx.cwd, target)
      if (!t) return text('No paused timer found matching that id/name')
      return text(`▶ Resumed: "${t.name}"`)
    }

    if (sub === 'remove' || sub === 'rm') {
      const target = parts.slice(1).join(' ')
      if (!target) return text('Usage: /timer remove <id|name>')
      return text(removeTimer(ctx.cwd, target) ? '✓ Timer removed' : 'Timer not found')
    }

    if (sub === 'stats') {
      const stats = getTimerStats(ctx.cwd)
      return text(formatTimerStats(stats))
    }

    if (sub === 'running') {
      const timers = getRunningTimers(ctx.cwd)
      return text(formatTimerList(timers))
    }

    if (sub === 'list' || !sub) {
      const timers = getAllTimers(ctx.cwd)
      return text(formatTimerList(timers))
    }

    return text(`Usage: /timer [start|stop|pause|resume|list|running|stats|remove]`)
  },
})
