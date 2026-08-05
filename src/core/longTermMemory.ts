/**
 * LongTermMemory — unified memory convergence (runtime architecture contract §八 Phase 7 / Round 9).
 *
 * Replaces ad-hoc storage across SemanticMemory / EpisodicMemory /
 * KnowledgeBase / TeamMemory with a single contract that enforces the
 * six spec'd requirements:
 *
 *   R1  Verification gate — failed tasks don't get written
 *   R2  Source marking     — Reflection results must be tagged
 *   R3  Commit binding     — code-related memories carry a commit hash
 *   R4  Expiration         — stale memories can be invalidated by TTL
 *   R5  Conflict-aware     — duplicates don't overwrite; they merge
 *   R6  Embedding-optional — pluggable, never required for write/read
 *
 * The spec recommends SQLite + FTS5. SQLite is NOT a current dep, so
 * the default backend is JSONL (matching existing SemanticMemory).
 * The `MemoryBackend` interface lets a SQLite/FTS5 implementation
 * drop in later without touching the gates.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'fs'
import { createHash, randomUUID } from 'crypto'
import { dirname, join } from 'path'
import { homedir } from 'os'

// ── Types ───────────────────────────────────────────────────────────────

export type MemoryKind =
  | 'semantic'    // durable fact ("engine uses ESM")
  | 'episodic'    // event ("on 2026-01-01, npm test failed")
  | 'procedural'  // recipe ("to run tests: vitest run")
  | 'reflection'  // derived from self-reflection (must mark source)
  | 'failure'     // v0.5.3 (P0.4): a failed run's lesson — verified=false
  | 'artifact'    // metadata about a generated artifact

export interface MemoryRecord {
  /** Stable id (assigned on first write). */
  id: string
  /** What kind of memory this is. */
  kind: MemoryKind
  /** Free-text content. */
  content: string

  /** Repo URL or absolute path. Required so memory is scoped. */
  repo: string
  /** Branch name. Optional. */
  branch?: string
  /** v0.5.3 Closure (P6/P7): baseCommit is the canonical git HEAD
   * at write-time. The legacy `commit` field is preserved as an
   * alias for back-compat with tests that pre-date the rename. */
  baseCommit?: string
  /** @deprecated Use `baseCommit`. Kept so existing call-sites
   *  that pre-date the rename do not break at compile-time. */
  commit?: string
  /** v0.5.3 Final (P0 issue): working-tree dirty flag. Code-bound
   *  entries from a dirty repo MUST carry diffHash, NOT commit. */
  dirty?: boolean
  /** v0.5.3 Final (P0 issue): sha256-prefix of git diff output. Required
   *  for code-bound entries from a dirty repo. */
  diffHash?: string
  /** v0.5.3 Final (P0 issue): for non-Git paths, sha256(cwd + mtime).
   *  Required for code-bound entries in non-git repos. */
  workspaceHash?: string

  /** Run that produced this memory. Required. */
  sourceRunId: string
  /** Tool/module that wrote it (for R2 source marking). */
  origin: string

  /** 0..1 confidence. */
  confidence: number
  /** Whether the source run's verification passed (R1 gate). */
  verified: boolean

  /** Optional tags for filtering. */
  tags: string[]

  /** ISO timestamp of first write. */
  createdAt: string
  /** Optional absolute TTL — records with expiresAt < now are dropped on read. */
  expiresAt?: string

  /**
   * Optional embedding vector (R6 — never required). When present,
   * backends may persist it alongside content for similarity search.
   */
  embedding?: number[]
}

/** Input shape for `record()` — id/createdAt are assigned by the store. */
export type MemoryRecordInput = Omit<MemoryRecord, 'id' | 'createdAt'>

/**
 * v0.5.3 Closure Integrity (P4): in-memory backend.
 *
 * Contract per the spec:
 *   - upsert(record) with the same id REPLACES the previous record,
 *     not appends. Map<id, MemoryRecord> is the natural shape.
 *   - load(now) returns each id at most once; TTL is honored here
 *     for parity with JsonlMemoryBackend.
 *   - delete(id) is idempotent.
 *   - Return order: insertion order (id ascends with creation).
 */
export class InMemoryMemoryBackend implements MemoryBackend {
  private readonly records = new Map<string, MemoryRecord>()

  upsert(record: MemoryRecord): void {
    this.records.set(record.id, record)
  }

  load(now: string): MemoryRecord[] {
    const out: MemoryRecord[] = []
    for (const r of this.records.values()) {
      // TTL parity with JsonlMemoryBackend.
      if (r.expiresAt && r.expiresAt < now) continue
      out.push(r)
    }
    return out
  }

  delete(id: string): void {
    this.records.delete(id)
  }
}

// ── Errors ──────────────────────────────────────────────────────────────

export class MemoryVerificationError extends Error {
  constructor(public readonly record: MemoryRecordInput) {
    super(`refusing to write unverified memory (run ${record.sourceRunId})`)
    this.name = 'MemoryVerificationError'
  }
}

export class MemoryCommitBindingError extends Error {
  constructor(public readonly record: MemoryRecordInput) {
    super(`code-related memory must bind to a commit (kind=${record.kind})`)
    this.name = 'MemoryCommitBindingError'
  }
}

export class MemoryConflictError extends Error {
  constructor(
    public readonly incoming: MemoryRecordInput,
    public readonly existing: MemoryRecord,
    public readonly reason: string,
  ) {
    super(`memory conflict (${reason})`)
    this.name = 'MemoryConflictError'
  }
}

// ── Backend interface ───────────────────────────────────────────────────

/**
 * Pluggable persistence backend. The default JSONL backend lives in
 * this file; a SQLite/FTS5 backend can implement the same surface.
 */
export interface MemoryBackend {
  /** Persist a new or updated record. */
  upsert(record: MemoryRecord): void
  /** Return all non-expired records (expiration enforced here, not by callers). */
  load(now: string): MemoryRecord[]
  /** Delete by id. */
  delete(id: string): void
}

// ── Heuristic: does this content reference code? ────────────────────────

const CODE_INDICATORS = [
  /\.(ts|js|tsx|jsx|py|go|rs|java|c|cc|cpp|h|hpp|rb|php|swift|kt|scala)\b/,
  /\bfunction\s+\w+/,
  /\bclass\s+\w+/,
  /\bimport\s+/,
  /\bexport\s+/,
  /\bdef\s+\w+/,
  /\brequire\s*\(/,
  /\bnpm\s+(install|test|run)\b/,
  /\bpnpm\s+/,
  /\bgit\s+(commit|push|merge|rebase)\b/,
]

export function referencesCode(content: string): boolean {
  return CODE_INDICATORS.some((re) => re.test(content))
}

// ── Content hashing for conflict detection (R5) ─────────────────────────
//
// v0.5.3 Closure (P7): the contentKey MUST include the RevisionBinding
// so that identical content seen from different branches / diffHashes
// / workspaceHashes does NOT accidentally merge across revisions.
// Without revision in the key, a fact observed on `branch=main@HEAD=abc`
// would silently merge with the same fact observed on
// `branch=main@HEAD=def` — losing provenance for both.
//   key = sha256(
//     repo | branch | baseCommit | dirty | diffHash | workspaceHash
//         | kind | normalized content)

function contentKey(rec: MemoryRecord | MemoryRecordInput): string {
  const h = createHash('sha256')
  h.update(rec.repo ?? '')
  h.update('\x00')
  h.update(rec.branch ?? '')
  h.update('\x00')
  h.update(rec.baseCommit ?? '')
  h.update('\x00')
  h.update(String(rec.dirty ?? false))
  h.update('\x00')
  h.update(rec.diffHash ?? '')
  h.update('\x00')
  h.update(rec.workspaceHash ?? '')
  h.update('\x00')
  h.update(rec.kind)
  h.update('\x00')
  h.update(rec.content.trim().toLowerCase())
  return h.digest('hex')
}

// ── Default JSONL backend ───────────────────────────────────────────────

/**
 * Simple append-only JSONL backend. Each line is a JSON record.
 * Updates are written as a new line with the same `id`; `load()`
 * collapses to the last write per id.
 */
export class JsonlMemoryBackend implements MemoryBackend {
  private readonly filePath: string

  constructor(filePath: string) {
    this.filePath = filePath
    if (existsSync(filePath)) return
    mkdirSync(dirname(filePath), { recursive: true })
    writeFileSync(filePath, '', { flag: 'wx' })
  }

  upsert(record: MemoryRecord): void {
    mkdirSync(dirname(this.filePath), { recursive: true })
    appendFileSync(this.filePath, JSON.stringify(record) + '\n')
  }

  load(now: string): MemoryRecord[] {
    if (!existsSync(this.filePath)) return []
    const raw = readFileSync(this.filePath, 'utf8')
    const lines = raw.split('\n').filter(Boolean)
    const byId = new Map<string, MemoryRecord>()
    for (const line of lines) {
      let rec: MemoryRecord
      try {
        rec = JSON.parse(line) as MemoryRecord
      } catch {
        continue // corrupted line — skip
      }
      // Enforce TTL on read.
      if (rec.expiresAt && rec.expiresAt < now) {
        byId.delete(rec.id)
        continue
      }
      byId.set(rec.id, rec)
    }
    return [...byId.values()]
  }

  delete(id: string): void {
    if (!existsSync(this.filePath)) return
    const raw = readFileSync(this.filePath, 'utf8')
    const lines = raw.split('\n').filter(Boolean)
    const kept: string[] = []
    for (const line of lines) {
      try {
        const rec = JSON.parse(line) as MemoryRecord
        if (rec.id !== id) kept.push(line)
      } catch {
        kept.push(line) // preserve corrupted lines as-is
      }
    }
    if (kept.length === 0) {
      unlinkSync(this.filePath)
    } else {
      // Atomic-ish rewrite.
      const tmp = `${this.filePath}.tmp`
      writeFileSync(tmp, kept.join('\n') + '\n')
      renameSync(tmp, this.filePath)
    }
  }
}

// ── Default project path ────────────────────────────────────────────────

export function defaultMemoryPath(repo: string): string {
  const slug = repo.replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-+|-+$/g, '').toLowerCase() || 'default'
  return join(homedir(), '.ovogo', 'projects', slug, 'memory', 'longterm.jsonl')
}

// ── LongTermMemory facade ───────────────────────────────────────────────

export interface LongTermMemoryOptions {
  backend?: MemoryBackend
  /**
   * When true, R1 (verification gate) is downgraded to a warning —
   * useful for tests and for the Reflection subsystem that legitimately
   * records negative findings. Default false.
   */
  allowUnverified?: boolean
  /**
   * When true, R3 (commit binding for code memories) is skipped.
   * Default false.
   */
  allowCodeWithoutCommit?: boolean
  /**
   * Override "now" for tests. Default: new Date().toISOString()
   */
  now?: () => string
}

export class LongTermMemory {
  private readonly backend: MemoryBackend
  private readonly allowUnverified: boolean
  private readonly allowCodeWithoutCommit: boolean
  private readonly now: () => string

  constructor(opts: LongTermMemoryOptions = {}) {
    this.backend = opts.backend ?? new JsonlMemoryBackend(defaultMemoryPath('default'))
    this.allowUnverified = opts.allowUnverified ?? false
    this.allowCodeWithoutCommit = opts.allowCodeWithoutCommit ?? false
    this.now = opts.now ?? (() => new Date().toISOString())
  }

  /**
   * Write a memory record. Applies every spec'd gate (R1-R6):
   *
   *   R1 — rejects when verified=false (unless allowUnverified)
   *   R2 — Reflection records carry origin='reflection:*'
   *   R3 — code-referencing semantic/procedural records require commit
   *   R4 — caller-supplied expiresAt is honored; TTL enforced on read
   *   R5 — conflicts merge into the existing record (higher confidence
   *        wins; ties go to higher sourceRank; never overwrite a
   *        verified record with an unverified one)
   *   R6 — embedding is passed through if supplied
   */
  record(input: MemoryRecordInput): MemoryRecord {
    // R2 — Reflection source marking.
    if (input.kind === 'reflection' && !input.origin.startsWith('reflection')) {
      throw new Error(
        `reflection memory must have origin starting with 'reflection:' (got ${input.origin})`,
      )
    }

    // R1 — Verification gate. `failure` entries are audit records of
    // a failed run — they MUST be writable even without a verified
    // flag because the run's own failure is exactly what makes
    // verification impossible. The conflict-aware merge (R5) still
    // prevents a failure entry from clobbering a verified success
    // entry.
    //
    // v0.5.3 Final (task 2): the user_stated shortcut is GONE. We
    // no longer trust origin strings. user_stated promotion only
    // happens through MemoryPromoter.decidePromotion(), which
    // verifies the sourceQuote against the original user message
    // and stamps origin='user_prompt' on success.
    if (!input.verified && !this.allowUnverified && input.kind !== 'failure') {
      throw new MemoryVerificationError(input)
    }

    // R3 — Commit binding for code references. `failure` entries
    // never require a commit — the run itself failed, so we can't
    // bind to a known-good state. The audit trail records the
    // failure without committing it as a project fact.
    //
    // v0.5.3 Final (P0 issue): R3 now accepts commit OR (diffHash
    // when dirty) OR (workspaceHash when non-git). The previous
    // check rejected entries that had a workspaceHash but no
    // commit — silently dropping code experiences from non-git
    // repos. Now we accept the right binding per repo state.
    if (
      !this.allowCodeWithoutCommit &&
      input.kind !== 'failure' &&
      (input.kind === 'semantic' || input.kind === 'procedural') &&
      referencesCode(input.content) &&
      !input.commit &&
      !(input.dirty && input.diffHash) &&
      !input.workspaceHash
    ) {
      throw new MemoryCommitBindingError(input)
    }

    const now = this.now()
    const existing = this.backend.load(now)

    // R5 — Conflict-aware merge.
    const key = contentKey(input)
    const priorWithSameContent = existing.find((r) => contentKey(r as MemoryRecordInput) === key)
    if (priorWithSameContent) {
      const merged = this.mergeConflict(priorWithSameContent, input)
      this.backend.upsert(merged)
      return merged
    }

    const record: MemoryRecord = {
      id: `mem_${randomUUID()}`,
      createdAt: now,
      ...input,
    }
    this.backend.upsert(record)
    return record
  }

  /**
   * Query the memory store. Returns matching records sorted by
   * descending confidence, then descending createdAt (most-recent
   * first when tied).
   */
  query(filter: MemoryQueryFilter = {}): MemoryRecord[] {
    const now = this.now()
    let records = this.backend.load(now)
    if (filter.repo) records = records.filter((r) => r.repo === filter.repo)
    if (filter.branch) records = records.filter((r) => r.branch === filter.branch)
    if (filter.kind) records = records.filter((r) => r.kind === filter.kind)
    if (filter.verified !== undefined) {
      records = records.filter((r) => r.verified === filter.verified)
    }
    if (filter.tag) {
      records = records.filter((r) => r.tags.includes(filter.tag!))
    }
    if (filter.sourceRunId) {
      records = records.filter((r) => r.sourceRunId === filter.sourceRunId)
    }
    if (filter.fullText) {
      const needle = filter.fullText.toLowerCase()
      records = records.filter((r) => r.content.toLowerCase().includes(needle))
    }
    if (filter.notExpiredBefore) {
      records = records.filter(
        (r) => !r.expiresAt || r.expiresAt >= filter.notExpiredBefore!,
      )
    }
    records.sort((a, b) => {
      if (b.confidence !== a.confidence) return b.confidence - a.confidence
      return b.createdAt.localeCompare(a.createdAt)
    })
    if (filter.limit) records = records.slice(0, filter.limit)
    return records
  }

  /** Drop expired records permanently. Returns the count removed. */
  collectGarbage(): number {
    const now = this.now()
    const all = this.backend.load(now) // already excludes expired
    const expiredIds = new Set(this.scanExpired(now))
    for (const id of expiredIds) this.backend.delete(id)
    void all
    return expiredIds.size
  }

  /** Delete by id. */
  delete(id: string): void {
    this.backend.delete(id)
  }

  /** Total record count (excluding TTL-expired). */
  size(): number {
    return this.backend.load(this.now()).length
  }

  // ── Internal ────────────────────────────────────────────────────────

  private scanExpired(now: string): string[] {
    // Re-read raw to find TTL-expired entries that load() filtered out.
    if (!(this.backend instanceof JsonlMemoryBackend)) return []
    if (!existsSync(this.backend['filePath'])) return []
    const raw = readFileSync(this.backend['filePath'], 'utf8')
    const lines = raw.split('\n').filter(Boolean)
    const expired: string[] = []
    for (const line of lines) {
      let rec: MemoryRecord
      try {
        rec = JSON.parse(line) as MemoryRecord
      } catch {
        continue
      }
      if (rec.expiresAt && rec.expiresAt < now) expired.push(rec.id)
    }
    return expired
  }

  private mergeConflict(existing: MemoryRecord, incoming: MemoryRecordInput): MemoryRecord {
    // R5: never overwrite a verified record with an unverified one.
    if (existing.verified && !incoming.verified) {
      // Tag the existing record's confidence upward if the new source
      // corroborates it, but don't lose the verification.
      return {
        ...existing,
        confidence: Math.min(1, existing.confidence + 0.05),
        tags: dedupe([...existing.tags, ...incoming.tags]),
      }
    }
    // Otherwise: higher confidence wins. Ties → keep existing (more stable).
    if (incoming.confidence > existing.confidence) {
      return {
        ...existing,
        content: incoming.content,
        confidence: incoming.confidence,
        commit: incoming.commit ?? existing.commit,
        branch: incoming.branch ?? existing.branch,
        tags: dedupe([...existing.tags, ...incoming.tags]),
        embedding: incoming.embedding ?? existing.embedding,
        verified: incoming.verified || existing.verified,
        expiresAt: incoming.expiresAt ?? existing.expiresAt,
        origin: incoming.origin,
      }
    }
    // Incoming does not exceed existing — just merge tags.
    return {
      ...existing,
      tags: dedupe([...existing.tags, ...incoming.tags]),
      embedding: incoming.embedding ?? existing.embedding,
    }
  }
}

// ── Filter ──────────────────────────────────────────────────────────────

export interface MemoryQueryFilter {
  repo?: string
  branch?: string
  kind?: MemoryKind
  verified?: boolean
  tag?: string
  sourceRunId?: string
  fullText?: string
  /** Lower bound on expiresAt. */
  notExpiredBefore?: string
  limit?: number
}

// ── Helpers ─────────────────────────────────────────────────────────────

function dedupe<T>(arr: T[]): T[] {
  return [...new Set(arr)]
}
