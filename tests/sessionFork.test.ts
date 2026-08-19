import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'fs'
import { tmpdir } from 'os'
import { join, basename } from 'path'
import {
  computeForkCutPoint,
  forkSession,
  createSessionDir,
  saveSession,
  loadSession,
  SessionNotFoundError,
} from '../src/core/sessionManager.js'
import type { OpenAIMessage } from '../src/core/types.js'

let tmpRoot = ''

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'ovogo-fork-test-'))
})

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true })
})

function msg(role: OpenAIMessage['role'], content: string): OpenAIMessage {
  return { role, content }
}

function assistantWithCalls(ids: string[]): OpenAIMessage {
  return {
    role: 'assistant',
    content: null,
    tool_calls: ids.map((id, i) => ({
      id,
      type: 'function' as const,
      function: { name: 'Bash', arguments: JSON.stringify({ command: `cmd${i}` }) },
    })),
  }
}

function toolResult(id: string, content: string): OpenAIMessage {
  return { role: 'tool', tool_call_id: id, content }
}

const CONVERSATION: OpenAIMessage[] = [
  msg('user', 'hello'),                            // 0
  msg('assistant', 'hi'),                         // 1
  msg('user', 'do things'),                       // 2
  assistantWithCalls(['tc1', 'tc2']),             // 3
  toolResult('tc1', 'ok1'),                       // 4
  toolResult('tc2', 'ok2'),                       // 5
  msg('assistant', 'done'),                       // 6
  msg('user', 'thanks'),                          // 7
]

describe('computeForkCutPoint', () => {
  it('defaults to the full history', () => {
    expect(computeForkCutPoint(CONVERSATION)).toBe(CONVERSATION.length)
  })

  it('keeps a clean boundary unchanged', () => {
    expect(computeForkCutPoint(CONVERSATION, 2)).toBe(2)
    expect(computeForkCutPoint(CONVERSATION, 7)).toBe(7)
  })

  it('advances past a tool row at the boundary', () => {
    // cut=4 would exclude tc2's result while including tc1's — boundary
    // sits inside the tool group and must advance to 6.
    expect(computeForkCutPoint(CONVERSATION, 4)).toBe(6)
    expect(computeForkCutPoint(CONVERSATION, 5)).toBe(6)
  })

  it('accepts a boundary right before a tool-call group', () => {
    // cut=3 excludes the whole assistant+results group — consistent.
    expect(computeForkCutPoint(CONVERSATION, 3)).toBe(3)
  })

  it('advances when the prefix leaves pending tool_calls', () => {
    // Group at the tail: user(0), assistant w/ tool_call(1), result(2).
    const msgs: OpenAIMessage[] = [
      msg('user', 'q'),
      assistantWithCalls(['x']),
      toolResult('x', 'r'),
    ]
    // cut=2 splits the group (assistant included, result excluded).
    expect(computeForkCutPoint(msgs, 2)).toBe(3)
  })

  it('clamps out-of-range requests', () => {
    expect(computeForkCutPoint(CONVERSATION, -5)).toBe(0)
    expect(computeForkCutPoint(CONVERSATION, 999)).toBe(CONVERSATION.length)
  })

  it('excludes an orphan tool block from the fork (Round 41 trim)', () => {
    const msgs: OpenAIMessage[] = [
      msg('user', 'q'),
      msg('assistant', 'a'),
      toolResult('orphan', 'stale'), // no matching assistant — legacy data
      msg('user', 'next'),
    ]
    // cut=2 lands ON the orphan tool row. Round 41: the consistency trim
    // now EXCLUDES the orphan from the prefix (the old grow-only walk
    // pulled it INTO the fork — an API-rejecting orphan tool result).
    expect(computeForkCutPoint(msgs, 2)).toBe(2)
  })
})

describe('forkSession', () => {
  it('copies the full history into a fresh session dir', () => {
    const cwd = join(tmpRoot, 'proj')
    const src = createSessionDir(cwd, new Date('2026-08-01T10:00:00Z'))
    saveSession(src, CONVERSATION)

    const result = forkSession(cwd, src)
    expect(result.messages).toBe(CONVERSATION.length)
    expect(result.adjusted).toBe(false)
    expect(result.forkDir).not.toBe(src)
    expect(basename(result.forkDir)).toMatch(/^session_.*_fork/)
    expect(loadSession(result.forkDir)).toEqual(CONVERSATION)
    // Source untouched.
    expect(loadSession(src)).toEqual(CONVERSATION)
  })

  it('forks at a safe boundary when a cut is requested mid-group', () => {
    const cwd = join(tmpRoot, 'proj2')
    const src = createSessionDir(cwd, new Date('2026-08-01T11:00:00Z'))
    saveSession(src, CONVERSATION)

    const result = forkSession(cwd, src, 4)
    expect(result.adjusted).toBe(true)
    expect(result.messages).toBe(6)
    const forked = loadSession(result.forkDir)
    expect(forked[forked.length - 1]).toEqual(toolResult('tc2', 'ok2'))
  })

  it('never generates duplicate fork directory names even within one second', () => {
    const cwd = join(tmpRoot, 'proj3')
    const src = createSessionDir(cwd, new Date('2026-08-01T12:00:00Z'))
    saveSession(src, CONVERSATION)

    // Two forks issued back-to-back (potentially in the same second)
    // must land in distinct directories — collision handling appends _fork2.
    const a = forkSession(cwd, src)
    const b = forkSession(cwd, src)
    expect(a.forkDir).not.toBe(b.forkDir)
    expect(existsSync(a.forkDir)).toBe(true)
    expect(existsSync(b.forkDir)).toBe(true)
  })

  it('throws SessionNotFoundError for a source without history', () => {
    const cwd = join(tmpRoot, 'proj4')
    const src = createSessionDir(cwd)
    expect(() => forkSession(cwd, src)).toThrow(SessionNotFoundError)
  })

  it('does not inherit lastOutcome from the source', () => {
    const cwd = join(tmpRoot, 'proj5')
    const src = createSessionDir(cwd, new Date('2026-08-01T13:00:00Z'))
    saveSession(src, CONVERSATION, {
      status: 'completed',
      changedFiles: ['a.ts'],
      verification: { executed: true, passed: true },
      blockers: [],
      requiredNextActions: [],
    })
    const result = forkSession(cwd, src)
    const envelope = JSON.parse(readFileSync(join(result.forkDir, 'history.json'), 'utf8')) as Record<string, unknown>
    expect(envelope.lastOutcome).toBeUndefined()
  })
})
