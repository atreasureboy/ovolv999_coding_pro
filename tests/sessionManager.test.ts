import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  AmbiguousSessionError,
  CorruptSessionError,
  SessionNotFoundError,
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
  it('writes history.json with pretty-printed JSON', () => {
    const cwd = freshDir('save')
    const dir = createSessionDir(cwd, FIXED_DATE)
    const history: OpenAIMessage[] = [mkMessage('user', 'hi'), mkMessage('assistant', 'hello')]

    saveSession(dir, history)

    const raw = readFileSync(join(dir, 'history.json'), 'utf8')
    expect(raw.endsWith('\n')).toBe(false)
    expect(JSON.parse(raw)).toEqual(history)
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
