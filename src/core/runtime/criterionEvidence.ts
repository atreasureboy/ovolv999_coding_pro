/**
 * CriterionEvidence (v0.3.2, ele_goal §Phase 5).
 *
 * Per-criterion proof of satisfaction. The TaskGraph previously
 * tracked only a `string[]` of satisfied criteria — the names alone
 * were taken as truth, with no way to distinguish "the model said it
 * was satisfied" from "verification actually ran". This module makes
 * the evidence structured and required.
 *
 * Phase 5 enforces:
 *   - Each criterion has an independent evidence record
 *   - evidenceType must be one of the supported kinds (test, command,
 *     file-change, review, user-confirmation, manual)
 *   - Verification failed → status locked to 'failed', not 'satisfied'
 *   - Mutation tasks without explicit evidence cannot be completed
 */

export type EvidenceType =
  | 'test'
  | 'command'
  | 'file-change'
  | 'review'
  | 'user-confirmation'
  | 'manual'

export type EvidenceStatus = 'unknown' | 'satisfied' | 'failed'

export interface CriterionEvidence {
  criterionId: string
  status: EvidenceStatus
  evidenceType: EvidenceType
  /** Optional reference (test name, command output line, file path, etc.). */
  evidenceRef?: string
  /** Notes from the verifier (e.g. "tests/test_x.ts::test_y PASSED"). */
  evidenceNote?: string
  recordedAt: number
}

export interface CriterionEvidenceStore {
  /** Record evidence for a criterion. Returns the result. */
  record(evidence: CriterionEvidence): void
  /** Look up the current evidence for a criterion. */
  get(criterionId: string): CriterionEvidence | undefined
  /** All evidence for a TaskNode (keyed by criterionId). */
  forNode(nodeId: string): CriterionEvidence[]
  /** Compute the satisfied count for a TaskNode. */
  satisfiedCount(nodeId: string, criteriaIds: string[]): number
  /** All recorded evidence. */
  all(): CriterionEvidence[]
  clear(): void
}

export class InMemoryCriterionEvidenceStore implements CriterionEvidenceStore {
  private readonly store = new Map<string, CriterionEvidence[]>()

  record(evidence: CriterionEvidence): void {
    const list = this.store.get(evidence.criterionId) ?? []
    // Replace previous evidence for the same criterionId (latest wins).
    const filtered = list.filter((e) => e.criterionId !== evidence.criterionId)
    filtered.push(evidence)
    this.store.set(evidence.criterionId, filtered)
  }

  get(criterionId: string): CriterionEvidence | undefined {
    const list = this.store.get(criterionId)
    return list?.[list.length - 1]
  }

  forNode(nodeId: string): CriterionEvidence[] {
    // We key by criterionId. The nodeId is a prefix convention
    // (`<nodeId>::<idx>`) so we filter by prefix.
    const out: CriterionEvidence[] = []
    for (const [key, list] of this.store) {
      if (key.startsWith(`${nodeId}::`)) {
        const last = list[list.length - 1]
        if (last) out.push(last)
      }
    }
    return out
  }

  satisfiedCount(nodeId: string, criteriaIds: string[]): number {
    let n = 0
    for (const id of criteriaIds) {
      const e = this.get(`${nodeId}::${id}`)
      if (e && e.status === 'satisfied') n++
    }
    return n
  }

  all(): CriterionEvidence[] {
    const out: CriterionEvidence[] = []
    for (const list of this.store.values()) {
      const last = list[list.length - 1]
      if (last) out.push(last)
    }
    return out
  }

  clear(): void {
    this.store.clear()
  }
}