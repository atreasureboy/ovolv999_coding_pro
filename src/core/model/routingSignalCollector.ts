/**
 * RoutingSignalCollector (v0.3.1, te_goal §三.1.3).
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
 * Signals te_goal.md §1.3 explicitly requires (bullets 1..11):
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
 * Plus the secondary signals te_goal §1.3 calls "should combine":
 *   - estimated impact files
 *   - affects public interface
 *   - is cross-module
 *   - modifies config / architecture
 *   - requires root-cause
 *   - task-graph size
 */
import type { RoutingInput } from './modelRouter.js'

export interface RoutingSignals {
  // required by Router.route
  userGoal: string
  // numeric / structural state
  repoFileCount: number
  filesTouched: number
  recentFailureCount: number
  contextUsageRatio: number
  budgetRemaining: number
  // role hint (for child / worker routing)
  role?: string
  // architecture heuristic
  needsArchitecture: boolean
  // health & history
  providerHealth: Array<{ profileId: string; failRate: number; avgLatencyMs: number }>
  previousRoutingFailures: number
  // expected tool requirement
  expectedToolRequirement: 'none' | 'read-only' | 'mixed' | 'side-effect'
  // secondary signals (te_goal §1.3 second paragraph)
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
}

/** Minimal view of ContextManager the collector reads. */
export interface ContextManagerSnapshot {
  /** Estimated fraction of context window used (0..1). */
  contextUsageRatio: number
  /** Tokens still budgeted (0..1 fraction). */
  budgetRemaining: number
  /** Recent LLM failures (rolling count). */
  recentFailureCount: number
}

/** Minimal view of ModelRouter health the collector reads. */
export interface RouterHealthSnapshot {
  providerHealth: Array<{ profileId: string; failRate: number; avgLatencyMs: number }>
  previousRoutingFailures: number
}

/** Optional inputs the collector consumes; all may be omitted. */
export interface CollectRoutingSignalsOptions {
  userMessage: string
  workingState?: WorkingStateSnapshot
  contextManager?: ContextManagerSnapshot
  taskGraph?: TaskGraphSnapshot
  routerHealth?: RouterHealthSnapshot
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
  const repoFileCount = Math.max(filesTouched * 10, 100) // cheap proxy until a real count exists

  // Static analysis — combine keyword evidence with task-graph
  // evidence so a single keyword match isn't a license to charge
  // "architecture" complexity (te_goal §1.3 second paragraph).
  const keywordArchitecture = ARCHITECTURE_KEYWORDS.test(goal)
  const keywordConfig = CONFIG_CHANGE_KEYWORDS.test(goal)
  const keywordCrossModule = CROSS_MODULE_KEYWORDS.test(goal)
  const keywordPublic = PUBLIC_INTERFACE_KEYWORDS.test(goal)
  const keywordRootCause = ROOT_CAUSE_KEYWORDS.test(goal)

  const tgArchitecture = tg ? (
    tg.hasConfigChanges
    || tg.hasCrossModuleEdits
    || tg.hasPublicInterfaceEdits
    || tg.hasRootCauseNode
  ) : false

  // Estimated impact: number of files expected to change.
  const estimatedImpactFiles = ws ? ws.filesChanged.length + Math.min(filesTouched, 12) : Math.min(goal.length / 240, 12)

  // Multi-file signal that hints at architecture work (te_goal §1.3).
  const manyFiles = filesTouched > 8 || estimatedImpactFiles > 8

  return {
    userGoal: goal,
    repoFileCount,
    filesTouched,
    recentFailureCount: cm?.recentFailureCount ?? 0,
    contextUsageRatio: cm?.contextUsageRatio ?? 0,
    budgetRemaining: cm?.budgetRemaining ?? 1,
    role: tg?.preferredRoles[0],
    needsArchitecture: keywordArchitecture || tgArchitecture || (keywordConfig && manyFiles),
    providerHealth: rh?.providerHealth ?? [],
    previousRoutingFailures: rh?.previousRoutingFailures ?? 0,
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
    filesTouched: s.filesTouched,
    consecutiveFailures: s.recentFailureCount + s.previousRoutingFailures,
    contextUsageRatio: s.contextUsageRatio,
    budgetRemaining: s.budgetRemaining,
    role: s.role,
    needsArchitecture: s.needsArchitecture,
  } satisfies RoutingInput
}