/**
 * WorkingState — structured task state (fi_goal.md §七 Phase 6 / Round 8).
 *
 * Replaces ad-hoc reliance on free-text conversation summaries for
 * carrying long-term task context. The state is:
 *
 *   - objective         : what we're trying to accomplish
 *   - constraints       : hard limits / rules the model must obey
 *   - confirmedFacts    : things we KNOW are true (verified)
 *   - decisions         : choices made + their rationale
 *   - filesRead         : files inspected (paths only)
 *   - filesChanged      : files modified (paths only)
 *   - verification      : passed / failed command lists
 *   - unresolved        : open questions / blockers
 *   - nextActions       : the next concrete steps
 *   - artifacts         : references to logs / diffs / reports
 *
 * ## Compaction invariants
 *
 * WorkingState lives OUTSIDE the message log — when the engine compacts
 * the conversation, the WorkingState is re-rendered into the next
 * system prompt verbatim. Therefore:
 *
 *   INV-1  constraints NEVER silently disappear across compaction
 *   INV-2  confirmedFacts NEVER silently disappear across compaction
 *   INV-3  filesChanged is preserved (so the model knows what it edited)
 *   INV-4  verification.failed is preserved (so the model doesn't repeat
 *          a broken command)
 *   INV-5  unresolved is preserved (so open questions don't get dropped)
 *
 * The invariant checker (`assertCompactionInvariants`) is exported so
 * tests + runtime can call it after every compaction.
 */

import type { ArtifactRef } from './executionRun.js'

// ── Types ───────────────────────────────────────────────────────────────

export interface Fact {
  /** Short human-readable statement, e.g. "engine.ts uses ESM imports". */
  claim: string
  /** Where we learned it (file path, tool name, URL). Optional. */
  source?: string
  /** ISO timestamp the fact was confirmed. */
  confirmedAt?: string
}

export interface Decision {
  /** The choice that was made. */
  choice: string
  /** Why we made it (1-2 sentences). */
  rationale: string
  /** ISO timestamp. */
  decidedAt?: string
}

export interface WorkingState {
  objective: string
  constraints: string[]

  confirmedFacts: Fact[]
  decisions: Decision[]

  filesRead: string[]
  filesChanged: string[]

  verification: {
    passed: string[]
    failed: string[]
  }

  unresolved: string[]
  nextActions: string[]

  artifacts: ArtifactRef[]
}

export function emptyWorkingState(objective = ''): WorkingState {
  return {
    objective,
    constraints: [],
    confirmedFacts: [],
    decisions: [],
    filesRead: [],
    filesChanged: [],
    verification: { passed: [], failed: [] },
    unresolved: [],
    nextActions: [],
    artifacts: [],
  }
}

// ── Mutators (return new state; never mutate in place) ──────────────────

export function addConstraint(state: WorkingState, constraint: string): WorkingState {
  if (state.constraints.includes(constraint)) return state
  return { ...state, constraints: [...state.constraints, constraint] }
}

export function addFact(state: WorkingState, fact: Fact): WorkingState {
  // Dedupe by claim text — same fact from multiple sources is one fact.
  if (state.confirmedFacts.some((f) => f.claim === fact.claim)) {
    return {
      ...state,
      confirmedFacts: state.confirmedFacts.map((f) =>
        f.claim === fact.claim
          ? { ...f, source: fact.source ?? f.source, confirmedAt: fact.confirmedAt ?? f.confirmedAt }
          : f,
      ),
    }
  }
  return { ...state, confirmedFacts: [...state.confirmedFacts, fact] }
}

export function addDecision(state: WorkingState, decision: Decision): WorkingState {
  return { ...state, decisions: [...state.decisions, decision] }
}

export function recordFileRead(state: WorkingState, path: string): WorkingState {
  if (state.filesRead.includes(path)) return state
  return { ...state, filesRead: [...state.filesRead, path] }
}

export function recordFileChange(state: WorkingState, path: string): WorkingState {
  if (state.filesChanged.includes(path)) return state
  return { ...state, filesChanged: [...state.filesChanged, path] }
}

export function recordVerification(
  state: WorkingState,
  command: string,
  passed: boolean,
): WorkingState {
  const next = { ...state.verification }
  if (passed) {
    if (!next.passed.includes(command)) {
      next.passed = [...next.passed, command]
    }
    next.failed = next.failed.filter((c) => c !== command)
  } else {
    if (!next.failed.includes(command)) {
      next.failed = [...next.failed, command]
    }
    next.passed = next.passed.filter((c) => c !== command)
  }
  return { ...state, verification: next }
}

export function resolveUnresolved(state: WorkingState, item: string): WorkingState {
  return { ...state, unresolved: state.unresolved.filter((u) => u !== item) }
}

export function pushNextAction(state: WorkingState, action: string): WorkingState {
  if (state.nextActions.includes(action)) return state
  return { ...state, nextActions: [...state.nextActions, action] }
}

export function shiftNextAction(state: WorkingState): WorkingState {
  const [, ...rest] = state.nextActions
  return { ...state, nextActions: rest }
}

export function addArtifact(state: WorkingState, artifact: ArtifactRef): WorkingState {
  if (state.artifacts.some((a) => a.id === artifact.id)) return state
  return { ...state, artifacts: [...state.artifacts, artifact] }
}

// ── Serialization ────────────────────────────────────────────────────────

/**
 * Render WorkingState as a single text block suitable for inclusion in
 * the system prompt. Format is YAML-ish: stable, scannable, and
 * diff-friendly across compaction cycles.
 */
export function serializeWorkingState(state: WorkingState): string {
  const lines: string[] = []
  lines.push('# WorkingState (structured task context)')
  lines.push('')
  lines.push(`objective: ${multiLine(state.objective)}`)

  if (state.constraints.length > 0) {
    lines.push('constraints:')
    for (const c of state.constraints) lines.push(`  - ${c}`)
  }

  if (state.confirmedFacts.length > 0) {
    lines.push('confirmedFacts:')
    for (const f of state.confirmedFacts) {
      const src = f.source ? `  (source: ${f.source})` : ''
      lines.push(`  - ${f.claim}${src}`)
    }
  }

  if (state.decisions.length > 0) {
    lines.push('decisions:')
    for (const d of state.decisions) {
      lines.push(`  - choice: ${d.choice}`)
      lines.push(`    rationale: ${d.rationale}`)
    }
  }

  if (state.filesRead.length > 0) {
    lines.push('filesRead:')
    for (const p of state.filesRead) lines.push(`  - ${p}`)
  }

  if (state.filesChanged.length > 0) {
    lines.push('filesChanged:')
    for (const p of state.filesChanged) lines.push(`  - ${p}`)
  }

  if (state.verification.passed.length > 0 || state.verification.failed.length > 0) {
    lines.push('verification:')
    if (state.verification.passed.length > 0) {
      lines.push('  passed:')
      for (const c of state.verification.passed) lines.push(`    - ${c}`)
    }
    if (state.verification.failed.length > 0) {
      lines.push('  failed:')
      for (const c of state.verification.failed) lines.push(`    - ${c}`)
    }
  }

  if (state.unresolved.length > 0) {
    lines.push('unresolved:')
    for (const u of state.unresolved) lines.push(`  - ${u}`)
  }

  if (state.nextActions.length > 0) {
    lines.push('nextActions:')
    for (const a of state.nextActions) lines.push(`  - ${a}`)
  }

  if (state.artifacts.length > 0) {
    lines.push('artifacts:')
    for (const a of state.artifacts) {
      lines.push(`  - id: ${a.id}  kind: ${a.kind}${a.path ? `  path: ${a.path}` : ''}`)
    }
  }

  lines.push('')
  lines.push('# End of WorkingState')
  return lines.join('\n')
}

function multiLine(s: string): string {
  // Single-line objective is the common case. For multi-line, wrap in quotes.
  if (!s.includes('\n')) return s
  return JSON.stringify(s)
}

// ── Compaction invariants ────────────────────────────────────────────────

export class CompactionInvariantError extends Error {
  constructor(
    public readonly violations: ReadonlyArray<CompactionViolation>,
  ) {
    super(`compaction invariant violations: ${violations.map((v) => v.field).join(', ')}`)
    this.name = 'CompactionInvariantError'
  }
}

export interface CompactionViolation {
  field: string
  detail: string
}

/**
 * Compute the diff between two WorkingStates from before and after a
 * compaction cycle. Returns the list of fields whose contents shrank
 * (a "shrink" means an item present before is now absent).
 *
 * Used by tests + runtime to enforce that compaction doesn't silently
 * drop critical state.
 */
export function compactionViolations(
  before: WorkingState,
  after: WorkingState,
): CompactionViolation[] {
  const out: CompactionViolation[] = []

  // INV-1: constraints
  const droppedConstraints = before.constraints.filter((c) => !after.constraints.includes(c))
  if (droppedConstraints.length > 0) {
    out.push({
      field: 'constraints',
      detail: `dropped: ${droppedConstraints.join('; ')}`,
    })
  }

  // INV-2: confirmedFacts
  const beforeClaims = new Set(before.confirmedFacts.map((f) => f.claim))
  const afterClaims = new Set(after.confirmedFacts.map((f) => f.claim))
  const droppedFacts = [...beforeClaims].filter((c) => !afterClaims.has(c))
  if (droppedFacts.length > 0) {
    out.push({
      field: 'confirmedFacts',
      detail: `dropped ${droppedFacts.length} fact(s)`,
    })
  }

  // INV-3: filesChanged (additive only)
  const droppedChanges = before.filesChanged.filter((p) => !after.filesChanged.includes(p))
  if (droppedChanges.length > 0) {
    out.push({
      field: 'filesChanged',
      detail: `dropped: ${droppedChanges.join('; ')}`,
    })
  }

  // INV-4: verification.failed (must not lose entries — re-running a
  // known-failing command wastes tokens + can mask regressions)
  const droppedFailed = before.verification.failed.filter(
    (c) => !after.verification.failed.includes(c),
  )
  if (droppedFailed.length > 0) {
    out.push({
      field: 'verification.failed',
      detail: `dropped: ${droppedFailed.join('; ')}`,
    })
  }

  // INV-5: unresolved
  const droppedUnresolved = before.unresolved.filter((u) => !after.unresolved.includes(u))
  if (droppedUnresolved.length > 0) {
    out.push({
      field: 'unresolved',
      detail: `dropped: ${droppedUnresolved.join('; ')}`,
    })
  }

  return out
}

/**
 * Throw CompactionInvariantError if `after` lost any protected field
 * from `before`. The caller should pass the snapshot taken BEFORE the
 * compaction call as `before`, and the merged state (after the model
 * has had a chance to refine) as `after`.
 */
export function assertCompactionInvariants(
  before: WorkingState,
  after: WorkingState,
): void {
  const violations = compactionViolations(before, after)
  if (violations.length > 0) {
    throw new CompactionInvariantError(violations)
  }
}

// ── Context assembly ────────────────────────────────────────────────────

/**
 * Build the next system prompt by combining the stable system prompt
 * with the rendered WorkingState. This is the structured replacement
 * for embedding state in conversation summaries.
 *
 * The WorkingState block is placed AFTER the stable prompt so it
 * reads as context, not as instruction — preventing prompt injection
 * from the objective field from escalating privileges.
 */
export function assembleSystemPrompt(
  stableSystemPrompt: string,
  state: WorkingState | undefined,
): string {
  if (!state) return stableSystemPrompt
  const block = serializeWorkingState(state)
  return `${stableSystemPrompt}\n\n${block}`
}

/**
 * Determine the effective context budget for a model. The budget is
 * the model's max context minus a headroom reserve for the response
 * and the rendered WorkingState.
 *
 * fi_goal.md §七 requires: "模型切换后重新计算上下文预算"
 * (recompute context budget after model switch). The caller should
 * invoke this whenever the active model changes.
 */
export function effectiveContextBudget(opts: {
  modelMaxContextTokens: number
  responseReserveTokens: number
  workingState: WorkingState | undefined
}): number {
  const stateTokens = opts.workingState
    ? Math.ceil(serializeWorkingState(opts.workingState).length / 3.5)
    : 0
  return Math.max(
    0,
    opts.modelMaxContextTokens - opts.responseReserveTokens - stateTokens,
  )
}
