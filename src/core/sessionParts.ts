/**
 * Session Part Store — append-only message/part persistence
 * (opencode's Session/Message/Part model, adapted to this codebase's
 * single-history-array runtime).
 *
 * Round 42 gap #1: every save rewrote the ENTIRE history.json envelope —
 * O(history) file writes per turn and O(history) memory forever. The
 * part store fixes the write side with an append-only JSONL ledger:
 *
 *   <sessionDir>/parts.jsonl
 *     {"kind":"meta","schema":"ovogo.parts.v1","title":...,"lastOutcome":...}
 *     {"kind":"msg","seq":0,"msg":{role,content,tool_calls,...}}
 *     {"kind":"msg","seq":1,...}
 *     {"kind":"msg","seq":2,"msg":{...},"superseded":true}   (never — see below)
 *
 * Design:
 *   - APPEND-only for the message stream. History is the conversation
 *     ledger; /clear starts a new session, compaction REWRITES via a
 *     full-file replacement (rare, bounded), so the hot path is pure
 *     append: one small write + fsync per save.
 *   - `meta` records (title, lastOutcome) are UPSERTS: a fresh meta line
 *     is appended and the LOADER takes the LAST one — no rewrite needed.
 *   - The last line may be torn (crash mid-append). The loader skips a
 *     truncated tail; the .bak of the previous envelope remains the
 *     recovery floor.
 *   - Readers: full read via readAll() (compat layer materializes the
 *     same OpenAIMessage[] the runtime uses today), paged read via
 *     readPage(cursor) for future UI/observability consumers.
 *   - Coexistence: when parts.jsonl exists it is the source of truth;
 *     history.json keeps being written (compat export for older tooling)
 *     ONLY when a full rewrite happens anyway (compaction). Migration is
 *     lazy: first save with the store writes parts.jsonl; loading falls
 *     back to the v2 envelope when the ledger is absent.
 */

import { existsSync, readFileSync, writeFileSync, unlinkSync, renameSync, statSync, openSync, writeSync, fsyncSync, closeSync } from 'fs'
import { join } from 'path'
import type { OpenAIMessage } from './types.js'
import type { OutcomeSummary } from './sessionManager.js'

export const PARTS_SCHEMA = 'ovogo.parts.v1'
export const PARTS_FILENAME = 'parts.jsonl'

export interface PartsMeta {
  schema: string
  title?: string
  lastOutcome?: OutcomeSummary
  updatedAt?: string
}

export interface PartsReadResult {
  messages: OpenAIMessage[]
  meta: PartsMeta
  /** Number of well-formed ledger lines skipped (torn tail etc.). */
  skippedTorn: number
}

interface MetaRecord {
  kind: 'meta'
  schema: string
  title?: string
  lastOutcome?: OutcomeSummary
  updatedAt?: string
}

interface MsgRecord {
  kind: 'msg'
  seq: number
  msg: OpenAIMessage
}

type LedgerRecord = MetaRecord | MsgRecord

export interface PageResult {
  messages: OpenAIMessage[]
  /** Cursor for the next page; null when the ledger is exhausted. */
  nextCursor: number | null
}

/**
 * Durable append: write + fsync + close per call. Matches the envelope
 * writer's durability contract (a power loss must not lose committed
 * turns) while keeping cost O(line) instead of O(history).
 */
function appendLineSync(sessionDir: string, line: string): void {
  appendLinesSync(sessionDir, [line])
}

/** Durable batch append: ONE open+write+fsync+close for all lines. */
function appendLinesSync(sessionDir: string, lines: string[]): void {
  const path = join(sessionDir, PARTS_FILENAME)
  let fd: number | null = null
  try {
    fd = openSync(path, 'a')
    writeSync(fd, lines.join('\n') + '\n', null, 'utf8')
    fsyncSync(fd)
  } finally {
    if (fd !== null) {
      try { closeSync(fd) } catch { /* best-effort */ }
    }
  }
}

/**
 * Append one message to the ledger. Cheap by design: one durable line
 * per save — never a full-history rewrite.
 */
export function appendMessage(sessionDir: string, msg: OpenAIMessage, seq: number): void {
  const rec: MsgRecord = { kind: 'msg', seq, msg: { ...msg } }
  appendLineSync(sessionDir, JSON.stringify(rec))
}

/** Upsert meta (title/lastOutcome) by appending a new meta line. */
export function appendMeta(sessionDir: string, meta: Partial<PartsMeta>): void {
  const rec: MetaRecord = { kind: 'meta', schema: PARTS_SCHEMA, ...meta, updatedAt: new Date().toISOString() }
  appendLineSync(sessionDir, JSON.stringify(rec))
}

/** Full rewrite of the ledger (compaction, /clear-style resets). */
export function rewriteLedger(sessionDir: string, messages: OpenAIMessage[], meta: Partial<PartsMeta>): void {
  const lines: string[] = [
    JSON.stringify({ kind: 'meta', schema: PARTS_SCHEMA, ...meta, updatedAt: new Date().toISOString() } satisfies MetaRecord),
    ...messages.map((m, i) => JSON.stringify({ kind: 'msg', seq: i, msg: m } satisfies MsgRecord)),
  ]
  const payload = lines.join('\n') + (lines.length > 0 ? '\n' : '')
  // Same atomic convention as the rest of the codebase: tmp + rename.
  const finalPath = join(sessionDir, PARTS_FILENAME)
  const tmpPath = `${finalPath}.tmp.${process.pid}.${Date.now()}`
  writeFileSync(tmpPath, payload, 'utf8')
  renameSync(tmpPath, finalPath)
}

/** Does this session dir have a parts ledger? */
export function hasPartsLedger(sessionDir: string): boolean {
  return existsSync(join(sessionDir, PARTS_FILENAME))
}

function isMsgRecord(value: unknown): value is MsgRecord {
  if (!value || typeof value !== 'object') return false
  const r = value as Record<string, unknown>
  return r.kind === 'msg' && typeof r.seq === 'number' && !!r.msg && typeof r.msg === 'object'
}

function isMetaRecord(value: unknown): value is MetaRecord {
  if (!value || typeof value !== 'object') return false
  const r = value as Record<string, unknown>
  return r.kind === 'meta' && r.schema === PARTS_SCHEMA
}

/**
 * Read the whole ledger. A torn trailing line (crash mid-append) is
 * skipped and counted — never fatal. Ordering is FILE ORDER (the append
 * stream is authoritative; `seq` is informational).
 */
export function readParts(sessionDir: string): PartsReadResult {
  const path = join(sessionDir, PARTS_FILENAME)
  const result: PartsReadResult = { messages: [], meta: { schema: PARTS_SCHEMA }, skippedTorn: 0 }
  if (!existsSync(path)) return result

  let raw: string
  try {
    raw = readFileSync(path, 'utf8')
  } catch {
    return result
  }
  const lines = raw.split('\n')
  // A trailing '\n' produces one empty last element — ignore it.
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (line === undefined || line.trim() === '') continue
    // Only the FINAL line may be torn; a torn line in the middle means
    // interleaved corruption — stop reading there (data after it is
    // untrustworthy) rather than skipping.
    let parsed: unknown
    try {
      parsed = JSON.parse(line)
    } catch {
      if (i === lines.length - 1) {
        result.skippedTorn++
        continue
      }
      break
    }
    if (isMetaRecord(parsed)) {
      // Upsert semantics: later meta lines win field-by-field. Same
      // validation discipline as the envelope gates — a malformed title
      // (non-string / overlong) is dropped, never trusted.
      const titleOk = typeof parsed.title === 'string' && parsed.title.trim().length > 0 && parsed.title.length <= 120
      const outcomeOk = parsed.lastOutcome === undefined
        || (typeof parsed.lastOutcome === 'object' && parsed.lastOutcome !== null
          && 'status' in (parsed.lastOutcome as unknown as Record<string, unknown>))
      result.meta = {
        ...result.meta,
        ...(titleOk ? { title: parsed.title } : {}),
        ...(outcomeOk ? { lastOutcome: parsed.lastOutcome } : {}),
        ...(parsed.updatedAt !== undefined ? { updatedAt: parsed.updatedAt } : {}),
      }
    } else if (isMsgRecord(parsed)) {
      result.messages.push(parsed.msg)
    }
    // Unknown record kinds are ignored (forward compatibility).
  }
  return result
}

/**
 * Paged read (opencode MessageV2.page pattern): returns up to `limit`
 * messages starting at `cursor` (a seq index). Newest-first consumers
 * can iterate pages backward via nextCursor.
 */
export function readPage(sessionDir: string, cursor: number, limit = 50): PageResult {
  const { messages } = readParts(sessionDir)
  if (cursor >= messages.length) return { messages: [], nextCursor: null }
  const slice = messages.slice(cursor, cursor + limit)
  const next = cursor + limit
  return { messages: slice, nextCursor: next < messages.length ? next : null }
}

/**
 * Append the DELTA between the persisted ledger and the live history.
 * The common per-turn save becomes: 0..N appended lines (just the new
 * messages) + a meta upsert — never a full rewrite. Returns the number
 * of appended messages.
 *
 * Mismatch detection: if the persisted prefix diverges from the live
 * history (compaction rewrote memory, fork/resume swapped arrays, or an
 * external edit), the ledger is REWRITTEN to match — correctness first,
 * the rewrite is the rare path.
 */
export function appendDelta(
  sessionDir: string,
  history: OpenAIMessage[],
  meta?: Partial<PartsMeta>,
): number {
  const existing = readParts(sessionDir)
  const persisted = existing.messages

  let commonPrefix = 0
  const max = Math.min(persisted.length, history.length)
  while (commonPrefix < max && ledgerEquals(persisted[commonPrefix], history[commonPrefix])) {
    commonPrefix++
  }

  if (commonPrefix < persisted.length) {
    // History was truncated/rewritten upstream (compaction) — rewrite.
    rewriteLedger(sessionDir, history, { ...existing.meta, ...meta })
    return history.length
  }

  return appendDeltaFrom(sessionDir, history, commonPrefix, meta)
}

/**
 * Round 45: append a caller-COMPUTED delta (no second ledger read).
 * All lines — new messages + optional meta upsert — are joined and
 * written in ONE open+write+fsync: appending to a single-stream ledger
 * is atomic per write, and the torn-tail reader already handles a
 * truncated final line, so batching cannot corrupt. Cuts a 20-message
 * turn from 21 fsyncs to 1.
 */
export function appendDeltaFrom(
  sessionDir: string,
  history: OpenAIMessage[],
  persistedCount: number,
  meta?: Partial<PartsMeta>,
): number {
  const lines: string[] = []
  for (let i = persistedCount; i < history.length; i++) {
    const rec: MsgRecord = { kind: 'msg', seq: i, msg: { ...history[i] } }
    lines.push(JSON.stringify(rec))
  }
  if (meta) {
    const rec: MetaRecord = { kind: 'meta', schema: PARTS_SCHEMA, ...meta, updatedAt: new Date().toISOString() }
    lines.push(JSON.stringify(rec))
  }
  if (lines.length > 0) appendLinesSync(sessionDir, lines)
  return history.length - persistedCount
}

/** Structural equality for ledger-vs-live comparison (JSON-stable fields). */
function ledgerEquals(a: OpenAIMessage | undefined, b: OpenAIMessage | undefined): boolean {
  if (!a || !b) return false
  return JSON.stringify(a) === JSON.stringify(b)
}

/** Ledger byte size (observability / diagnostics). */
export function partsLedgerSize(sessionDir: string): number {
  try {
    return statSync(join(sessionDir, PARTS_FILENAME)).size
  } catch {
    return 0
  }
}

/** Remove the ledger (session teardown / test isolation). */
export function deletePartsLedger(sessionDir: string): void {
  try {
    const p = join(sessionDir, PARTS_FILENAME)
    if (existsSync(p)) unlinkSync(p)
  } catch {
    /* best-effort */
  }
}
