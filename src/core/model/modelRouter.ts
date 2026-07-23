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

const DEFAULT_LONG_CONTEXT_THRESHOLD = 0.8
const DEFAULT_FAILURE_ESCALATION = 2

export class ModelRouter {
  private profiles: ModelProfile[]
  private readonly routing: RoutingConfig
  private readonly health = new Map<string, ProfileHealth>()
  private lastDecision: RoutingDecision | null = null
  /** Sticky manual override (highest priority). */
  private manualOverride: string | null = null

  constructor(profiles: ModelProfile[], routing: RoutingConfig = { enabled: true }) {
    this.profiles = profiles.length > 0 ? profiles : []
    this.routing = {
      enabled: routing.enabled ?? true,
      longContextThreshold: routing.longContextThreshold ?? DEFAULT_LONG_CONTEXT_THRESHOLD,
      failureEscalationThreshold: routing.failureEscalationThreshold ?? DEFAULT_FAILURE_ESCALATION,
    }
  }

  /** Manual override (from --model / /model). Null clears it. */
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

    // Role fit for subtask routing.
    if (input.role && p.roles.includes(input.role)) { score += 0.25; reasonCodes.push(`role:${input.role}`) }

    // Health penalty: failing / slow profiles sink.
    const h = this.health.get(p.id)
    if (h && h.calls >= 3) {
      const failRate = h.failures / h.calls
      score -= failRate * 0.6
      if (failRate > 0.3) reasonCodes.push(`unhealthy:${p.id}`)
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
