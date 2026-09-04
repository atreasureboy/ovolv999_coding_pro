/**
 * Evidence System (v0.3.5).
 *
 * Replaces model self-declaration of acceptance criteria with structured,
 * verifiable evidence. Each evidence record is tied to a run, a node,
 * optionally a criterion, and a revision number. When code changes
 * (revision increments), prior evidence becomes stale automatically.
 *
 * The model can only SUBMIT evidence via record_evidence — the system
 * computes criterion satisfaction, not the model.
 */

export type EvidenceKind =
  | 'command_result'
  | 'test_result'
  | 'build_result'
  | 'file_change'
  | 'artifact'
  | 'analysis_result'
  | 'user_confirmation'

export interface TaskEvidence {
  id: string
  runId: string
  nodeId: string
  criterionId?: string
  kind: EvidenceKind
  summary: string
  source: string
  command?: string
  exitCode?: number
  artifactPath?: string
  artifactHash?: string
  revision: number
  createdAt: string
  valid: boolean
  invalidReason?: string
}

export type CriterionStatus = 'pending' | 'satisfied' | 'failed' | 'stale'

export interface CriterionState {
  id: string
  description: string
  status: CriterionStatus
  evidenceId?: string
}

export class EvidenceStore {
  private readonly evidence = new Map<string, TaskEvidence[]>()
  private currentRevision = 0

getRevision(): number {
    return this.currentRevision
  }

  /**
   * Runtime truth contract §evidence: the revision is the workspace-mutation
   * counter. record() stamps the CURRENT revision; a bump invalidates every
   * record stamped earlier — getValidEvidence() only counts records from the
   * current revision, so evidence cannot outlive the code state it was
   * observed on. Returns the new revision.
   */
  bumpRevision(): number {
    return ++this.currentRevision
  }

  record(evidence: Omit<TaskEvidence, 'id' | 'revision' | 'createdAt' | 'valid'>): TaskEvidence {
    const full: TaskEvidence = {
      ...evidence,
      id: `ev_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      revision: this.currentRevision,
      createdAt: new Date().toISOString(),
      valid: true,
    }
    const list = this.evidence.get(evidence.nodeId) ?? []
    list.push(full)
    this.evidence.set(evidence.nodeId, list)
    return full
  }

  /** Get all valid evidence for a node (optionally filtered by criterion).
   *  Valid = not invalidated AND stamped at the current revision — anything
   *  older describes a code state that no longer exists. */
  getValidEvidence(nodeId: string, criterionId?: string): TaskEvidence[] {
    const list = this.evidence.get(nodeId) ?? []
    return list.filter((e) =>
      e.valid
      && e.revision === this.currentRevision
      && (!criterionId || e.criterionId === criterionId))
  }

  /** Compute criterion status from evidence. */
  computeCriterionStatus(nodeId: string, criterionId: string, description: string): CriterionState {
    const valid = this.getValidEvidence(nodeId, criterionId)
    if (valid.length === 0) {
      // Check if there's stale evidence (invalidated, or pre-dates a revision bump)
      const all = (this.evidence.get(nodeId) ?? []).filter((e) => e.criterionId === criterionId)
      const hasStale = all.some((e) => !e.valid || e.revision !== this.currentRevision)
      const hasFailed = all.some((e) => e.exitCode !== undefined && e.exitCode !== 0)
      if (hasFailed) return { id: criterionId, description, status: 'failed' }
      if (hasStale) return { id: criterionId, description, status: 'stale' }
      return { id: criterionId, description, status: 'pending' }
    }
    // Valid evidence exists — check if any indicates failure
    const hasFailure = valid.some((e) => e.exitCode !== undefined && e.exitCode !== 0)
    if (hasFailure) return { id: criterionId, description, status: 'failed' }
    // All valid evidence is positive
    const lastValid = valid[valid.length - 1]
    return { id: criterionId, description, status: 'satisfied', evidenceId: lastValid?.id }
  }

  /** Compute all criterion statuses for a node. */
  computeAllCriteria(nodeId: string, criteria: Array<{ id: string; description: string }>): CriterionState[] {
    return criteria.map((c) => this.computeCriterionStatus(nodeId, c.id, c.description))
  }

  /** Get all evidence for a run (for debugging/trace). */
  forRun(runId: string): TaskEvidence[] {
    const out: TaskEvidence[] = []
    for (const list of this.evidence.values()) {
      out.push(...list.filter((e) => e.runId === runId))
    }
    return out
  }

  /** Clear all evidence (per-run reset). */
  clear(): void {
    this.evidence.clear()
    this.currentRevision = 0
  }

}
