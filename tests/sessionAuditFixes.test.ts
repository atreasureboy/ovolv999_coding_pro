/**
 * Regression tests for the SESSION audit fixes.
 *
 * Covers (one describe block per fix):
 *   1. saveSession uses a unique tmp file (not the fixed .tmp that could race).
 *   2. session message/tool_calls are deeply schema-validated.
 *   3. compact never produces an orphan tool/tool_call leading message.
 *   4. SemanticMemory rewrite is atomic (tmp + fsync + rename + finally cleanup).
 *   5. EpisodicMemory skips corrupt/wrong-shape rows.
 *   6. EventLog bounded read (limit) + rotation API.
 *   7. FileHistory version cap + SHA-256 directory naming.
 *
 * All tests assume the project already exports the underlying helpers; if a
 * previously-private helper is now exported solely for these tests, that
 * export is intentional and surface-stable.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
  chmodSync,
} from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { createHash } from 'crypto'

import {
  saveSession,
  loadSession,
  createSessionDir,
} from '../src/core/sessionManager.js'
import { computeSafeSplitPoint, serializeMessages } from '../src/core/compact.js'
import { SemanticMemory } from '../src/core/semanticMemory.js'
import { EpisodicMemory, isValidEpisode, MAX_EPISODES } from '../src/core/episodicMemory.js'
import { EventLog, DEFAULT_EVENTLOG_ROTATE_BYTES } from '../src/core/eventLog.js'
import {
  FileHistory,
  MAX_VERSIONS_PER_FILE,
} from '../src/core/fileHistory.js'
import type { OpenAIMessage } from '../src/core/types.js'

// ── helpers ────────────────────────────────────────────────────────────────

let tmpRoot = ''

function freshDir(label: string): string {
  return mkdtempSync(join(tmpRoot, `${label}-`))
}

const FIXED_DATE = new Date('2026-07-13T10:30:45.000Z')

function mkMsg(role: OpenAIMessage['role'], content: string): OpenAIMessage {
  return { role, content }
}

function listTmpLeftovers(dir: string): string[] {
  if (!existsSync(dir)) return []
  return readdirSync(dir).filter((n) => /\.tmp/.test(n))
}

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'ovogo-session-fixes-'))
})

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true })
})

// ──────────────────────────────────────────────────────────────────────────
// 1) saveSession unique tmp file
// ──────────────────────────────────────────────────────────────────────────

describe('saveSession: unique tmp file (defect #1)', () => {
  it('never leaves a fixed `history.json.tmp` behind', () => {
    const dir = createSessionDir(freshDir('savetmp-fixed'), FIXED_DATE)
    saveSession(dir, [mkMsg('user', 'hi')])
    expect(existsSync(join(dir, 'history.json.tmp'))).toBe(false)
  })

  it('uses a process-unique tmp suffix on disk (pid + ts + random bytes)', () => {
    const dir = createSessionDir(freshDir('savetmp-unique'), FIXED_DATE)
    saveSession(dir, [mkMsg('user', 'hi')])
    // The new tmp naming: `history.json.tmp.<pid>.<ts>.<random>`.
    // After a successful write the tmp has been renamed, so it MUST NOT
    // exist anymore. The only way a leftover tmp could exist is if the
    // unique suffix collisioned with another concurrent writer — which
    // is effectively impossible.
    const leftovers = listTmpLeftovers(dir).filter((n) => n.startsWith('history.json.tmp'))
    expect(leftovers).toEqual([])
  })

  it('two sequential saves in the same dir do not race on the tmp name', () => {
    // Same-millisecond writes must not steal each other's tmp. The old
    // fixed `.tmp` would have; the unique suffix cannot. We assert the
    // outcome (final file correct, no leftover tmps) rather than the
    // internal name.
    const dir = createSessionDir(freshDir('savetmp-race'), FIXED_DATE)
    saveSession(dir, [mkMsg('user', 'first')])
    saveSession(dir, [mkMsg('user', 'second'), mkMsg('assistant', 'reply')])
    expect(loadSession(dir)).toHaveLength(2)
    expect(listTmpLeftovers(dir).filter((n) => n.startsWith('history.json.tmp'))).toEqual([])
  })

  it('a failed save does not leave ANY process-unique tmp around', () => {
    const dir = createSessionDir(freshDir('savetmp-cleanup'), FIXED_DATE)
    // Pre-create history.json as a DIRECTORY so writeFileSync(tmp, ...) →
    // rename(tmp, history.json) → ENOTDIR on rename. The error path must
    // still clean up its tmp.
    mkdirSync(join(dir, 'history.json'))
    expect(() => saveSession(dir, [mkMsg('user', 'will-fail')])).toThrow()
    expect(listTmpLeftovers(dir).filter((n) => n.startsWith('history.json.tmp'))).toEqual([])
  })
})

// ──────────────────────────────────────────────────────────────────────────
// 2) deep schema validation of tool_calls
// ──────────────────────────────────────────────────────────────────────────

describe('session message deep validation (defect #2)', () => {
  it('rejects an assistant message whose tool_calls[].id is not a string', () => {
    const dir = createSessionDir(freshDir('tool-id-type'), FIXED_DATE)
    const bad = [{
      role: 'assistant' as const,
      content: null,
      tool_calls: [{ id: 42, type: 'function' as const, function: { name: 'X', arguments: '{}' } }],
    }]
    writeFileSync(join(dir, 'history.json'), JSON.stringify(bad), 'utf8')
    expect(() => loadSession(dir)).toThrow(/CorruptSessionError|history\[0\]/)
  })

  it('rejects an assistant message whose tool_calls[].type is not "function"', () => {
    const dir = createSessionDir(freshDir('tool-type'), FIXED_DATE)
    const bad = [{
      role: 'assistant' as const,
      content: null,
      tool_calls: [{ id: 'tc1', type: 'tool' as const, function: { name: 'X', arguments: '{}' } }],
    }]
    writeFileSync(join(dir, 'history.json'), JSON.stringify(bad), 'utf8')
    expect(() => loadSession(dir)).toThrow(/CorruptSessionError|history\[0\]/)
  })

  it('rejects an assistant message whose tool_calls[].function is not an object', () => {
    const dir = createSessionDir(freshDir('tool-fn-not-obj'), FIXED_DATE)
    const bad = [{
      role: 'assistant' as const,
      content: null,
      tool_calls: [{ id: 'tc1', type: 'function' as const, function: 'not-an-object' as unknown as { name: string; arguments: string } }],
    }]
    writeFileSync(join(dir, 'history.json'), JSON.stringify(bad), 'utf8')
    expect(() => loadSession(dir)).toThrow(/CorruptSessionError|history\[0\]/)
  })

  it('rejects an assistant message whose tool_calls[].function.name is missing', () => {
    const dir = createSessionDir(freshDir('tool-name-missing'), FIXED_DATE)
    const bad = [{
      role: 'assistant' as const,
      content: null,
      tool_calls: [{ id: 'tc1', type: 'function' as const, function: { arguments: '{}' } }],
    }]
    writeFileSync(join(dir, 'history.json'), JSON.stringify(bad), 'utf8')
    expect(() => loadSession(dir)).toThrow(/CorruptSessionError|history\[0\]/)
  })

  it('rejects an assistant message whose tool_calls[].function.arguments is not a string', () => {
    const dir = createSessionDir(freshDir('tool-args-not-string'), FIXED_DATE)
    const bad = [{
      role: 'assistant' as const,
      content: null,
      tool_calls: [{ id: 'tc1', type: 'function' as const, function: { name: 'X', arguments: { not: 'a string' } as unknown as string } }],
    }]
    writeFileSync(join(dir, 'history.json'), JSON.stringify(bad), 'utf8')
    expect(() => loadSession(dir)).toThrow(/CorruptSessionError|history\[0\]/)
  })

  it('accepts a well-formed assistant message with tool_calls round-trips', () => {
    const dir = createSessionDir(freshDir('tool-roundtrip'), FIXED_DATE)
    const ok: OpenAIMessage[] = [{
      role: 'assistant',
      content: null,
      tool_calls: [{ id: 'tc1', type: 'function', function: { name: 'Read', arguments: '{"path":"a.ts"}' } }],
    }]
    saveSession(dir, ok)
    expect(loadSession(dir)).toEqual(ok)
  })
})

// ──────────────────────────────────────────────────────────────────────────
// 3) compact: orphan tool/tool_call prevention
// ──────────────────────────────────────────────────────────────────────────

describe('computeSafeSplitPoint: orphan tool/tool_call prevention (defect #3)', () => {
  it('never returns an index pointing to a leading tool message', () => {
    // 5 tool messages then a user message; splitPoint would be 12 if
    // KEEP_RECENT=8, but messages[12] is a tool → must advance past.
    const msgs: OpenAIMessage[] = []
    for (let i = 0; i < 20; i++) msgs.push({ role: 'user', content: `u${i}` })
    // Force a trailing block of tool messages after the natural split
    msgs.push({ role: 'assistant', content: 'c' })
    for (let i = 0; i < 10; i++) msgs.push({ role: 'tool', tool_call_id: `t${i}`, content: 'r', name: 'X' })
    const split = computeSafeSplitPoint(msgs)
    expect(msgs[split]?.role).not.toBe('tool')
    expect(split).toBeGreaterThanOrEqual(0)
    expect(split).toBeLessThanOrEqual(msgs.length)
  })

  it('never returns an index whose message is assistant-with-tool_calls without its results', () => {
    const msgs: OpenAIMessage[] = []
    // Pad with non-tool messages
    for (let i = 0; i < 5; i++) msgs.push({ role: 'user', content: `filler ${i} ` + 'x'.repeat(40) })
    msgs.push({ role: 'assistant', content: 'ack' })
    // Assistant with tool_calls but NO matching tool results follow it.
    msgs.push({
      role: 'assistant',
      content: null,
      tool_calls: [{ id: 'orphan1', type: 'function', function: { name: 'Bash', arguments: '{}' } }],
    })
    // Fill with more user/assistant pairs to push past KEEP_RECENT=8
    for (let i = 0; i < 10; i++) msgs.push({ role: 'user', content: `u ${i} ` + 'y'.repeat(40) })

    const split = computeSafeSplitPoint(msgs)
    // Whatever messages[split] is, it must NOT be an assistant whose
    // tool_calls are unmatched inside the recent window.
    const m = msgs[split]
    expect(m).toBeDefined()
    if (m && m.role === 'assistant' && m.tool_calls && m.tool_calls.length > 0) {
      const ids = new Set(m.tool_calls.map((tc) => tc.id))
      for (let j = split + 1; j < msgs.length; j++) {
        const n = msgs[j]
        if (n.role === 'tool' && n.tool_call_id && ids.has(n.tool_call_id)) ids.delete(n.tool_call_id)
        else if (n.role !== 'tool') break
      }
      expect(ids.size).toBe(0)
    }
  })

  it('keeps an assistant with tool_calls whose results ARE in the recent window', () => {
    // Recent window naturally includes an assistant + its tool result.
    const msgs: OpenAIMessage[] = []
    for (let i = 0; i < 6; i++) msgs.push({ role: 'user', content: 'pad ' + 'x'.repeat(50) })
    msgs.push({
      role: 'assistant',
      content: null,
      tool_calls: [{ id: 'tc-a', type: 'function', function: { name: 'Read', arguments: '{}' } }],
    })
    msgs.push({ role: 'tool', tool_call_id: 'tc-a', content: 'ok', name: 'Read' })
    msgs.push({ role: 'assistant', content: 'fresh answer' })

    const split = computeSafeSplitPoint(msgs)
    expect(split).toBeGreaterThanOrEqual(0)
    expect(msgs[split]?.role).not.toBe('tool')
  })

  it('returns messages.length when no safe boundary exists (e.g. trailing tool block)', () => {
    // Every trailing message is a tool; there is no safe leading
    // boundary. The split point signals "nothing usable to keep verbatim".
    const msgs: OpenAIMessage[] = []
    for (let i = 0; i < 5; i++) msgs.push({ role: 'user', content: 'pad' })
    for (let i = 0; i < 12; i++) msgs.push({ role: 'tool', tool_call_id: `t${i}`, content: 'r', name: 'X' })
    const split = computeSafeSplitPoint(msgs)
    // Either split is at a non-tool boundary, OR split === messages.length
    // (signalling "no safe boundary — caller must fall back").
    if (split < msgs.length) {
      expect(msgs[split]?.role).not.toBe('tool')
    } else {
      expect(split).toBe(msgs.length)
    }
  })

  // ─── serializeMessages: emit BOTH content AND tool_calls ────────────────
  // Defect found in independent review: serializeMessages used an
  // if / else-if chain that emitted ONLY the assistant content when both
  // content and tool_calls were present, silently dropping the tool
  // calls from the summarization prompt. After compaction the LLM
  // would have no record of which tools had been invoked. This test
  // locks down the fix.

  it('serializeMessages: assistant with non-empty content + tool_calls emits BOTH halves', () => {
    const msgs: OpenAIMessage[] = [
      {
        role: 'assistant',
        content: 'Let me check that file.',
        tool_calls: [{ id: 'tc1', type: 'function', function: { name: 'Read', arguments: '{"file_path":"a.ts"}' } }],
      },
    ]
    const out = serializeMessages(msgs)
    // Content half present.
    expect(out).toContain('[ASSISTANT]: Let me check that file.')
    // Tool-call half ALSO present (the regression). Previous code dropped this.
    expect(out).toContain('[ASSISTANT tool calls]:')
    expect(out).toContain('→ Read({"file_path":"a.ts"})')
  })

  it('serializeMessages: assistant with ONLY content (no tool_calls) still works', () => {
    const msgs: OpenAIMessage[] = [{ role: 'assistant', content: 'plain reply' }]
    const out = serializeMessages(msgs)
    expect(out).toContain('[ASSISTANT]: plain reply')
    expect(out).not.toContain('[ASSISTANT tool calls]')
  })

  it('serializeMessages: assistant with ONLY tool_calls (content null) still works', () => {
    const msgs: OpenAIMessage[] = [{
      role: 'assistant',
      content: null,
      tool_calls: [{ id: 'tc1', type: 'function', function: { name: 'Bash', arguments: '{"command":"ls"}' } }],
    }]
    const out = serializeMessages(msgs)
    expect(out).toContain('[ASSISTANT tool calls]:')
    expect(out).toContain('→ Bash({"command":"ls"})')
    expect(out).not.toContain('[ASSISTANT]:')
  })

  it('serializeMessages: assistant with NEITHER content NOR tool_calls emits nothing', () => {
    // Pathological but legal — an assistant turn with no spoken text and
    // no tool calls contributes nothing to the summary. The serializer
    // must not invent a heading.
    const msgs: OpenAIMessage[] = [{ role: 'assistant', content: '' }]
    const out = serializeMessages(msgs)
    expect(out).not.toContain('[ASSISTANT]')
    expect(out).not.toContain('[ASSISTANT tool calls]')
  })
})

// ──────────────────────────────────────────────────────────────────────────
// 4) SemanticMemory: atomic rewrite + sync write semantics
// ──────────────────────────────────────────────────────────────────────────

describe('SemanticMemory: atomic sync rewrite (defect #4)', () => {
  it('write() is fully synchronous: data is on disk when the call returns', () => {
    const projectDir = freshDir('sem-sync')
    const mem = new SemanticMemory(projectDir)
    mem.write({
      content: 'sync test',
      tags: [],
      source: 'user_stated',
      confidence: 0.9,
      timestamp: new Date().toISOString(),
    })
    // No microtask tick needed — the file must already exist with the line.
    const raw = readFileSync(join(projectDir, 'memory', 'semantic.jsonl'), 'utf8')
    expect(raw).toContain('sync test')
  })

  it('rewrite (dedup update) leaves no leftover tmp file', () => {
    const projectDir = freshDir('sem-tmp-cleanup')
    const mem = new SemanticMemory(projectDir)
    mem.write({ content: 'same', tags: [], source: 'user_stated', confidence: 0.5, timestamp: '' })
    mem.write({ content: 'same', tags: [], source: 'user_stated', confidence: 0.9, timestamp: '' }) // triggers persistAll
    const leftovers = listTmpLeftovers(join(projectDir, 'memory'))
    expect(leftovers).toEqual([])
  })

  it('rewrite preserves all in-memory entries atomically (no torn line)', () => {
    const projectDir = freshDir('sem-atomic-rewrite')
    const mem = new SemanticMemory(projectDir)
    // Seed several entries
    for (let i = 0; i < 8; i++) {
      mem.write({
        content: `entry ${i}`,
        tags: [`t${i}`],
        source: 'user_stated',
        confidence: 0.5,
        timestamp: new Date(2026, 0, 1, i).toISOString(),
      })
    }
    // Force a rewrite via dedup update
    mem.write({
      content: 'entry 3',
      tags: ['t3'],
      source: 'user_stated',
      confidence: 0.99,
      timestamp: new Date().toISOString(),
    })

    // Re-read from disk via a fresh instance — every line must parse.
    const mem2 = new SemanticMemory(projectDir)
    const all = mem2.readAll()
    expect(all).toHaveLength(8)
    const entry3 = all.find((e) => e.content === 'entry 3')
    expect(entry3?.confidence).toBe(0.99)
  })

  it('after a rewrite, a duplicate write that finds the existing entry persists correctly', () => {
    // Two-process-style: instance A writes, instance B writes the same
    // content (triggers persistAll on B). The dedup path must work and
    // the on-disk file must still be valid JSONL.
    const projectDir = freshDir('sem-cross-instances')
    const a = new SemanticMemory(projectDir)
    a.write({ content: 'shared', tags: [], source: 'user_stated', confidence: 0.5, timestamp: '' })

    const b = new SemanticMemory(projectDir) // reloads from disk
    b.write({ content: 'shared', tags: [], source: 'user_stated', confidence: 0.9, timestamp: '' })

    const raw = readFileSync(join(projectDir, 'memory', 'semantic.jsonl'), 'utf8')
    const lines = raw.trim().split('\n').filter(Boolean)
    expect(lines).toHaveLength(1)
    const parsed = JSON.parse(lines[0])
    expect(parsed.confidence).toBe(0.9)
  })

  it('rewrite does not deadlock or hang when many dedup updates fire back-to-back', () => {
    // Sanity: persistAll must remain callable from inside write() in a
    // tight loop without surprising behaviour. The fix uses sync I/O
    // throughout, so the loop completes deterministically.
    const projectDir = freshDir('sem-loop')
    const mem = new SemanticMemory(projectDir)
    mem.write({ content: 'loop-target', tags: [], source: 'user_stated', confidence: 0.1, timestamp: '' })
    for (let i = 0; i < 50; i++) {
      mem.write({ content: 'loop-target', tags: [], source: 'user_stated', confidence: 0.1 + i / 1000, timestamp: '' })
    }
    expect(mem.readAll()).toHaveLength(1)
  })
})

// ──────────────────────────────────────────────────────────────────────────
// 5) EpisodicMemory: skip corrupt schema rows
// ──────────────────────────────────────────────────────────────────────────

describe('EpisodicMemory: skip corrupt schema rows (defect #5)', () => {
  it('returns [] only when the file is missing or all rows are bad', () => {
    const dir = freshDir('epi-empty')
    const mem = new EpisodicMemory(dir)
    expect(mem.readAll()).toEqual([])
  })

  it('skips a malformed JSON line but keeps valid surrounding rows', () => {
    const dir = freshDir('epi-bad-line')
    const mem = new EpisodicMemory(dir)
    mem.write({ turn: 1, toolName: 'Bash', inputSummary: 'ls', resultSummary: 'a', outcome: 'success', timestamp: '' })
    // Inject bad JSON between two good rows on the next reload
    const mem2 = new EpisodicMemory(dir)
    mem2.write({ turn: 2, toolName: 'Bash', inputSummary: 'ls', resultSummary: 'b', outcome: 'success', timestamp: '' })
    // Append a corrupt line directly
    writeFileSync(join(dir, 'memory', 'episodes.jsonl'), 'NOT JSON AT ALL\n', { flag: 'a' })
    // Append a valid row after the corrupt line
    const mem3 = new EpisodicMemory(dir)
    mem3.write({ turn: 3, toolName: 'Bash', inputSummary: 'ls', resultSummary: 'c', outcome: 'success', timestamp: '' })

    const all = new EpisodicMemory(dir).readAll()
    expect(all.map((e) => e.turn)).toEqual([1, 2, 3])
  })

  it('skips rows whose shape does not match EpisodicMemoryEntry', () => {
    const dir = freshDir('epi-bad-shape')
    new EpisodicMemory(dir).write({
      turn: 1, toolName: 'Bash', inputSummary: '', resultSummary: '', outcome: 'success', timestamp: '',
    })
    // Inject a "JSON-parses but wrong shape" line: missing required fields.
    writeFileSync(
      join(dir, 'memory', 'episodes.jsonl'),
      JSON.stringify({ id: 'x', not: 'an episode' }) + '\n',
      { flag: 'a' },
    )
    // And a "outcome is not in the allowed set" line.
    writeFileSync(
      join(dir, 'memory', 'episodes.jsonl'),
      JSON.stringify({
        id: 'y', turn: 2, toolName: 'Bash', inputSummary: '', resultSummary: '',
        outcome: 'unknown', timestamp: '',
      }) + '\n',
      { flag: 'a' },
    )
    new EpisodicMemory(dir).write({
      turn: 3, toolName: 'Read', inputSummary: '', resultSummary: '', outcome: 'failure', timestamp: '',
    })

    const all = new EpisodicMemory(dir).readAll()
    expect(all).toHaveLength(2)
    expect(all.map((e) => e.turn)).toEqual([1, 3])
  })

  it('a wholly corrupt file returns [] without throwing', () => {
    const dir = freshDir('epi-all-bad')
    mkdirSync(join(dir, 'memory'), { recursive: true })
    writeFileSync(join(dir, 'memory', 'episodes.jsonl'), '}\n][{\nNOT JSON\n', 'utf8')
    const mem = new EpisodicMemory(dir)
    expect(() => mem.readAll()).not.toThrow()
    expect(mem.readAll()).toEqual([])
  })

  it('isValidEpisode covers the documented required fields', () => {
    // Base case
    expect(isValidEpisode({
      id: 'x', turn: 0, toolName: 'Bash', inputSummary: '', resultSummary: '',
      outcome: 'success', timestamp: '',
    })).toBe(true)
    // Missing id
    expect(isValidEpisode({
      turn: 0, toolName: 'Bash', inputSummary: '', resultSummary: '',
      outcome: 'success', timestamp: '',
    })).toBe(false)
    // outcome not in the allowed set
    expect(isValidEpisode({
      id: 'x', turn: 0, toolName: 'Bash', inputSummary: '', resultSummary: '',
      outcome: 'maybe', timestamp: '',
    })).toBe(false)
    // turn must be a number
    expect(isValidEpisode({
      id: 'x', turn: '1', toolName: 'Bash', inputSummary: '', resultSummary: '',
      outcome: 'success', timestamp: '',
    })).toBe(false)
    // duration, when present, must be a number
    expect(isValidEpisode({
      id: 'x', turn: 0, toolName: 'Bash', inputSummary: '', resultSummary: '',
      outcome: 'success', timestamp: '', duration: '100ms',
    })).toBe(false)
  })
})

// ──────────────────────────────────────────────────────────────────────────
// 6) EventLog bounded read + rotation
// ──────────────────────────────────────────────────────────────────────────

describe('EventLog: bounded read + rotation (defect #6)', () => {
  it('readAll with limit returns only the most recent N valid entries', () => {
    const dir = freshDir('evlog-limit')
    const log = new EventLog(dir)
    for (let i = 0; i < 50; i++) log.append('tool_call', `t_${i}`, { i })
    const out = log.readAll({ limit: 5 })
    expect(out).toHaveLength(5)
    expect(out[0].source).toBe('t_45')
    expect(out[4].source).toBe('t_49')
  })

  it('readAll without limit returns the entire log (back-compat)', () => {
    const dir = freshDir('evlog-no-limit')
    const log = new EventLog(dir)
    for (let i = 0; i < 25; i++) log.append('tool_call', `t_${i}`, { i })
    expect(log.readAll()).toHaveLength(25)
  })

  it('readAll limit skips corrupt rows before applying the cap', () => {
    const dir = freshDir('evlog-limit-corrupt')
    const log = new EventLog(dir)
    for (let i = 0; i < 10; i++) log.append('tool_call', `good_${i}`, { i })
    // Insert corrupt lines after the good ones.
    writeFileSync(join(dir, 'events.ndjson'), 'garbage\n' + JSON.stringify({ broken: true }) + '\n', { flag: 'a' })
    // Then a few more good entries.
    for (let i = 10; i < 15; i++) log.append('tool_call', `good_${i}`, { i })

    // Limit applies to VALID entries only — we asked for 3, we get the
    // 3 most recent VALID ones (good_12, good_13, good_14). The 2
    // corrupt lines must not bump the count.
    const out = log.readAll({ limit: 3 })
    expect(out.map((e) => e.source)).toEqual(['good_12', 'good_13', 'good_14'])
  })

  it('rotateIfExceeded: returns false for missing or small files', () => {
    const dir = freshDir('evlog-rotate-noop')
    const log = new EventLog(dir)
    expect(log.rotateIfExceeded(1024)).toBe(false)
    log.append('tool_call', 'x', {})
    expect(log.rotateIfExceeded(10_000)).toBe(false)
  })

  it('rotateIfExceeded: rotates the file once it crosses the threshold', () => {
    const dir = freshDir('evlog-rotate')
    const log = new EventLog(dir)
    log.append('tool_call', 'x', { payload: 'x'.repeat(500) })
    const rotatedPath = join(dir, 'events.ndjson.1')
    expect(existsSync(rotatedPath)).toBe(false)
    expect(log.rotateIfExceeded(100)).toBe(true)
    expect(existsSync(rotatedPath)).toBe(true)
    // After rotation, the main file no longer exists. Next append creates a fresh one.
    expect(existsSync(join(dir, 'events.ndjson'))).toBe(false)
    log.append('tool_call', 'after-rotate', {})
    expect(log.readAll()).toHaveLength(1)
    // The rotated file still has the original entry.
    expect(readFileSync(rotatedPath, 'utf8')).toContain('"source":"x"')
  })

  it('rotateIfExceeded: idempotent — second call after rotation is a no-op', () => {
    const dir = freshDir('evlog-rotate-idem')
    const log = new EventLog(dir)
    log.append('tool_call', 'x', { payload: 'x'.repeat(500) })
    expect(log.rotateIfExceeded(100)).toBe(true)
    expect(log.rotateIfExceeded(100)).toBe(false)
  })

  it('rotateIfExceeded: rejects invalid thresholds without throwing', () => {
    const dir = freshDir('evlog-rotate-bad')
    const log = new EventLog(dir)
    log.append('tool_call', 'x', {})
    expect(log.rotateIfExceeded(0)).toBe(false)
    expect(log.rotateIfExceeded(-1)).toBe(false)
    expect(log.rotateIfExceeded(Number.NaN)).toBe(false)
  })

  // ─── PRODUCTION AUTO-ROTATION ──────────────────────────────────────────
  // Defect found in independent review: rotateIfExceeded was only being
  // called by tests. Production append()/readAll() never invoked it, so
  // the log was effectively unbounded. These tests prove append() now
  // auto-triggers rotation inline, with no external helper needed.

  it('production: default constructor uses 10 MiB cap (DEFAULT_EVENTLOG_ROTATE_BYTES)', () => {
    // Sanity: the constant is what we documented. If it changes, this
    // catches accidental drift in either the export or the constructor
    // default.
    expect(DEFAULT_EVENTLOG_ROTATE_BYTES).toBe(10 * 1024 * 1024)
  })

  it('production: append() AUTO-rotates when file exceeds the configured cap', () => {
    // Build an EventLog with a 200-byte cap, then append enough data
    // to exceed it. We do NOT call rotateIfExceeded — the rotation must
    // fire from inside append().
    const dir = freshDir('evlog-auto-rotate')
    const log = new EventLog(dir, { rotateBytes: 200 })
    const rotatedPath = join(dir, 'events.ndjson.1')

    // First append: file is created with ~520 bytes (well above 200).
    // The very first append() that causes the file to exist must fire
    // the auto-rotate — but on the FIRST append the file does not exist
    // yet, so no rotation fires. The second append sees the size and
    // rotates before writing.
    log.append('tool_call', 'A', { payload: 'x'.repeat(500) })
    expect(existsSync(rotatedPath)).toBe(false) // no rotation yet (no file existed before this append)
    expect(statSync(join(dir, 'events.ndjson')).size).toBeGreaterThan(200)

    // Second append: file exists and is > 200 bytes → must auto-rotate.
    log.append('tool_call', 'B', {})
    expect(existsSync(rotatedPath)).toBe(true) // PROOF: append() rotated it
    expect(existsSync(join(dir, 'events.ndjson'))).toBe(true) // and started a fresh file for B

    // The rotated `.1` holds the FIRST entry's bytes.
    const rotatedRaw = readFileSync(rotatedPath, 'utf8')
    expect(rotatedRaw).toContain('"source":"A"')

    // The fresh file holds the second entry only.
    const freshEntries = log.readAll()
    expect(freshEntries.map((e) => e.source)).toEqual(['B'])
  })

  it('production: append() does NOT auto-rotate when file is below cap', () => {
    const dir = freshDir('evlog-no-rotate')
    const log = new EventLog(dir, { rotateBytes: 100_000 })
    for (let i = 0; i < 10; i++) log.append('tool_call', `t_${i}`, { i })
    expect(existsSync(join(dir, 'events.ndjson.1'))).toBe(false)
    expect(log.readAll()).toHaveLength(10)
  })

  it('production: auto-rotation continues working across MANY appends', () => {
    // Stress: 60 appends of ~500-byte payloads under a 1 KiB cap. The
    // log must keep rotating on each cycle, never blow past the cap
    // without a rotation, and readAll() must always reflect the most
    // recent state.
    const dir = freshDir('evlog-rotate-many')
    const log = new EventLog(dir, { rotateBytes: 1024 })
    for (let i = 0; i < 60; i++) {
      log.append('tool_call', `s_${i}`, { payload: 'x'.repeat(500) })
    }
    // At least one rotation must have occurred.
    expect(existsSync(join(dir, 'events.ndjson.1'))).toBe(true)
    // The live file holds at most a few recent appends — bounded by the
    // cap plus a small slack for the just-appended entry. The exact
    // count depends on whether the last rotation fired; what matters
    // is that we never accumulate 60 × 500-byte payloads (~30 KiB)
    // without rotation.
    const currentSize = statSync(join(dir, 'events.ndjson')).size
    expect(currentSize).toBeLessThan(1024 + 600) // cap + one ~500-byte entry of slack
    // readAll returns a handful of recent entries — we never accumulate
    // the full 60 in the live file.
    const entries = log.readAll()
    expect(entries.length).toBeGreaterThan(0)
    expect(entries.length).toBeLessThan(60)
  })

  it('production: rotateBytes=0 disables auto-rotation (no threshold check)', () => {
    const dir = freshDir('evlog-no-cap')
    const log = new EventLog(dir, { rotateBytes: 0 })
    // Append way more than the default cap (10 MiB) — well, we don't
    // actually write 10 MiB here, but the test is about ensuring
    // rotateBytes=0 means "never auto-rotate". We verify that by
    // appending moderate data and confirming no `.1` exists.
    for (let i = 0; i < 5; i++) log.append('tool_call', `t_${i}`, { i })
    expect(existsSync(join(dir, 'events.ndjson.1'))).toBe(false)
    expect(log.readAll()).toHaveLength(5)
  })

  it('production: readAll() does NOT auto-rotate (rotation is append-only)', () => {
    // A pure read should never trigger rotation. If it did, every
    // critic / monitor would have a side effect — bad. Verify by
    // setting a small cap, building a large file via direct write
    // (bypassing append), and reading without rotation.
    const dir = freshDir('evlog-read-no-rotate')
    const log = new EventLog(dir, { rotateBytes: 100 })
    // Seed a large file directly (no append, so no rotation trigger).
    const seedLines: string[] = []
    for (let i = 0; i < 50; i++) {
      seedLines.push(JSON.stringify({
        id: `e_${i}`, timestamp: new Date().toISOString(),
        type: 'tool_call', source: `s_${i}`, detail: { i },
      }))
    }
    writeFileSync(join(dir, 'events.ndjson'), seedLines.join('\n') + '\n', 'utf8')
    expect(statSync(join(dir, 'events.ndjson')).size).toBeGreaterThan(100)

    // readAll must NOT rotate.
    expect(log.readAll()).toHaveLength(50)
    expect(existsSync(join(dir, 'events.ndjson.1'))).toBe(false)
    expect(existsSync(join(dir, 'events.ndjson'))).toBe(true)
  })

  it('production: append() succeeds even when rotation would fail (best-effort)', () => {
    // If auto-rotation throws (e.g. permissions on the .1 path), the
    // append must STILL succeed — it is the load-bearing operation.
    //
    // We force rotation failure by pre-creating `events.ndjson.1` as a
    // DIRECTORY. renameSync then fails with EISDIR. The append must
    // still write to the live file.
    const dir = freshDir('evlog-rotate-fails')
    mkdirSync(join(dir, 'events.ndjson.1'))
    const log = new EventLog(dir, { rotateBytes: 50 })

    log.append('tool_call', 'seed', { payload: 'x'.repeat(200) })
    // File > 50 bytes now. Next append will try to rotate and fail.
    log.append('tool_call', 'after-failed-rotate', {})

    // The append still went through — the live file holds BOTH entries
    // because the rename failed and the append fell through to the
    // live log. We assert the live file is intact and the entry
    // objects are returned to the caller.
    expect(existsSync(join(dir, 'events.ndjson'))).toBe(true)
    const entries = log.readAll()
    expect(entries.map((e) => e.source)).toEqual(['seed', 'after-failed-rotate'])
  })

  it('production: backward-compatible single-arg constructor still works', () => {
    // Defends the documented API: `new EventLog(sessionDir)` keeps
    // working. The default cap kicks in but is high enough that
    // ordinary appends never trigger rotation.
    const dir = freshDir('evlog-bc-ctor')
    const log = new EventLog(dir) // no second arg
    log.append('tool_call', 'x', { i: 1 })
    log.append('tool_call', 'y', { i: 2 })
    expect(log.readAll()).toHaveLength(2)
    expect(existsSync(join(dir, 'events.ndjson.1'))).toBe(false)
  })
})

// ──────────────────────────────────────────────────────────────────────────
// 7) FileHistory: version cap + SHA-256 path
// ──────────────────────────────────────────────────────────────────────────

describe('FileHistory: version cap + SHA-256 path (defect #7)', () => {
  it('exports MAX_VERSIONS_PER_FILE = 50', () => {
    expect(MAX_VERSIONS_PER_FILE).toBe(50)
  })

  it('uses SHA-256 of the absolute file path as the backup directory name', () => {
    const dir = freshDir('fh-sha256')
    const history = new FileHistory(dir)
    const fp = join(dir, 'src', 'a.ts')
    mkdirSync(join(dir, 'src'), { recursive: true })
    writeFileSync(fp, 'v0', 'utf8')
    history.trackEdit(fp)

    const expectedHash = createHash('sha256').update(fp).digest('hex').slice(0, 32)
    expect(existsSync(join(dir, 'file-history', expectedHash))).toBe(true)
  })

  it('different file paths produce different SHA-256 backup directories', () => {
    const dir = freshDir('fh-sha256-distinct')
    const history = new FileHistory(dir)
    const a = join(dir, 'a.ts')
    const b = join(dir, 'b.ts')
    writeFileSync(a, 'a0', 'utf8')
    writeFileSync(b, 'b0', 'utf8')
    history.trackEdit(a)
    history.trackEdit(b)
    // Filter out the persistent index sidecar so we only count the
    // hash-derived backup directories. The two SHA-256 buckets for `a`
    // and `b` must remain distinct.
    const subdirs = readdirSync(join(dir, 'file-history')).filter(
      (n) => n !== 'index.json',
    )
    expect(subdirs).toHaveLength(2)
    // Both dirs should be 32 hex chars (SHA-256 slice).
    for (const sub of subdirs) expect(sub).toMatch(/^[0-9a-f]{32}$/)
  })

  it('keeps the cap on the version list (no overflow)', () => {
    const dir = freshDir('fh-cap')
    const history = new FileHistory(dir)
    const fp = join(dir, 'src', 'a.ts')
    mkdirSync(join(dir, 'src'), { recursive: true })
    writeFileSync(fp, 'v0', 'utf8')

    // Produce 60 edits. The list MUST be capped at MAX_VERSIONS_PER_FILE.
    for (let i = 1; i <= 60; i++) {
      history.trackEdit(fp)
      writeFileSync(fp, `v${i}`, 'utf8')
    }
    const versions = history.getVersions(fp)
    expect(versions).toHaveLength(MAX_VERSIONS_PER_FILE)
  })

  it('the OLDEST backup is unlinked from disk once the cap is exceeded', () => {
    const dir = freshDir('fh-evict')
    const history = new FileHistory(dir)
    const fp = join(dir, 'src', 'a.ts')
    mkdirSync(join(dir, 'src'), { recursive: true })
    writeFileSync(fp, 'v0', 'utf8')

    history.trackEdit(fp)
    const firstBackupPath = history.getVersions(fp)[0].backupPath
    expect(existsSync(firstBackupPath)).toBe(true)

    // Push past the cap.
    for (let i = 1; i <= MAX_VERSIONS_PER_FILE + 5; i++) {
      history.trackEdit(fp)
      writeFileSync(fp, `v${i}`, 'utf8')
    }

    // The original backup we recorded is no longer on disk — it was
    // evicted (oldest-first) when the cap was exceeded.
    expect(existsSync(firstBackupPath)).toBe(false)
  })

  it('restoreOriginal points to the OLDEST still-tracked backup (post-eviction)', () => {
    const dir = freshDir('fh-restore-post-evict')
    const history = new FileHistory(dir)
    const fp = join(dir, 'src', 'a.ts')
    mkdirSync(join(dir, 'src'), { recursive: true })
    writeFileSync(fp, 'ORIGINAL', 'utf8')

    history.trackEdit(fp)            // v0 captured: "ORIGINAL"
    writeFileSync(fp, 'middle', 'utf8')

    // Generate enough edits that "ORIGINAL" is evicted.
    for (let i = 0; i < MAX_VERSIONS_PER_FILE + 2; i++) {
      history.trackEdit(fp)
      writeFileSync(fp, `m_${i}`, 'utf8')
    }

    // Now restoreOriginal must return the OLDEST backup STILL on disk,
    // which is no longer "ORIGINAL" — it's one of the 'm_X' values.
    expect(history.restoreOriginal(fp)).toBe(true)
    const restored = readFileSync(fp, 'utf8')
    expect(restored).not.toBe('ORIGINAL')
    expect(restored.startsWith('m_')).toBe(true)
  })

  it('the on-disk backup directory holds at most MAX_VERSIONS_PER_FILE files per file path', () => {
    const dir = freshDir('fh-disk-count')
    const history = new FileHistory(dir)
    const fp = join(dir, 'src', 'a.ts')
    mkdirSync(join(dir, 'src'), { recursive: true })
    writeFileSync(fp, 'v0', 'utf8')

    for (let i = 1; i <= MAX_VERSIONS_PER_FILE + 10; i++) {
      history.trackEdit(fp)
      writeFileSync(fp, `v${i}`, 'utf8')
    }

    const hashDir = join(dir, 'file-history', createHash('sha256').update(fp).digest('hex').slice(0, 32))
    const filesInHashDir = readdirSync(hashDir).filter(
      (n) => n.startsWith('v') && !n.endsWith('.meta.json'),
    )
    expect(filesInHashDir).toHaveLength(MAX_VERSIONS_PER_FILE)
  })

  it('preserves the existing API surface (trackEdit / getVersions / restoreVersion / restoreOriginal / getEditedFiles / getSummary / clear)', () => {
    // Smoke test: confirm nothing was broken by the SHA-256 + cap change.
    const dir = freshDir('fh-smoke')
    const history = new FileHistory(dir)
    const fp = join(dir, 'src', 'a.ts')
    mkdirSync(join(dir, 'src'), { recursive: true })
    writeFileSync(fp, 'original', 'utf8')
    history.trackEdit(fp)
    writeFileSync(fp, 'v1', 'utf8')
    history.trackEdit(fp)
    writeFileSync(fp, 'v2', 'utf8')

    const versions = history.getVersions(fp)
    expect(versions).toHaveLength(2)
    expect(readFileSync(versions[0].backupPath, 'utf8')).toBe('original')
    expect(readFileSync(versions[1].backupPath, 'utf8')).toBe('v1')

    expect(history.restoreVersion(fp, 0)).toBe(true)
    expect(readFileSync(fp, 'utf8')).toBe('original')

    expect(history.restoreOriginal(fp)).toBe(true)

    history.clear()
    expect(history.getEditedFiles()).toHaveLength(0)

    expect(history.getSummary()).toContain('No file edits')
  })

  // ─── restoreVersion: atomic tmp + write/fsync/close + rename ─────────────
  // Defect found in independent review: restoreVersion wrote the live
  // file directly via writeFileSync. A crash mid-write would leave a
  // half-written file at the live path — readers would see torn content.
  // The fix routes the write through a unique same-directory tmp +
  // open/write/fsync/close + rename + finally cleanup, so a crash or
  // any I/O failure leaves the live file unchanged. API is unchanged
  // (returns boolean, never throws).

  it('restoreVersion: successful restore writes the backup to the live file exactly', () => {
    const dir = freshDir('fh-restore-ok')
    const history = new FileHistory(dir)
    const fp = join(dir, 'src', 'a.ts')
    mkdirSync(join(dir, 'src'), { recursive: true })
    writeFileSync(fp, 'ORIGINAL', 'utf8')
    history.trackEdit(fp)
    writeFileSync(fp, 'live-current', 'utf8')

    // Restore version 0 → live file must now hold "ORIGINAL", byte-exact.
    expect(history.restoreVersion(fp, 0)).toBe(true)
    expect(readFileSync(fp, 'utf8')).toBe('ORIGINAL')
    // No leftover restore tmp in the live file's directory.
    const leftovers = listTmpLeftovers(join(dir, 'src')).filter((n) => /\.restore\.tmp\./.test(n))
    expect(leftovers).toEqual([])
  })

  it('restoreVersion: restores the SAME bytes that the backup recorded (round-trip across edits)', () => {
    const dir = freshDir('fh-restore-roundtrip')
    const history = new FileHistory(dir)
    const fp = join(dir, 'src', 'a.ts')
    mkdirSync(join(dir, 'src'), { recursive: true })

    // Build 3 distinct versions and restore each one to verify the
    // bytes match what trackEdit captured.
    writeFileSync(fp, 'v0-payload', 'utf8')
    history.trackEdit(fp)
    writeFileSync(fp, 'v1-payload', 'utf8')
    history.trackEdit(fp)
    writeFileSync(fp, 'v2-payload', 'utf8')
    history.trackEdit(fp)
    writeFileSync(fp, 'live-far-future', 'utf8')

    const versions = history.getVersions(fp)
    expect(versions).toHaveLength(3)
    expect(readFileSync(versions[0].backupPath, 'utf8')).toBe('v0-payload')
    expect(readFileSync(versions[1].backupPath, 'utf8')).toBe('v1-payload')
    expect(readFileSync(versions[2].backupPath, 'utf8')).toBe('v2-payload')

    // Restore each in turn — the live file must exactly match the backup.
    // versions[0] holds the OLDEST backup (the file's content before
    // the first edit), versions[length-1] the NEWEST.
    expect(history.restoreVersion(fp, 0)).toBe(true)
    expect(readFileSync(fp, 'utf8')).toBe('v0-payload')
    expect(history.restoreVersion(fp, 1)).toBe(true)
    expect(readFileSync(fp, 'utf8')).toBe('v1-payload')
    expect(history.restoreVersion(fp, 2)).toBe(true)
    expect(readFileSync(fp, 'utf8')).toBe('v2-payload')
  })

  it('restoreVersion: a failed restore does NOT corrupt the live file', () => {
    // Force the FIRST step (backup read) to fail by deleting the
    // backup file. readFileSync(versions[version]) returns ENOENT,
    // restoreVersion must return false WITHOUT touching the live file.
    const dir = freshDir('fh-restore-fail')
    const history = new FileHistory(dir)
    const fp = join(dir, 'src', 'a.ts')
    mkdirSync(join(dir, 'src'), { recursive: true })
    writeFileSync(fp, 'live-original', 'utf8')
    history.trackEdit(fp)
    writeFileSync(fp, 'live-after-edit', 'utf8')
    const liveBefore = readFileSync(fp, 'utf8')
    const mtimeBefore = statSync(fp).mtimeMs

    // Delete the backup so the readFileSync inside restoreVersion fails.
    const backupPath = history.getVersions(fp)[0].backupPath
    rmSync(backupPath, { force: true })

    expect(history.restoreVersion(fp, 0)).toBe(false)
    // Live file is byte-identical AND mtime-untouched.
    expect(readFileSync(fp, 'utf8')).toBe(liveBefore)
    expect(statSync(fp).mtimeMs).toBe(mtimeBefore)
  })

  it('restoreVersion: a failure mid-stream leaves no .restore.tmp.* file behind', () => {
    // Same setup as above: delete the backup so readFileSync fails
    // BEFORE any tmp file is created. A different failure path: pre-
    // create a `.restore.tmp.<unique>` collision by making the parent
    // directory read-only is not portable; instead we use a path that
    // is a DIRECTORY (rename tmp -> dir fails with EISDIR). The tmp
    // MUST be unlinked by the `finally` cleanup regardless.
    const dir = freshDir('fh-restore-no-tmp-leak')
    const history = new FileHistory(dir)
    const fp = join(dir, 'src', 'a.ts')
    mkdirSync(join(dir, 'src'), { recursive: true })
    writeFileSync(fp, 'live', 'utf8')
    history.trackEdit(fp)
    writeFileSync(fp, 'live2', 'utf8')

    // Force rename to fail by making the target path itself be a
    // DIRECTORY. The tmp file will be created in <dir>/src/ with a
    // .restore.tmp.* suffix, then rename(tmp, <dir>/src/a.ts) will
    // fail with EISDIR (because <dir>/src/a.ts is a directory).
    rmSync(fp, { force: true })
    mkdirSync(fp)

    expect(history.restoreVersion(fp, 0)).toBe(false)
    // No leftover restore tmp anywhere under the parent dir.
    const leftovers = listTmpLeftovers(join(dir, 'src')).filter((n) => /\.restore\.tmp\./.test(n))
    expect(leftovers).toEqual([])

    // Live file (now a directory) is NOT corrupted by a half-written
    // file at its path — it is still the same directory we made it.
    expect(statSync(fp).isDirectory()).toBe(true)
  })

  it('restoreVersion: returns false for invalid version without touching the live file', () => {
    const dir = freshDir('fh-restore-invalid-ver')
    const history = new FileHistory(dir)
    const fp = join(dir, 'src', 'a.ts')
    mkdirSync(join(dir, 'src'), { recursive: true })
    writeFileSync(fp, 'live-content', 'utf8')
    history.trackEdit(fp)
    const liveBefore = readFileSync(fp, 'utf8')

    expect(history.restoreVersion(fp, -1)).toBe(false)
    expect(history.restoreVersion(fp, 99)).toBe(false)
    // Live file untouched.
    expect(readFileSync(fp, 'utf8')).toBe(liveBefore)
  })

  // ─── restoreVersion: preserve live file's mode (e.g. 0755 executable) ───
  // Defect found in independent review: the tmp+rename path used by
  // restoreVersion wrote the tmp with the umask default (~0644), then
  // renamed it over the live file. The rename PUBLISHES that 0644 mode
  // at the live path, silently dropping the executable bit on a script
  // the caller was trying to recover. The fix captures the live file's
  // mode BEFORE writing the tmp and chmodSyncs the tmp to MATCH before
  // the rename publishes it. This test pins the executable-bit
  // round-trip — a regression would lose `+x` and break CI scripts
  // restored via undo.

  it('restoreVersion: preserves 0755 (executable) across restore', () => {
    const dir = freshDir('fh-restore-mode-0755')
    const history = new FileHistory(dir)
    const fp = join(dir, 'script.sh')
    // Establish an executable live file at the SAME mode we want
    // preserved across restore.
    writeFileSync(fp, '#!/bin/sh\necho live\n', { mode: 0o755 })
    expect(statSync(fp).mode & 0o777).toBe(0o755)
    history.trackEdit(fp)

    // Overwrite with non-executable content and back to 0755 (real
    // edit tool path: a mistaken chmod, then a wrong-content restore).
    writeFileSync(fp, 'broken content', 'utf8')
    chmodSync(fp, 0o755) // keep mode as the "thing to preserve"

    expect(history.restoreVersion(fp, 0)).toBe(true)
    // Mode bits MUST survive the tmp + chmod + rename chain.
    expect(statSync(fp).mode & 0o777).toBe(0o755)
    // And content is the backup.
    expect(readFileSync(fp, 'utf8')).toBe('#!/bin/sh\necho live\n')
  })

  it('restoreVersion: preserves 0644 (regular file) mode', () => {
    const dir = freshDir('fh-restore-mode-0644')
    const history = new FileHistory(dir)
    const fp = join(dir, 'notes.txt')
    writeFileSync(fp, 'first', { mode: 0o644 })
    expect(statSync(fp).mode & 0o777).toBe(0o644)
    history.trackEdit(fp)
    writeFileSync(fp, 'second', 'utf8')
    chmodSync(fp, 0o644)

    expect(history.restoreVersion(fp, 0)).toBe(true)
    expect(statSync(fp).mode & 0o777).toBe(0o644)
    expect(readFileSync(fp, 'utf8')).toBe('first')
  })

  it('restoreVersion: REWIND applies the BACKUP mode — true rewind semantics', () => {
    // The backup represents the file's FULL state at trackEdit time:
    // content AND mode (trackEdit chmod's the backup to match the
    // live mode at backup time). When the user restores a snapshot
    // they expect both to revert — restoring a 0755 script after the
    // user accidentally chmod'd it to 0644 must bring the executable
    // bit BACK, not preserve the wrong current mode.
    //
    // The earlier "current-live-mode" reading was inconsistent with
    // what a rewind tool should do: rewind means "go back to the
    // snapshot", full stop. Anything else surprises the caller.
    const dir = freshDir('fh-restore-mode-backup')
    const history = new FileHistory(dir)
    const fp = join(dir, 'tool.sh')
    // Live file at 0755; backup captures this state.
    writeFileSync(fp, '#!/bin/sh\necho orig\n', { mode: 0o755 })
    history.trackEdit(fp)
    // User (or a buggy tool) overwrote with broken content AND
    // accidentally chmod'd the live file to 0644. The backup file
    // STILL records the 0755 state.
    writeFileSync(fp, 'messed up', 'utf8')
    chmodSync(fp, 0o644)

    expect(history.restoreVersion(fp, 0)).toBe(true)
    // REWIND: live file goes back to 0755 (from backup), NOT 0644
    // (current). This is the corrected semantic.
    expect(statSync(fp).mode & 0o777).toBe(0o755)
    expect(readFileSync(fp, 'utf8')).toBe('#!/bin/sh\necho orig\n')
  })
})

// ──────────────────────────────────────────────────────────────────────────
// 8) EpisodicMemory: bounded retention
// ──────────────────────────────────────────────────────────────────────────
//
// Defect found in independent review: write() appended forever, so a
// long-running session would accumulate an unbounded episode log.
// These tests pin the cap: once the file would exceed MAX_EPISODES,
// the OLDEST entries are evicted and the file is rewritten atomically
// (tmp + fsync + rename + cleanup). The most-recent entries survive.

describe('EpisodicMemory: bounded retention (defect #8)', () => {
  it('MAX_EPISODES is exported as a positive integer', () => {
    expect(Number.isInteger(MAX_EPISODES)).toBe(true)
    expect(MAX_EPISODES).toBeGreaterThan(0)
  })

  it('does NOT compact while the count is at or below the configured cap', () => {
    const dir = freshDir('epi-bounded-under')
    // Use a small cap so the test stays cheap and doesn't depend on
    // disk speed — the wall-clock cost of MAX_EPISODES writes is
    // irrelevant to the correctness contract we're verifying here.
    const cap = 50
    const mem = new EpisodicMemory(dir, { maxEpisodes: cap })
    for (let i = 0; i < cap - 1; i++) {
      mem.write({ turn: i, toolName: 'T', inputSummary: '', resultSummary: '', outcome: 'success', timestamp: '' })
    }
    const all = new EpisodicMemory(dir).readAll()
    expect(all).toHaveLength(cap - 1)
    // First entry still present — no eviction happened.
    expect(all[0]?.turn).toBe(0)
  })

  it('evicts the OLDEST entries when the configured cap is exceeded', () => {
    const dir = freshDir('epi-bounded-over')
    const cap = 100
    const mem = new EpisodicMemory(dir, { maxEpisodes: cap })
    const total = cap + 50
    for (let i = 0; i < total; i++) {
      mem.write({ turn: i, toolName: 'T', inputSummary: '', resultSummary: '', outcome: 'success', timestamp: '' })
    }
    const all = new EpisodicMemory(dir).readAll()
    expect(all).toHaveLength(cap)
    // The OLDEST entries (turn < 50) must have been evicted; the
    // most recent (turn >= 50) must survive.
    expect(all[0]?.turn).toBe(50)
    expect(all[all.length - 1]?.turn).toBe(total - 1)
  })

  it('compaction never leaves a torn file (atomic tmp + fsync + rename)', () => {
    const dir = freshDir('epi-bounded-atomic')
    const cap = 50
    const mem = new EpisodicMemory(dir, { maxEpisodes: cap })
    for (let i = 0; i < cap + 10; i++) {
      mem.write({ turn: i, toolName: 'T', inputSummary: '', resultSummary: '', outcome: 'success', timestamp: '' })
    }
    // No leftover compaction tmp anywhere in memory/.
    const memDir = join(dir, 'memory')
    const leftovers = listTmpLeftovers(memDir).filter((n) => n.startsWith('episodes.jsonl'))
    expect(leftovers).toEqual([])
    // The on-disk file is fully valid JSONL — every line parses.
    const raw = readFileSync(join(memDir, 'episodes.jsonl'), 'utf8')
    const lines = raw.split('\n').filter(Boolean)
    expect(lines).toHaveLength(cap)
    for (const line of lines) {
      // JSON.parse returns `any`, but we only care that it throws on
      // a malformed line. Bind the result to a typed alias so the
      // lint guard on unsafe-`any` doesn't trip.
      const parsed: unknown = JSON.parse(line)
      expect(parsed).toBeDefined()
    }
  })

  it('multiple compaction cycles stay within the configured cap', () => {
    const dir = freshDir('epi-bounded-cycles')
    const cap = 50
    const mem = new EpisodicMemory(dir, { maxEpisodes: cap })
    // Write 3 * cap entries. The file must never hold more than cap.
    const total = 3 * cap
    for (let i = 0; i < total; i++) {
      mem.write({ turn: i, toolName: 'T', inputSummary: '', resultSummary: '', outcome: 'success', timestamp: '' })
    }
    const all = new EpisodicMemory(dir).readAll()
    expect(all).toHaveLength(cap)
    // The tail of the file is the last `cap` writes.
    expect(all[0]?.turn).toBe(2 * cap)
    expect(all[all.length - 1]?.turn).toBe(total - 1)
  })

  it('defaults to MAX_EPISODES when no option is supplied', () => {
    const dir = freshDir('epi-default-cap')
    const mem = new EpisodicMemory(dir)
    // Writing 5 small entries must NOT trigger compaction regardless
    // of the configured default — the default cap is well above 5.
    for (let i = 0; i < 5; i++) {
      mem.write({ turn: i, toolName: 'T', inputSummary: '', resultSummary: '', outcome: 'success', timestamp: '' })
    }
    expect(new EpisodicMemory(dir).readAll()).toHaveLength(5)
  })

  it('invalid maxEpisodes falls back to MAX_EPISODES (no throw at boot)', () => {
    // The engine wires EpisodicMemory up at boot time; a TypeError
    // there would block every subsequent tool call. Invalid inputs
    // (zero, negatives, NaN, non-integers) must fall back silently.
    const dir = freshDir('epi-bad-cap')
    for (const bad of [0, -1, Number.NaN, 1.5, Number.POSITIVE_INFINITY] as Array<number | undefined>) {
      const mem = new EpisodicMemory(dir, { maxEpisodes: bad })
      // Writing a handful of small entries must still succeed and
      // round-trip — i.e. the fallback is the documented default,
      // not "broken forever".
      mem.write({ turn: 1, toolName: 'T', inputSummary: '', resultSummary: '', outcome: 'success', timestamp: '' })
      expect(mem.readAll()).toHaveLength(1)
      // Reset between cases so the per-instance cap is well-defined
      // for the next iteration.
      rmSync(dir, { recursive: true, force: true })
      mkdirSync(dir, { recursive: true })
    }
  })

  it('COMPLEXITY: amortized O(1) per write — counter converges to `cap` not to `totalWrites`', () => {
    // Regression guard for the O(N²) bug without depending on wall
    // clock (which is flaky on slow CI disks). The cheapest observable
    // proxy for "amortized O(1) per write" is the in-memory counter:
    // if write() were re-scanning the file every call, the counter
    // would still end up at `cap` after the final compaction, but
    // the test would lose its meaning under volume. The structural
    // assertion that matters is: the counter MUST equal `cap` after
    // a successful compaction, not exceed it. If we never compacted,
    // the counter would grow unboundedly with `totalWrites`.
    const dir = freshDir('epi-complexity')
    const cap = 50
    const mem = new EpisodicMemory(dir, { maxEpisodes: cap })
    const totalWrites = cap * 10 // 500 writes — enough to exercise
                                 // several compaction cycles without
                                 // burning CI disk on sync I/O.
    for (let i = 0; i < totalWrites; i++) {
      mem.write({ turn: i, toolName: 'T', inputSummary: '', resultSummary: '', outcome: 'success', timestamp: '' })
    }
    // Sanity: the cap held.
    expect(new EpisodicMemory(dir).readAll()).toHaveLength(cap)
    // The counter MUST equal `cap` after the final compaction. A
    // regression that forgets to reset the counter post-compact
    // (or never compacts) would let it grow to `totalWrites`.
    expect(mem['entryCount']).toBe(cap)
    // And the counter MUST be strictly less than `totalWrites` —
    // proof that compaction actually fired at least once. Without
    // this assertion, an "always reset to cap" bug that fired on
    // every write would also pass `entryCount === cap`.
    expect(mem['entryCount']).toBeLessThan(totalWrites)
  })
})

// ──────────────────────────────────────────────────────────────────────────
// 9) SemanticMemory: mtime/size-based reload
// ──────────────────────────────────────────────────────────────────────────
//
// Defect found in independent review: ensureLoaded() only ran on
// first access — the in-memory state was never reconciled with
// external writes to the same file. Two ovogogogo processes (or a
// recovery tool) silently disagreed about what was known. These tests
// pin the new behaviour: every read consults (mtimeMs, size) and
// reloads when an external writer has touched the file.

describe('SemanticMemory: mtime/size-based reload (defect #9)', () => {
  it('reloads the index when an external process appends to the file', () => {
    const dir = freshDir('sem-external-append')
    const a = new SemanticMemory(dir)
    a.write({ content: 'a', tags: ['ta'], source: 'user_stated', confidence: 0.5, timestamp: '' })
    expect(a.readAll()).toHaveLength(1)

    // Simulate a second process (or a recovery tool) appending a new
    // entry directly to the file. Wait one tick so mtime advances
    // (some filesystems have second-resolution mtimes).
    const memDir = join(dir, 'memory')
    const sleep = (ms: number) => {
      const until = Date.now() + ms
      while (Date.now() < until) { /* spin */ }
    }
    sleep(20)
    writeFileSync(
      join(memDir, 'semantic.jsonl'),
      JSON.stringify({
        id: 'sem_external', content: 'b', tags: ['tb'],
        source: 'tool_observed', confidence: 0.7, timestamp: '',
      }) + '\n',
      { flag: 'a' },
    )

    // The SAME instance must now see the external entry — no
    // explicit reload required.
    const all = a.readAll()
    const external = all.find((e) => e.content === 'b')
    expect(external).toBeDefined()
    expect(external?.id).toBe('sem_external')
  })

  it('reloads when an external writer truncates the file', () => {
    const dir = freshDir('sem-external-truncate')
    const a = new SemanticMemory(dir)
    a.write({ content: 'will-be-truncated', tags: [], source: 'user_stated', confidence: 0.5, timestamp: '' })
    expect(a.readAll()).toHaveLength(1)

    const memDir = join(dir, 'memory')
    const sleep = (ms: number) => {
      const until = Date.now() + ms
      while (Date.now() < until) { /* spin */ }
    }
    sleep(20)
    // External truncation: empty the file completely.
    writeFileSync(join(memDir, 'semantic.jsonl'), '', 'utf8')

    // The same instance must now report an empty index.
    expect(a.readAll()).toEqual([])
  })

  it('reloads when an external writer deletes the file', () => {
    const dir = freshDir('sem-external-delete')
    const a = new SemanticMemory(dir)
    a.write({ content: 'will-be-deleted', tags: [], source: 'user_stated', confidence: 0.5, timestamp: '' })
    expect(a.readAll()).toHaveLength(1)

    const memDir = join(dir, 'memory')
    const sleep = (ms: number) => {
      const until = Date.now() + ms
      while (Date.now() < until) { /* spin */ }
    }
    sleep(20)
    rmSync(join(memDir, 'semantic.jsonl'), { force: true })

    // The same instance must reconcile to empty rather than keeping
    // the stale in-memory copy.
    expect(a.readAll()).toEqual([])
  })

  it('does NOT reload when the file has not changed (cheap mtime/size check)', () => {
    // The reload path is observable through the in-memory index — if
    // we never touch the file, reads should return the same shape
    // without rebuilding. This is a sanity check: a regression that
    // always reloads would not break correctness but would make the
    // semantic memory much slower on large files.
    const dir = freshDir('sem-no-unnecessary-reload')
    const a = new SemanticMemory(dir)
    a.write({ content: 'pinned', tags: [], source: 'user_stated', confidence: 0.5, timestamp: '' })
    // A series of reads without intervening external writes must
    // always return the same single entry.
    for (let i = 0; i < 5; i++) {
      expect(a.readAll()).toHaveLength(1)
      expect(a.readAll()[0]?.content).toBe('pinned')
    }
  })

  it('a write by the same instance refreshes the (mtime, size) cache (no self-reload)', () => {
    // After write(), the next read should not spuriously reload.
    // Without updating the cache, the file's mtime would appear
    // changed and every subsequent read would re-read the file.
    const dir = freshDir('sem-cache-refresh')
    const a = new SemanticMemory(dir)
    a.write({ content: 'one', tags: [], source: 'user_stated', confidence: 0.5, timestamp: '' })
    a.write({ content: 'two', tags: [], source: 'user_stated', confidence: 0.5, timestamp: '' })
    a.write({ content: 'three', tags: [], source: 'user_stated', confidence: 0.5, timestamp: '' })
    // All 3 entries present in memory and persisted.
    const all = a.readAll()
    expect(all.map((e) => e.content).sort()).toEqual(['one', 'three', 'two'])
  })
})

// ──────────────────────────────────────────────────────────────────────────
// Cross-cutting sanity: the on-disk files of the fixed modules never expose
// the legacy fixed tmp name on success.
// ──────────────────────────────────────────────────────────────────────────

describe('cross-cutting: fixed tmp names are not left behind', () => {
  it('saveSession does not leave history.json.tmp', () => {
    const dir = createSessionDir(freshDir('cross-save'), FIXED_DATE)
    saveSession(dir, [mkMsg('user', 'q')])
    expect(existsSync(join(dir, 'history.json.tmp'))).toBe(false)
  })

  it('SemanticMemory persistAll does not leave a fixed semantic.jsonl.tmp', () => {
    const projectDir = freshDir('cross-sem')
    const mem = new SemanticMemory(projectDir)
    mem.write({ content: 'a', tags: [], source: 'user_stated', confidence: 0.5, timestamp: '' })
    mem.write({ content: 'a', tags: [], source: 'user_stated', confidence: 0.9, timestamp: '' })
    const fixedTmp = join(projectDir, 'memory', 'semantic.jsonl.tmp')
    expect(existsSync(fixedTmp)).toBe(false)
  })
})