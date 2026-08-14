/**
 * builtin command group 1/7 — split from builtin.ts (Round 29).
 * Registration is side-effectful: importing this file registers its commands.
 */

/*
 * Lazy-require pattern (inherited from builtin.ts): command handlers
 * require rarely-used modules at dispatch time to keep CLI startup lean.
 * The pattern is intentional; these rules would fire on every require.
 */
 


import { registerCommand } from '../index.js'
import { listConfiguredModelTierProfiles, resolveModelTier, type ConfiguredModelTierProfile } from '../../core/model/modelTier.js'
import { getCurrentMode, setCurrentMode, cycleMode, getAllModes, type Mode } from '../../core/modes.js'
import type { PermissionMode } from '../../core/permissionSystem.js'
import { isValidPermissionMode } from '../../core/permissionSystem.js'
import { estimateTokens, calculateContextState, microCompact } from '../../core/compact.js'
import { EXECUTION_PROFILES, isExecutionProfile } from '../../core/effort.js'
import { join } from 'path'
import { homedir } from 'os'
import { exit, persistPermissionState, text } from '../shared.js'
import { previewMessage, roleLabel } from './common.js'

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

// ── Phase 2: adaptive model routing ──────────────────────────────

// ── Phase 2: adaptive model routing ──────────────────────────────
registerCommand({
  name: 'route',
  description: 'Show the last model routing decision and its reasons. /route auto clears the manual override.',
  usage: '/route [auto]',
  handler: (args, ctx) => {
    const trimmed = args.trim().toLowerCase()
    if (trimmed === 'auto' || trimmed === 'clear') {
      ctx.engine.clearModelOverride()
      return text('Manual override cleared — auto-routing resumed.')
    }
    const router = ctx.engine.getModelRouter()
    const d = router.getLastDecision()
    const override = router.getManualOverride()
    const lines: string[] = []
    if (override) lines.push(`Manual override (highest priority): ${override}`)
    lines.push(`Routing enabled: ${router.isRoutingEnabled()}`)
    if (!d) {
      lines.push('', 'No routing decision yet — run a turn first.')
    } else {
      lines.push(
        '',
        `Selected: ${d.selectedModel}  (profile: ${d.selectedProfile})`,
        `Confidence: ${d.confidence}   Complexity: ${d.estimatedComplexity}`,
        `Reasons: ${d.reasonCodes.join(', ') || '(none)'}`,
        `Fallback chain: ${d.fallbackChain.length ? d.fallbackChain.join(' → ') : '(none)'}`,
      )
    }
    return text(lines.join('\n'))
  },
})

// ── Phase 8: /progress — runtime progress + stall + budget ─────────

// ── Phase 8: /progress — runtime progress + stall + budget ─────────
registerCommand({
  name: 'progress',
  description: 'Show progress: meaningful changes, time-since-progress, acceptances, TaskGraph, stall risk, budget',
  usage: '/progress',
  handler: (_args, ctx) => {
    const ws = ctx.engine.getContextManager().getWorkingState()
    const tg = ctx.engine.getTaskGraph()
    const pm = ctx.engine.getProgressMonitor()
    const cost = ctx.engine.getCostTracker()
    const lines: string[] = ['=== Progress ===']
    if (ws) {
      const changed = (ws.filesChanged ?? []).length
      const read = (ws.filesRead ?? []).length
      const verPassed = (ws.verification?.passed ?? []).length
      const verFailed = (ws.verification?.failed ?? []).length
      lines.push(
        `Files: ${changed} changed, ${read} read`,
        `Verification: ${verPassed} passed, ${verFailed} failed`,
        `Unresolved: ${(ws.unresolved ?? []).length}`,
      )
    }
    if (tg) {
      const snap = tg.snapshot()
      const s = snap.summary
      lines.push(
        '',
        `TaskGraph: ${s.completed}/${s.total} completed · ${s.failed} failed · ${s.blocked} blocked · ${s.running} running · ${s.ready} ready`,
      )
    }
    if (pm) {
      const snap = pm.snapshot(0)
      lines.push(
        '',
        `Iterations: ${snap.iteration}`,
        `Minutes since last progress: ${snap.minutesSinceLastMeaningfulProgress.toFixed(1)}`,
        `Repeated errors (consecutive): ${snap.repeatedErrors}`,
        `Remaining acceptances: ${snap.remainingAcceptanceCriteria.length}`,
        `Verification Δ: ${snap.verificationDelta}`,
      )
    }
    if (cost) {
      lines.push(
        '',
        `API calls: ${cost.getTotalAPICalls()}`,
        `Cost: $${cost.getTotalCost().toFixed(4)}`,
      )
    }
    return text(lines.join('\n'))
  },
})

registerCommand({
  name: 'models',
  description: 'List configured model profiles with health (calls/failures/latency)',
  usage: '/models',
  handler: (_args, ctx) => {
    const router = ctx.engine.getModelRouter()
    const routedProfiles = router.listProfiles()
    const config = ctx.engine.getConfig?.()
    const configuredProfiles = listConfiguredModelTierProfiles(
      config?.models?.profiles,
      config?.provider ?? 'openai',
    )
    const profiles: ConfiguredModelTierProfile[] = configuredProfiles.length > 0
      ? configuredProfiles
      : routedProfiles.map((profile) => {
        const resolution = resolveModelTier(profile)
        return {
          id: profile.id,
          provider: profile.provider,
          model: profile.model,
          tier: resolution.tier,
          tierInferred: resolution.inferred,
          roles: profile.roles,
          available: profile.available,
          // Spread to widen the concrete RoutingCapabilities interface into
          // the Record<string, number> index-signature shape that
          // ConfiguredModelTierProfile.capabilities expects. The runtime
          // value is unchanged — this avoids the `as unknown as` cast that
          // previously hid the interface↔index-signature mismatch.
          capabilities: { ...profile.capabilities },
        }
      })
    if (profiles.length === 0) return text('No model profiles configured.')
    const bindingRegistry = ctx.engine.getBindingRegistry?.()
    const lines = profiles.map((p) => {
      const routed = routedProfiles.find((profile) => profile.id === p.id)
      const h = routed ? router.getProfileHealth(p.id) : null
      const health = h
        ? `${h.calls} calls, ${h.failures} fail, ${Math.round(h.ewmaLatency)}ms avg`
        : routed
          ? 'no data'
          : 'assigned per sub-agent task'
      const caps = p.capabilities
      const binding = bindingRegistry?.get(p.id)
      const providerLabel = binding
        ? `provider=${binding.provider}${binding.baseURL ? ` baseURL=${binding.baseURL}` : ''}${binding.apiKeyRef ? ` key=${binding.apiKeyRef}` : ''}`
        : `provider=${p.provider}${p.baseURL ? ` baseURL=${p.baseURL}` : ''}${p.apiKeyEnv ? ` key=${p.apiKeyEnv}` : ''}`
      const capability = (name: string): string => caps[name] === undefined ? 'n/a' : String(caps[name])
      return `  ${p.available ? '' : '(disabled) '}${p.model}  [${p.id}]  tier: ${p.tier}${p.tierInferred ? ' (legacy inferred)' : ''}  roles: ${p.roles.join(',') || 'general'}` +
        `\n      ${providerLabel}` +
        `\n      reasoning=${capability('reasoning')} coding=${capability('coding')} ctx=${capability('contextWindow')} tools=${capability('toolCalling')} cost=${capability('cost')} speed=${capability('speed')}` +
        `\n      health: ${health}`
    })
    return text(['Model profiles:', ...lines, '', `Main-agent routing enabled: ${router.isRoutingEnabled()}`].join('\n'))
  },
})

// ── Phase 3: task graph (renamed from /tasks to /plan for clarity) ──

// ── Phase 3: task graph (renamed from /tasks to /plan for clarity) ──
registerCommand({
  name: 'plan',
  description: 'Show the task plan graph: nodes, dependencies, status, blockers',
  usage: '/plan',
  aliases: ['plan-tree'],
  handler: (_args, ctx) => {
    const g = ctx.engine.getTaskGraph()
    const snap = g.snapshot()
    if (snap.summary.total === 0) {
      return text('No task graph for this run (simple task — no decomposition).')
    }
    const s = snap.summary
    const lines = [
      `TaskGraph: ${s.completed}/${s.total} completed · ${s.failed} failed · ${s.blocked} blocked · ${s.running} running · ${s.ready} ready · ${s.pending} pending`,
      '',
    ]
    for (const n of snap.nodes) {
      const deps = n.dependencies.length ? ` ← [${n.dependencies.join(',')}]` : ''
      const flag = n.status === 'blocked' ? `  ⚠ ${n.blockReason ?? ''}`
        : n.status === 'failed' ? `  ✗ ${n.failReason ?? ''}`
        : ''
      lines.push(`  [${n.status.padEnd(10)}] ${n.title}${deps}${flag}`)
    }
    return text(lines.join('\n'))
  },
})

// ── Phase 7: observability (/trace, /why) ─────────────────────────

// ── Phase 7: observability (/trace, /why) ─────────────────────────
registerCommand({
  name: 'trace',
  description: 'Show the structured execution trace: goal, model routing, task graph, progress, final status',
  usage: '/trace',
  handler: (_args, ctx) => {
    const e = ctx.engine
    const lines: string[] = ['=== Execution Trace ===']
    const reg = e.getRunRegistry()
    const runs = reg.list({ kind: 'turn' })
    if (runs.length > 0) {
      const r = runs[runs.length - 1]
      lines.push(`Goal: ${r.goal}`)
      lines.push(`Final status: ${r.status} (${r.phase})${r.error ? ' — ' + r.error : ''}`)
    }
    const d = e.getModelRouter().getLastDecision()
    if (d) {
      lines.push('', 'Model routing:')
      lines.push(`  selected: ${d.selectedModel} [${d.selectedProfile}] conf=${d.confidence} complexity=${d.estimatedComplexity}`)
      lines.push(`  reasons: ${d.reasonCodes.join(', ')}`)
      if (d.fallbackChain.length) lines.push(`  fallback: ${d.fallbackChain.join(' → ')}`)
    }
    const tg = e.getTaskGraph().snapshot()
    if (tg.summary.total > 0) {
      const s = tg.summary
      lines.push('', `TaskGraph: ${s.completed}/${s.total} done · ${s.failed} failed · ${s.blocked} blocked · ${s.running + s.ready + s.pending} active`)
      for (const n of tg.nodes.slice(0, 12)) lines.push(`  [${n.status}] ${n.title}`)
    }
    const pm = e.getProgressMonitor().snapshot(0)
    if (pm.changedFiles.length > 0 || pm.repeatedErrors > 0) {
      lines.push('', `Progress: ${pm.changedFiles.length} file(s) changed · ${pm.repeatedErrors} consecutive error(s) · verification Δ=${pm.verificationDelta}`)
    }
    return text(lines.join('\n'))
  },
})

registerCommand({
  name: 'why',
  description: 'Explain the key runtime decisions from structured events (model choice, completion, blockers)',
  usage: '/why',
  handler: (_args, ctx) => {
    const e = ctx.engine
    const lines: string[] = ['=== Why (decision explanations) ===']
    const d = e.getModelRouter().getLastDecision()
    if (d) {
      const override = e.getModelRouter().getManualOverride()
      lines.push(`Model "${d.selectedModel}":`)
      if (override) lines.push(`  because: manual override (--model//model) — highest priority`)
      else lines.push(`  because: ${d.reasonCodes.join('; ') || 'single profile / default'}`)
    }
    const reg = e.getRunRegistry()
    const runs = reg.list({ kind: 'turn' })
    if (runs.length > 0) {
      const r = runs[runs.length - 1]
      if (r.status === 'blocked') {
        lines.push('', `Blocked:`)
        lines.push(`  because: ${r.error ?? r.phase}`)
      } else if (r.status === 'succeeded') {
        lines.push('', `Completed: stop_sequence with no verification failures or running children.`)
      }
    }
    const tg = e.getTaskGraph()
    if (tg.size() > 0 && tg.hasUnfinished()) {
      lines.push('', `Not completed (TaskGraph):`)
      lines.push(`  because: ${tg.snapshot().summary.total - tg.snapshot().summary.completed} task node(s) still unfinished`)
    }
    return text(lines.join('\n'))
  },
})



// ── /compact — manually trigger compaction ─────────────────────────────────

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

// ── /model — show or change model ───────────────────────────────────────────

registerCommand({
  name: 'model',
  description: 'Show current model, set a sticky override, or restore auto-routing',
  aliases: ['m'],
  usage: '/model [name|id|auto]',
  handler: (args, ctx) => {
    const trimmed = args.trim()
    if (!trimmed) {
      const router = ctx.engine.getModelRouter()
      const override = router.getManualOverride()
      const lines = [`Current model: ${ctx.engine.getModel()}`]
      if (override) lines.push(`Manual override: ${override}  (use '/model auto' to clear)`)
      else lines.push(`Auto-routing: enabled (use '/model <name>' to lock)`)
      return text(lines.join('\n'))
    }
    if (trimmed === 'auto' || trimmed === 'clear') {
      ctx.engine.clearModelOverride()
      return text('Manual override cleared — auto-routing resumed.')
    }
    try {
      ctx.engine.setModelByUser(trimmed)
      const router = ctx.engine.getModelRouter()
      const profiles = router.listProfiles()
      const matched = profiles.find((p) => p.id === trimmed || p.model === trimmed)
      return text(
        `Model set by user: ${ctx.engine.getModel()}` +
        (matched ? `  (matched profile: ${matched.id})` : '  (no matching profile — using raw string)'),
      )
    } catch (err) {
      return text(`Failed to set model: ${(err as Error).message}`)
    }
  },
})

// ── /exec-profile — show or change execution profile ────────────────────────
// (NOT /profile — that name belongs to the legacy config-profiles system
// below; NOT /effort — that is the reasoning-effort axis. The CLI flag is
// --profile because argv has no such collision.)

// ── /exec-profile — show or change execution profile ────────────────────────
// (NOT /profile — that name belongs to the legacy config-profiles system
// below; NOT /effort — that is the reasoning-effort axis. The CLI flag is
// --profile because argv has no such collision.)

registerCommand({
  name: 'exec-profile',
  description: 'Show current execution profile, set a sticky override, or restore auto',
  aliases: ['ep'],
  usage: '/exec-profile [fast|standard|deep|autonomous|auto]',
  handler: (args, ctx) => {
    const trimmed = args.trim()
    if (!trimmed) {
      const override = ctx.engine.getExecutionProfileOverride()
      const lines: string[] = [
        override
          ? `Execution profile: ${override}  (sticky override — '/exec-profile auto' to clear)`
          : 'Execution profile: auto  (resolved per turn from task intent + prompt)',
        '',
        'Available profiles:',
      ]
      for (const [name, spec] of Object.entries(EXECUTION_PROFILES)) {
        const caps: string[] = [`modules: ${spec.modules.join(', ')}`]
        if (spec.maxIterations !== undefined) caps.push(`max iterations: ${spec.maxIterations}`)
        if (spec.maxOutputTokens !== undefined) caps.push(`max output tokens: ${spec.maxOutputTokens}`)
        if (spec.excludedTools && spec.excludedTools.length > 0) caps.push(`hidden tools: ${spec.excludedTools.join(', ')}`)
        lines.push(`  ${name} — ${spec.description}`)
        lines.push(`      ${caps.join(' · ')}`)
      }
      return text(lines.join('\n'))
    }
    if (trimmed === 'auto' || trimmed === 'clear') {
      ctx.engine.setExecutionProfileOverride(null)
      return text('Profile override cleared — per-turn auto resolution resumed.')
    }
    if (!isExecutionProfile(trimmed)) {
      return text(`Unknown profile "${trimmed}". Valid: fast, standard, deep, autonomous (or 'auto' to clear).`)
    }
    ctx.engine.setExecutionProfileOverride(trimmed)
    return text(`Execution profile set: ${trimmed}  (sticky — applies to every turn until '/exec-profile auto')`)
  },
})

// ── /permissions — show permission mode ─────────────────────────────────────

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
      // R12: 7-mode union (was 5-mode legacy list). Including
      // `dontAsk` (auto-approve without prompt) and `bubble`
      // (sandbox-wrap shell) closes the gap with the type union.
      if (!isValidPermissionMode(String(mode))) {
        return text(`Unknown permission mode: ${String(mode)}`)
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
