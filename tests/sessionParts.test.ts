import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import {mkdtempSync, rmSync, readFileSync, existsSync, appendFileSync} from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  appendMessage,
  appendMeta,
  rewriteLedger,
  readParts,
  readPage,
  appendDelta,
  hasPartsLedger,
  partsLedgerSize,
  PARTS_FILENAME,
} from '../src/core/sessionParts.js'
import {
  createSessionDir,
  saveSession,
  saveSessionIncremental,
  loadSessionEnvelope,
  setSessionTitle,
  forkSession,
} from '../src/core/sessionManager.js'
import type { OpenAIMessage } from '../src/core/types.js'

/**
 * Round 42 gap #1 (opencode Session/Message/Part model): append-only
 * parts ledger + incremental saves. The hot path must go from O(history)
 * bytes per turn to O(new messages).
 */

let cwd = ''
let dir = ''

const MSGS: OpenAIMessage[] = [
  { role: 'user', content: 'hello' },
  { role: 'assistant', content: 'hi there' },
]

beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), 'ovogo-parts-'))
  dir = createSessionDir(cwd)
})

afterEach(() => {
  rmSync(cwd, { recursive: true, force: true })
})

describe('parts ledger primitives', () => {
  it('append → read round-trips messages and meta', () => {
    appendMessage(dir, MSGS[0], 0)
    appendMessage(dir, MSGS[1], 1)
    appendMeta(dir, { title: 't' })
    const { messages, meta, skippedTorn } = readParts(dir)
    expect(messages).toHaveLength(2)
    expect(meta.title).toBe('t')
    expect(skippedTorn).toBe(0)
  })

  it('later meta lines win (upsert semantics)', () => {
    appendMeta(dir, { title: 'first' })
    appendMeta(dir, { title: 'second' })
    expect(readParts(dir).meta.title).toBe('second')
  })

  it('a torn trailing line is skipped, not fatal', () => {
    appendMessage(dir, MSGS[0], 0)
    appendFileSync(join(dir, PARTS_FILENAME), '{"kind":"msg","seq":1,"msg":{"role":"user","cont', 'utf8')
    const { messages, skippedTorn } = readParts(dir)
    expect(messages).toHaveLength(1)
    expect(skippedTorn).toBe(1)
  })

  it('rewrite replaces the ledger atomically', () => {
    appendMessage(dir, MSGS[0], 0)
    rewriteLedger(dir, MSGS, { title: 'fresh' })
    const { messages, meta } = readParts(dir)
    expect(messages).toEqual(MSGS)
    expect(meta.title).toBe('fresh')
  })

  it('appendDelta appends only the new tail', () => {
    appendDelta(dir, MSGS)
    const before = partsLedgerSize(dir)
    const longer = [...MSGS, { role: 'user' as const, content: 'more' }]
    const appended = appendDelta(dir, longer, { title: 'x' })
    expect(appended).toBe(1)
    expect(partsLedgerSize(dir)).toBeGreaterThan(before)
    expect(readParts(dir).messages).toEqual(longer)
  })

  it('appendDelta rewrites on divergence (compaction)', () => {
    appendDelta(dir, MSGS)
    const compacted: OpenAIMessage[] = [{ role: 'system', content: 'summary' }, MSGS[1]]
    appendDelta(dir, compacted)
    expect(readParts(dir).messages).toEqual(compacted)
  })

  it('readPage paginates with cursors', () => {
    const many: OpenAIMessage[] = Array.from({ length: 7 }, (_, i) => ({ role: 'user' as const, content: `m${i}` }))
    appendDelta(dir, many)
    const p1 = readPage(dir, 0, 3)
    expect(p1.messages).toHaveLength(3)
    expect(p1.nextCursor).toBe(3)
    const p2 = readPage(dir, 3, 3)
    expect(p2.messages).toHaveLength(3)
    expect(p2.nextCursor).toBe(6)
    const p3 = readPage(dir, 6, 3)
    expect(p3.messages).toHaveLength(1)
    expect(p3.nextCursor).toBeNull()
  })
})

describe('sessionManager integration', () => {
  it('saveSession mirrors into the ledger; loads prefer the ledger', () => {
    saveSession(dir, MSGS)
    expect(hasPartsLedger(dir)).toBe(true)
    // Ledger is ahead of the envelope after an incremental append.
    const longer = [...MSGS, { role: 'user' as const, content: 'tail' }]
    expect(saveSessionIncremental(dir, longer)).toBe('appended')
    // history.json still holds 2 messages; the load sees 3 via the ledger.
    const envJson = JSON.parse(readFileSync(join(dir, 'history.json'), 'utf8')) as { messages: unknown[] }
    expect(envJson.messages).toHaveLength(2)
    expect(loadSessionEnvelope(dir)?.messages).toHaveLength(3)
  })

  it('first save for a fresh dir takes the full path (envelope created)', () => {
    const fresh = createSessionDir(cwd, new Date(Date.now() + 5000))
    expect(saveSessionIncremental(fresh, MSGS)).toBe('full')
    expect(existsSync(join(fresh, 'history.json'))).toBe(true)
    expect(loadSessionEnvelope(fresh)?.messages).toEqual(MSGS)
  })

  it('incremental then full-write paths stay consistent', () => {
    saveSession(dir, MSGS)
    const longer = [...MSGS, { role: 'assistant' as const, content: 'ok' }]
    expect(saveSessionIncremental(dir, longer)).toBe('appended')
    // Force divergence (as if compaction rewrote memory): full fallback.
    const compacted: OpenAIMessage[] = [{ role: 'system', content: '[summary]' }]
    expect(saveSessionIncremental(dir, compacted)).toBe('full')
    expect(loadSessionEnvelope(dir)?.messages).toEqual(compacted)
  })

  it('outcome/title meta survives incremental saves', () => {
    saveSession(dir, MSGS)
    setSessionTitle(dir, 'Ledger title')
    const longer = [...MSGS, { role: 'user' as const, content: 'x' }]
    saveSessionIncremental(dir, longer)
    const env = loadSessionEnvelope(dir)
    expect(env?.title).toBe('Ledger title')
  })

  it('fork gets its own independent ledger', () => {
    saveSession(dir, MSGS)
    const fork = forkSession(cwd, dir)
    expect(hasPartsLedger(fork.forkDir)).toBe(true)
    expect(readParts(fork.forkDir).messages).toHaveLength(MSGS.length)
    // Mutating the fork's ledger never touches the source.
    appendMessage(fork.forkDir, { role: 'user', content: 'fork-only' }, 99)
    expect(readParts(dir).messages).toHaveLength(MSGS.length)
  })

  it('reasoningContent round-trips through the ledger', () => {
    const withReasoning: OpenAIMessage[] = [
      { role: 'user', content: 'think' },
      { role: 'assistant', content: 'answer', reasoningContent: 'because...' },
    ]
    saveSession(dir, withReasoning)
    expect(readParts(dir).messages[1]?.reasoningContent).toBe('because...')
  })
})
