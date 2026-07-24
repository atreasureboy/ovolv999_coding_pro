/**
 * ModelRouter (eight_goal Phase 2) — adaptive, config-driven model
 * selection. The single place that decides which model a turn uses.
 *
 * NOT a keyword `if/else`. Selection is a transparent multi-criteria
 * scorer: a task is scored for complexity/context/budget/failure from
 * real signals (prompt, repo size, history, context usage), then each
 * available ModelProfile is scored against the task's needs (reasoning,
 * coding, contextWindow, cost). The top scorer wins; the rest form the
 * fallback chain. Every decision emits reasonCodes so `/route` and
 * `/why` can explain it from structured data, not a model hallucination.
 *
 * Priority (eight_goal §四.1): a manual `--model` / `/model` override
 * ALWAYS wins and is sticky. Auto-routing is opt-out (`routing.enabled`).
 * Provider fallback (§四.8) advances the chain on 429/timeout/error and
 * ONLY re-issues the LLM call — never replays side-effectful tools,
 * because fallback fires at the streaming-establishment boundary before
 * any tool executes.
 *
 * Profiles live in config (~/.ovogo/settings.json `models.profiles`),
 * never hardcoded in the coordinator. Built-in defaults cover a single
 * configured model so the router degrades gracefully when unconfigured.
 */

import type { TokenUsage } from '../costTracker.js'

export interface ModelCapabilities {
  /** 0..1 — strength at multi-step reasoning / architecture. */
  reasoning: number
  /** 0..1 — strength at code generation / editing. */
  coding: number
  /** Max context window in tokens. */
  contextWindow: number
  /** 0..1 — reliability of tool/function calling. */
  toolCalling: number
  /** 0..1 — relative speed (1 = fastest). */
  speed: number
  /** 0..1 — relative cost (1 = cheapest). Inverted into the score. */
  cost: number
}

export interface ModelProfile {
  id: string
  provider: string
  model: string
  capabilities: ModelCapabilities
  /** Roles this profile can serve: 'main' | 'cheap' | 'long-context' | 'worker'. */
  roles: string[]
  available: boolean
}

export interface RoutingInput {
  userGoal: string
  /** Approximate repo file count (complexity signal). */
  repoFileCount?: number
  /** Files referenced in the turn so far (complexity signal). */
  filesTouched?: number
  /** Consecutive model failures before this turn (health/fallback signal). */
  consecutiveFailures?: number
  /** Current context usage ratio 0..1 (long-context signal). */
  contextUsageRatio?: number
  /** Remaining budget fraction 0..1 (cost-pressure signal). */
  budgetRemaining?: number
  /** Subtask role hint, if routing a child ('worker' etc.). */
  role?: string
  /** True if the goal looks like architecture / root-cause / decision work. */
  needsArchitecture?: boolean
  // ── v0.3.1 (te_goal §三.1.3) expanded signals ────────────────────
  /** Per-profile health snapshot (failRate + avg latency). */
  providerHealth?: Array<{ profileId: string; failRate: number; avgLatencyMs: number }>
  /** Number of times routing fell back this session. */
  previousRoutingFailures?: number
  /** What kind of tools the model is likely to call. */
  expectedToolRequirement?: 'none' | 'read-only' | 'mixed' | 'side-effect'
  /** True if the change affects an exported / public surface. */
  affectsPublicInterface?: boolean
  /** True if the change crosses module boundaries. */
  isCrossModule?: boolean
  /** True if the change modifies configuration / schema. */
  isConfigChange?: boolean
  /** True if the goal requires root-cause analysis. */
  requiresRootCause?: boolean
  /** Estimated number of files the change will touch. */
  estimatedImpactFiles?: number
  /** Total TaskGraph node count for the run. */
  taskGraphScale?: number
}

export interface BudgetAllocation {
  maxInputTokens?: number
  maxOutputTokens?: number
  maxCost?: number
}

export interface RoutingDecision {
  selectedModel: string
  selectedProfile: string
  reasonCodes: string[]
  confidence: number
  estimatedComplexity: number
  fallbackChain: string[]
  budgetAllocation: BudgetAllocation
}

export interface RoutingConfig {
  enabled: boolean
  /** When context usage exceeds this, prefer a long-context profile. */
  longContextThreshold?: number
  /** Consecutive failures after which to escalate / switch profile. */
  failureEscalationThreshold?: number
}

/** Runtime health per profile (updated by the engine on each call). */
interface ProfileHealth {
  calls: number
  failures: number
  /** Exponentially-weighted moving average latency (ms). */
  ewmaLatency: number
}

/**
 * v0.3.1 (te_goal §三.1.1): narrowed router sink. Three distinct
 * call paths replace the legacy single setManualOverride(s) / raw
 * route() path so auto-routing can never accidentally pin a manual
 * override, and the manual user path always wins.
 */
export interface ModelSwitchSink {
  setModelByUser(modelOrProfile: string): void
  applyRoutingDecision(model: string, budgetAllocation?: BudgetAllocation): void
  clearModelOverride(): void
}

export type RouterEventType =
  | 'MODEL_OVERRIDE_SET'
  | 'MODEL_OVERRIDE_CLEARED'
  | 'ROUTING_DECISION_APPLIED'
  | 'ROUTING_FALLBACK_APPLIED'
  | 'BUDGET_ALLOCATION_APPLIED'

export type RouterEventListener = (event: {
  type: RouterEventType
  payload?: Record<string, unknown>
}) => void

const DEFAULT_LONG_CONTEXT_THRESHOLD = 0.8
const DEFAULT_FAILURE_ESCALATION = 2

export class ModelRouter {
  private profiles: ModelProfile[]
  private readonly routing: RoutingConfig
  private readonly health = new Map<string, ProfileHealth>()
  private lastDecision: RoutingDecision | null = null
  /** Sticky manual override (highest priority). */
  private manualOverride: string | null = null
  /** Optional sink that performs the actual engine switch. */
  private sink: ModelSwitchSink | null = null
  /** Optional event listener (RunEventEmitter.emit wrapping). */
  private listener: RouterEventListener | null = null
  /** Last applied (post-sink) model + allocation; used for dedup so
   *  re-applying the same routing decision doesn't spam events. */
  private lastApplied: { model: string; allocation?: BudgetAllocation } | null = null

  constructor(profiles: ModelProfile[], routing: RoutingConfig = { enabled: true }) {
    this.profiles = profiles.length > 0 ? profiles : []
    this.routing = {
      enabled: routing.enabled ?? true,
      longContextThreshold: routing.longContextThreshold ?? DEFAULT_LONG_CONTEXT_THRESHOLD,
      failureEscalationThreshold: routing.failureEscalationThreshold ?? DEFAULT_FAILURE_ESCALATION,
    }
  }

  /**
   * Wire the actual model-switch sink. The router NEVER mutates the
   * engine's model directly — it asks the sink to do it. This keeps
   * Engine the single owner of `config.model` and the single emitter
   * of `MODEL_CHANGED`, while letting the router own the decision
   * (manual vs auto) and emit its own structured events.
   */
  setSink(sink: ModelSwitchSink): void {
    this.sink = sink
  }

  /** Wire a structured event listener (typically RunEventEmitter.emit). */
  setEventListener(listener: RouterEventListener | null): void {
    this.listener = listener
  }

  private emit(type: RouterEventType, payload?: Record<string, unknown>): void {
    this.listener?.({ type, payload })
  }

  /**
   * v0.3.1 (te_goal §三.1.1): sticky manual override entry. Accepts
   * either a profile id (`profile-1`) or a model string (`gpt-4o`).
   * The sink is the only path that performs the model switch so the
   * router can never bypass Engine.setModelByUser.
   */
  setModelByUser(modelOrProfile: string): void {
    const trimmed = modelOrProfile?.trim()
    if (!trimmed) throw new Error('ModelRouter.setModelByUser: empty model/profile id')
    // Best-effort: resolve to a profile id so the same string can later
    // be displayed in /why and /route.
    const profile = this.profiles.find((p) => p.id === trimmed || p.model === trimmed)
    this.manualOverride = profile ? profile.model : trimmed
    this.emit('MODEL_OVERRIDE_SET', { modelOrProfile: trimmed, profileId: profile?.id })
    this.sink?.setModelByUser(profile?.model ?? trimmed)
  }

  /**
   * v0.3.1 (te_goal §三.1.1): auto-routing entry. NEVER sets the
   * manual override. Optionally applies a budget allocation emitted
   * alongside the chosen model.
   */
  applyRoutingDecision(model: string, budgetAllocation?: BudgetAllocation): void {
    const trimmed = model?.trim()
    if (!trimmed) return
    // No-op when re-applying the same decision — keeps the event stream
    // quiet when the router is called repeatedly with no signal change.
    if (this.lastApplied
      && this.lastApplied.model === trimmed
      && JSON.stringify(this.lastApplied.allocation ?? {}) === JSON.stringify(budgetAllocation ?? {})) {
      return
    }
    this.lastApplied = { model: trimmed, allocation: budgetAllocation }
    this.emit('ROUTING_DECISION_APPLIED', { selectedModel: trimmed })
    this.sink?.applyRoutingDecision(trimmed, budgetAllocation)
    if (budgetAllocation && (budgetAllocation.maxOutputTokens !== undefined || budgetAllocation.maxInputTokens !== undefined)) {
      this.emit('BUDGET_ALLOCATION_APPLIED', { allocation: budgetAllocation })
    }
  }

  /** v0.3.1 (te_goal §三.1.1): restore auto-routing after `/model auto`. */
  clearModelOverride(): void {
    if (this.manualOverride === null) return
    this.manualOverride = null
    this.emit('MODEL_OVERRIDE_CLEARED')
    this.sink?.clearModelOverride()
  }

  /**
   * v0.3.1 (te_goal §三.1.4): emit a structured fallback event when
   * the router advances to the next profile in the chain. Engine
   * drives this; the router just logs.
   */
  emitFallback(from: string, to: string, error: string): void {
    this.emit('ROUTING_FALLBACK_APPLIED', { from, to, error })
  }

  /**
   * Legacy lower-level API (kept for tests + back-compat). Sets the
   * sticky override flag WITHOUT emitting events or calling the sink.
   * Production callers should use setModelByUser() instead. This
   * method is intentionally a no-op for events to avoid recursion
   * when Engine.setModelByUser → router.setManualOverride → emit/sink.
   */
  setManualOverride(model: string | null): void {
    this.manualOverride = model?.trim() || null
  }

  getManualOverride(): string | null {
    return this.manualOverride
  }

  isRoutingEnabled(): boolean {
    return this.routing.enabled
  }

  listProfiles(): ModelProfile[] {
    return this.profiles
  }

  getLastDecision(): RoutingDecision | null {
    return this.lastDecision
  }

  getProfileHealth(id: string): ProfileHealth | undefined {
    return this.health.get(id)
  }

  /** Engine reports a call result so health/failure stats stay current. */
  recordCall(profileId: string, ok: boolean, latencyMs: number, _usage: TokenUsage | null): void {
    const h = this.health.get(profileId) ?? { calls: 0, failures: 0, ewmaLatency: 0 }
    h.calls++
    if (!ok) h.failures++
    h.ewmaLatency = h.ewmaLatency === 0 ? latencyMs : 0.7 * h.ewmaLatency + 0.3 * latencyMs
    this.health.set(profileId, h)
  }

  /**
   * The single decision function. Pure given input + current health —
   * no side effects except caching lastDecision. Callers apply the
   * selected model and emit a routing event.
   *
   * v0.3.1: even when a manual override is set we still refresh
   * `lastDecision` so /route and /why can report fresh observations
   * (signals, fallback chain, complexity) during manual turns. Only
   * the side-effect of switching the model is skipped.
   */
  route(input: RoutingInput): RoutingDecision {
    const available = this.profiles.filter((p) => p.available)
    const reasonCodes: string[] = []

    // 1) Manual override always wins (eight_goal §四.1).
    if (this.manualOverride) {
      const match = available.find((p) => p.model === this.manualOverride)
        ?? available.find((p) => p.id === this.manualOverride)
      const model = match?.model ?? this.manualOverride
      reasonCodes.push('manual-override')
      const decision = this.decide(input, model, match?.id ?? 'manual', reasonCodes, available, 1)
      this.lastDecision = decision
      return decision
    }

    // 2) If only one profile (or none configured for routing), use it directly.
    if (!this.routing.enabled || available.length <= 1) {
      const only = available[0]
      const model = only?.model ?? this.manualOverride ?? ''
      if (!this.routing.enabled) reasonCodes.push('routing-disabled')
      else reasonCodes.push('single-profile')
      const decision = this.decide(input, model, only?.id ?? 'default', reasonCodes, available, available.length > 0 ? 0.9 : 0)
      this.lastDecision = decision
      return decision
    }

    // 3) Estimate task complexity from real signals.
    const complexity = this.estimateComplexity(input, reasonCodes)

    // 4) Score each available profile against the task needs.
    const scored = available.map((p) => ({
      profile: p,
      score: this.scoreProfile(p, input, complexity, reasonCodes),
    }))
    scored.sort((a, b) => b.score - a.score)

    const best = scored[0]
    const fallbackChain = scored.slice(1).map((s) => s.profile.model)
    const confidence = this.confidence(scored)

    const decision: RoutingDecision = {
      selectedModel: best.profile.model,
      selectedProfile: best.profile.id,
      reasonCodes: dedupe(reasonCodes),
      confidence,
      estimatedComplexity: complexity,
      fallbackChain,
      budgetAllocation: this.budgetFor(best.profile, input),
    }
    this.lastDecision = decision
    return decision
  }

  /**
   * Advance to the next profile in the fallback chain after a provider
   * failure on the CURRENT call. Returns null if the chain is exhausted.
   * Caller MUST only call this at the LLM-call boundary (before tools
   * execute) so no side-effectful tool is ever replayed.
   */
  nextFallback(failedModel: string): string | null {
    const chain = this.lastDecision?.fallbackChain ?? []
    const idx = chain.indexOf(failedModel)
    const next = idx >= 0 ? chain[idx + 1] : chain[0]
    if (next) {
      this.emitFallback(failedModel, next, 'provider-failure')
    }
    return next ?? null
  }

  // ── internals ───────────────────────────────────────────────────

  private estimateComplexity(input: RoutingInput, reasonCodes: string[]): number {
    let c = 0.3 // baseline
    const goal = (input.userGoal ?? '').toLowerCase()
    if (input.needsArchitecture || /architect|refactor|redesign|root cause|design decision|migration/.test(goal)) {
      c += 0.35; reasonCodes.push('architecture-signal')
    }
    if (/debug|fix|investigate|trace|why does|broken|crash|error/.test(goal)) {
      c += 0.15; reasonCodes.push('debug-signal')
    }
    if ((input.repoFileCount ?? 0) > 500) { c += 0.15; reasonCodes.push('large-repo') }
    if ((input.filesTouched ?? 0) > 5) { c += 0.1; reasonCodes.push('many-files') }
    if ((input.userGoal ?? '').length > 1200) { c += 0.1; reasonCodes.push('long-goal') }
    c = Math.min(1, c)
    return round(c)
  }

  private scoreProfile(
    p: ModelProfile,
    input: RoutingInput,
    complexity: number,
    reasonCodes: string[],
  ): number {
    let score = 0
    const cap = p.capabilities

    // Complexity → want reasoning + coding strength.
    score += complexity * (cap.reasoning * 0.6 + cap.coding * 0.4)

    // Trivial tasks should prefer the CHEAP model: as complexity falls,
    // the cost advantage (cap.cost, 1=cheapest) weighs in more. This is
    // what makes "list files" route to the cheap model and "redesign the
    // architecture" route to the strong one — otherwise capability scores
    // dominate and the strong model always wins. (eight_goal §四 默认策略.)
    score += (1 - complexity) * cap.cost * 0.8

    // Long-context pressure → want a big window.
    const ctxRatio = input.contextUsageRatio ?? 0
    if (ctxRatio > (this.routing.longContextThreshold ?? DEFAULT_LONG_CONTEXT_THRESHOLD)) {
      if (cap.contextWindow >= 200_000) { score += 0.3; reasonCodes.push('long-context-need') }
    }

    // Budget pressure → favour cheap. budgetRemaining low = high pressure.
    const budget = input.budgetRemaining ?? 1
    if (budget < 0.3) { score += cap.cost * 0.4; reasonCodes.push('budget-pressure') }

    // Tool reliability matters for any tool-using turn.
    score += cap.toolCalling * 0.15

    // v0.3.1 (te_goal §三.1.3): side-effect tool goals require high
    // tool-calling reliability; the cheap model is acceptable for
    // read-only/none categories but penalised for side-effect work.
    const toolReq = input.expectedToolRequirement ?? 'mixed'
    if (toolReq === 'side-effect') {
      score += cap.toolCalling * 0.25
      reasonCodes.push('side-effect-tools')
    } else if (toolReq === 'read-only' || toolReq === 'none') {
      // No tool pressure — cheap model is acceptable.
    }

    // Architecture / root-cause / config / cross-module / public-
    // interface signals bump the reasoning weight slightly so the
    // strong model is preferred for non-trivial engineering work.
    const reasoningBonus = (
      (input.needsArchitecture ? 0.15 : 0)
      + (input.requiresRootCause ? 0.1 : 0)
      + (input.isConfigChange ? 0.05 : 0)
      + (input.isCrossModule ? 0.05 : 0)
      + (input.affectsPublicInterface ? 0.05 : 0)
    )
    if (reasoningBonus > 0) {
      score += cap.reasoning * reasoningBonus
      reasonCodes.push('architecture-signal')
    }

    // Role fit for subtask routing.
    if (input.role && p.roles.includes(input.role)) { score += 0.25; reasonCodes.push(`role:${input.role}`) }

    // Large task graphs prefer the long-context profile.
    if ((input.taskGraphScale ?? 0) > 5 && cap.contextWindow >= 200_000) {
      score += 0.1
      reasonCodes.push('task-graph-large')
    }

    // Health penalty: failing / slow profiles sink. Uses the
    // configurable failureEscalationThreshold (te_goal §三.1.4) —
    // not the hardcoded "calls >= 3" rule.
    const h = this.health.get(p.id)
    const threshold = this.routing.failureEscalationThreshold ?? DEFAULT_FAILURE_ESCALATION
    if (h && h.calls >= threshold) {
      const failRate = h.failures / h.calls
      score -= failRate * 0.6
      if (failRate > 0.3) reasonCodes.push(`unhealthy:${p.id}`)
    }

    // Per-profile health from the collector can also penalise a
    // profile even if local recordCall has not run yet.
    if (input.providerHealth) {
      const remote = input.providerHealth.find((h) => h.profileId === p.id)
      if (remote && remote.failRate > 0.3) {
        score -= remote.failRate * 0.4
        reasonCodes.push(`health-from-collector:${p.id}`)
      }
    }

    // Previous routing failures amplify the health penalty so the
    // router favours profiles that have actually succeeded recently.
    const prevFailures = input.previousRoutingFailures ?? 0
    if (prevFailures > 0) {
      score -= 0.05 * prevFailures
      reasonCodes.push('previous-routing-failures')
    }

    return score
  }

  private confidence(scored: { score: number }[]): number {
    if (scored.length < 2) return 0.9
    const gap = scored[0].score - scored[1].score
    return round(Math.max(0.3, Math.min(0.99, 0.5 + gap)))
  }

  private budgetFor(p: ModelProfile, input: RoutingInput): BudgetAllocation {
    const alloc: BudgetAllocation = {}
    if (p.capabilities.contextWindow) alloc.maxInputTokens = Math.floor(p.capabilities.contextWindow * 0.8)
    if (input.budgetRemaining !== undefined && input.budgetRemaining < 0.3) {
      alloc.maxOutputTokens = 2048 // tighten under budget pressure
    }
    return alloc
  }

  private decide(
    input: RoutingInput,
    model: string,
    profileId: string,
    reasonCodes: string[],
    available: ModelProfile[],
    confidence: number,
  ): RoutingDecision {
    void input
    const complexity = this.lastDecision?.estimatedComplexity ?? 0.5
    return {
      selectedModel: model,
      selectedProfile: profileId,
      reasonCodes: dedupe(reasonCodes),
      confidence,
      estimatedComplexity: complexity,
      fallbackChain: available.filter((p) => p.model !== model).map((p) => p.model),
      budgetAllocation: {},
    }
  }
}

function dedupe(arr: string[]): string[] {
  return Array.from(new Set(arr))
}
function round(n: number): number {
  return Math.round(n * 100) / 100
}

// ── config helpers ────────────────────────────────────────────────

export interface ModelsConfig {
  profiles: ModelProfile[]
  routing: RoutingConfig
}

export const DEFAULT_ROUTING_CONFIG: RoutingConfig = {
  enabled: true,
  longContextThreshold: DEFAULT_LONG_CONTEXT_THRESHOLD,
  failureEscalationThreshold: DEFAULT_FAILURE_ESCALATION,
}

/**
 * Build a router from a single configured model (the common case: user
 * has one provider). The model becomes the 'main' profile; routing is
 * effectively a no-op (single profile) but the override + health + event
 * machinery still works. Multi-profile routing activates when the user
 * declares `models.profiles` in settings.
 */
export function routerFromSingleModel(model: string, provider = 'openai'): ModelRouter {
  const profile: ModelProfile = {
    id: 'default',
    provider,
    model,
    capabilities: { reasoning: 0.8, coding: 0.8, contextWindow: 128_000, toolCalling: 0.8, speed: 0.7, cost: 0.6 },
    roles: ['main', 'cheap', 'long-context', 'worker'],
    available: true,
  }
  return new ModelRouter([profile], DEFAULT_ROUTING_CONFIG)
}
