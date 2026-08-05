/**
 * RoutingSignalCollector (v0.3.1, runtime truth contract §三.1.3).
 *
 * The single source of truth for "what does the Router know about this
 * turn?" before it scores profiles. Without this collector, callers
 * feed a handful of ad-hoc signals and the Router makes decisions on
 * incomplete evidence. With it, the Router receives a complete,
 * structured snapshot derived from real runtime state (workingState,
 * contextManager, taskGraph, budgetTracker, modelRouter health) plus
 * lightweight static analysis of the goal text.
 *
 * Pure (no I/O) — deterministic given inputs. Unit-testable.
 *
 * Signals runtime truth contract §1.3 explicitly requires (bullets 1..11):
 *   userGoal
 *   repoFileCount
 *   filesTouched
 *   recentFailureCount
 *   contextUsageRatio
 *   budgetRemaining
 *   task role
 *   needsArchitecture          (NOT keyword-only — must combine static
 *                               analysis with task-graph evidence)
 *   provider health
 *   previous routing failures
 *   expected tool requirement
 *
 * Plus the secondary signals runtime truth contract §1.3 calls "should combine":
 *   - estimated impact files
 *   - affects public interface
 *   - is cross-module
 *   - modifies config / architecture
 *   - requires root-cause
 *   - task-graph size
 */
import type { RoutingInput } from './modelRouter.js'

export interface RoutingSignals {
  userGoal: string
  /**
   * v0.5.3 Final (P0 issue): repoFileCount is `number` ONLY when
   * the value is real. undefined means "RepoStats did not produce
   * a number" — Router MUST treat as neutral, never fabricate
   * any default.
   */
  repoFileCount?: number
  /**
   * v0.5.3 Final (P0 issue): repoFileCount provenance. Router
   * uses this to choose how to weight a partial count.
   *  - 'ready'   → use the count exactly
   *  - 'empty'   → repoFileCount is exactly 0
   *  - 'partial' → count is a lower bound; treat weakly
   *  - 'unknown' → repoFileCount is undefined
   */
  repoStatsState?: 'ready' | 'empty' | 'partial' | 'unknown'
  /** True when the count is a partial lower bound. */
  repoStatsLowerBound?: boolean
  filesTouched: number
  recentFailureCount: number
  /** undefined when no reliable context measurement is available. */
  contextUsageRatio?: number
  /** undefined when no budget tracking is wired. */
  budgetRemaining?: number
  role?: string
  needsArchitecture: boolean
  providerHealth: Array<{ profileId: string; failRate: number; avgLatencyMs: number }>
  // v0.5.5 §14: previousRoutingFailures / totalFallbacksApplied /
  // circuitState / consecutiveProviderFailures are NOT decision
  // inputs. Session-wide counts are exposed via
  // getRoutingFailureStats() for observability only.
  manualOverrideActive?: boolean
  // expected tool requirement
  expectedToolRequirement: 'none' | 'read-only' | 'mixed' | 'side-effect'
  // secondary signals (runtime truth contract §1.3 second paragraph)
  affectsPublicInterface: boolean
  isCrossModule: boolean
  isConfigChange: boolean
  requiresRootCause: boolean
  estimatedImpactFiles: number
  taskGraphScale: number
}

/** Minimal view of WorkingState the collector reads (avoids coupling). */
export interface WorkingStateSnapshot {
  filesRead: string[]
  filesChanged: string[]
  verification: { passed: string[]; failed: string[] }
  unresolved: string[]
}

/** Minimal view of TaskGraph the collector reads. */
export interface TaskGraphSnapshot {
  nodeCount: number
  preferredRoles: string[]
  hasConfigChanges: boolean
  hasCrossModuleEdits: boolean
  hasPublicInterfaceEdits: boolean
  hasRootCauseNode: boolean
  /** v0.5.2 (Stage 2.3): precomputed structural impact from the graph.
   *  When supplied, the collector uses it INSTEAD of the booleans
   *  above; the booleans remain for backwards compatibility. */
  aggregateImpact?: {
    maxScope: 'local' | 'module' | 'cross-module' | 'repository' | null
    estimatedFiles: number
  } | null
}

/** Minimal view of ContextManager the collector reads. */
export interface ContextManagerSnapshot {
  /** Estimated fraction of context window used (0..1). undefined = unknown. */
  contextUsageRatio?: number
  /** Tokens still budgeted (0..1 fraction). undefined = unknown. */
  budgetRemaining?: number
  /** Recent LLM failures (rolling count). */
  recentFailureCount: number
}

/** Minimal view of ModelRouter health the collector reads. */
export interface RouterHealthSnapshot {
  providerHealth: Array<{ profileId: string; failRate: number; avgLatencyMs: number }>
  // v0.5.5 §14: previousRoutingFailures / totalFallbacksApplied /
  // circuitState / consecutiveProviderFailures are NOT decision
  // inputs. They were session-wide counts that affected every
  // profile identically and never changed the ranking.
  /** v0.5.3 P0-3: removed (coordinator-local global circuit is
   *  gone). Replaced by per-profile circuit visibility below. */
  circuitState?: 'closed' | 'open' | 'half-open'
  /** @deprecated v0.5.3 P0-3 — per-profile circuit visibility
   *  supersedes this global counter. */
  consecutiveProviderFailures?: number
  /**
   * v0.5.3 P0-3: per-profile circuit visibility. Each entry shows
   * whether the Router would let the profile serve a call right
   * now. When all profiles are open the Router signals unavailable.
   */
  profileCircuits?: Array<{ profileId: string; state: 'closed' | 'open' | 'half-open' }>
  manualOverrideActive?: boolean
}

/**
 * v0.5.2 (Stage 2.2): real repository statistics. The Router treats
 * `repoFileCount` as a complexity signal, but the previous proxy
 * (`filesTouched * 10`) was wildly wrong on cold-start. When supplied,
 * `sourceFileCount` overrides the proxy. `undefined` means "unknown"
 * (failure open, not 0 or 100).
 */
export interface RepoStatsSnapshot {
  rootDir: string
  /** v0.5.3 Final (task 8): the actual state — 'ready', 'empty',
   *  'partial', or 'unknown'. The Router uses this to distinguish a
   *  known-zero repo from a fully-unread one. */
  state?: 'ready' | 'empty' | 'partial' | 'unknown'
  sourceFileCount?: number
  totalFileCount?: number
  /** For partial states, true means the count is a lower bound. */
  lowerBound?: boolean
  reason?: string
}

/** Optional inputs the collector consumes; all may be omitted. */
export interface CollectRoutingSignalsOptions {
  userMessage: string
  workingState?: WorkingStateSnapshot
  contextManager?: ContextManagerSnapshot
  taskGraph?: TaskGraphSnapshot
  routerHealth?: RouterHealthSnapshot
  /** v0.5.2 (Stage 2.2): real repo stats. Omit when unavailable. */
  repoStats?: RepoStatsSnapshot
}

const ARCHITECTURE_KEYWORDS = /\b(architect|refactor|redesign|root[\s_-]?cause|migration|design[\s_-]?decision|restructure|rebuild|overhaul)\b/i
const CONFIG_CHANGE_KEYWORDS = /\b(setting|configuration|config|schema|policy|toml|yaml|\.env|package\.json|tsconfig)\b/i
const CROSS_MODULE_KEYWORDS = /\b(cross[\s_-]?module|across[\s_-]?modules|between[\s_-]?modules|integration[\s_-]?boundary)\b/i
const PUBLIC_INTERFACE_KEYWORDS = /\b(api|public[\s_-]?interface|export|signature|breaking[\s_-]?change|backward[\s_-]?compat|deprecat)\b/i
const ROOT_CAUSE_KEYWORDS = /\b(why|debug|investigate|trace|broken|crash|error|exception|stack[\s_-]?trace)\b/i

/**
 * Decide the expected tool requirement of the goal. Read-only / Q&A
 * goals should not be charged a "side-effect" budget.
 */
function classifyExpectedToolRequirement(goal: string, workingState?: WorkingStateSnapshot): RoutingSignals['expectedToolRequirement'] {
  const text = goal.toLowerCase()
  const mentionsFileWrite = /\b(write|edit|create|implement|add|remove|delete|rename|refactor|fix[\s_-]?bug)\b/.test(text)
  const mentionsCommandRun = /\b(run|test|build|compile|lint|execute|deploy|install|script|command)\b/.test(text)
  if (workingState?.filesChanged && workingState.filesChanged.length > 0) return 'side-effect'
  if (mentionsFileWrite && mentionsCommandRun) return 'side-effect'
  if (mentionsFileWrite) return 'mixed'
  if (mentionsCommandRun) return 'mixed'
  if (text.length < 80) return 'read-only'
  return 'none'
}

export function collectRoutingSignals(opts: CollectRoutingSignalsOptions): RoutingSignals {
  const goal = opts.userMessage ?? ''
  const ws = opts.workingState
  const tg = opts.taskGraph
  const cm = opts.contextManager
  const rh = opts.routerHealth

  const filesTouched = ws
    ? ws.filesRead.length + ws.filesChanged.length
    : 0
  // v0.5.3 Final (P0 issue): repoFileCount is the EXACT sourceFileCount
  // when state='ready' (or empty with count=0). For 'partial' the
  // router treats it as a weak lower bound. For 'unknown' (or no
  // snapshot at all) the router gets `undefined` — it MUST NOT
  // fabricate 100 or any other number. The previous implementation
  // here used `Math.max(filesTouched * 10, 100)` as a fallback,
  // which was a real lie: a zero-file-edit turn was reported as a
  // 100-file repo, triggering spurious model escalations.
  const realCount = opts.repoStats?.sourceFileCount
  const repoStatsState = opts.repoStats?.state
  const repoFileCount =
    repoStatsState === 'ready' && typeof realCount === 'number' && realCount >= 0
      ? realCount
      : repoStatsState === 'empty'
        ? 0
        : (repoStatsState === 'partial' && typeof realCount === 'number' && realCount >= 0)
          ? realCount
          : undefined

  // Static analysis — combine keyword evidence with task-graph
  // evidence so a single keyword match isn't a license to charge
  // "architecture" complexity (runtime truth contract §1.3 second paragraph).
  const keywordArchitecture = ARCHITECTURE_KEYWORDS.test(goal)
  const keywordConfig = CONFIG_CHANGE_KEYWORDS.test(goal)
  const keywordCrossModule = CROSS_MODULE_KEYWORDS.test(goal)
  const keywordPublic = PUBLIC_INTERFACE_KEYWORDS.test(goal)
  const keywordRootCause = ROOT_CAUSE_KEYWORDS.test(goal)

  // v0.5.2 (Stage 2.3): structured impact wins over the legacy booleans.
  // aggregateImpact is computed off TaskNode.impact[] (see TaskGraph.
  // aggregateImpact). When the graph has nodes WITH impact metadata,
  // it is the source of truth; keyword analysis is only a fallback
  // for goals with no decomposed graph.
  const hasStructuralImpact = Boolean(
    tg?.aggregateImpact && tg.aggregateImpact.maxScope !== null,
  )
  const tgArchitecture = tg ? (
    tg.hasConfigChanges
    || tg.hasCrossModuleEdits
    || tg.hasPublicInterfaceEdits
    || tg.hasRootCauseNode
  ) : false

  // Estimated impact: prefer the TaskGraph's precomputed estimate when
  // structural impact exists; otherwise use the legacy heuristic that
  // blends filesChanged + filesRead.
  const estimatedImpactFiles = hasStructuralImpact && tg?.aggregateImpact
    ? Math.max(tg.aggregateImpact.estimatedFiles, ws ? ws.filesChanged.length + Math.min(filesTouched, 12) : 0)
    : ws
      ? ws.filesChanged.length + Math.min(filesTouched, 12)
      : Math.min(goal.length / 240, 12)

  // Multi-file signal that hints at architecture work (runtime truth contract §1.3).
  const manyFiles = filesTouched > 8 || estimatedImpactFiles > 8

  return {
    userGoal: goal,
    repoFileCount,
    repoStatsState,
    repoStatsLowerBound: opts.repoStats?.lowerBound,
    filesTouched,
    recentFailureCount: cm?.recentFailureCount ?? 0,
    contextUsageRatio: cm?.contextUsageRatio,
    budgetRemaining: cm?.budgetRemaining,
    role: tg?.preferredRoles[0],
    needsArchitecture: keywordArchitecture || tgArchitecture || (keywordConfig && manyFiles),
    providerHealth: rh?.providerHealth ?? [],
    manualOverrideActive: rh?.manualOverrideActive,
    expectedToolRequirement: classifyExpectedToolRequirement(goal, ws),
    affectsPublicInterface: keywordPublic || (tg?.hasPublicInterfaceEdits ?? false),
    isCrossModule: keywordCrossModule || (tg?.hasCrossModuleEdits ?? false),
    isConfigChange: keywordConfig || (tg?.hasConfigChanges ?? false),
    requiresRootCause: keywordRootCause || (tg?.hasRootCauseNode ?? false),
    estimatedImpactFiles,
    taskGraphScale: tg?.nodeCount ?? 0,
  }
}

/** Convert collected signals into the Router's RoutingInput. */
export function signalsToRoutingInput(s: RoutingSignals): RoutingInput {
  return {
    userGoal: s.userGoal,
    repoFileCount: s.repoFileCount,
    // v0.5.3 Final (Closure Integrity #1): propagate RepoStats
    // provenance so the Router's estimator can decide whether to
    // weight the count exactly, weakly, or skip entirely.
    repoStatsState: s.repoStatsState,
    repoStatsLowerBound: s.repoStatsLowerBound,
    filesTouched: s.filesTouched,
    consecutiveFailures: s.recentFailureCount,
    contextUsageRatio: s.contextUsageRatio,
    budgetRemaining: s.budgetRemaining,
    role: s.role,
    needsArchitecture: s.needsArchitecture,
    providerHealth: s.providerHealth,
    // v0.5.5 §14: previousRoutingFailures / totalFallbacksApplied /
    // circuitState / consecutiveProviderFailures are NOT
    // propagated. Session-wide counts are exposed via
    // getRoutingFailureStats() for observability only.
    manualOverrideActive: s.manualOverrideActive,
    expectedToolRequirement: s.expectedToolRequirement,
    affectsPublicInterface: s.affectsPublicInterface,
    isCrossModule: s.isCrossModule,
    isConfigChange: s.isConfigChange,
    requiresRootCause: s.requiresRootCause,
    estimatedImpactFiles: s.estimatedImpactFiles,
    taskGraphScale: s.taskGraphScale,
  } satisfies RoutingInput
}
