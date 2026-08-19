import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, unlinkSync, openSync, writeSync, fsyncSync, closeSync, statSync } from 'fs'
import { join, resolve, basename } from 'path'
import { randomBytes } from 'crypto'
import type { OpenAIMessage, ToolCall } from './types.js'
import type { TurnOutcome } from './runtime/turnOutcome.js'
import { warnOnce } from '../utils/warnOnce.js'

export interface SessionInfo {
  dir: string
  name: string
  messages: number
}

/** Matches the default timestamped directory names produced by createSessionDir. */
const SESSION_DIR_PREFIX = 'session_'

// ── persistence envelope ────────────────────────────────────────────────────
//
// All `history.json` files written by ovogogogo are wrapped in an envelope so
// that schema evolution has a single, explicit decision point — we can detect
// and migrate on load instead of guessing from file shape or filename.
//
// Supported versions form a contiguous range [MIN_SUPPORTED_VERSION..CURRENT_VERSION].
// Files with version OUTSIDE that range throw UnknownSessionVersionError so
// callers see an actionable error rather than silent corruption.

/** The schema this binary writes. Bump when the on-disk shape changes. */
export const CURRENT_SESSION_VERSION = 2

/** The lowest version this binary still understands (>= will migrate; < will reject). */
export const MIN_SUPPORTED_VERSION = 1

/** Schema name — human-readable identifier separate from numeric version. */
export const CURRENT_SESSION_SCHEMA = 'ovogo.session.v2'

/** v1 schema name — retained so SCHEMA_FOR_VERSION validates legacy files. */
export const V1_SESSION_SCHEMA = 'ovogo.session.v1'

/**
 * v0.4.1 WS7 (session truth): the persisted summary of the last turn's
 * outcome. /resume and /sessions read the REAL verdict from here instead
 * of guessing "changed files ⇒ Completed". Fields mirror TurnOutcome but
 * are JSON-safe scalars/arrays only.
 */
export interface OutcomeSummary {
  /** The completion-contract verdict status that actually ended the turn. Never guessed. */
  status: string
  changedFiles: string[]
  verification: { executed: boolean; passed: boolean }
  blockers: string[]
  requiredNextActions: string[]
  /** The model that finally answered (fallback-aware). */
  lastModel?: string
  durationMs?: number
}

export interface SessionEnvelope {
  version: number
  schema: string
  /** Last write time. New envelopes always populate this. Validated as ISO. */
  updatedAt: string
  messages: OpenAIMessage[]
  /**
   * v2 only: the last turn's outcome truth. Absent in v1 files and in v2
   * files saved before any turn completed — listings render 'unknown'
   * for those, NEVER a guess.
   */
  lastOutcome?: OutcomeSummary
}

/**
 * Canonical schema name for an envelope at a given version. The map keeps
 * `version` (numeric) tightly bound to `schema` (string) so a file claiming
 * to be version 1 with a wrong schema name is rejected as corrupt, not
 * silently loaded as something else. Add an entry here when introducing a
 * new version.
 */
const SCHEMA_FOR_VERSION: Readonly<Record<number, string>> = Object.freeze({
  1: V1_SESSION_SCHEMA,
  [CURRENT_SESSION_VERSION]: CURRENT_SESSION_SCHEMA,
})

/** Thrown when a session's history.json was written by an unsupported version. */
export class UnknownSessionVersionError extends Error {
  readonly version: number
  readonly minSupported: number
  readonly maxSupported: number
  constructor(sessionDir: string, version: number, minSupported: number, maxSupported: number) {
    super(
      `Session at ${sessionDir} uses history version ${version}, ` +
      `but this build of ovogogogo only supports versions ${minSupported}..${maxSupported}. ` +
      `Upgrade ovogogogo to load this session, or move the directory aside to continue.`,
    )
    this.name = 'UnknownSessionVersionError'
    this.version = version
    this.minSupported = minSupported
    this.maxSupported = maxSupported
  }
}

/** Thrown when a session cannot be unambiguously resolved from user input. */
export class SessionNotFoundError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SessionNotFoundError'
  }
}

/** Thrown when --resume input matches multiple sessions. */
export class AmbiguousSessionError extends Error {
  readonly matches: string[]
  constructor(matches: string[]) {
    super(`Ambiguous session reference: ${matches.length} sessions match — provide a longer prefix`)
    this.name = 'AmbiguousSessionError'
    this.matches = matches
  }
}

/** Thrown when a session's history.json exists but cannot be parsed. */
export class CorruptSessionError extends Error {
  constructor(
    readonly sessionDir: string,
    readonly kind: 'json-corrupt' | 'schema-incompatible' | 'permission-denied' | 'truncated' | 'invalid-message' | 'io-error',
    cause: unknown,
  ) {
    super((cause as Error)?.message ?? String(cause))
    this.name = 'CorruptSessionError'
  }
}

export function formatSessionLoadDiagnostic(error: unknown, sessionDir: string): string {
  const historyPath = join(sessionDir, 'history.json')
  const backupPath = `${historyPath}.bak`
  let reason = error instanceof Error ? error.message : String(error)
  let recovery = `Restore ${backupPath}, or move the damaged session directory aside.`
  if (error instanceof UnknownSessionVersionError) {
    reason = `schema-incompatible: history version ${error.version} is outside supported range ${error.minSupported}..${error.maxSupported}`
    recovery = `Upgrade ovolv999, or move ${sessionDir} aside before starting a new session.`
  } else if (error instanceof CorruptSessionError) {
    reason = `${error.kind}: ${error.message}`
    if (error.kind === 'permission-denied') {
      recovery = `Grant read access to ${historyPath}, then retry.`
    }
  }
  return [
    'Session load failed.',
    `Path: ${historyPath}`,
    `Reason: ${reason}`,
    `Recovery: ${recovery}`,
    `Backup: ${backupPath}`,
  ].join('\n')
}

function assertNonEmpty(value: string, name: string): void {
  if (typeof value !== 'string' || value.length === 0) {
    throw new TypeError(`${name} must be a non-empty string`)
  }
}

function isSessionDirName(name: string): boolean {
  return name.startsWith(SESSION_DIR_PREFIX)
}

const VALID_ROLES = new Set<OpenAIMessage['role']>(['system', 'user', 'assistant', 'tool'])

/**
 * Validate the *shape* of a single tool call inside an assistant message.
 * A tool_call MUST look like:
 *   { id: string, type: 'function', function: { name: string, arguments: string } }
 *
 * This deep check rejects garbage that the shallow "tool_calls is an array"
 * test would let through — e.g. an item whose `function` is a string, or
 * whose `arguments` is an object. The engine reads these fields directly
 * when reconstructing an API call, so malformed items can cause runtime 400s.
 */
function isValidToolCallShape(tc: unknown): tc is ToolCall {
  if (!tc || typeof tc !== 'object' || Array.isArray(tc)) return false
  const t = tc as Record<string, unknown>
  if (typeof t.id !== 'string' || t.id.length === 0) return false
  if (t.type !== 'function') return false
  if (!t.function || typeof t.function !== 'object' || Array.isArray(t.function)) return false
  const fn = t.function as Record<string, unknown>
  if (typeof fn.name !== 'string' || fn.name.length === 0) return false
  if (typeof fn.arguments !== 'string') return false
  return true
}

/**
 * Validate the *shape* of a single message without dropping anything that the
 * engine hasn't strictly required. The point is to keep obviously malformed
 * entries (e.g. a JSON number where a role string is expected) out of the
 * engine, while tolerating legacy history files that may have been written
 * by an earlier version with fewer or extra optional fields.
 *
 * For `tool_calls` we additionally deep-validate each item — see
 * {@link isValidToolCallShape}. A non-array `tool_calls` is corrupt; an
 * array containing a malformed item is also corrupt.
 *
 * For `role: 'tool'` we REQUIRE a non-empty `tool_call_id`: the OpenAI-
 * compatible API rejects orphan tool results (rows that lack an anchor
 * back to an assistant `tool_calls[i].id`) as malformed conversation turns.
 * Letting such a row through at write time and catching it later at the
 * provider boundary is worse than rejecting it here — the engine would
 * have to choose between silently dropping the tool message (data loss)
 * or surfacing a 400 from the API mid-turn. Both are worse than a clear
 * save-time error pointing at the bad index.
 */
function isValidMessageShape(msg: unknown): msg is OpenAIMessage {
  if (!msg || typeof msg !== 'object') return false
  const m = msg as Record<string, unknown>
  if (typeof m.role !== 'string' || !VALID_ROLES.has(m.role as OpenAIMessage['role'])) return false
  if (m.content !== null && typeof m.content !== 'string') return false
  // Optional fields — accept when present, tolerate absence for old formats.
  if (m.tool_calls !== undefined) {
    if (!Array.isArray(m.tool_calls)) return false
    for (let i = 0; i < m.tool_calls.length; i++) {
      if (!isValidToolCallShape(m.tool_calls[i])) return false
    }
  }
  if (m.tool_call_id !== undefined && typeof m.tool_call_id !== 'string') return false
  if (m.name !== undefined && typeof m.name !== 'string') return false
  // `tool` rows MUST carry a non-empty tool_call_id — orphan tool results
  // are rejected by the provider as a malformed turn. Both load and save
  // route through this check, so a missing/empty ID is caught as early as
  // possible.
  if (m.role === 'tool') {
    if (typeof m.tool_call_id !== 'string' || m.tool_call_id.length === 0) return false
  }
  return true
}

/**
 * Detect whether the parsed JSON root is an envelope object (vs a legacy
 * root array). Detection is intentionally LENIENT — we only require an
 * object with a numeric `version`. Anything more specific (schema name,
 * timestamps, messages array) is validated later in `migrateToCurrent`,
 * AFTER the version-range gate. This ordering matters: a future version
 * with truncated fields must still classify as "envelope, unknown
 * version" rather than "corrupt shape".
 *
 * Filename is never consulted — detection is purely from content.
 */
function isEnvelope(parsed: unknown): parsed is EnvelopeRecord {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return false
  const obj = parsed as Record<string, unknown>
  return typeof obj.version === 'number'
}

/**
 * Type-narrowed view of an envelope object. Caller must have already used
 * isEnvelope() to confirm it isn't a legacy root array. Per-field types
 * are validated inside `migrateToCurrent` — this is just a structural view.
 */
type EnvelopeRecord = {
  version: number
  schema: unknown
  updatedAt: unknown
  messages: unknown
  lastOutcome?: unknown
}

/**
 * Migration step: take a v0 legacy root array of messages and produce the
 * current envelope. The per-message shape didn't change between v0 and v1 —
 * we just promote the root into the envelope. `updatedAt` records the
 * load/migration time so the freshly-upgraded session reads as "just
 * modified".
 */
function migrateLegacyV0ToV1(messages: OpenAIMessage[]): SessionEnvelope {
  return {
    version: CURRENT_SESSION_VERSION,
    schema: CURRENT_SESSION_SCHEMA,
    updatedAt: new Date().toISOString(),
    messages: messages.map((m) => ({ ...m })),
  }
}

/**
 * Validate that a timestamp string is a real ISO-8601 instant. We accept any
 * string that `Date.parse` round-trips and that also keeps itself as a
 * string — this rejects `new Date(undefined)`-style undefined values that
 * produced a NaN epoch.
 */
function isValidIsoTimestamp(value: unknown): value is string {
  if (typeof value !== 'string') return false
  const ms = Date.parse(value)
  if (Number.isNaN(ms)) return false
  // Reject values that parse to a real time but were never ISO (e.g. "now").
  // ISO 8601 strings round-trip via toISOString without changes — a strong
  // way to surface locale-formatted strings that snuck in.
  try {
    return new Date(ms).toISOString() === value
  } catch {
    return false
  }
}

/**
 * Walk any known version forward to the current envelope. Throws
 * UnknownSessionVersionError when the source version is outside the supported
 * range — that is the single decision point for "can we even read this file".
 *
 * **Ordering invariant**: once we've confirmed the root is an envelope
 * object (and not a legacy root array), the FIRST check we run is the
 * version range. A future version with truncated or incomplete fields still
 * produces UnknownSessionVersionError — we don't want field-shape errors
 * to mask "we don't know how to read this version yet".
 *
 * Future versions add new branches in numeric order. Each branch validates
 * the source envelope's fields before transforming them.
 */
function migrateToCurrent(parsed: unknown, sessionDir: string): SessionEnvelope {
  if (Array.isArray(parsed)) {
    // Legacy v0: root array. Validate messages then migrate to v1.
    for (let i = 0; i < parsed.length; i++) {
      if (!isValidMessageShape(parsed[i])) {
        throw new CorruptSessionError(
          sessionDir,
          'invalid-message',
          new Error(`history[${i}] does not match OpenAIMessage shape (role/content invalid)`),
        )
      }
    }
    return migrateLegacyV0ToV1(parsed as OpenAIMessage[])
  }

  if (!isEnvelope(parsed)) {
    throw new CorruptSessionError(
      sessionDir,
      'schema-incompatible',
      new Error('history root is neither an envelope object nor a legacy array'),
    )
  }

  const env = parsed
  const version = env.version

  // Gate (1): version range. Done BEFORE field-shape validation so a future
  // version file with missing or malformed fields still produces
  // UnknownSessionVersionError, never CorruptSessionError.
  if (!Number.isInteger(version) || version < MIN_SUPPORTED_VERSION || version > CURRENT_SESSION_VERSION) {
    throw new UnknownSessionVersionError(sessionDir, version, MIN_SUPPORTED_VERSION, CURRENT_SESSION_VERSION)
  }

  // Gate (2): schema name MUST match the canonical name for THIS version.
  // A file claiming to be version 1 with a foreign schema string is corrupt,
  // not a successful load — we don't want to import arbitrary content
  // thinking it's ours. We treat missing or non-string schema as corrupt
  // AT this gate (version is already known in range), not at gate (1).
  const expectedSchema = SCHEMA_FOR_VERSION[version]
  if (typeof env.schema !== 'string' || env.schema !== expectedSchema) {
    const observed = typeof env.schema === 'string' ? env.schema : '<missing>'
    throw new CorruptSessionError(
      sessionDir,
      'schema-incompatible',
      new Error(`history schema "${observed}" does not match expected "${expectedSchema}" for version ${version}`),
    )
  }
  const schema: string = env.schema

  // Gate (3): timestamp field is a real ISO instant.
  if (!isValidIsoTimestamp(env.updatedAt)) {
    throw new CorruptSessionError(
      sessionDir,
      'schema-incompatible',
      new Error(
        `history.updatedAt ${JSON.stringify(env.updatedAt)} is not a valid ISO-8601 timestamp`,
      ),
    )
  }
  const updatedAt: string = env.updatedAt

  // Gate (4): messages array. Missing/non-array is treated as corrupt here.
  if (!Array.isArray(env.messages)) {
    throw new CorruptSessionError(
      sessionDir,
      'schema-incompatible',
      new Error('history.messages must be an array'),
    )
  }
  const messages = env.messages
  for (let i = 0; i < messages.length; i++) {
    if (!isValidMessageShape(messages[i])) {
      throw new CorruptSessionError(
        sessionDir,
        'invalid-message',
        new Error(`history[${i}] does not match OpenAIMessage shape (role/content invalid)`),
      )
    }
  }

  // Gate (5, v2): lastOutcome is optional, but when present it MUST match
  // the OutcomeSummary shape — a half-written outcome record is corruption,
  // not something to display as truth.
  if (env.lastOutcome !== undefined && !isValidOutcomeSummary(env.lastOutcome)) {
    throw new CorruptSessionError(
      sessionDir,
      'schema-incompatible',
      new Error('history.lastOutcome does not match the OutcomeSummary shape'),
    )
  }

  // Same-version short-circuit — no transform needed. Gates above
  // validated version, schema, updatedAt, and every messages entry
  // (via isValidMessageShape, which narrows to OpenAIMessage). We
  // rebuild the typed envelope from the validated fields rather than
  // double-casting the loose EnvelopeRecord — the gates are the safety
  // net, and the explicit construction makes the provenance visible.
  const currentEnv: SessionEnvelope = {
    version: env.version,
    schema,
    updatedAt,
    messages: messages as OpenAIMessage[],
    lastOutcome: env.lastOutcome,
  }
  if (version === CURRENT_SESSION_VERSION) {
    return currentEnv
  }

  if (version === 1) {
    // Safe: gate (4) validated every entry against isValidMessageShape;
    // the cast only sheds the Array.isArray `any[]` narrowing.
    return migrateV1ToV2(env, messages as OpenAIMessage[], updatedAt)
  }

  // Future intermediate versions add a dispatch branch above.
  throw new UnknownSessionVersionError(sessionDir, version, MIN_SUPPORTED_VERSION, CURRENT_SESSION_VERSION)
}

/**
 * Runtime shape check for a persisted OutcomeSummary. Mirrors the interface
 * field-by-field so a truncated / foreign lastOutcome record is rejected as
 * corrupt instead of rendered as session truth.
 */
function isValidOutcomeSummary(value: unknown): value is OutcomeSummary {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const o = value as Record<string, unknown>
  if (typeof o.status !== 'string' || o.status.length === 0) return false
  if (!Array.isArray(o.changedFiles) || !o.changedFiles.every((f) => typeof f === 'string')) return false
  if (!Array.isArray(o.blockers) || !o.blockers.every((f) => typeof f === 'string')) return false
  if (!Array.isArray(o.requiredNextActions) || !o.requiredNextActions.every((f) => typeof f === 'string')) return false
  if (!o.verification || typeof o.verification !== 'object' || Array.isArray(o.verification)) return false
  const ver = o.verification as Record<string, unknown>
  if (typeof ver.executed !== 'boolean' || typeof ver.passed !== 'boolean') return false
  if (o.lastModel !== undefined && typeof o.lastModel !== 'string') return false
  if (o.durationMs !== undefined && (typeof o.durationMs !== 'number' || Number.isNaN(o.durationMs))) return false
  return true
}

/**
 * Migration step v1 → v2: message shapes are unchanged; v2 only ADDS the
 * optional lastOutcome field. v1 files never stored an outcome, so the
 * migrated envelope simply lacks one — /sessions then reports status
 * 'unknown' and never guesses. `updatedAt` is preserved verbatim: a schema
 * upgrade is not a user edit, and the gate above already proved it is a
 * valid ISO instant.
 */
function migrateV1ToV2(env: EnvelopeRecord, messages: OpenAIMessage[], updatedAt: string): SessionEnvelope {
  return {
    version: CURRENT_SESSION_VERSION,
    schema: CURRENT_SESSION_SCHEMA,
    updatedAt,
    messages: messages.map((m) => ({ ...m })),
  }
}

/**
 * Create a new timestamped session directory under `<cwd>/sessions/session_<ts>/`.
 * Returns the absolute path to the freshly created directory.
 *
 * The timestamp uses `YYYY-MM-DD_HHMMSS` (UTC, second-resolution) so two
 * sessions created within the same minute but in different seconds get
 * distinct directory names.
 */
export function createSessionDir(cwd: string, now: Date = new Date()): string {
  assertNonEmpty(cwd, 'cwd')
  const ts = now
    .toISOString()
    .replace('T', '_')
    .replace(/:/g, '')
    .slice(0, 17) // YYYY-MM-DD_HHMMSS

  const dirName = `${SESSION_DIR_PREFIX}${ts}`
  const sessionDir = join(cwd, 'sessions', dirName)
  mkdirSync(sessionDir, { recursive: true })
  return sessionDir
}

/**
 * Atomically persist the conversation history to disk.
 *
 * Writes `<sessionDir>/history.json` wrapped in a versioned envelope:
 *   { version, schema, updatedAt, messages: [...] }
 *
 * `updatedAt` is set to the current write time on every call so a reader
 * can tell when the session was last touched. There is intentionally no
 * "creation time" field — `updatedAt` always reflects the last write.
 *
 * Each message is cloned (shallow spread) before serialization so all
 * fields round-trip — in particular `tool_call_id` on `tool` rows (the
 * OpenAI-compatible API rejects orphan tool results without an anchor)
 * and `tool_calls` on assistant rows. A spread also protects us from
 * in-place mutation of the caller's array between turns.
 *
 * Writes to a uniquely-suffixed temp file in the SAME directory and
 * renames it into place so the file is never partially written. The tmp
 * name combines process pid + Date.now() ms + 8 random bytes — collisions
 * across concurrent saveSession() calls in the same process (or between
 * processes on the same dir) are effectively impossible. The earlier
 * fixed `.tmp` suffix could race when two saves fired in the same
 * millisecond: writer A's rename would steal writer B's half-written tmp
 * mid-flight, leaving B's data overwritten or its tmp clobbered. With a
 * unique suffix each call gets its own tmp and only the LAST rename
 * survives — exactly the property the caller expects.
 *
 * Before rename, the tmp is fsync'd so its bytes are committed to
 * stable storage. writeFileSync alone is not enough — a power loss
 * between writeFileSync and renameSync can publish a target that points
 * at zero-byte or partial content. The fd-level open / writeSync /
 * fsyncSync / closeSync chain closes that gap.
 *
 * Cleans up OUR tmp file if the rename fails. Other concurrent writers'
 * tmps are left alone. `history` may be an empty array — callers use this
 * to persist /clear as "session exists, history emptied" atomically.
 *
 * Pre-flight validation: EVERY entry in `history` is shape-checked BEFORE
 * any filesystem side effect (mkdir / tmp file open / rename). An invalid
 * entry raises TypeError synchronously and leaves the directory and any
 * prior `history.json` untouched. Without this guard, a malformed message
 * would be written and only caught on the next load — corrupting the
 * session, breaking resume, and forcing the operator to hand-edit
 * history.json. Catching it at save time keeps the on-disk state always
 * self-consistent.
 */
export function saveSession(sessionDir: string, history: OpenAIMessage[], outcome?: OutcomeSummary): void {
  assertNonEmpty(sessionDir, 'sessionDir')
  if (!Array.isArray(history)) {
    throw new TypeError('history must be an array of OpenAIMessage')
  }
  // Validate every entry BEFORE touching the filesystem so a bad message
  // can never produce a half-written / orphan-tmp state. The error path
  // MUST be free of side effects — callers rely on "saveSession threw,
  // therefore nothing on disk changed for the history".
  for (let i = 0; i < history.length; i++) {
    if (!isValidMessageShape(history[i])) {
      throw new TypeError(
        `history[${i}] does not match OpenAIMessage shape ` +
        `(role='tool' rows must include a non-empty tool_call_id; all rows need a valid role and string-or-null content)`,
      )
    }
  }
  // v0.4.1 WS7: same pre-flight discipline for the outcome record — a
  // malformed lastOutcome must never be persisted as session truth.
  if (outcome !== undefined && !isValidOutcomeSummary(outcome)) {
    throw new TypeError('outcome does not match the OutcomeSummary shape')
  }

  const historyPath = join(sessionDir, 'history.json')
  // Uniquely-suffixed tmp — pid + ms + 8 random bytes hex. Same shape as
  // atomicWrite in src/core/atomicWrite.ts so a single convention covers
  // all atomic-replace file mutations.
  const tmpPath = `${historyPath}.tmp.${process.pid}.${Date.now()}.${randomBytes(8).toString('hex')}`
  mkdirSync(sessionDir, { recursive: true })

  const envelope: SessionEnvelope = {
    version: CURRENT_SESSION_VERSION,
    schema: CURRENT_SESSION_SCHEMA,
    updatedAt: new Date().toISOString(),
    // Spread each message so all fields are preserved verbatim — in
    // particular `tool_call_id` on `tool` role messages (without it, the
    // OpenAI-compatible API rejects the row as orphan-without-anchor)
    // and `tool_calls` on `assistant` role messages. Using a shallow
    // clone keeps us safe against in-place mutation of the caller's
    // array across subsequent turns.
    messages: history.map((m) => ({ ...m })),
    // Omitted entirely when no outcome is supplied so v2 files written
    // before any turn completed are byte-identical in shape to the v1
    // ones (minus the version bump).
    ...(outcome ? { lastOutcome: outcome } : {}),
  }

  let tmpFd: number | null = null
  try {
    // Open the tmp file ourselves so we get an explicit fsync on the
    // fd BEFORE the rename publishes it. writeFileSync alone does NOT
    // guarantee bytes hit stable storage before renameSync returns —
    // a power loss between write and rename can leave the target
    // pointing at zero-byte / partial content. fsyncSync closes that
    // gap: by the time we rename, the bytes are durably committed.
    const payload = Buffer.from(JSON.stringify(envelope, null, 2), 'utf8')
    tmpFd = openSync(tmpPath, 'w')
    writeSync(tmpFd, payload, 0, payload.length, 0)
    fsyncSync(tmpFd)
    closeSync(tmpFd)
    tmpFd = null
    if (existsSync(historyPath)) copyFileSync(historyPath, `${historyPath}.bak`)
    renameSync(tmpPath, historyPath)
  } catch (err) {
    // Best-effort: remove OUR orphan tmp file so we don't leak it on disk.
    // We only touch the path we just created — concurrent writers' tmps
    // are deliberately left alone. Also close the fd if we still hold it.
    if (tmpFd !== null) {
      try { closeSync(tmpFd) } catch { /* swallow */ }
    }
    try {
      if (existsSync(tmpPath)) unlinkSync(tmpPath)
    } catch {
      /* swallow cleanup failure — the write error is the important one */
    }
    throw err
  }
}

/**
 * Load the conversation history for a session directory.
 *
 * Returns an empty array when no history file exists (a freshly-created
 * directory is a valid empty session). Throws CorruptSessionError when the
 * history file is present but unparseable, and UnknownSessionVersionError
 * when it was written by a version this binary cannot read. The latter is
 * a first-class error — never silently coerced.
 *
 * Supports both:
 *   - legacy root-array files (v0 → implicitly migrated to the current envelope)
 *   - current envelope files (version == CURRENT_SESSION_VERSION)
 * Files at intermediate supported versions are migrated forward in
 * migrateToCurrent(). Detection is purely from JSON content — filename is
 * never used to infer the schema.
 */
export function loadSession(sessionDir: string): OpenAIMessage[] {
  return loadSessionEnvelope(sessionDir)?.messages ?? []
}

/**
 * Load the FULL envelope (messages + persisted outcome truth) for a session
 * directory. Returns null when no history file exists. Error contract is
 * identical to loadSession: CorruptSessionError for unparseable content,
 * UnknownSessionVersionError for foreign versions — neither is coerced.
 * v0.4.1 WS7: this is the read path /sessions and /resume use so they can
 * show the REAL last-turn status instead of guessing from file shapes.
 */
export function loadSessionEnvelope(sessionDir: string): SessionEnvelope | null {
  assertNonEmpty(sessionDir, 'sessionDir')
  const historyPath = join(sessionDir, 'history.json')

  if (!existsSync(historyPath)) return null

  let raw: string
  try {
    raw = readFileSync(historyPath, 'utf8')
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    throw new CorruptSessionError(
      sessionDir,
      code === 'EACCES' || code === 'EPERM' ? 'permission-denied' : 'io-error',
      err,
    )
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (err) {
    const truncated = raw.trim().length === 0 || /end of JSON|unexpected end|unterminated|expected .+ after property value/i.test((err as Error).message)
    throw new CorruptSessionError(sessionDir, truncated ? 'truncated' : 'json-corrupt', err)
  }

  return migrateToCurrent(parsed, sessionDir)
}

/**
 * v0.4.1 WS7 (session truth): project a TurnOutcome down to the persistable
 * OutcomeSummary. lastModel uses the same precedence as
 * ui/turnOutcomeCard.effectiveModelFor (last SUCCEEDED attempt → last
 * attempt → absent) so the envelope and the on-screen card always agree on
 * which model answered after a fallback chain.
 */
export function summarizeOutcome(outcome: TurnOutcome): OutcomeSummary {
  const attempts = outcome.modelAttempts ?? []
  let lastModel: string | undefined
  for (let i = attempts.length - 1; i >= 0; i--) {
    if (attempts[i].status === 'succeeded') {
      lastModel = attempts[i].model
      break
    }
  }
  if (lastModel === undefined && attempts.length > 0) {
    lastModel = attempts[attempts.length - 1].model
  }
  return {
    status: outcome.completion.status,
    changedFiles: outcome.changedFiles ?? [],
    verification: {
      executed: outcome.verification?.executed ?? false,
      passed: outcome.verification?.passed ?? false,
    },
    blockers: outcome.completion.reasons ?? [],
    requiredNextActions: outcome.completion.requiredNextActions ?? [],
    ...(lastModel ? { lastModel } : {}),
    ...(typeof outcome.durationMs === 'number' ? { durationMs: outcome.durationMs } : {}),
  }
}

/**
 * Return the most recently modified session directory that has a history file,
 * or `null` when none exist. Sorted lexicographically by directory name, which
 * matches our `session_<timestamp>` naming scheme.
 */
export function findLatestSession(cwd: string): string | null {
  assertNonEmpty(cwd, 'cwd')
  const sessionsDir = join(cwd, 'sessions')
  if (!existsSync(sessionsDir)) return null

  let entries: string[]
  try {
    entries = readdirSync(sessionsDir)
  } catch {
    return null
  }

  for (const entry of [...entries].filter(isSessionDirName).sort().reverse()) {
    const dir = join(sessionsDir, entry)
    if (existsSync(join(dir, 'history.json'))) return dir
  }
  return null
}

/**
 * Resolve a user-supplied session reference to an absolute directory path.
 *
 * Accepted forms:
 *   1. Absolute path              → used verbatim
 *   2. Relative path (has '/')    → resolved against `cwd`
 *   3. Full session name          → matched under `<cwd>/sessions/<name>`
 *   4. Unique session prefix      → matched under `<cwd>/sessions/<prefix>*`
 *
 * Throws SessionNotFoundError when nothing matches and AmbiguousSessionError
 * when multiple sessions share the same prefix. This gives --resume a single
 * clear error path regardless of the input shape.
 */
export function resolveSessionPath(cwd: string, session: string): string {
  assertNonEmpty(cwd, 'cwd')
  assertNonEmpty(session, 'session')

  // Form 1 + 2: explicit path (absolute or cwd-relative)
  // Always anchor relative paths to `cwd` so that --resume behaves the same
  // regardless of the process's current working directory.
  if (session.includes('/') || session.includes('\\')) {
    const abs = resolve(cwd, session)
    if (!existsSync(abs)) {
      throw new SessionNotFoundError(`Session path does not exist: ${abs}`)
    }
    return abs
  }

  const sessionsDir = join(cwd, 'sessions')
  if (!existsSync(sessionsDir)) {
    throw new SessionNotFoundError(`No sessions directory found at ${sessionsDir}`)
  }

  // Form 3: exact directory name under <cwd>/sessions/
  const exactDir = join(sessionsDir, session)
  if (existsSync(exactDir)) return exactDir

  // Form 4: unique prefix among session_*-style directories
  let entries: string[]
  try {
    entries = readdirSync(sessionsDir)
  } catch (err) {
    throw new SessionNotFoundError(`Cannot read sessions directory: ${(err as Error).message}`)
  }

  const matches = entries.filter(isSessionDirName).filter((name) => name.startsWith(session))
  if (matches.length === 0) {
    throw new SessionNotFoundError(`No session matching "${session}" under ${sessionsDir}`)
  }
  if (matches.length > 1) {
    throw new AmbiguousSessionError(matches.slice().sort())
  }
  const [match] = matches
  return join(sessionsDir, match)
}

/**
 * Find the unique session directory whose name starts with `prefix`.
 *
 * Returns null when there is no match or none match uniquely. Callers that
 * want explicit error semantics should use resolveSessionPath instead.
 */
export function findSessionByPrefix(cwd: string, prefix: string): string | null {
  assertNonEmpty(cwd, 'cwd')
  assertNonEmpty(prefix, 'prefix')
  const sessionsDir = join(cwd, 'sessions')
  if (!existsSync(sessionsDir)) return null

  let entries: string[]
  try {
    entries = readdirSync(sessionsDir)
  } catch {
    return null
  }

  const matches = entries.filter(isSessionDirName).filter((name) => name.startsWith(prefix))
  if (matches.length !== 1) return null
  const [match] = matches
  return join(sessionsDir, match)
}

/**
 * Return all session directories, newest first by directory name. Each entry
 * records the cached history length so /sessions doesn't have to re-parse
 * every file. Histories that fail to parse are reported with messages=0
 * rather than throwing — /sessions is informational.
 */
export interface SessionInfo {
  dir: string
  name: string
  messages: number
}

export interface DetailedSessionInfo extends SessionInfo {
  title?: string
  updatedAt?: string
  changedFiles?: string[]
  status?: string
}

/**
 * Return all session directories, newest first by directory name. Each entry
 * records the cached history length so /sessions doesn't have to re-parse
 * every file.
 */
export function listSessions(cwd: string): SessionInfo[] {
  assertNonEmpty(cwd, 'cwd')
  const sessionsDir = join(cwd, 'sessions')
  if (!existsSync(sessionsDir)) return []

  let entries: string[]
  try {
    entries = readdirSync(sessionsDir)
  } catch {
    return []
  }

  return entries
    .filter(isSessionDirName)
    .sort()
    .reverse()
    .map((name) => {
      const dir = join(sessionsDir, name)
      let messages = 0
      if (existsSync(join(dir, 'history.json'))) {
        try {
          messages = loadSession(dir).length
        } catch {
          /* corrupt history → report 0 instead of breaking /sessions */
        }
      }
      return { dir, name, messages }
    })
}

/**
 * v0.4.0-era heuristic scan: derive touched file names from Edit/Write
 * tool calls in the message history. Kept ONLY as a changedFiles fallback
 * for v1 legacy envelopes (which predate lastOutcome). It is deliberately
 * NEVER used to infer `status` — "changed files ⇒ Completed" was exactly
 * the guess v0.4.1 WS7 removes (a blocked turn that edited files is not
 * completed, and /resume used to lie about it).
 */
function scanChangedFilesFromMessages(msgs: OpenAIMessage[]): string[] {
  const changedFilesSet = new Set<string>()
  for (const m of msgs) {
    if (m.role === 'assistant' && Array.isArray(m.tool_calls)) {
      for (const tc of m.tool_calls) {
        if (['Edit', 'Write', 'Replace', 'FileEdit', 'FileWrite'].includes(tc.function.name)) {
          try {
            const args = JSON.parse(tc.function.arguments || '{}') as Record<string, unknown>
            const file = (args.file_path || args.path || args.targetFile || args.file) as string | undefined
            if (file && typeof file === 'string') {
              changedFilesSet.add(basename(file))
            }
          } catch {
            /* ignore json parse errors */
          }
        }
      }
    }
  }
  return Array.from(changedFilesSet)
}

/**
 * Return rich session details (title, timestamp, status, changedFiles) for /resume and /sessions UI.
 *
 * v0.4.1 WS7 (session truth): `status` comes ONLY from the envelope's
 * persisted lastOutcome verdict. Sessions without one (v1 legacy, or v2
 * saved before a turn completed) report 'unknown' — never a guess.
 * Corrupt or foreign-version histories report 'corrupt' / 'unknown' and
 * warn once on stderr instead of silently rendering as 'Completed'.
 */
export function listSessionsDetailed(cwd: string): DetailedSessionInfo[] {
  const basic = listSessions(cwd)
  return basic.map((s) => {
    let title: string | undefined
    let updatedAt: string | undefined
    let status = 'unknown'
    let changedFiles: string[] = []

    try {
      const historyPath = join(s.dir, 'history.json')
      if (existsSync(historyPath)) {
        const stat = statSync(historyPath)
        updatedAt = stat.mtime.toISOString().replace('T', ' ').slice(0, 16)
      }

      const envelope = loadSessionEnvelope(s.dir)
      if (envelope) {
        const firstUserMsg = envelope.messages.find((m) => m.role === 'user')
        if (firstUserMsg && typeof firstUserMsg.content === 'string') {
          title = firstUserMsg.content.trim().slice(0, 60).replaceAll('\n', ' ')
        }

        if (envelope.lastOutcome) {
          // v2 truth path.
          status = envelope.lastOutcome.status
          changedFiles = [...envelope.lastOutcome.changedFiles]
        }
        // v1 legacy fallback: the file scan still names touched files,
        // but status stays 'unknown' — we no longer guess completion.
        if (changedFiles.length === 0) {
          changedFiles = scanChangedFilesFromMessages(envelope.messages)
        }
      }
    } catch (err) {
      if (err instanceof CorruptSessionError) {
        status = 'corrupt'
        warnOnce(`session:corrupt:${s.dir}`, `Warning: session "${s.name}" has a corrupt history.json — ${(err as Error).message}`)
      } else if (err instanceof UnknownSessionVersionError) {
        status = 'unknown'
        warnOnce(`session:version:${s.dir}`, `Warning: session "${s.name}" was written by a newer build — ${(err as Error).message}`)
      } else {
        status = 'corrupt'
        warnOnce(`session:read:${s.dir}`, `Warning: could not read session "${s.name}": ${(err as Error).message}`)
      }
    }

    return {
      ...s,
      title: title || s.name,
      updatedAt,
      changedFiles,
      status,
    }
  })
}

// ── fork ────────────────────────────────────────────────────────────────────

export interface ForkResult {
  /** Absolute path of the new session directory. */
  forkDir: string
  /** Number of messages copied into the fork. */
  messages: number
  /** True when the requested cut point was moved to a safe boundary. */
  adjusted: boolean
}

/**
 * Compute a safe fork cut point: the prefix [0, cut) must be a
 * self-consistent conversation — no orphan `tool` rows at the boundary and
 * no assistant `tool_calls` left without their matching tool results.
 *
 * Adjustment rules (cut only ever GROWS, never shrinks):
 *   1. If messages[cut] is a `tool` row, the cut sits inside a tool-call
 *      group — advance past the contiguous tool rows.
 *   2. If the prefix contains assistant tool_calls whose results were NOT
 *      included, advance to include their contiguous tool responses.
 * The loop terminates because cut is monotonically increasing and bounded
 * by messages.length.
 */
export function computeForkCutPoint(messages: OpenAIMessage[], requested?: number): number {
  const n = messages.length
  let cut = requested === undefined ? n : Math.max(0, Math.min(Math.trunc(requested), n))

  for (;;) {
    while (cut < n && messages[cut]?.role === 'tool') cut++

    // Collect tool_call ids that are issued but not answered within [0, cut).
    const pending = new Set<string>()
    for (let i = 0; i < cut; i++) {
      const m = messages[i]
      if (!m) continue
      if (m.role === 'assistant' && Array.isArray(m.tool_calls)) {
        for (const tc of m.tool_calls) {
          if (tc.id) pending.add(tc.id)
        }
      } else if (m.role === 'tool' && m.tool_call_id) {
        pending.delete(m.tool_call_id)
      }
    }
    if (pending.size === 0) return cut

    // Include the contiguous tool responses that satisfy the pending ids.
    let j = cut
    const missing = new Set(pending)
    while (j < n && missing.size > 0) {
      const m = messages[j]
      if (!m) break
      if (m.role === 'tool' && m.tool_call_id && missing.has(m.tool_call_id)) {
        missing.delete(m.tool_call_id)
        j++
      } else if (m.role === 'tool') {
        j++
      } else {
        break
      }
    }
    if (j === cut) return cut // no progress possible — accept the boundary
    cut = j
  }
}

/**
 * Create a unique fork directory name under `<cwd>/sessions/`.
 *
 * createSessionDir uses second-resolution timestamps, so a fork created in
 * the same second as another fork (or the source session itself) would
 * collide. On collision we append `_fork<k>` until the name is free — the
 * `session_*` prefix keeps it visible to isSessionDirName, /sessions, and
 * resolveSessionPath prefix matching.
 */
function createForkSessionDir(cwd: string, now: Date = new Date()): string {
  assertNonEmpty(cwd, 'cwd')
  const ts = now
    .toISOString()
    .replace('T', '_')
    .replace(/:/g, '')
    .slice(0, 17)
  const sessionsRoot = join(cwd, 'sessions')
  let candidate = `${SESSION_DIR_PREFIX}${ts}_fork`
  let k = 2
  while (existsSync(join(sessionsRoot, candidate))) {
    candidate = `${SESSION_DIR_PREFIX}${ts}_fork${k}`
    k++
  }
  const dir = join(sessionsRoot, candidate)
  mkdirSync(dir, { recursive: true })
  return dir
}

/**
 * Fork an existing session into a NEW session directory.
 *
 * The fork copies the source conversation prefix [0, cut) — where cut
 * defaults to the full history and is always adjusted to a safe boundary
 * (see computeForkCutPoint) — into a fresh envelope. The source session is
 * never modified. The forked history is written through saveSession, so it
 * gets the same shape validation and atomic-write guarantees as a normal
 * session save; the fork is immediately resumable via --resume / /resume.
 *
 * lastOutcome is intentionally NOT copied: the fork has not completed any
 * turn of its own, and inheriting the source's verdict would make /sessions
 * report the fork with the truth of a turn it never ran.
 *
 * Throws SessionNotFoundError when `sourceDir` has no history file, and
 * propagates CorruptSessionError / UnknownSessionVersionError from the
 * source load untouched.
 */
export function forkSession(cwd: string, sourceDir: string, atMessage?: number): ForkResult {
  assertNonEmpty(cwd, 'cwd')
  assertNonEmpty(sourceDir, 'sourceDir')

  const envelope = loadSessionEnvelope(sourceDir)
  if (!envelope) {
    throw new SessionNotFoundError(`Source session has no history: ${sourceDir}`)
  }

  const requested = atMessage === undefined ? envelope.messages.length : atMessage
  const cut = computeForkCutPoint(envelope.messages, requested)
  const forkDir = createForkSessionDir(cwd)
  // Clone each message (saveSession re-validates shapes and rejects orphan
  // tool rows, so a bad prefix can never be persisted as a silent fork).
  const prefix = envelope.messages.slice(0, cut).map((m) => ({ ...m }))
  saveSession(forkDir, prefix)

  return {
    forkDir,
    messages: prefix.length,
    adjusted: cut !== Math.max(0, Math.min(Math.trunc(requested), envelope.messages.length)),
  }
}
