/**
 * builtin command group 7/7 — split from builtin.ts (Round 29).
 * Registration is side-effectful: importing this file registers its commands.
 */

/*
 * Lazy-require pattern (inherited from builtin.ts): command handlers
 * require rarely-used modules at dispatch time to keep CLI startup lean.
 * The pattern is intentional; these rules would fire on every require.
 */
/* eslint-disable @typescript-eslint/consistent-type-imports,
   @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment,
   @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-argument */


import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
import { getCommand, registerCommand } from '../index.js'
import { existsSync, readFileSync } from 'fs'
import { join } from 'path'
import { text } from '../shared.js'

// ── /cache ──────────────────────────────────────────────────────────────────

registerCommand({
  name: 'cache',
  description: 'Prompt cache statistics. Usage: /cache [stats | reset | health]',
  handler: (args) => {
    const cs = require('../../utils/cacheStats.js') as typeof import('../../utils/cacheStats.js')
    const parts = args.trim().split(/\s+/)
    const sub = parts[0] ?? 'stats'

    if (sub === 'stats') {
      return text(cs.formatCacheStats(cs.getCacheStats()))
    }

    if (sub === 'reset') {
      cs.resetCacheStats()
      return text('Cache statistics reset.')
    }

    if (sub === 'health') {
      const warning = cs.checkCacheHealth()
      if (!warning) return text('Cache health: OK')
      return text(cs.formatCacheWarning(warning))
    }

    return text(cs.formatCacheStats(cs.getCacheStats()))
  },
})

// ── /health ─────────────────────────────────────────────────────────────────

// ── /health ─────────────────────────────────────────────────────────────────

registerCommand({
  name: 'health',
  description: 'System health checks. Usage: /health',
  handler: () => {
    const sh = require('../../utils/systemHealth.js') as typeof import('../../utils/systemHealth.js')
    const report = sh.runSystemHealthChecks()
    return text(sh.formatSystemHealth(report))
  },
})

// ── /ide ────────────────────────────────────────────────────────────────────

// ── /ide ────────────────────────────────────────────────────────────────────

registerCommand({
  name: 'ide',
  description: 'IDE detection info. Usage: /ide',
  handler: () => {
    const ide = require('../../utils/ide.js') as typeof import('../../utils/ide.js')
    const info = ide.detectIDE()
    if (!info) return text('No IDE detected (running in a plain terminal).')
    const lines = [ide.formatIDEInfo(info), '']
    const recs = ide.getExtensionRecommendations(info.type)
    if (recs.length > 0) {
      lines.push('Recommended extensions:')
      for (const r of recs) {
        lines.push(`  ${r.id}: ${r.name} — ${r.reason}`)
      }
    }
    return text(lines.join('\n'))
  },
})

// ── v0.3.4 (durable supervisor contract §Phase 5): /loop-status ───────────────────

// ── v0.3.4 (durable supervisor contract §Phase 5): /loop-status ───────────────────
registerCommand({
  name: 'loop',
  description: 'Start or manage an autonomous Loop. Usage: /loop <goal> | continue | restart | status | init <goal>',
  usage: '/loop <goal> | /loop continue | /loop restart | /loop status | /loop init <goal>',
  handler: async (args, ctx) => {
    const input = args.trim()
    if (input === 'status') {
      const status = getCommand('loop-status')
      return status ? await status.handler('', ctx) : text('Loop status is unavailable.')
    }
    if (input.startsWith('init ')) {
      const goal = input.slice(5).trim()
      if (!goal) return text('Usage: /loop init <goal>')
      const { initializeLoopWorkspace } = await import('../../core/loopScaffold.js')
      const result = initializeLoopWorkspace(ctx.cwd, goal)
      return text(
        `Loop workspace ready · ${result.created.length} created · ${result.preserved.length} preserved\n` +
        'Review .loop/GOAL.md and .loop/ACCEPTANCE.md, then run /loop continue.',
      )
    }
    if (!ctx.runLoop) return text('Loop execution is unavailable in this interface.')
    if (input === 'continue' || input === '') {
      if (!existsSync(join(ctx.cwd, '.loop', 'GOAL.md'))) {
        return text('Usage: /loop <goal>\nExample: /loop audit and fix the current project')
      }
      await ctx.runLoop({})
      return { type: 'noop' }
    }
    if (input === 'restart') {
      if (!existsSync(join(ctx.cwd, '.loop', 'GOAL.md'))) {
        return text('No Loop goal exists. Start one with /loop <goal>.')
      }
      await ctx.runLoop({ restart: true })
      return { type: 'noop' }
    }
    const { setLoopGoal } = await import('../../core/loopScaffold.js')
    setLoopGoal(ctx.cwd, input)
    await ctx.runLoop({ restart: true })
    return { type: 'noop' }
  },
})

registerCommand({
  name: 'loop-status',
  description: 'Show the current Loop Supervisor status: lease, heartbeat, iteration, checkpoint',
  usage: '/loop-status',
  handler: (_args, ctx) => {
    const loopDir = join(ctx.cwd, '.loop')
    const lines: string[] = ['=== Loop Supervisor Status ===']

    // Lease
    const lockPath = join(loopDir, 'loop.lock')
    if (existsSync(lockPath)) {
      try {
        const lock = JSON.parse(readFileSync(lockPath, 'utf8'))
        lines.push(`Lease: HELD by PID ${lock.pid} on ${lock.hostname ?? 'unknown'}`)
        lines.push(`  owner: ${lock.ownerToken?.slice(0, 8) ?? 'unknown'}...`)
        lines.push(`  created: ${lock.createdAt ?? 'unknown'}`)
        const hbAge = lock.heartbeatAt ? Math.round((Date.now() - new Date(lock.heartbeatAt).getTime()) / 1000) : -1
        lines.push(`  heartbeat: ${hbAge >= 0 ? hbAge + 's ago' : 'unknown'}`)
        if (lock.heartbeat) {
          lines.push(`  iteration: ${lock.heartbeat.iteration ?? '?'}`)
          lines.push(`  phase: ${lock.heartbeat.phase ?? '?'}`)
          lines.push(`  circuit: ${lock.heartbeat.circuitStatus ?? '?'}`)
        }
        // Check if stale
        if (hbAge > 120) {
          lines.push(`  ⚠ STALE (heartbeat > 120s) — safe to take over`)
        }
      } catch {
        lines.push('Lease: CORRUPT')
      }
    } else {
      lines.push('Lease: none (no active loop)')
    }

    // Checkpoint
    const cpPath = join(loopDir, 'checkpoint.json')
    if (existsSync(cpPath)) {
      try {
        const cp = JSON.parse(readFileSync(cpPath, 'utf8'))
        lines.push('', `Checkpoint: iteration ${cp.iteration}, phase ${cp.phase}`)
        lines.push(`  sequence: ${cp.sequence}`)
        lines.push(`  goalHash: ${cp.goalHash ?? 'n/a'}`)
        lines.push(`  acceptanceHash: ${cp.acceptanceHash ?? 'n/a'}`)
        lines.push(`  providerFailures: ${cp.consecutiveProviderFailures ?? 0}`)
        lines.push(`  updated: ${cp.updatedAt ?? 'unknown'}`)
      } catch {
        lines.push('Checkpoint: CORRUPT (try checkpoint.previous.json)')
      }
    } else {
      lines.push('Checkpoint: none')
    }

    // Flags
    const flags = ['DONE.flag', 'CANDIDATE_DONE.flag', 'PARKED.flag', 'DONE.flag.rejected']
    for (const f of flags) {
      if (existsSync(join(loopDir, f))) {
        lines.push(`Flag: ${f} EXISTS`)
      }
    }

    return text(lines.join('\n'))
  },
})

// ── Export for REPL ─────────────────────────────────────────────────────────

export { registerCommand } from '../index.js'
