/**
 * TaskIntent (v0.3.2, run-scoped runtime contract §Phase 3).
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

/**
 * English interrogative leads — "how do I…", "what does…", "explain…".
 * Shared by classifyTaskIntent (mutation suppression) and the execution-
 * verification gates (prematureHandoff, coordinator): a question that
 * CONTAINS an execution verb is still a question, so it must not be
 * demanded commands or file changes.
 */
const QUESTION_LEAD = /^\s*(?:please\s+)?(?:explain|describe|clarify|tell\s+me|show\s+me|walk\s+me\s+through)\b|^\s*(?:how\s+(?:do|does|did|can|could|would|should|to)\b|what\s+(?:is|are|was|were|does|do|did)\b|why\s+(?:is|are|was|were|does|do|did|would|should)\b|where\s+(?:is|are|was|were|does|do|did|can|would)\b|whether\b)/i

export function isInterrogativeLead(message: string): boolean {
  return QUESTION_LEAD.test(message)
}

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
 * Static-rule classifier per run-scoped runtime contract §Phase 3 minimum rules. Returns
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
} = {}): TaskIntent {
  const text = userMessage.toLowerCase()
  const explicit = options.explicitKind
  const planMode = options.planMode ?? false
  const explicitCriteria = options.explicitAcceptanceCriteria ?? []
  const projectExploration = /(?:读取|阅读|了解|熟悉|查看|审查|分析)[\s\S]{0,20}(?:项目|仓库|代码库)|(?:项目|仓库|代码库)[\s\S]{0,20}(?:读取|阅读|了解|熟悉|查看|审查|分析)|(?:进一步|继续|深入)[\s\S]{0,12}(?:读取|阅读|了解|查看|分析)|\b(?:read|inspect|explore|understand|review|audit)\b[\s\S]{0,40}\b(?:project|repository|repo|codebase)\b|\b(?:project|repository|repo|codebase)\b[\s\S]{0,40}\b(?:read|inspect|explore|understand|review|audit)\b/i.test(userMessage)
  const mutationKeywords = /\b(fix|implement|refactor|rewrite|write|add|remove|delete|rename|edit|modify|patch|change|update|build|create|install|configure|set up|polish|redesign)\b|(修复|修改|实现|增加|新增|删除|重构|迁移|替换|优化|补充测试|改造|接入|完善|美化|重新设计|调整界面|升级界面|改进界面)/
  const analysisKeywords = /\b(audit|analyze|review|design|architect|investigate|examine|explore|inspect|evaluate|assess|describe|explain|plan|verify|validate|check|test|diagnose|troubleshoot)\b|(审计|分析|检查|评估|设计|给出方案|研究|对比|解释架构|验证|测试|诊断|排查)/
  const mutationStartsWith = /^\s*(fix|implement|refactor|rewrite|write|add|remove|delete|rename|edit|modify|patch|change|update|build|create|install|configure|set up|polish|redesign|修复|修改|实现|增加|新增|删除|重构|迁移|替换|优化)/i.test(text)
  const mutationAfterAnalysis = /\b(?:and|then|after(?:wards)?)\s+(?:fix|implement|refactor|rewrite|add|remove|edit|modify|patch|change|update|build|create|install|configure)\b|(?:并|然后|之后|后|并且|且)[，,\s]*(?:修复|修改|实现|增加|新增|删除|重构|迁移|替换|优化|补充测试|改造|接入|完善)/i
  // An interrogative lead asks ABOUT the verbs rather than requesting them
  // ("how do I configure X", "what does the update script do") — the same
  // subject-vs-request distinction as mutationWordIsAnalysisSubject, for
  // questions. An explicit connector re-fires mutation ("…and then fix it").
  // Chinese how-words are excluded deliberately: 怎么/如何 in a coding
  // request are usually imperative ("怎么修复登录bug" = fix it).
  const questionOverridesMutation = QUESTION_LEAD.test(text) && !mutationAfterAnalysis.test(text)
  // The mutation word appears only as the OBJECT of analysis/deliberation
  // (“评估迁移风险”, "assess whether to refactor", "…before you implement
  // anything") — suppress mutation UNLESS an explicit connector re-fires
  // (“分析X并修复Y” stays mutation). English half mirrors the Chinese one.
  const mutationWordIsAnalysisSubject = new RegExp(
    '(?:评估|研究|分析|审计|检查)[\\s\\S]{0,12}(?:迁移风险|迁移方案|竞品实现|现有实现|实现方式|实现逻辑)\\s*$'
    + '|\\b(?:assess|evaluate|analyze|analyse|study|review|audit|examine|investigate)\\b[\\s\\S]{0,24}(?:the\\s+)?(?:migration|refactor\\w*|rewrite|redesign|re-?architect\\w*)[\\s\\S]{0,16}$'
    + '|\\b(?:whether|if)\\s+to\\s+(?:fix|implement|refactor|rewrite|migrate|rebuild|replace|remove|delete|add|change|update)\\b'
    + '|\\bbefore\\s+(?:you\\s+|we\\s+|i\\s+)?(?:fix|implement|refactor|rewrite|migrate|rebuild|replace|touch|change|update|edit|modify)\\b',
    'i',
  ).test(text)
  const requestsMutation = mutationKeywords.test(text)
    && (!mutationWordIsAnalysisSubject || mutationAfterAnalysis.test(text))
    && !questionOverridesMutation

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

  if (projectExploration && !requestsMutation) {
    return {
      kind: 'analysis',
      requestedOutcomes: extractOutcomes(userMessage),
      explicitAcceptanceCriteria: explicitCriteria,
      requiresWorkspaceChange: false,
      expectedVerification: [{ kind: 'review', description: 'Representative project areas were inspected before reporting.' }],
      confidence: 0.9,
      source: 'static-rule',
      userMessage,
    }
  }

  // v0.3.3 (background autonomy contract §Phase 3): bilingual (EN + ZH) keyword matching.
  // Mutation keywords: 修复/修改/实现/增加/新增/删除/重构/迁移/替换/优化代码/补充测试/改造/接入/完善
  // Analysis keywords: 审计/分析/检查/评估/设计/给出方案/研究/对比/解释架构
  // Informational keywords: 解释/说明/回答/总结/翻译/查询
  const informationalKeywords = /\b(what|why|how|when|where|who|explain|summarize|describe|tell me|show|list|find|locate|search|hello|hi)\b|(解释|说明|回答|总结|翻译|查询|是什么|怎么做|为什么|你是谁|谁是|什么是|如何|多少|哪里|哪个|哪些)/

  if (requestsMutation) {
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
  if (mutationKeywords.test(text) && !questionOverridesMutation) {
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

  return {
    kind: 'informational',
    requestedOutcomes: extractOutcomes(userMessage),
    explicitAcceptanceCriteria: explicitCriteria,
    requiresWorkspaceChange: false,
    expectedVerification: options.expectedVerification ?? [],
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
