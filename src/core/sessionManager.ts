import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from 'fs'
import { join, resolve } from 'path'
import type { OpenAIMessage } from './types.js'

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
export const CURRENT_SESSION_VERSION = 1

/** The lowest version this binary still understands (>= will migrate; < will reject). */
export const MIN_SUPPORTED_VERSION = 1

/** Schema name — human-readable identifier separate from numeric version. */
export const CURRENT_SESSION_SCHEMA = 'ovogo.session.v1'

export interface SessionEnvelope {
  version: number
  schema: string
  /** Last write time. New envelopes always populate this. Validated as ISO. */
  updatedAt: string
  messages: OpenAIMessage[]
}

/**
 * Canonical schema name for an envelope at a given version. The map keeps
 * `version` (numeric) tightly bound to `schema` (string) so a file claiming
 * to be version 1 with a wrong schema name is rejected as corrupt, not
 * silently loaded as something else. Add an entry here when introducing a
 * new version.
 */
const SCHEMA_FOR_VERSION: Readonly<Record<number, string>> = Object.freeze({
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
    cause: unknown,
  ) {
    super(`Session at ${sessionDir} contains malformed history.json: ${(cause as Error)?.message ?? String(cause)}`)
    this.name = 'CorruptSessionError'
  }
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
 * Validate the *shape* of a single message without dropping anything that the
 * engine hasn't strictly required. The point is to keep obviously malformed
 * entries (e.g. a JSON number where a role string is expected) out of the
 * engine, while tolerating legacy history files that may have been written
 * by an earlier version with fewer or extra optional fields.
 */
function isValidMessageShape(msg: unknown): msg is OpenAIMessage {
  if (!msg || typeof msg !== 'object') return false
  const m = msg as Record<string, unknown>
  if (typeof m.role !== 'string' || !VALID_ROLES.has(m.role as OpenAIMessage['role'])) return false
  if (m.content !== null && typeof m.content !== 'string') return false
  // Optional fields — accept when present, tolerate absence for old formats.
  if (m.tool_calls !== undefined && !Array.isArray(m.tool_calls)) return false
  if (m.tool_call_id !== undefined && typeof m.tool_call_id !== 'string') return false
  if (m.name !== undefined && typeof m.name !== 'string') return false
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
function isEnvelope(parsed: unknown): parsed is Record<string, unknown> {
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
}

/** Narrow an `isEnvelope()`-confirmed object to its declared shape. */
function asEnvelopeRecord(parsed: Record<string, unknown>): EnvelopeRecord {
  return parsed as unknown as EnvelopeRecord
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
          new Error(`history[${i}] does not match OpenAIMessage shape (role/content invalid)`),
        )
      }
    }
    return migrateLegacyV0ToV1(parsed as OpenAIMessage[])
  }

  if (!isEnvelope(parsed)) {
    throw new CorruptSessionError(
      sessionDir,
      new Error('history root is neither an envelope object nor a legacy array'),
    )
  }

  const env = asEnvelopeRecord(parsed)
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
      new Error(`history schema "${observed}" does not match expected "${expectedSchema}" for version ${version}`),
    )
  }

  // Gate (3): timestamp field is a real ISO instant.
  if (!isValidIsoTimestamp(env.updatedAt)) {
    throw new CorruptSessionError(
      sessionDir,
      new Error(
        `history.updatedAt ${JSON.stringify(env.updatedAt)} is not a valid ISO-8601 timestamp`,
      ),
    )
  }

  // Gate (4): messages array. Missing/non-array is treated as corrupt here.
  if (!Array.isArray(env.messages)) {
    throw new CorruptSessionError(
      sessionDir,
      new Error('history.messages must be an array'),
    )
  }
  const messages = env.messages
  for (let i = 0; i < messages.length; i++) {
    if (!isValidMessageShape(messages[i])) {
      throw new CorruptSessionError(
        sessionDir,
        new Error(`history[${i}] does not match OpenAIMessage shape (role/content invalid)`),
      )
    }
  }

  if (version === CURRENT_SESSION_VERSION) {
    // Same-version short-circuit — no transform needed.
    return env as unknown as SessionEnvelope
  }

  // Intermediate versions (MIN..CURRENT) — a clean migration step is needed.
  // Future: add migrateToV2, migrateToV3, ... and dispatch by version here.
  throw new UnknownSessionVersionError(sessionDir, version, MIN_SUPPORTED_VERSION, CURRENT_SESSION_VERSION)
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
 * Writes to `history.json.tmp` first and renames it into place so the file
 * is never partially written. Cleans up the tmp file if the rename fails.
 * `history` may be an empty array — callers use this to persist /clear as
 * "session exists, history emptied" atomically.
 */
export function saveSession(sessionDir: string, history: OpenAIMessage[]): void {
  assertNonEmpty(sessionDir, 'sessionDir')
  if (!Array.isArray(history)) {
    throw new TypeError('history must be an array of OpenAIMessage')
  }

  const historyPath = join(sessionDir, 'history.json')
  const tmpPath = `${historyPath}.tmp`
  mkdirSync(sessionDir, { recursive: true })

  const envelope: SessionEnvelope = {
    version: CURRENT_SESSION_VERSION,
    schema: CURRENT_SESSION_SCHEMA,
    updatedAt: new Date().toISOString(),
    messages: history.map((m) => ({ ...m })),
  }

  try {
    writeFileSync(tmpPath, JSON.stringify(envelope, null, 2), 'utf8')
    renameSync(tmpPath, historyPath)
  } catch (err) {
    // Best-effort: remove the orphan tmp file so we don't leak it on disk.
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
  assertNonEmpty(sessionDir, 'sessionDir')
  const historyPath = join(sessionDir, 'history.json')

  if (!existsSync(historyPath)) return []

  let raw: string
  try {
    raw = readFileSync(historyPath, 'utf8')
  } catch (err) {
    throw new CorruptSessionError(sessionDir, err)
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (err) {
    throw new CorruptSessionError(sessionDir, err)
  }

  return migrateToCurrent(parsed, sessionDir).messages
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
