/**
 * ModelRouter (adaptive runtime contract Phase 2) — adaptive, config-driven model
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
 * Priority (adaptive runtime contract §四.1): a manual `--model` / `/model` override
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

import { randomUUID } from 'node:crypto'
import type { TokenUsage } from '../costTracker.js'

/**
 * v0.5.3 Hotfix §7 — Probe lease ownership token.
 *
 * Acquired by `tryAcquireProbe(profileId)` and required by
 * `finishProbe(lease, outcome)`. The lease is the single proof
 * that the calling code holds the right to drive the circuit
 * state transition. Without a valid lease, finishProbe is a
 * no-op (defensive against misbehaving callers).
 *
 * v0.5.5 §9: attemptScopeId binds the lease to a specific range
 * of ModelCallAttempts on the Coordinator. finishProbe uses
 * ONLY attempts inside this scope to decide success/failure,
 * never the run-wide list.
 */
export interface ProbeLease {
  /** Unique id used to verify ownership on release. */
  leaseId: string
  /** The profile the lease was acquired for. */
  profileId: string
  /** The model the profile uses — captured for diagnostics. */
  model: string
  /** Wall-clock when the lease was minted. */
  acquiredAt: number
  /** v0.5.5 §9: opaque scope id. finishProbe filters attempts
   *  to those carrying this id. Prevents cross-attempt bleed. */
  attemptScopeId: string
}

export type ProbeOutcome = 'success' | 'failure' | 'aborted'

/**
 * v0.5.3 Hotfix §8 — structured RouteApplication. The Router
 * returns one of three discriminated outcomes so callers can
 * distinguish "applied a real fallback" from "no-op (same model
 * was already current)" from "no profile is available at all".
 *
 *   - applied     — the previous config.model was different; we
 *                   advanced. previousModel carries the value
 *                   that was in effect BEFORE apply.
 *   - unchanged   — the requested model equals the current one;
 *                   this is a no-op emit.
 *   - unavailable — no profile is available (all circuits open, or
 *                   no profile matched). decision.selectedModel
 *                   is empty and reasonCodes include
 *                   'all-profiles-open' (or equivalent).
 */
export type RouteApplication = {
  kind: 'applied'
  decision: RoutingDecision
  previousModel: string
} | {
  kind: 'unchanged'
  decision: RoutingDecision
} | {
  kind: 'unavailable'
  decision: RoutingDecision
}

/**
 * Routing-time strength scores for a model profile. Deliberately NOT the
 * `ModelCapabilities` in core/modelCapabilities.ts — that one is the
 * provider feature set (boolean flags + limits) used by ProviderAdapter;
 * this one is the 0..1 scoring input the router ranks profiles with.
 */
export interface RoutingCapabilities {
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
  tier?: 'top' | 'secondary'
  capabilities: RoutingCapabilities
  /** Roles this profile can serve: 'main' | 'cheap' | 'long-context' | 'worker'. */
  roles: string[]
  available: boolean
}

export interface RoutingInput {
  userGoal: string
  /** Approximate repo file count (complexity signal). undefined
   *  is ALWAYS neutral — the Router MUST NOT fabricate a value. */
  repoFileCount?: number
  /** v0.5.3 Final (P0 issue): provenance of repoFileCount.
   *  - ready/empty → count is exact.
   *  - partial → count is a lower bound; Router weights weakly.
   *  - unknown → Router treats as neutral (no fabrication). */
  repoStatsState?: 'ready' | 'empty' | 'partial' | 'unknown'
  /** True when the count is a partial lower bound. */
  repoStatsLowerBound?: boolean
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
  // ── v0.3.1 (runtime truth contract §三.1.3) expanded signals ────────────────────
  /** Per-profile health snapshot (failRate + avg latency). */
  providerHealth?: Array<{ profileId: string; failRate: number; avgLatencyMs: number }>
  // v0.5.5 §14: previousRoutingFailures / totalFallbacksApplied /
  // circuitState / consecutiveProviderFailures are NOT decision
  // inputs. They were session-wide counts that affected every
  // profile identically and never changed the ranking. Session
  // fallback counts are exposed via getRoutingFailureStats() for
  // observability only.
  /** True when the user has manually overridden the model. The Router
   *  honors the override (and these signals are advisory only). */
  manualOverrideActive?: boolean
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
  /**
   * v0.5.5 §13: per-profile score breakdown for observability.
   * Non-selected profile reasons live here, NOT in the top-level
   * `reasonCodes` (which carries only global + selected-profile
   * codes). Empty when route() was called with no profiles (the
   * `unavailable` branch).
   */
  profileScores?: Array<{
    profileId: string
    score: number
    reasonCodes: string[]
  }>
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
 * v0.3.1 (runtime truth contract §三.1.1): narrowed router sink. Three distinct
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
const CIRCUIT_OPEN_THRESHOLD = 5
const CIRCUIT_HALF_OPEN_COOLDOWN_MS = 30_000

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
  /**
   * v0.5.2 (Stage 2.4): real routing-failure counters. The Coordinator
   * used to hardcode `previousRoutingFailures: 0` into the signal
   * collector; these fields track every fallback advancement so the
   * Router can break out of a failing chain. Reset only on cold
   * Router construction (per-session lifetime).
   */
  private totalRoutingFailures = 0
  private totalFallbacksApplied = 0
  // v0.5.3 Final (task 7): totalRetryAttempts removed — never had a
  // production caller. See recordRetry() doc-comment.
  // Probe lease set (v0.5.3 Final): one probe per profile at a time.
  private readonly probeInFlight = new Set<string>()
  // v0.5.3 Hotfix §7: active lease tokens keyed by leaseId. Used
  // to verify that finishProbe's caller actually owns the lease.
  private readonly activeLeases = new Map<string, ProbeLease>()
  /** v0.5.3 (P1.8): per-profile circuit state. The Coordinator's
   *  global circuit penalizes ALL profiles for one failure; this
   *  per-profile circuit isolates the failing profile so healthy
   *  ones remain selectable. */
  private readonly circuitStates = new Map<string, 'closed' | 'open' | 'half-open'>()
  private readonly circuitOpenedAt = new Map<string, number>()
  private readonly consecutiveProfileFailures = new Map<string, number>()

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
   * v0.3.1 (runtime truth contract §三.1.1): sticky manual override entry. Accepts
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
   * v0.3.1 (runtime truth contract §三.1.1): auto-routing entry. NEVER sets the
   * manual override. Optionally applies a budget allocation emitted
   * alongside the chosen model.
   */
  applyRoutingDecision(model: string, budgetAllocation?: BudgetAllocation, _meta?: { previousModel?: string; reasonCodes?: string[] }): void {
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
    // v0.5.3 Hotfix §9: emit the structured payload with
    // previousModel + reasonCodes so the Engine can surface the
    // TRUE pre-state and the profile-scoped reason codes.
    this.emit('ROUTING_DECISION_APPLIED', {
      selectedModel: trimmed,
      previousModel: _meta?.previousModel,
      reasonCodes: _meta?.reasonCodes ?? [],
    })
    this.sink?.applyRoutingDecision(trimmed, budgetAllocation)
    if (budgetAllocation && (budgetAllocation.maxOutputTokens !== undefined || budgetAllocation.maxInputTokens !== undefined)) {
      this.emit('BUDGET_ALLOCATION_APPLIED', { allocation: budgetAllocation })
    }
  }

  /**
   * v0.5.5 §3 — PURE classification. The Router does NOT apply the
   * decision to its Sink here. The single application owner is
   * the Engine (whose callback invokes `markApplied` after a
   * successful switch). Returning a `RouteApplication` is a
   * classification; no state mutation, no event emission, no
   * Sink call.
   *
   * previousModel MUST come from the Engine's actual current
   * state — NOT from this.lastApplied (which only tracks what the
   * Router has previously applied, not what the Engine currently
   * holds in `config.model`).
   */
  classifyRouteApplication(decision: RoutingDecision, previousModel: string): RouteApplication {
    if (!decision || decision.selectedModel === '') {
      return { kind: 'unavailable', decision }
    }
    if (previousModel === decision.selectedModel) {
      return { kind: 'unchanged', decision }
    }
    return { kind: 'applied', decision, previousModel }
  }

  /**
   * v0.5.5 §3 — markApplied. The Engine calls this AFTER applying
   * the routing decision to its own config.model + Sink. Updates
   * the Router's lastApplied tracking AND emits the structured
   * ROUTING_DECISION_APPLIED event. Centralising event emission
   * here means downstream consumers see the same payload whether
   * the Engine or a manual override triggered the change.
   */
  markApplied(model: string, budgetAllocation: BudgetAllocation | undefined, previousModel: string, reasonCodes: string[]): void {
    this.applyRoutingDecision(model, budgetAllocation, { previousModel, reasonCodes })
  }

  /**
   * v0.5.3 Hotfix §8 — DEPRECATED in v0.5.5. Replaced by
   * classifyRouteApplication + Engine-owned markApplied. This
   * method is kept for backwards compatibility with callers that
   * still expect the Router to apply internally; new code MUST
   * NOT use it.
   *
   * @deprecated v0.5.5 §3: use classifyRouteApplication()
   * + markApplied() instead. The Router must NOT mutate
   * config.model — the Engine owns that contract.
   */
  applyRouteApplication(decision: RoutingDecision): RouteApplication {
    if (!decision || decision.selectedModel === '') {
      return { kind: 'unavailable', decision }
    }
    const previous = this.lastApplied?.model ?? ''
    if (previous === decision.selectedModel) {
      return { kind: 'unchanged', decision }
    }
    this.applyRoutingDecision(decision.selectedModel, decision.budgetAllocation, {
      previousModel: previous,
      reasonCodes: decision.reasonCodes,
    })
    return { kind: 'applied', decision, previousModel: previous }
  }

  /** v0.3.1 (runtime truth contract §三.1.1): restore auto-routing after `/model auto`. */
  clearModelOverride(): void {
    if (this.manualOverride === null) return
    this.manualOverride = null
    this.emit('MODEL_OVERRIDE_CLEARED')
    this.sink?.clearModelOverride()
  }

  /**
   * v0.3.1 (runtime truth contract §三.1.4): emit a structured fallback event when
   * the router advances to the next profile in the chain. Engine
   * drives this; the router just logs.
   */
  emitFallback(from: string, to: string, error: string): void {
    // v0.5.2 (Stage 2.4): real counter. A fallback means the previous
    // model failed AND we advanced; both failure AND fallback counters
    // increment. Distinct signals for /why and routing-event payload.
    this.totalRoutingFailures++
    this.totalFallbacksApplied++
    this.emit('ROUTING_FALLBACK_APPLIED', { from, to, error })
  }

  /**
   * v0.5.2 (Stage 2.4): record a retry attempt on the same model.
   * v0.5.3 Final (task 7): REMOVED. ModelGateway never retries the
   * same model internally — it falls back at the stream boundary.
   * Without a real production caller the counter was always 0
   * (decoration). We removed:
   *   - recordRetry() effect
   *   - totalRetryAttempts counter
   *   - the field in getRoutingFailureStats()
   *   - the field in RouterHealthSnapshot
   * The method is kept as a no-op for back-compat with any stale
   * call site.
   */
  /** @deprecated v0.5.3 Final — does nothing. */
  recordRetry(): void {
    // no-op
  }

  /**
   * v0.5.2 (Stage 2.4): counter accessors. The Coordinator's signal
   * collector previously hardcoded `previousRoutingFailures: 0`;
   * the public getter lets it read real values without re-exporting
   * private state.
   */
  getRoutingFailureStats(): {
    totalFailures: number
    totalFallbacksApplied: number
  } {
    return {
      totalFailures: this.totalRoutingFailures,
      totalFallbacksApplied: this.totalFallbacksApplied,
    }
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
    // v0.5.3 (P1.8): per-profile circuit tracking. A successful call
    // closes the per-profile circuit; a failed call increments the
    // consecutive-failure counter and opens the circuit at the
    // threshold. Healthy profiles are unaffected by another
    // profile's failures — that's the whole point of moving from a
    // global circuit to per-profile.
    if (ok) {
      this.consecutiveProfileFailures.set(profileId, 0)
      this.circuitStates.set(profileId, 'closed')
      return
    }
    const next = (this.consecutiveProfileFailures.get(profileId) ?? 0) + 1
    this.consecutiveProfileFailures.set(profileId, next)
    if (next >= CIRCUIT_OPEN_THRESHOLD) {
      this.circuitStates.set(profileId, 'open')
      this.circuitOpenedAt.set(profileId, Date.now())
    }
  }

  /** v0.5.3 (P1.8): per-profile circuit state accessor. */
  getProfileCircuitState(profileId: string): 'closed' | 'open' | 'half-open' {
    const state = this.circuitStates.get(profileId) ?? 'closed'
    if (state === 'open') {
      const openedAt = this.circuitOpenedAt.get(profileId) ?? 0
      if (Date.now() - openedAt >= CIRCUIT_HALF_OPEN_COOLDOWN_MS) {
        this.circuitStates.set(profileId, 'half-open')
        return 'half-open'
      }
    }
    return state
  }

  /** v0.5.3 (P0-3): expose the consecutive-failure counter for a
   *  profile so the Coordinator can size its backoff without
   *  duplicating bookkeeping. */
  getProfileConsecutiveFailures(profileId: string): number {
    return this.consecutiveProfileFailures.get(profileId) ?? 0
  }

  /** v0.5.3 (P1.8): true iff a profile is callable right now.
   *  When circuit is half-open we allow the probe; when open we
   *  reject so the Router selects the next healthy profile. */
  isProfileAvailable(profileId: string): boolean {
    return this.getProfileCircuitState(profileId) !== 'open'
  }

  /**
   * v0.5.3 Final (task 7) + v0.5.3 Hotfix §7: probe lease ownership
   * token. Returns the lease iff the caller has acquired the right
   * to issue ONE probe call against a half-open profile.
   * Concurrent callers receive null — the Router's "second probe
   * must be rejected" invariant is enforced here, not by accident
   * elsewhere. A call returns null if the circuit is not yet
   * half-open (callers must check getProfileCircuitState first to
   * drive the cooldown transition).
   *
   * The lease is opaque (leaseId) and bound to (profileId, model,
   * acquiredAt). finishProbe(lease, outcome) verifies the leaseId
   * before mutating circuit state.
   */
  tryAcquireProbe(profileId: string, attemptScopeId: string = randomUUID()): ProbeLease | null {
    const state = this.getProfileCircuitState(profileId)
    if (state !== 'half-open') return null
    if (this.probeInFlight.has(profileId)) return null
    this.probeInFlight.add(profileId)
    const profile = this.profiles.find((p) => p.id === profileId)
    const lease: ProbeLease = {
      leaseId: randomUUID(),
      profileId,
      model: profile?.model ?? '',
      acquiredAt: Date.now(),
      attemptScopeId,
    }
    this.activeLeases.set(lease.leaseId, lease)
    return lease
  }

  /**
   * v0.5.3 Final (task 7) + v0.5.3 Hotfix §7: complete a probe
   * previously acquired via tryAcquireProbe. The lease token is
   * required — finishProbe MUST validate leaseId. Mismatched or
   * unknown leases are silently ignored (defensive against
   * misbehaving callers). The probe-bound attemptId is recorded
   * for diagnostics.
   *
   *   success → CLOSED (reset failures)
   *   failure → re-OPEN with renewed cooldown
   *   aborted → CLOSED (treat probe as inconclusive; do NOT
   *     open the circuit again — the caller abandoned it)
   */
  finishProbe(lease: ProbeLease, outcome: ProbeOutcome): void {
    const owned = this.activeLeases.get(lease.leaseId)
    if (!owned) return
    if (owned.profileId !== lease.profileId) return
    if (!this.probeInFlight.has(lease.profileId)) {
      this.activeLeases.delete(lease.leaseId)
      return
    }
    this.probeInFlight.delete(lease.profileId)
    this.activeLeases.delete(lease.leaseId)
    if (outcome === 'success') {
      this.circuitStates.set(lease.profileId, 'closed')
      this.consecutiveProfileFailures.set(lease.profileId, 0)
    } else if (outcome === 'failure') {
      this.circuitStates.set(lease.profileId, 'open')
      this.circuitOpenedAt.set(lease.profileId, Date.now())
    }
    // 'aborted' → leave circuit state as-is, just clean the lease.
  }

  /** For tests: read the in-flight probe set. */
  getProbeInFlight(): ReadonlySet<string> {
    return this.probeInFlight
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
    // v0.5.3 (P1.8): per-profile circuit filter. Profiles whose
    // circuit is OPEN are excluded from selection. The half-open
    // state allows exactly one probe call so the Router can detect
    // recovery.
    const available = this.profiles.filter(
      (p) => p.available && this.isProfileAvailable(p.id),
    )
    const reasonCodes: string[] = []
    if (available.length === 0) {
      // v0.5.3 Final (task 7): all profiles are in open circuit.
      // The previous implementation silently returned an "empty"
      // decision (`selectedModel=''`, `selectedProfile='default'`),
      // which made it indistinguishable from a successful no-op.
      // We now return an explicit unavailable decision that the
      // caller (Coordinator) MUST treat as a failure.
      const unavailable: RoutingDecision = {
        selectedModel: '',
        selectedProfile: '',
        reasonCodes: ['all-profiles-open', ...reasonCodes],
        confidence: 0,
        estimatedComplexity: 0,
        fallbackChain: [],
        budgetAllocation: {},
      }
      this.lastDecision = unavailable
      return unavailable
    }

    // 1) Manual override always wins (adaptive runtime contract §四.1).
    if (this.manualOverride) {
      const match = available.find((p) => p.model === this.manualOverride)
        ?? available.find((p) => p.id === this.manualOverride)
      const model = match?.model ?? this.manualOverride
      reasonCodes.push('manual-override')
      const overrideComplexity = this.estimateComplexity(input, reasonCodes)
      const decision = this.decide(input, model, match?.id ?? 'manual', reasonCodes, available, 1, overrideComplexity)
      this.lastDecision = decision
      return decision
    }

    // 2) If only one profile is healthy, use it directly. Zero-healthy
    //    falls through to the unreachable all-open block above and
    //    returns the structured unavailable decision.
    if (!this.routing.enabled || available.length === 1) {
      const only = available[0]
      const model = only?.model ?? this.manualOverride ?? ''
      if (!this.routing.enabled) reasonCodes.push('routing-disabled')
      else reasonCodes.push('single-profile')
      const singleComplexity = this.estimateComplexity(input, reasonCodes)
      const decision = this.decide(input, model, only?.id ?? 'default', reasonCodes, available, available.length > 0 ? 0.9 : 0, singleComplexity)
      this.lastDecision = decision
      return decision
    }

    // 3) Estimate task complexity from real signals. v0.5.5 §15:
    //    complexity is computed for THIS input, not inherited
    //    from the lastDecision cache. Every route() path runs
    //    estimateComplexity so manual / single-profile / routing-
    //    disabled / multi-profile branches all share a fresh value.
    const complexity = this.estimateComplexity(input, reasonCodes)

    // 4) Score each available profile against the task needs.
    //    v0.5.5 §13: reasonCodes are profile-scoped. The final
    //    decision's reasonCodes = global + selected-profile codes
    //    only — non-selected unhealthy reasons do NOT leak.
    const scored = available.map((p) => {
      const profileReasons: string[] = []
      return {
        profile: p,
        score: this.scoreProfile(p, input, complexity, profileReasons),
        reasonCodes: profileReasons,
      }
    })
    scored.sort((a, b) => b.score - a.score)

    const best = scored[0]
    const fallbackChain = scored.slice(1).map((s) => s.profile.model)
    const confidence = this.confidence(scored)

    const decision: RoutingDecision = {
      selectedModel: best.profile.model,
      selectedProfile: best.profile.id,
      reasonCodes: dedupe([...reasonCodes, ...best.reasonCodes]),
      confidence,
      estimatedComplexity: complexity,
      fallbackChain,
      budgetAllocation: this.budgetFor(best.profile, input),
      // v0.5.5 §13: per-profile score breakdown for observability.
      // Non-selected unhealthy reasons live here, NOT in reasonCodes.
      profileScores: scored.map((s) => ({
        profileId: s.profile.id,
        score: s.score,
        reasonCodes: s.reasonCodes,
      })),
    }
    this.lastDecision = decision
    return decision
  }

  /**
   * Advance to the next profile in the fallback chain after a provider
   * failure on the CURRENT call. Returns null if the chain is exhausted.
   * Caller MUST only call this at the LLM-call boundary (before tools
   * execute) so no side-effectful tool is ever replayed.
   *
   * v0.5.3 P0-3: does NOT call emitFallback() internally — callers
   * (Coordinator) must explicitly invoke emitFallback() once when they
   * accept the returned profile. Previous behavior double-counted
   * fallbacks (router + caller) and inflated routingFailureStats().
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
    // v0.5.3 Final (P0 issue): the old code used
    //   (input.repoFileCount ?? 0) > 500
    // which fabricated a 0 for the unknown case — anything > 500
    // triggered a "large-repo" bump even when RepoStats was
    // completely unknown. The Collector now passes `undefined` for
    // that path; we honor it here.
    if (input.repoStatsState === 'ready' && typeof input.repoFileCount === 'number' && input.repoFileCount > 500) {
      c += 0.15; reasonCodes.push('large-repo')
    } else if (input.repoStatsState === 'partial' && typeof input.repoFileCount === 'number' && input.repoFileCount > 500) {
      // weak weighting — partial bound could over/under-count.
      c += 0.05; reasonCodes.push('large-repo-partial')
    }
    // empty → repoFileCount === 0: handled implicitly (not a positive signal).
    // unknown → no fabrication, no signal.
    if ((input.filesTouched ?? 0) > 5) { c += 0.1; reasonCodes.push('many-files') }
    if ((input.estimatedImpactFiles ?? 0) > 5) { c += 0.1; reasonCodes.push('large-impact') }
    if ((input.consecutiveFailures ?? 0) > 0) {
      c += Math.min(0.2, (input.consecutiveFailures ?? 0) * 0.05)
      reasonCodes.push('failure-escalation')
    }
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
    // dominate and the strong model always wins. (adaptive runtime contract §四 默认策略.)
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

    // v0.3.1 (runtime truth contract §三.1.3): side-effect tool goals require high
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
    // configurable failureEscalationThreshold (runtime truth contract §三.1.4) —
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
    if ((!h || h.calls < threshold) && input.providerHealth) {
      const remote = input.providerHealth.find((h) => h.profileId === p.id)
      if (remote && remote.failRate > 0.3) {
        score -= remote.failRate * 0.4
        reasonCodes.push(`health-from-collector:${p.id}`)
      }
    }

    // v0.5.5 §14: previousRoutingFailures / totalFallbacksApplied /
    // global consecutive failures / global circuitState are NOT
    // decision inputs. They were session-wide counts that
    // affected every profile identically and never changed the
    // ranking. The Router MUST only consume per-profile data
    // (local recordCall + perProfile providerHealth).

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
    complexity: number,
  ): RoutingDecision {
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
    tier: 'top',
    capabilities: { reasoning: 0.8, coding: 0.8, contextWindow: 128_000, toolCalling: 0.8, speed: 0.7, cost: 0.6 },
    roles: ['main', 'cheap', 'long-context', 'worker'],
    available: true,
  }
  return new ModelRouter([profile], DEFAULT_ROUTING_CONFIG)
}
