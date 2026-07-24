/**
 * TaskIntent (v0.3.2, ele_goal §Phase 3).
 *
 * The structured user intent captured at the START of a run. Before
 * v0.3.2 the taskKind was derived from "did files change?" — which
 * meant a mutation that failed to make changes was misclassified as
 * informational. This module makes the intent explicit and is the
 * single source of truth for what a run is trying to accomplish.
 *
 * The intent is constructed BEFORE routing so the CompletionContract
 * and the Routing collector can both consult it.
 */

export type TaskKind = 'informational' | 'analysis' | 'mutation'

export interface AcceptanceCriterion {
  id?: string
  description: string
  satisfied?: boolean
}

export interface VerificationRequirement {
  /** What kind of verification is required (test, type-check, lint, etc.). */
  kind: 'test' | 'typecheck' | 'lint' | 'build' | 'command' | 'review' | 'manual'
  /** Human-readable description of the verification. */
  description: string
  /** True if the requirement has been fulfilled. */
  satisfied?: boolean
}

export interface TaskIntent {
  kind: TaskKind
  /** What the user explicitly asked for (parsed from natural language). */
  requestedOutcomes: string[]
  /** Acceptance criteria explicitly declared by the user or upper agent. */
  explicitAcceptanceCriteria: AcceptanceCriterion[]
  /** Whether the intent involves modifying the workspace. */
  requiresWorkspaceChange: boolean
  /** What verification (if any) is expected to run. */
  expectedVerification: VerificationRequirement[]
  /** Confidence in the classification (0..1). < 0.5 means "could be any kind". */
  confidence: number
  /** How the intent was determined. */
  source: 'static-rule' | 'keyword' | 'classifier-model' | 'user-stated' | 'plan-mode'
  /** The raw user message for audit. */
  userMessage: string
}

/**
 * Static-rule classifier per ele_goal §Phase 3 minimum rules. Returns
 * a TaskIntent with source='static-rule' or 'keyword'. Confidence is
 * 0.6 for keyword matches, 0.95 for explicit plan-mode or user-stated
 * intents. When the static-rule layer can't confidently classify,
 * the caller should fall back to a classifier-model.
 */
export function classifyTaskIntent(userMessage: string, options: {
  planMode?: boolean
  explicitKind?: TaskKind
  explicitAcceptanceCriteria?: AcceptanceCriterion[]
  expectedVerification?: VerificationRequirement[]
}): TaskIntent {
  const text = userMessage.toLowerCase()
  const explicit = options.explicitKind
  const planMode = options.planMode ?? false
  const explicitCriteria = options.explicitAcceptanceCriteria ?? []

  // Highest priority: explicit user-stated kind.
  if (explicit) {
    return {
      kind: explicit,
      requestedOutcomes: extractOutcomes(userMessage),
      explicitAcceptanceCriteria: explicitCriteria,
      requiresWorkspaceChange: explicit === 'mutation',
      expectedVerification: options.expectedVerification ?? [],
      confidence: 0.95,
      source: 'user-stated',
      userMessage,
    }
  }

  // Plan mode is always analysis — even if the user describes a
  // mutation, plan mode means "design before implementing".
  if (planMode) {
    return {
      kind: 'analysis',
      requestedOutcomes: extractOutcomes(userMessage),
      explicitAcceptanceCriteria: explicitCriteria,
      requiresWorkspaceChange: false,
      expectedVerification: options.expectedVerification ?? [],
      confidence: 0.9,
      source: 'plan-mode',
      userMessage,
    }
  }

  // Static-rule layer per ele_goal §Phase 3 minimum rules.
  const mutationKeywords = /\b(fix|implement|refactor|rewrite|add|remove|delete|rename|edit|modify|patch|change|update|build|create|install|configure|set up)\b/
  const analysisKeywords = /\b(audit|analyze|review|design|architect|investigate|examine|explore|inspect|evaluate|assess|describe|explain|plan)\b/
  const informationalKeywords = /\b(what|why|how|when|where|who|explain|summarize|describe|tell me|show|list|find|locate|search|hello|hi)\b/

  if (mutationKeywords.test(text)) {
    return {
      kind: 'mutation',
      requestedOutcomes: extractOutcomes(userMessage),
      explicitAcceptanceCriteria: explicitCriteria,
      requiresWorkspaceChange: true,
      expectedVerification: options.expectedVerification ?? defaultVerificationForMutation(),
      confidence: 0.6,
      source: 'keyword',
      userMessage,
    }
  }
  if (analysisKeywords.test(text)) {
    return {
      kind: 'analysis',
      requestedOutcomes: extractOutcomes(userMessage),
      explicitAcceptanceCriteria: explicitCriteria,
      requiresWorkspaceChange: false,
      expectedVerification: options.expectedVerification ?? [],
      confidence: 0.6,
      source: 'keyword',
      userMessage,
    }
  }
  if (informationalKeywords.test(text)) {
    return {
      kind: 'informational',
      requestedOutcomes: extractOutcomes(userMessage),
      explicitAcceptanceCriteria: explicitCriteria,
      requiresWorkspaceChange: false,
      expectedVerification: [],
      confidence: 0.6,
      source: 'static-rule',
      userMessage,
    }
  }

  // Default: low-confidence informational. Caller should fall back
  // to a classifier model if available.
  return {
    kind: 'informational',
    requestedOutcomes: extractOutcomes(userMessage),
    explicitAcceptanceCriteria: explicitCriteria,
    requiresWorkspaceChange: false,
    expectedVerification: [],
    confidence: 0.3,
    source: 'static-rule',
    userMessage,
  }
}

function extractOutcomes(message: string): string[] {
  // Split on semicolons / periods that look like list items.
  return message
    .split(/[;\n]/)
    .map((s) => s.trim())
    .filter((s) => s.length > 5 && s.length < 200)
    .slice(0, 5)
}

function defaultVerificationForMutation(): VerificationRequirement[] {
  return [
    { kind: 'typecheck', description: 'Project type-check passes after edits.' },
    { kind: 'lint', description: 'Lint passes after edits.' },
  ]
}