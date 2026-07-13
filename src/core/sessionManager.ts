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
 * Writes to `<sessionDir>/history.json.tmp` and renames it into place so the
 * file is never partially written. Cleans up the tmp file if the rename fails.
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

  try {
    writeFileSync(tmpPath, JSON.stringify(history, null, 2), 'utf8')
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
 * history file is present but unparseable, so callers can distinguish
 * "empty session" from "broken session" without guesswork.
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

  if (!Array.isArray(parsed)) {
    throw new CorruptSessionError(sessionDir, new Error('history root must be an array'))
  }

  for (let i = 0; i < parsed.length; i++) {
    if (!isValidMessageShape(parsed[i])) {
      throw new CorruptSessionError(
        sessionDir,
        new Error(`history[${i}] does not match OpenAIMessage shape (role/content invalid)`),
      )
    }
  }

  return parsed as OpenAIMessage[]
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
