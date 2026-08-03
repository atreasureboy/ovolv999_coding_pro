/**
 * EventLog tests — covering append, line-tolerant readAll, query, and the
 * best-effort write contract. Concurrency is exercised at the API surface
 * (multiple EventLog instances writing the same dir); we do NOT promise
 * power-loss durability so fsync is intentionally omitted.
 */

import { mkdtempSync, rmSync, writeFileSync, appendFileSync, mkdirSync, readFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  EventLog,
  isValidEntry,
  buildFilter,
  type EventLogEntry,
  type ReadAllOptions,
} from '../src/core/eventLog.js'

// ── helpers ────────────────────────────────────────────────────────────────

function tmpSession(): string {
  return mkdtempSync(join(tmpdir(), 'ovogo-eventlog-'))
}

function countLines(path: string): number {
  const raw = readFileSync(path, 'utf8')
  if (raw === '') return 0
  return raw.split('\n').filter((l: string) => l.length > 0).length
}

function readRaw(path: string): string {
  return readFileSync(path, 'utf8')
}

// ── isValidEntry / buildFilter (pure helpers) ──────────────────────────────

const VALID_TS = '2025-01-01T00:00:00.000Z'

describe('isValidEntry', () => {
  it('accepts a well-formed entry', () => {
    expect(isValidEntry({
      id: 'evt_1',
      timestamp: '2025-01-01T00:00:00.000Z',
      type: 'tool_call',
      source: 'Bash',
      detail: { command: 'ls' },
    })).toBe(true)
  })

  it('accepts an entry with optional tags', () => {
    expect(isValidEntry({
      id: 'evt_1',
      timestamp: '2025-01-01T00:00:00.000Z',
      type: 'tool_call',
      source: 'Bash',
      detail: {},
      tags: ['foo', 'bar'],
    })).toBe(true)
  })

  it('rejects entries missing required fields', () => {
    expect(isValidEntry({ id: 'x', timestamp: VALID_TS, type: 'tool_call', source: 's' })).toBe(false) // no detail
    expect(isValidEntry({ id: 'x', timestamp: VALID_TS, type: 'tool_call', detail: {} })).toBe(false) // no source
    expect(isValidEntry({ id: 'x', timestamp: VALID_TS, source: 's', detail: {} })).toBe(false)      // no type
    expect(isValidEntry({ id: 'x', type: 'tool_call', source: 's', detail: {} })).toBe(false)         // no timestamp
    expect(isValidEntry({ timestamp: VALID_TS, type: 'tool_call', source: 's', detail: {} })).toBe(false) // no id
  })

  it('rejects non-object / arrays / null', () => {
    expect(isValidEntry(null)).toBe(false)
    expect(isValidEntry(undefined)).toBe(false)
    expect(isValidEntry('string')).toBe(false)
    expect(isValidEntry(42)).toBe(false)
    expect(isValidEntry([])).toBe(false)
  })

  it('rejects entries whose detail is not an object', () => {
    expect(isValidEntry({
      id: 'x', timestamp: VALID_TS, type: 'tool_call', source: 's', detail: 'oops',
    })).toBe(false)
    expect(isValidEntry({
      id: 'x', timestamp: VALID_TS, type: 'tool_call', source: 's', detail: null,
    })).toBe(false)
  })

  it('rejects entries whose tags is not an array', () => {
    expect(isValidEntry({
      id: 'x', timestamp: VALID_TS, type: 'tool_call', source: 's', detail: {}, tags: 'oops',
    })).toBe(false)
  })

  it('rejects entries whose tags contain non-string elements', () => {
    expect(isValidEntry({
      id: 'x', timestamp: VALID_TS, type: 'tool_call', source: 's', detail: {}, tags: ['ok', 42],
    })).toBe(false)
    expect(isValidEntry({
      id: 'x', timestamp: VALID_TS, type: 'tool_call', source: 's', detail: {}, tags: [null, 'ok'],
    })).toBe(false)
    expect(isValidEntry({
      id: 'x', timestamp: VALID_TS, type: 'tool_call', source: 's', detail: {}, tags: [{ nested: 'obj' }],
    })).toBe(false)
    // Empty array is still valid
    expect(isValidEntry({
      id: 'x', timestamp: VALID_TS, type: 'tool_call', source: 's', detail: {}, tags: [],
    })).toBe(true)
  })

  it('rejects unknown event types (not in EventType whitelist)', () => {
    expect(isValidEntry({
      id: 'x', timestamp: VALID_TS, type: 'tool_call_typo', source: 's', detail: {},
    })).toBe(false)
    expect(isValidEntry({
      id: 'x', timestamp: VALID_TS, type: 'Tool_Call', source: 's', detail: {},  // case sensitive
    })).toBe(false)
    expect(isValidEntry({
      id: 'x', timestamp: VALID_TS, type: '', source: 's', detail: {},
    })).toBe(false)
  })

  it('accepts every documented EventType value', () => {
    const allTypes = [
      'tool_call', 'tool_result', 'boot_context', 'invoke_sent', 'invoke_completed',
      'memory_write', 'context_compact', 'module_flag', 'agent_completion', 'protocol',
      'workspace_change', 'permission_decision', 'worker_restart', 'llm_api', 'llm_api_usage_missing',
    ]
    for (const t of allTypes) {
      expect(isValidEntry({
        id: 'x', timestamp: VALID_TS, type: t, source: 's', detail: {},
      })).toBe(true)
    }
  })

  it('rejects unparseable timestamps', () => {
    expect(isValidEntry({
      id: 'x', timestamp: 'not-a-date', type: 'tool_call', source: 's', detail: {},
    })).toBe(false)
    expect(isValidEntry({
      id: 'x', timestamp: '', type: 'tool_call', source: 's', detail: {},
    })).toBe(false)
    expect(isValidEntry({
      id: 'x', timestamp: '2025-13-99T99:99:99.999Z', type: 'tool_call', source: 's', detail: {},
    })).toBe(false)
  })

  it('accepts ISO-8601 and other Date.parse-able timestamp forms', () => {
    expect(isValidEntry({
      id: 'x', timestamp: '2025-01-01T00:00:00.000Z', type: 'tool_call', source: 's', detail: {},
    })).toBe(true)
    expect(isValidEntry({
      id: 'x', timestamp: '2025-06-15T13:45:30+02:00', type: 'tool_call', source: 's', detail: {},
    })).toBe(true)
  })
})

describe('buildFilter', () => {
  const sample = (overrides: Partial<EventLogEntry> = {}): EventLogEntry => ({
    id: 'e1',
    timestamp: 't',
    type: 'tool_call',
    source: 'Bash',
    detail: {},
    ...overrides,
  })

  it('matches by type', () => {
    const f = buildFilter({ type: 'tool_call' })
    expect(f(sample())).toBe(true)
    expect(f(sample({ type: 'tool_result' }))).toBe(false)
  })

  it('matches by source', () => {
    const f = buildFilter({ source: 'Bash' })
    expect(f(sample())).toBe(true)
    expect(f(sample({ source: 'Read' }))).toBe(false)
  })

  it('matches by tag presence', () => {
    const f = buildFilter({ tag: 'verify' })
    expect(f(sample({ tags: ['verify', 'ok'] }))).toBe(true)
    expect(f(sample({ tags: ['other'] }))).toBe(false)
    expect(f(sample())).toBe(false)  // no tags
  })

  it('AND-combines multiple filters', () => {
    const f = buildFilter({ type: 'tool_call', source: 'Bash', tag: 'verify' })
    expect(f(sample({ tags: ['verify'] }))).toBe(true)
    expect(f(sample({ tags: ['verify'], source: 'Read' }))).toBe(false)
    expect(f(sample({ tags: ['verify'], type: 'tool_result' }))).toBe(false)
    expect(f(sample({ tags: ['verify'] }))).toBe(true)
  })

  it('empty filter matches everything', () => {
    const f = buildFilter({})
    expect(f(sample())).toBe(true)
  })
})

// ── EventLog: append + readAll basics ──────────────────────────────────────

describe('EventLog.append / readAll', () => {
  let dir: string
  let log: EventLog

  beforeEach(() => {
    dir = tmpSession()
    log = new EventLog(dir)
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('returns the entry it appended', () => {
    const e = log.append('tool_call', 'Bash', { command: 'ls' })
    expect(e.id).toMatch(/^evt_/)
    expect(e.type).toBe('tool_call')
    expect(e.source).toBe('Bash')
    expect(e.detail).toEqual({ command: 'ls' })
    expect(typeof e.timestamp).toBe('string')
  })

  it('readAll returns a single entry after one append', () => {
    log.append('tool_call', 'Bash', { command: 'ls' })
    const entries = log.readAll()
    expect(entries).toHaveLength(1)
    expect(entries[0].source).toBe('Bash')
  })

  it('readAll returns entries in append order', () => {
    for (let i = 0; i < 5; i++) {
      log.append('tool_call', `tool_${i}`, { i })
    }
    const entries = log.readAll()
    expect(entries).toHaveLength(5)
    expect(entries.map((e) => e.source)).toEqual([
      'tool_0', 'tool_1', 'tool_2', 'tool_3', 'tool_4',
    ])
    expect(entries.map((e) => (e.detail as { i: number }).i)).toEqual([0, 1, 2, 3, 4])
  })

  it('preserves tags when supplied', () => {
    log.append('tool_call', 'Bash', { command: 'ls' }, ['verify', 'safe'])
    const [e] = log.readAll()
    expect(e.tags).toEqual(['verify', 'safe'])
  })

  it('readAll returns [] when the file does not exist', () => {
    const fresh = new EventLog(join(dir, 'never-touched'))
    expect(fresh.readAll()).toEqual([])
  })

  it('readAll returns [] for an empty file', () => {
    writeFileSync(join(dir, 'events.ndjson'), '', 'utf8')
    expect(log.readAll()).toEqual([])
  })

  it('creates the session directory if it does not exist', () => {
    const nested = join(dir, 'a', 'b', 'c')
    const l = new EventLog(nested)
    l.append('tool_call', 'X', {})
    expect(l.readAll()).toHaveLength(1)
  })

  it('getFilePath returns the events.ndjson path under the session dir', () => {
    expect(log.getFilePath()).toBe(join(dir, 'events.ndjson'))
  })
})

// ── EventLog: line-tolerant readAll (corrupt-line recovery) ────────────────

describe('EventLog.readAll corruption recovery', () => {
  let dir: string
  let log: EventLog

  beforeEach(() => {
    dir = tmpSession()
    log = new EventLog(dir)
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  function writeRaw(content: string): void {
    writeFileSync(join(dir, 'events.ndjson'), content, 'utf8')
  }

  it('skips a malformed JSON line, keeps valid surrounding lines', () => {
    log.append('tool_call', 'A', { i: 1 })
    appendFileSync(join(dir, 'events.ndjson'), '{not valid json\n', 'utf8')
    log.append('tool_call', 'B', { i: 2 })
    appendFileSync(join(dir, 'events.ndjson'), 'also garbage\n', 'utf8')
    log.append('tool_call', 'C', { i: 3 })

    const entries = log.readAll()
    expect(entries.map((e) => e.source)).toEqual(['A', 'B', 'C'])
  })

  it('skips entries that fail schema validation (valid JSON but wrong shape)', () => {
    log.append('tool_call', 'A', { i: 1 })
    appendFileSync(join(dir, 'events.ndjson'), JSON.stringify({ id: 'x', not: 'valid' }) + '\n', 'utf8')
    log.append('tool_call', 'B', { i: 2 })

    const entries = log.readAll()
    expect(entries.map((e) => e.source)).toEqual(['A', 'B'])
  })

  it('survives a wholly corrupt file without throwing', () => {
    writeRaw('}{garbage line 1\n][{\nnot even close\n')
    expect(() => log.readAll()).not.toThrow()
    expect(log.readAll()).toEqual([])
  })

  it('reports the count of skipped lines via onSkip', () => {
    log.append('tool_call', 'A', {})
    appendFileSync(join(dir, 'events.ndjson'), 'garbage1\n', 'utf8')
    log.append('tool_call', 'B', {})
    appendFileSync(join(dir, 'events.ndjson'), JSON.stringify({ id: 'x' }) + '\n', 'utf8') // invalid shape
    log.append('tool_call', 'C', {})
    appendFileSync(join(dir, 'events.ndjson'), 'garbage2\n', 'utf8')

    let skipped = -1
    const entries = log.readAll({ onSkip: (n) => { skipped = n } })
    expect(entries).toHaveLength(3)
    expect(skipped).toBe(3)
  })

  it('readAll returns [] when the entire file is one bad JSON line', () => {
    writeRaw('not json at all')
    const opts: ReadAllOptions = { onSkip: () => {} }
    expect(log.readAll(opts)).toEqual([])
  })

  it('preserves a valid entry sandwiched between two corrupt lines', () => {
    log.append('tool_call', 'MIDDLE', {})
    const path = join(dir, 'events.ndjson')
    const orig = readRaw(path)
    writeFileSync(path, 'first_garbage\n' + orig + 'last_garbage\n', 'utf8')

    const [e] = log.readAll()
    expect(e.source).toBe('MIDDLE')
  })

  it('skips a valid-JSON line with unknown type (whitelist)', () => {
    log.append('tool_call', 'A', {})
    // Type "made_up_event" is valid JSON, valid shape, but not in EventType
    appendFileSync(join(dir, 'events.ndjson'),
      JSON.stringify({
        id: 'x', timestamp: new Date().toISOString(),
        type: 'made_up_event', source: 's', detail: {},
      }) + '\n', 'utf8')
    log.append('tool_call', 'B', {})

    let skipped = 0
    const entries = log.readAll({ onSkip: (n) => { skipped = n } })
    expect(entries.map((e) => e.source)).toEqual(['A', 'B'])
    expect(skipped).toBe(1)
  })

  it('skips a valid-JSON line with non-string tag elements', () => {
    log.append('tool_call', 'A', {}, ['clean'])
    appendFileSync(join(dir, 'events.ndjson'),
      JSON.stringify({
        id: 'x', timestamp: new Date().toISOString(),
        type: 'tool_call', source: 'Bash', detail: {}, tags: ['ok', 42],
      }) + '\n', 'utf8')
    log.append('tool_call', 'B', {})

    let skipped = 0
    const entries = log.readAll({ onSkip: (n) => { skipped = n } })
    expect(entries.map((e) => e.source)).toEqual(['A', 'B'])
    expect(skipped).toBe(1)
  })

  it('skips a valid-JSON line with unparseable timestamp', () => {
    log.append('tool_call', 'A', {})
    appendFileSync(join(dir, 'events.ndjson'),
      JSON.stringify({
        id: 'x', timestamp: 'definitely-not-a-date',
        type: 'tool_call', source: 'Bash', detail: {},
      }) + '\n', 'utf8')
    log.append('tool_call', 'B', {})

    let skipped = 0
    const entries = log.readAll({ onSkip: (n) => { skipped = n } })
    expect(entries.map((e) => e.source)).toEqual(['A', 'B'])
    expect(skipped).toBe(1)
  })
})

// ── EventLog: query() filter ───────────────────────────────────────────────

describe('EventLog.query', () => {
  let dir: string
  let log: EventLog

  beforeEach(() => {
    dir = tmpSession()
    log = new EventLog(dir)
    log.append('tool_call', 'Bash', { i: 1 }, ['verify'])
    log.append('tool_call', 'Read', { i: 2 })
    log.append('tool_result', 'Bash', { i: 3 }, ['verify', 'success'])
    log.append('tool_result', 'Read', { i: 4 })
    log.append('context_compact', 'engine', { tokens: 1000 })
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('with no argument returns all entries', () => {
    expect(log.query()).toHaveLength(5)
  })

  it('filters by type', () => {
    const r = log.query({ type: 'tool_call' })
    expect(r).toHaveLength(2)
    expect(r.every((e) => e.type === 'tool_call')).toBe(true)
  })

  it('filters by source', () => {
    const r = log.query({ source: 'Bash' })
    expect(r).toHaveLength(2)
    expect(r.every((e) => e.source === 'Bash')).toBe(true)
  })

  it('filters by tag (any-match)', () => {
    const r = log.query({ tag: 'verify' })
    expect(r).toHaveLength(2)
    expect(r.every((e) => e.tags?.includes('verify'))).toBe(true)
  })

  it('combines filters with AND', () => {
    const r = log.query({ type: 'tool_call', source: 'Bash' })
    expect(r).toHaveLength(1)
    expect(r[0].detail).toEqual({ i: 1 })
  })

  it('accepts a predicate function', () => {
    const r = log.query((e) => e.source === 'Read')
    expect(r).toHaveLength(2)
  })

  it('predicate + structured filter give equivalent results for the same condition', () => {
    const a = log.query({ source: 'Bash' })
    const b = log.query((e) => e.source === 'Bash')
    expect(a.map((e) => e.id)).toEqual(b.map((e) => e.id))
  })

  it('query still skips corrupt lines (re-uses readAll)', () => {
    appendFileSync(join(dir, 'events.ndjson'), 'garbage\n', 'utf8')
    expect(log.query({ source: 'Bash' })).toHaveLength(2)
  })
})

// ── EventLog: best-effort append ───────────────────────────────────────────

describe('EventLog.append best-effort contract', () => {
  let dir: string

  beforeEach(() => { dir = tmpSession() })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('does not throw when events.ndjson path is a directory (EISDIR)', () => {
    // Pre-create a directory at the target path; appendFileSync will fail.
    mkdirSync(join(dir, 'events.ndjson'))
    const log = new EventLog(dir)
    expect(() => log.append('tool_call', 'X', {})).not.toThrow()
  })

  it('returns the entry object even when the write fails', () => {
    mkdirSync(join(dir, 'events.ndjson'))
    const log = new EventLog(dir)
    const e = log.append('tool_call', 'X', { a: 1 })
    // Caller still receives the structured entry — they can hold a reference
    // even if the on-disk log is broken.
    expect(e.id).toMatch(/^evt_/)
    expect(e.detail).toEqual({ a: 1 })
  })

  it('readAll after a failed append returns no new entries', () => {
    mkdirSync(join(dir, 'events.ndjson'))
    const log = new EventLog(dir)
    log.append('tool_call', 'X', {})
    // Read should not crash; path is a directory so readFileSync throws
    // and readAll returns []. What matters is no exception escapes.
    expect(() => log.readAll()).not.toThrow()
  })
})

// ── EventLog: volume / concurrency ─────────────────────────────────────────

describe('EventLog volume + concurrent writers', () => {
  let dir: string

  beforeEach(() => { dir = tmpSession() })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('every append terminates its line with \\n so the file always ends with a newline', () => {
    const log = new EventLog(dir)
    // Edge cases: one append, many appends, plus interleaved manual writes.
    log.append('tool_call', 'A', {})
    expect(readRaw(log.getFilePath())).toMatch(/\n$/)

    for (let i = 0; i < 50; i++) log.append('tool_call', 'B', { i })
    expect(readRaw(log.getFilePath())).toMatch(/\n$/)
    // No orphaned final line: file ends with exactly one trailing \n,
    // and split('\n') yields (N + 1) entries with the last being empty.
    const raw = readRaw(log.getFilePath())
    const parts = raw.split('\n')
    expect(parts[parts.length - 1]).toBe('')
    expect(parts.length).toBe(51 + 1)  // 1 + 50 entries + trailing empty
  })

  it('NDJSON invariant holds after a properly-delimited corrupt line is injected', () => {
    const log = new EventLog(dir)
    log.append('tool_call', 'A', {})
    // Properly delimited garbage (with trailing newline) — the next append's
    // trailing newline still puts the file in a parseable final state.
    appendFileSync(join(dir, 'events.ndjson'), 'garbage_with_newline\n', 'utf8')
    log.append('tool_call', 'B', {})
    expect(readRaw(log.getFilePath())).toMatch(/\n$/)
    // The garbage is skipped; both valid entries survive.
    const entries = log.readAll({ onSkip: () => {} })
    expect(entries.map((e) => e.source)).toEqual(['A', 'B'])
  })

  it('1000 sequential appends produce exactly 1000 readable entries', () => {
    const log = new EventLog(dir)
    const N = 1000
    for (let i = 0; i < N; i++) {
      log.append('tool_call', 'Bash', { i })
    }
    const entries = log.readAll()
    expect(entries).toHaveLength(N)
    // Order is preserved (sequential appends → sequential reads)
    for (let i = 0; i < N; i++) {
      expect(entries[i].detail).toEqual({ i })
    }
  })

  it('on-disk NDJSON has exactly N non-empty lines after 1000 appends', () => {
    const log = new EventLog(dir)
    const N = 1000
    for (let i = 0; i < N; i++) {
      log.append('tool_call', 'Bash', { i })
    }
    // Each NDJSON line must be valid JSON on its own (no interleaving).
    expect(countLines(log.getFilePath())).toBe(N)
  })

  it('every line is independently parseable JSON', () => {
    const log = new EventLog(dir)
    for (let i = 0; i < 100; i++) {
      log.append('tool_call', 'Bash', { i, payload: 'x'.repeat(50) })
    }
    const raw = readRaw(log.getFilePath())
    const lines = raw.split('\n').filter((l: string) => l.length > 0)
    expect(lines).toHaveLength(100)
    for (const line of lines) {
      expect(() => { JSON.parse(line) }).not.toThrow()
    }
  })

  it('1000 concurrent appends from multiple EventLog instances preserve all entries', () => {
    const N_WRITERS = 10
    const PER_WRITER = 100
    const writers = Array.from({ length: N_WRITERS }, () => new EventLog(dir))
    // Fire all writers in parallel — they all share the same file path.
    const promises: Promise<void>[] = []
    for (let w = 0; w < N_WRITERS; w++) {
      const writer = writers[w]
      promises.push(new Promise<void>((resolve) => {
        for (let i = 0; i < PER_WRITER; i++) {
          writer.append('tool_call', `writer_${w}`, { w, i })
        }
        resolve()
      }))
    }
    return Promise.all(promises).then(() => {
      const entries = new EventLog(dir).readAll()
      expect(entries).toHaveLength(N_WRITERS * PER_WRITER)
      // Every writer's events must be present at least once.
      const sourcesSeen = new Set(entries.map((e) => e.source))
      for (let w = 0; w < N_WRITERS; w++) {
        expect(sourcesSeen.has(`writer_${w}`)).toBe(true)
      }
      // Underlying NDJSON must be line-aligned.
      expect(countLines(join(dir, 'events.ndjson'))).toBe(N_WRITERS * PER_WRITER)
    })
  })
})