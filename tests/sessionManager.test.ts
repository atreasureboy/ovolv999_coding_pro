import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  AmbiguousSessionError,
  CorruptSessionError,
  CURRENT_SESSION_SCHEMA,
  CURRENT_SESSION_VERSION,
  MIN_SUPPORTED_VERSION,
  SessionNotFoundError,
  UnknownSessionVersionError,
  createSessionDir,
  findLatestSession,
  findSessionByPrefix,
  listSessions,
  loadSession,
  resolveSessionPath,
  saveSession,
} from '../src/core/sessionManager.js'
import type { OpenAIMessage } from '../src/core/types.js'

// ── helpers ────────────────────────────────────────────────────────────────

let tmpRoot = ''

function freshDir(prefix: string): string {
  return mkdtempSync(join(tmpRoot, `${prefix}-`))
}

const FIXED_DATE = new Date('2026-07-13T10:30:45.000Z')

function mkMessage(role: OpenAIMessage['role'], content: string): OpenAIMessage {
  return { role, content }
}

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'ovogo-session-test-'))
})

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true })
})

// ── createSessionDir ──────────────────────────────────────────────────────

describe('createSessionDir', () => {
  it('creates <cwd>/sessions/session_<ts>/ with a stable, second-resolution name', () => {
    const cwd = freshDir('create')
    const dir = createSessionDir(cwd, FIXED_DATE)
    // 2026-07-13T10:30:45Z -> ISO `2026-07-13_10:30:45.000Z` -> session_YYYY-MM-DD_HHMMSS
    expect(dir).toBe(join(cwd, 'sessions', 'session_2026-07-13_103045'))
    expect(existsSync(dir)).toBe(true)
    expect(existsSync(join(dir, '..'))).toBe(true)
  })

  it('does not throw when the parent sessions/ already exists', () => {
    const cwd = freshDir('create-existing')
    mkdirSync(join(cwd, 'sessions'), { recursive: true })
    expect(() => createSessionDir(cwd, FIXED_DATE)).not.toThrow()
  })

  it('rejects empty cwd with TypeError', () => {
    expect(() => createSessionDir('')).toThrow(TypeError)
  })

  it('creates distinct directories for the same minute but different seconds', () => {
    const cwd = freshDir('create-collision')
    const a = createSessionDir(cwd, new Date('2026-07-13T10:30:45.000Z'))
    const b = createSessionDir(cwd, new Date('2026-07-13T10:30:50.000Z'))
    const c = createSessionDir(cwd, new Date('2026-07-13T10:30:59.000Z'))

    expect(a).toBe(join(cwd, 'sessions', 'session_2026-07-13_103045'))
    expect(b).toBe(join(cwd, 'sessions', 'session_2026-07-13_103050'))
    expect(c).toBe(join(cwd, 'sessions', 'session_2026-07-13_103059'))
    expect(new Set([a, b, c]).size).toBe(3)
    for (const d of [a, b, c]) expect(existsSync(d)).toBe(true)
  })
})

// ── saveSession ───────────────────────────────────────────────────────────

describe('saveSession', () => {
  it('writes history.json with pretty-printed JSON inside the v1 envelope', () => {
    const cwd = freshDir('save')
    const dir = createSessionDir(cwd, FIXED_DATE)
    const history: OpenAIMessage[] = [mkMessage('user', 'hi'), mkMessage('assistant', 'hello')]

    saveSession(dir, history)

    const raw = readFileSync(join(dir, 'history.json'), 'utf8')
    expect(raw.endsWith('\n')).toBe(false)

    const parsed = JSON.parse(raw)
    // Envelope shape (see envelope versioning describe block): the messages
    // array is nested under `.messages`, not at the root.
    expect(parsed.version).toBe(CURRENT_SESSION_VERSION)
    expect(parsed.schema).toBe(CURRENT_SESSION_SCHEMA)
    expect(parsed.messages).toEqual(history)
  })

  it('persists an empty history atomically — no leftover .tmp file', () => {
    const cwd = freshDir('save-empty')
    const dir = createSessionDir(cwd, FIXED_DATE)

    saveSession(dir, [])

    expect(existsSync(join(dir, 'history.json'))).toBe(true)
    expect(existsSync(join(dir, 'history.json.tmp'))).toBe(false)
    expect(loadSession(dir)).toEqual([])
  })

  it('rejects non-array history', () => {
    const cwd = freshDir('save-bad')
    const dir = createSessionDir(cwd, FIXED_DATE)
    expect(() => saveSession(dir, null as unknown as OpenAIMessage[])).toThrow(TypeError)
    expect(() => saveSession(dir, 'nope' as unknown as OpenAIMessage[])).toThrow(TypeError)
  })

  it('overwrites a previous history.json atomically', () => {
    const cwd = freshDir('save-overwrite')
    const dir = createSessionDir(cwd, FIXED_DATE)
    saveSession(dir, [mkMessage('user', 'first')])
    saveSession(dir, [mkMessage('user', 'second'), mkMessage('assistant', 'reply')])

    expect(existsSync(join(dir, 'history.json.tmp'))).toBe(false)
    expect(loadSession(dir)).toHaveLength(2)
  })
})

// ── loadSession ───────────────────────────────────────────────────────────

describe('loadSession', () => {
  it('returns [] when no history.json exists (empty session is valid)', () => {
    const cwd = freshDir('load-empty')
    const dir = createSessionDir(cwd, FIXED_DATE)
    expect(loadSession(dir)).toEqual([])
  })

  it('returns parsed history when present', () => {
    const cwd = freshDir('load-ok')
    const dir = createSessionDir(cwd, FIXED_DATE)
    const seeded = [mkMessage('user', 'q'), mkMessage('assistant', 'a')]
    writeFileSync(join(dir, 'history.json'), JSON.stringify(seeded), 'utf8')

    expect(loadSession(dir)).toEqual(seeded)
  })

  it('throws CorruptSessionError for malformed JSON', () => {
    const cwd = freshDir('load-malformed')
    const dir = createSessionDir(cwd, FIXED_DATE)
    writeFileSync(join(dir, 'history.json'), '{ not json', 'utf8')

    expect(() => loadSession(dir)).toThrow(CorruptSessionError)
  })

  it('throws CorruptSessionError for non-array root JSON', () => {
    const cwd = freshDir('load-nonarray')
    const dir = createSessionDir(cwd, FIXED_DATE)
    writeFileSync(join(dir, 'history.json'), JSON.stringify({ not: 'array' }), 'utf8')

    expect(() => loadSession(dir)).toThrow(CorruptSessionError)
  })

  it('rejects empty sessionDir with TypeError', () => {
    expect(() => loadSession('')).toThrow(TypeError)
  })

  // ── per-message shape validation ────────────────────────────────────────
  // The engine streams history into the LLM provider, so a single malformed
  // entry can break the API call. These tests lock in the contract.

  it('rejects a history entry with an invalid role', () => {
    const cwd = freshDir('load-bad-role')
    const dir = createSessionDir(cwd, FIXED_DATE)
    writeFileSync(
      join(dir, 'history.json'),
      JSON.stringify([{ role: 'manager', content: 'hi' }]),
      'utf8',
    )
    expect(() => loadSession(dir)).toThrow(CorruptSessionError)
  })

  it('rejects a history entry whose content is neither string nor null', () => {
    const cwd = freshDir('load-bad-content')
    const dir = createSessionDir(cwd, FIXED_DATE)
    writeFileSync(
      join(dir, 'history.json'),
      JSON.stringify([{ role: 'user', content: 123 }]),
      'utf8',
    )
    expect(() => loadSession(dir)).toThrow(CorruptSessionError)
  })

  it('rejects a primitive (non-object) history entry', () => {
    const cwd = freshDir('load-primitive')
    const dir = createSessionDir(cwd, FIXED_DATE)
    writeFileSync(join(dir, 'history.json'), JSON.stringify(['just a string']), 'utf8')
    expect(() => loadSession(dir)).toThrow(CorruptSessionError)
  })

  it('tolerates missing tool_calls / tool_call_id / name (backward compat)', () => {
    const cwd = freshDir('load-legacy')
    const dir = createSessionDir(cwd, FIXED_DATE)
    // Older versions may have written messages without optional fields.
    const legacy = [
      { role: 'system', content: 'old system prompt' },
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: null },
    ]
    writeFileSync(join(dir, 'history.json'), JSON.stringify(legacy), 'utf8')

    expect(loadSession(dir)).toEqual(legacy)
  })

  it('tolerates optional fields when present and well-typed', () => {
    const cwd = freshDir('load-optional')
    const dir = createSessionDir(cwd, FIXED_DATE)
    const messages = [
      { role: 'user', content: 'q' },
      {
        role: 'assistant',
        content: null,
        tool_calls: [{ id: '1', type: 'function', function: { name: 'x', arguments: '{}' } }],
      },
      { role: 'tool', content: 'r', tool_call_id: '1', name: 'x' },
    ]
    writeFileSync(join(dir, 'history.json'), JSON.stringify(messages), 'utf8')

    expect(loadSession(dir)).toEqual(messages)
  })

  it('rejects an entry whose tool_calls is not an array', () => {
    const cwd = freshDir('load-bad-tools')
    const dir = createSessionDir(cwd, FIXED_DATE)
    writeFileSync(
      join(dir, 'history.json'),
      JSON.stringify([{ role: 'assistant', content: 'x', tool_calls: 'not-an-array' }]),
      'utf8',
    )
    expect(() => loadSession(dir)).toThrow(CorruptSessionError)
  })
})

// ── findLatestSession ─────────────────────────────────────────────────────

describe('findLatestSession', () => {
  it('returns null when no sessions directory exists', () => {
    const cwd = freshDir('latest-none')
    expect(findLatestSession(cwd)).toBeNull()
  })

  it('returns null when sessions/ exists but contains no session_* dirs', () => {
    const cwd = freshDir('latest-nosession')
    mkdirSync(join(cwd, 'sessions'), { recursive: true })
    writeFileSync(join(cwd, 'sessions', 'random.txt'), '', 'utf8')
    expect(findLatestSession(cwd)).toBeNull()
  })

  it('returns the lexicographically last directory that has history.json', () => {
    const cwd = freshDir('latest')
    const oldDir = createSessionDir(cwd, new Date('2026-07-13T08:00:00.000Z'))
    const newDir = createSessionDir(cwd, new Date('2026-07-13T12:00:00.000Z'))
    saveSession(oldDir, [mkMessage('user', 'old')])
    saveSession(newDir, [mkMessage('user', 'new')])

    expect(findLatestSession(cwd)).toBe(newDir)
  })

  it('skips directories without history.json', () => {
    const cwd = freshDir('latest-skip')
    const a = createSessionDir(cwd, new Date('2026-07-13T08:00:00.000Z')) // no history
    const b = createSessionDir(cwd, new Date('2026-07-13T09:00:00.000Z'))
    saveSession(b, [mkMessage('user', 'only-b')])
    expect(a).not.toBe(b)
    expect(findLatestSession(cwd)).toBe(b)
  })
})

// ── listSessions ──────────────────────────────────────────────────────────

describe('listSessions', () => {
  it('returns [] when no sessions directory exists', () => {
    const cwd = freshDir('list-none')
    expect(listSessions(cwd)).toEqual([])
  })

  it('lists sessions newest-first with cached message counts', () => {
    const cwd = freshDir('list-ok')
    const older = createSessionDir(cwd, new Date('2026-07-13T08:00:00.000Z'))
    const newer = createSessionDir(cwd, new Date('2026-07-13T11:00:00.000Z'))
    saveSession(older, [mkMessage('user', '1'), mkMessage('assistant', '2')])
    saveSession(newer, [mkMessage('user', '1')])

    const sessions = listSessions(cwd)
    expect(sessions).toEqual([
      { dir: newer, name: 'session_2026-07-13_110000', messages: 1 },
      { dir: older, name: 'session_2026-07-13_080000', messages: 2 },
    ])
  })

  it('reports messages=0 for corrupt entries instead of throwing', () => {
    const cwd = freshDir('list-corrupt')
    const dir = createSessionDir(cwd, FIXED_DATE)
    writeFileSync(join(dir, 'history.json'), '!!!not json!!!', 'utf8')

    const [entry] = listSessions(cwd)
    expect(entry?.dir).toBe(dir)
    expect(entry?.messages).toBe(0)
  })

  it('reports messages=0 for directories without history.json', () => {
    const cwd = freshDir('list-empty-dir')
    const dir = createSessionDir(cwd, FIXED_DATE)
    expect(dir).toBeTruthy()
    const [entry] = listSessions(cwd)
    expect(entry?.messages).toBe(0)
  })
})

// ── findSessionByPrefix ───────────────────────────────────────────────────

describe('findSessionByPrefix', () => {
  it('returns null when no directory starts with the prefix', () => {
    const cwd = freshDir('prefix-none')
    createSessionDir(cwd, FIXED_DATE)
    expect(findSessionByPrefix(cwd, 'nope_')).toBeNull()
  })

  it('returns the directory for a unique prefix', () => {
    const cwd = freshDir('prefix-uniq')
    const target = createSessionDir(cwd, FIXED_DATE)
    expect(findSessionByPrefix(cwd, 'session_202')).toBe(target)
  })

  it('returns null (does NOT throw) for an ambiguous prefix', () => {
    const cwd = freshDir('prefix-ambig')
    createSessionDir(cwd, new Date('2026-07-13T08:00:00.000Z'))
    createSessionDir(cwd, new Date('2026-07-13T09:00:00.000Z'))
    expect(findSessionByPrefix(cwd, 'session_2026-07-13_0')).toBeNull()
  })

  it('rejects empty inputs', () => {
    const cwd = freshDir('prefix-bad')
    expect(() => findSessionByPrefix('', 'session')).toThrow(TypeError)
    expect(() => findSessionByPrefix(cwd, '')).toThrow(TypeError)
  })
})

// ── resolveSessionPath ────────────────────────────────────────────────────

describe('resolveSessionPath', () => {
  it('treats arguments with separators as paths', () => {
    const cwd = freshDir('resolve-path')
    const dir = createSessionDir(cwd, FIXED_DATE)

    expect(resolveSessionPath(cwd, dir)).toBe(dir)
  })

  it('throws SessionNotFoundError for a missing absolute path', () => {
    const cwd = freshDir('resolve-miss')
    expect(() => resolveSessionPath(cwd, '/definitely/not/here/ovogo')).toThrow(SessionNotFoundError)
  })

  it('resolves a full session directory name', () => {
    const cwd = freshDir('resolve-full')
    const dir = createSessionDir(cwd, FIXED_DATE)
    expect(resolveSessionPath(cwd, 'session_2026-07-13_103045')).toBe(dir)
  })

  it('resolves a unique prefix to its single match', () => {
    const cwd = freshDir('resolve-unique')
    const dir = createSessionDir(cwd, FIXED_DATE)
    // Prefix unique to a single session — must include a length past any sibling ambiguity.
    const other = createSessionDir(cwd, new Date('2026-07-13T11:00:00.000Z'))
    expect(other).not.toBe(dir)
    expect(resolveSessionPath(cwd, 'session_2026-07-13_103045')).toBe(dir)
  })

  it('throws SessionNotFoundError when the prefix matches nothing', () => {
    const cwd = freshDir('resolve-nomatch')
    createSessionDir(cwd, FIXED_DATE)
    expect(() => resolveSessionPath(cwd, 'session_9999_')).toThrow(SessionNotFoundError)
  })

  it('throws AmbiguousSessionError with all matches when prefix is shared', () => {
    const cwd = freshDir('resolve-ambig')
    const a = createSessionDir(cwd, new Date('2026-07-13T08:00:00.000Z'))
    const b = createSessionDir(cwd, new Date('2026-07-13T09:00:00.000Z'))
    saveSession(a, [mkMessage('user', 'a')])
    saveSession(b, [mkMessage('user', 'b')])

    expect(() => resolveSessionPath(cwd, 'session_2026-07-13_0')).toThrow(AmbiguousSessionError)

    try {
      resolveSessionPath(cwd, 'session_2026-07-13_0')
      throw new Error('expected throw')
    } catch (err: unknown) {
      expect(err).toBeInstanceOf(AmbiguousSessionError)
      const e = err as AmbiguousSessionError
      expect(e.matches).toEqual(['session_2026-07-13_080000', 'session_2026-07-13_090000'])
    }
  })

  it('anchors a relative path with separators to the given cwd, not process.cwd()', () => {
    // Build a session under <cwd>/some/sub/<name> and ask resolveSessionPath to
    // resolve `some/sub/<name>` against `cwd`. If the implementation depended
    // on process.cwd() it would point somewhere else and fail.
    const cwd = freshDir('resolve-relative')
    const real = createSessionDir(cwd, FIXED_DATE)
    const target = join(cwd, 'some', 'sub', real.split('/').pop()!)
    mkdirSync(target, { recursive: true })

    // Chdir to a place that definitely does NOT contain the session, then
    // confirm resolveSessionPath still finds it via `cwd` anchoring.
    const originalCwd = process.cwd()
    process.chdir(tmpdir())
    try {
      expect(resolveSessionPath(cwd, `some/sub/${real.split('/').pop()}`)).toBe(target)
    } finally {
      process.chdir(originalCwd)
    }
  })

  it('rejects empty inputs', () => {
    expect(() => resolveSessionPath('', 'session_x')).toThrow(TypeError)
    const cwd = freshDir('resolve-empty')
    expect(() => resolveSessionPath(cwd, '')).toThrow(TypeError)
  })
})

// ── envelope versioning ─────────────────────────────────────────────────
//
// The persistence format is a versioned envelope so future schema changes
// have an explicit decision point. These tests lock in:
//   1. legacy (v0) root-array files keep loading
//   2. current-version files round-trip
//   3. unknown future versions throw an actionable error
//   4. corrupt envelopes throw CorruptSessionError
//   5. nothing in the schema is inferred from filename

describe('session envelope (versioning & migration)', () => {
  it('CURRENT_SESSION_VERSION is exported and >= MIN_SUPPORTED_VERSION', () => {
    expect(typeof CURRENT_SESSION_VERSION).toBe('number')
    expect(Number.isInteger(CURRENT_SESSION_VERSION)).toBe(true)
    expect(CURRENT_SESSION_VERSION).toBeGreaterThanOrEqual(MIN_SUPPORTED_VERSION)
    expect(CURRENT_SESSION_SCHEMA).toMatch(/^ovogo\.session\.v\d+$/)
  })

  it('saveSession writes the current-version envelope (not a bare array)', () => {
    const cwd = freshDir('env-save')
    const dir = createSessionDir(cwd, FIXED_DATE)
    saveSession(dir, [mkMessage('user', 'hi'), mkMessage('assistant', 'hello')])

    const raw = readFileSync(join(dir, 'history.json'), 'utf8')
    const parsed = JSON.parse(raw)

    expect(Array.isArray(parsed)).toBe(false)
    expect(parsed.version).toBe(CURRENT_SESSION_VERSION)
    expect(parsed.schema).toBe(CURRENT_SESSION_SCHEMA)
    // updatedAt is required on v1 and must be a real ISO instant.
    expect(typeof parsed.updatedAt).toBe('string')
    expect(Number.isNaN(Date.parse(parsed.updatedAt))).toBe(false)
    expect(new Date(parsed.updatedAt).toISOString()).toBe(parsed.updatedAt)
    expect(parsed.messages).toEqual([
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'hello' },
    ])
  })

  it('round-trip: save → load returns identical messages', () => {
    const cwd = freshDir('env-roundtrip')
    const dir = createSessionDir(cwd, FIXED_DATE)
    const history: OpenAIMessage[] = [
      mkMessage('system', 'sys'),
      mkMessage('user', 'q'),
      {
        role: 'assistant',
        content: null,
        tool_calls: [{ id: '1', type: 'function', function: { name: 'T', arguments: '{}' } }],
      },
      { role: 'tool', content: 'r', tool_call_id: '1', name: 'T' },
      mkMessage('assistant', 'reply'),
    ]
    saveSession(dir, history)
    expect(loadSession(dir)).toEqual(history)
  })

  it('loadSession returns [] for a freshly created session (no history.json)', () => {
    const cwd = freshDir('env-empty')
    const dir = createSessionDir(cwd, FIXED_DATE)
    expect(loadSession(dir)).toEqual([])
  })

  it('legacy root-array file (v0) still loads without --resume errors', () => {
    // Simulates an ovogogogo session written before envelope versioning: a
    // bare JSON array of OpenAIMessage. Must remain loadable.
    const cwd = freshDir('env-legacy')
    const dir = createSessionDir(cwd, FIXED_DATE)
    const legacy = [
      { role: 'user', content: 'old q' },
      { role: 'assistant', content: 'old a' },
    ]
    writeFileSync(join(dir, 'history.json'), JSON.stringify(legacy), 'utf8')

    // loadSession returns the same messages — caller surface is unchanged.
    expect(loadSession(dir)).toEqual(legacy)

    // The legacy file is still on disk verbatim: we never silently rewrite it.
    // (Rewriting on load would touch files that the user might be inspecting
    // or backing up; we only rewrite when the caller explicitly saves again.)
    const onDisk = readFileSync(join(dir, 'history.json'), 'utf8')
    expect(JSON.parse(onDisk)).toEqual(legacy)
  })

  it('legacy v0 file with optional fields still loads', () => {
    const cwd = freshDir('env-legacy-opt')
    const dir = createSessionDir(cwd, FIXED_DATE)
    const legacy = [
      { role: 'user', content: 'q' },
      {
        role: 'assistant',
        content: null,
        tool_calls: [{ id: '1', type: 'function', function: { name: 'X', arguments: '{}' } }],
      },
      { role: 'tool', content: 'r', tool_call_id: '1', name: 'X' },
    ]
    writeFileSync(join(dir, 'history.json'), JSON.stringify(legacy), 'utf8')
    expect(loadSession(dir)).toEqual(legacy)
  })

  it('a session written by a newer ovogogogo throws UnknownSessionVersionError (not CorruptSessionError)', () => {
    const cwd = freshDir('env-future')
    const dir = createSessionDir(cwd, FIXED_DATE)
    const future = {
      version: CURRENT_SESSION_VERSION + 1,
      schema: 'ovogo.session.v999',
      createdAt: '2026-07-13T00:00:00.000Z',
      messages: [{ role: 'user', content: 'q' }],
    }
    writeFileSync(join(dir, 'history.json'), JSON.stringify(future), 'utf8')

    let caught: unknown
    try { loadSession(dir) } catch (err) { caught = err }
    expect(caught).toBeInstanceOf(UnknownSessionVersionError)

    const e = caught as UnknownSessionVersionError
    expect(e.version).toBe(CURRENT_SESSION_VERSION + 1)
    expect(e.minSupported).toBe(MIN_SUPPORTED_VERSION)
    expect(e.maxSupported).toBe(CURRENT_SESSION_VERSION)
    expect(e.message).toContain(String(CURRENT_SESSION_VERSION + 1))
    expect(e.message).toContain(String(MIN_SUPPORTED_VERSION))
    expect(e.message).toContain(String(CURRENT_SESSION_VERSION))
  })

  it('a much-newer version (e.g. 99) still throws UnknownSessionVersionError', () => {
    const cwd = freshDir('env-future-99')
    const dir = createSessionDir(cwd, FIXED_DATE)
    writeFileSync(
      join(dir, 'history.json'),
      JSON.stringify({
        version: 99,
        schema: 'ovogo.session.v99',
        createdAt: '2030-01-01T00:00:00.000Z',
        messages: [],
      }),
      'utf8',
    )
    expect(() => loadSession(dir)).toThrow(UnknownSessionVersionError)
  })

  it('envelope at version = minSupported still loads (lower edge of range)', () => {
    const cwd = freshDir('env-min')
    const dir = createSessionDir(cwd, FIXED_DATE)
    writeFileSync(
      join(dir, 'history.json'),
      JSON.stringify({
        version: MIN_SUPPORTED_VERSION,
        schema: CURRENT_SESSION_SCHEMA,
        updatedAt: '2026-07-13T00:00:00.000Z',
        messages: [{ role: 'user', content: 'q' }],
      }),
      'utf8',
    )
    expect(loadSession(dir)).toEqual([{ role: 'user', content: 'q' }])
  })

  it('envelope at version below MIN_SUPPORTED throws UnknownSessionVersionError', () => {
    // Only meaningful when MIN_SUPPORTED > 1. The assertion is conditional
    // so the test stays stable as the floor rises.
    if (MIN_SUPPORTED_VERSION <= 1) return
    const cwd = freshDir('env-pre-min')
    const dir = createSessionDir(cwd, FIXED_DATE)
    writeFileSync(
      join(dir, 'history.json'),
      JSON.stringify({
        version: MIN_SUPPORTED_VERSION - 1,
        schema: CURRENT_SESSION_SCHEMA,
        createdAt: '2026-01-01T00:00:00.000Z',
        messages: [],
      }),
      'utf8',
    )
    expect(() => loadSession(dir)).toThrow(UnknownSessionVersionError)
  })

  it('envelope missing required fields throws CorruptSessionError (not UnknownSessionVersionError)', () => {
    const cwd = freshDir('env-malformed-shapes')
    const cases: Array<{ name: string; json: object }> = [
      // valid envelope OBJECT shape but field types wrong
      { name: 'no version', json: { schema: CURRENT_SESSION_SCHEMA, updatedAt: 'x', messages: [] } },
      { name: 'version is string', json: { version: '1', schema: CURRENT_SESSION_SCHEMA, updatedAt: 'x', messages: [] } },
      { name: 'no schema', json: { version: 1, updatedAt: 'x', messages: [] } },
      { name: 'no updatedAt', json: { version: 1, schema: CURRENT_SESSION_SCHEMA, messages: [] } },
      { name: 'messages is string', json: { version: 1, schema: CURRENT_SESSION_SCHEMA, updatedAt: 'x', messages: 'nope' } },
      { name: 'messages is object', json: { version: 1, schema: CURRENT_SESSION_SCHEMA, updatedAt: 'x', messages: {} } },
    ]
    for (const c of cases) {
      const dir = createSessionDir(cwd, FIXED_DATE)
      writeFileSync(join(dir, 'history.json'), JSON.stringify(c.json), 'utf8')
      let caught: unknown
      try { loadSession(dir) } catch (err) { caught = err }
      expect(caught, c.name).toBeInstanceOf(CorruptSessionError)
      expect(caught, c.name).not.toBeInstanceOf(UnknownSessionVersionError)
    }
  })

  it('envelope with malformed messages inside throws CorruptSessionError', () => {
    const cwd = freshDir('env-bad-inner')
    const dir = createSessionDir(cwd, FIXED_DATE)
    writeFileSync(
      join(dir, 'history.json'),
      JSON.stringify({
        version: CURRENT_SESSION_VERSION,
        schema: CURRENT_SESSION_SCHEMA,
        updatedAt: '2026-07-13T00:00:00.000Z',
        messages: [{ role: 'manager', content: 'wrong-role' }],
      }),
      'utf8',
    )
    expect(() => loadSession(dir)).toThrow(CorruptSessionError)
  })

  it('envelope with float version (e.g. 1.5) is treated as unknown, not corrupted', () => {
    const cwd = freshDir('env-float-version')
    const dir = createSessionDir(cwd, FIXED_DATE)
    writeFileSync(
      join(dir, 'history.json'),
      JSON.stringify({
        version: 1.5,
        schema: CURRENT_SESSION_SCHEMA,
        createdAt: '2026-07-13T00:00:00.000Z',
        messages: [],
      }),
      'utf8',
    )
    // 1.5 is not an integer, so the version-range check rejects it.
    expect(() => loadSession(dir)).toThrow(UnknownSessionVersionError)
  })

  it('envelope with explicit version 0 (negative direction) is rejected, not silently treated as v0 root array', () => {
    // A v0 envelope object IS distinguishable from a legacy root array —
    // the loader never falls back to "I guess this is a bare array". If
    // someone wraps a v0 in an envelope, the version check catches it.
    const cwd = freshDir('env-v0-obj')
    const dir = createSessionDir(cwd, FIXED_DATE)
    writeFileSync(
      join(dir, 'history.json'),
      JSON.stringify({
        version: 0,
        schema: CURRENT_SESSION_SCHEMA,
        createdAt: '2026-07-13T00:00:00.000Z',
        messages: [],
      }),
      'utf8',
    )
    expect(() => loadSession(dir)).toThrow(UnknownSessionVersionError)
  })

  it('malformed JSON envelope throws CorruptSessionError', () => {
    const cwd = freshDir('env-malformed-json')
    const dir = createSessionDir(cwd, FIXED_DATE)
    writeFileSync(join(dir, 'history.json'), '{ not json', 'utf8')
    expect(() => loadSession(dir)).toThrow(CorruptSessionError)
  })

  it('saveSession atomic: tmp file never survives a successful write', () => {
    const cwd = freshDir('env-atomic')
    const dir = createSessionDir(cwd, FIXED_DATE)
    saveSession(dir, [mkMessage('user', 'a')])
    expect(existsSync(join(dir, 'history.json.tmp'))).toBe(false)
  })

  it('saveSession overwrites a legacy file in place: legacy → current envelope, single atomic write', () => {
    const cwd = freshDir('env-upgrade')
    const dir = createSessionDir(cwd, FIXED_DATE)
    const legacy = [mkMessage('user', 'old'), mkMessage('assistant', 'old-reply')]
    writeFileSync(join(dir, 'history.json'), JSON.stringify(legacy), 'utf8')
    expect(JSON.parse(readFileSync(join(dir, 'history.json'), 'utf8'))).toEqual(legacy)

    // Caller (e.g. a turn that resumed a legacy session) saves — we upgrade.
    saveSession(dir, legacy)

    const onDisk = JSON.parse(readFileSync(join(dir, 'history.json'), 'utf8'))
    expect(Array.isArray(onDisk)).toBe(false)
    expect(onDisk.version).toBe(CURRENT_SESSION_VERSION)
    expect(onDisk.schema).toBe(CURRENT_SESSION_SCHEMA)
    expect(typeof onDisk.updatedAt).toBe('string')
    expect(onDisk.messages).toEqual(legacy)
    expect(existsSync(join(dir, 'history.json.tmp'))).toBe(false)
  })

  it('listSessions still reports message counts after the envelope change (legacy + current mixed)', () => {
    const cwd = freshDir('env-list-mixed')
    const legacyDir = createSessionDir(cwd, new Date('2026-07-13T08:00:00.000Z'))
    writeFileSync(
      join(legacyDir, 'history.json'),
      JSON.stringify([mkMessage('user', 'old1'), mkMessage('assistant', 'old2')]),
      'utf8',
    )
    const currentDir = createSessionDir(cwd, new Date('2026-07-13T11:00:00.000Z'))
    saveSession(currentDir, [mkMessage('user', 'new1')])

    const sessions = listSessions(cwd)
    expect(sessions).toEqual([
      { dir: currentDir, name: 'session_2026-07-13_110000', messages: 1 },
      { dir: legacyDir, name: 'session_2026-07-13_080000', messages: 2 },
    ])
  })

  it('listSessions reports messages=0 for an unknown-future version (file is not loaded but listed)', () => {
    const cwd = freshDir('env-list-future')
    const dir = createSessionDir(cwd, FIXED_DATE)
    writeFileSync(
      join(dir, 'history.json'),
      JSON.stringify({
        version: CURRENT_SESSION_VERSION + 1,
        schema: 'ovogo.session.v999',
        createdAt: '2030-01-01T00:00:00.000Z',
        messages: [],
      }),
      'utf8',
    )
    const [entry] = listSessions(cwd)
    expect(entry?.dir).toBe(dir)
    // Future-version file fails to load → counted as messages=0 (per the
    // documented "informational" contract of /sessions).
    expect(entry?.messages).toBe(0)
  })

  it('saveSession works on a brand-new directory (creates parent / sessions ancestors)', () => {
    // Use a directory that has no `sessions/` ancestor yet.
    const cwd = freshDir('env-deep-create')
    const dir = join(cwd, 'sessions', 'session_2026-07-13_103045')
    saveSession(dir, [mkMessage('user', 'q')])

    expect(existsSync(dir)).toBe(true)
    expect(loadSession(dir)).toEqual([mkMessage('user', 'q')])
    expect(JSON.parse(readFileSync(join(dir, 'history.json'), 'utf8')).version)
      .toBe(CURRENT_SESSION_VERSION)
  })

  it('saveSession rejects non-array history (same contract as before)', () => {
    const cwd = freshDir('env-bad-history')
    const dir = createSessionDir(cwd, FIXED_DATE)
    expect(() => saveSession(dir, null as unknown as OpenAIMessage[])).toThrow(TypeError)
    expect(() => saveSession(dir, 'nope' as unknown as OpenAIMessage[])).toThrow(TypeError)
  })

  it('UnknownSessionVersionError.name is stable for error-class matching', () => {
    // Defensive: don't accidentally rename the class — internal error-class
    // matching depends on this. If you ever do rename it, update CLI callers
    // in `bin/ovogogogo.ts`.
    const cwd = freshDir('env-errname')
    const dir = createSessionDir(cwd, FIXED_DATE)
    writeFileSync(
      join(dir, 'history.json'),
      JSON.stringify({ version: 999, schema: 'x', updatedAt: '2030-01-01T00:00:00.000Z', messages: [] }),
      'utf8',
    )
    let caught: unknown
    try { loadSession(dir) } catch (err) { caught = err }
    expect((caught as Error).name).toBe('UnknownSessionVersionError')
  })
})

// ── schema-name tightening + ISO validation + version-gate ordering ───────
//
// Review-driven hardening:
//   1. v1 envelope MUST carry the canonical schema name — a wrong schema
//      string is corrupt, not silently accepted.
//   2. updatedAt must be a real ISO-8601 instant. Non-ISO strings, NaN
//      parsers, and numbers must all be rejected.
//   3. Future-version files with truncated fields MUST throw
//      UnknownSessionVersionError, not CorruptSessionError — the version
//      gate runs before any per-field shape validation.

describe('envelope hardening: schema name, timestamps, version-gate ordering', () => {
  it('v1 with the WRONG schema string is rejected as CorruptSessionError (not UnknownSessionVersionError)', () => {
    const cwd = freshDir('schema-wrong')
    const dir = createSessionDir(cwd, FIXED_DATE)
    writeFileSync(
      join(dir, 'history.json'),
      JSON.stringify({
        version: CURRENT_SESSION_VERSION,
        schema: 'ovogo.session.v99', // wrong name, right version
        updatedAt: '2026-07-13T00:00:00.000Z',
        messages: [{ role: 'user', content: 'q' }],
      }),
      'utf8',
    )
    let caught: unknown
    try { loadSession(dir) } catch (err) { caught = err }
    expect(caught).toBeInstanceOf(CorruptSessionError)
    expect(caught).not.toBeInstanceOf(UnknownSessionVersionError)
    // The error message names both expected and observed schemas so the
    // operator can see exactly what mismatched.
    expect((caught as Error).message).toContain('ovogo.session.v99')
    expect((caught as Error).message).toContain(CURRENT_SESSION_SCHEMA)
    expect((caught as Error).message).toContain(`for version ${CURRENT_SESSION_VERSION}`)
  })

  it('v1 with a foreign schema string ("x" / "ovogo.session" / random) is rejected', () => {
    const cwd = freshDir('schema-many')
    for (const wrong of ['x', 'ovogo.session', 'ovogo.session.v1.0', 'session.v1', '']) {
      const dir = createSessionDir(cwd, FIXED_DATE)
      writeFileSync(
        join(dir, 'history.json'),
        JSON.stringify({
          version: CURRENT_SESSION_VERSION,
          schema: wrong,
          updatedAt: '2026-07-13T00:00:00.000Z',
          messages: [],
        }),
        'utf8',
      )
      expect(() => loadSession(dir), `schema="${wrong}"`).toThrow(CorruptSessionError)
    }
  })

  it('v1 with missing schema field is rejected as CorruptSessionError', () => {
    const cwd = freshDir('schema-missing')
    const dir = createSessionDir(cwd, FIXED_DATE)
    writeFileSync(
      join(dir, 'history.json'),
      JSON.stringify({
        version: CURRENT_SESSION_VERSION,
        updatedAt: '2026-07-13T00:00:00.000Z',
        messages: [],
      }),
      'utf8',
    )
    expect(() => loadSession(dir)).toThrow(CorruptSessionError)
  })

  it('v1 with non-string schema (number / null) is rejected as CorruptSessionError', () => {
    const cwd = freshDir('schema-typed')
    for (const bad of [42, null, true, []]) {
      const dir = createSessionDir(cwd, FIXED_DATE)
      writeFileSync(
        join(dir, 'history.json'),
        JSON.stringify({
          version: CURRENT_SESSION_VERSION,
          schema: bad,
          updatedAt: '2026-07-13T00:00:00.000Z',
          messages: [],
        }),
        'utf8',
      )
      expect(() => loadSession(dir), `schema=${JSON.stringify(bad)}`).toThrow(CorruptSessionError)
    }
  })

  it('updatedAt must be a real ISO-8601 instant — non-ISO strings rejected', () => {
    const cwd = freshDir('iso-bad-strings')
    for (const bad of ['not a date', '2026/07/13 00:00:00', 'Mon Jul 13 2026', '13/07/2026', '']) {
      const dir = createSessionDir(cwd, FIXED_DATE)
      writeFileSync(
        join(dir, 'history.json'),
        JSON.stringify({
          version: CURRENT_SESSION_VERSION,
          schema: CURRENT_SESSION_SCHEMA,
          updatedAt: bad,
          messages: [],
        }),
        'utf8',
      )
      expect(() => loadSession(dir), `updatedAt="${bad}"`).toThrow(CorruptSessionError)
    }
  })

  it('updatedAt must be ISO — number, null, undefined, missing all rejected', () => {
    const cwd = freshDir('iso-bad-types')
    const cases: Array<{ name: string; json: Record<string, unknown> }> = [
      { name: 'number', json: { version: CURRENT_SESSION_VERSION, schema: CURRENT_SESSION_SCHEMA, updatedAt: 1700000000000, messages: [] } },
      { name: 'null',   json: { version: CURRENT_SESSION_VERSION, schema: CURRENT_SESSION_SCHEMA, updatedAt: null,   messages: [] } },
      { name: 'undefined (missing field)', json: { version: CURRENT_SESSION_VERSION, schema: CURRENT_SESSION_SCHEMA, messages: [] } },
    ]
    for (const c of cases) {
      const dir = createSessionDir(cwd, FIXED_DATE)
      writeFileSync(join(dir, 'history.json'), JSON.stringify(c.json), 'utf8')
      expect(() => loadSession(dir), c.name).toThrow(CorruptSessionError)
    }
  })

  it('updatedAt accepts a real ISO instant and round-trips losslessly', () => {
    const cwd = freshDir('iso-good')
    const dir = createSessionDir(cwd, FIXED_DATE)
    const iso = '2026-07-13T10:30:45.000Z'
    writeFileSync(
      join(dir, 'history.json'),
      JSON.stringify({
        version: CURRENT_SESSION_VERSION,
        schema: CURRENT_SESSION_SCHEMA,
        updatedAt: iso,
        messages: [{ role: 'user', content: 'q' }],
      }),
      'utf8',
    )
    // loadSession validates the envelope and reads messages; separately we
    // confirm the on-disk updatedAt survived unchanged.
    expect(loadSession(dir)).toEqual([{ role: 'user', content: 'q' }])
    const onDisk = JSON.parse(readFileSync(join(dir, 'history.json'), 'utf8'))
    expect(onDisk.updatedAt).toBe(iso)
  })

  // ── version-gate ordering: future-version files with missing fields → UnknownSessionVersionError
  it('FUTURE-version file with NO fields except version still throws UnknownSessionVersionError (not CorruptSessionError)', () => {
    // The critical invariant: gate (1) — version range — fires before ANY
    // field-shape check. A future version we don't recognize may have a
    // totally different schema; we must NOT classify it as "corrupt" just
    // because it lacks OUR field names.
    const cwd = freshDir('vg-order-min')
    const dir = createSessionDir(cwd, FIXED_DATE)
    writeFileSync(
      join(dir, 'history.json'),
      JSON.stringify({ version: CURRENT_SESSION_VERSION + 1 }),
      'utf8',
    )
    let caught: unknown
    try { loadSession(dir) } catch (err) { caught = err }
    expect(caught).toBeInstanceOf(UnknownSessionVersionError)
    expect(caught).not.toBeInstanceOf(CorruptSessionError)
  })

  it('FUTURE-version file with TRUNCATED standard fields still throws UnknownSessionVersionError', () => {
    // Realistic case: a future writer uses the same field names but adds a
    // new mandatory field. Loading should report the version mismatch,
    // not a shape mismatch on a field WE don't yet understand.
    const cwd = freshDir('vg-order-truncated')
    const dir = createSessionDir(cwd, FIXED_DATE)
    writeFileSync(
      join(dir, 'history.json'),
      JSON.stringify({
        version: CURRENT_SESSION_VERSION + 2,
        schema: 'ovogo.session.v3',
        // updatedAt missing — would otherwise look "corrupt"
        messages: [{ role: 'user', content: 'q' }],
      }),
      'utf8',
    )
    let caught: unknown
    try { loadSession(dir) } catch (err) { caught = err }
    expect(caught).toBeInstanceOf(UnknownSessionVersionError)
    expect(caught).not.toBeInstanceOf(CorruptSessionError)
  })

  it('FUTURE-version file with WRONG-type fields still throws UnknownSessionVersionError (not CorruptSessionError)', () => {
    const cwd = freshDir('vg-order-types')
    const dir = createSessionDir(cwd, FIXED_DATE)
    writeFileSync(
      join(dir, 'history.json'),
      JSON.stringify({
        version: CURRENT_SESSION_VERSION + 1,
        schema: 12345,        // wrong type
        updatedAt: 99999,     // wrong type
        messages: 'not-array',
      }),
      'utf8',
    )
    let caught: unknown
    try { loadSession(dir) } catch (err) { caught = err }
    expect(caught).toBeInstanceOf(UnknownSessionVersionError)
  })

  it('FUTURE-version file with version BELOW MIN_SUPPORTED also throws UnknownSessionVersionError', () => {
    const cwd = freshDir('vg-order-old')
    const dir = createSessionDir(cwd, FIXED_DATE)
    writeFileSync(
      join(dir, 'history.json'),
      JSON.stringify({ version: 0 }),
      'utf8',
    )
    let caught: unknown
    try { loadSession(dir) } catch (err) { caught = err }
    // v0 is below MIN_SUPPORTED_VERSION (1). Must be unknown-version, NOT
    // corrupt — the gate ordering matters here too.
    expect(caught).toBeInstanceOf(UnknownSessionVersionError)
    expect(caught).not.toBeInstanceOf(CorruptSessionError)
    // Specifically: a version:0 OBJECT is distinct from a v0 root ARRAY
    // (the latter still loads). Detection follows shape, not filename.
  })

  it('SAVE writes a canonical-schema envelope — same string as exported constant', () => {
    // This guards against accidental schema-name drift between the constant
    // and what saveSession actually writes.
    const cwd = freshDir('schema-canonical')
    const dir = createSessionDir(cwd, FIXED_DATE)
    saveSession(dir, [])
    const onDisk = JSON.parse(readFileSync(join(dir, 'history.json'), 'utf8'))
    expect(onDisk.schema).toBe(CURRENT_SESSION_SCHEMA)
  })
})
