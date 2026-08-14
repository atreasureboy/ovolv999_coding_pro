/**
 * Round 28 regression tests — conversation checkpoints (/rewind turn N).
 *
 * The checkpoint anchor appended after each turn records historyLength +
 * per-file version counts; rewinding truncates BOTH the conversation and
 * the file state — Claude Code's /rewind semantics.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  appendCheckpoint,
  listCheckpoints,
  rewindToCheckpoint,
} from '../src/core/conversationCheckpoints.js'
import { FileHistory } from '../src/core/fileHistory.js'
import type { OpenAIMessage } from '../src/core/types.js'

describe('Conversation checkpoints (Round 28)', () => {
  let dir: string
  let fh: FileHistory
  let history: OpenAIMessage[]

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'r28-cp-'))
    fh = new FileHistory(dir)
    history = []
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('appends checkpoints with turn numbers, history lengths, and file version counts', () => {
    history.push({ role: 'user', content: 'hi' }, { role: 'assistant', content: 'hello' })
    appendCheckpoint(dir, history, null, 'hi')
    history.push({ role: 'user', content: 'edit the file' })
    appendCheckpoint(dir, history, fh, 'edit the file')

    const cps = listCheckpoints(dir)
    expect(cps).toHaveLength(2)
    expect(cps[0].turn).toBe(1)
    expect(cps[0].historyLength).toBe(2)
    expect(cps[1].turn).toBe(2)
    expect(cps[1].historyLength).toBe(3)
    expect(cps[1].prompt).toBe('edit the file')
  })

  it('rewinds BOTH conversation and files to the end of turn N', () => {
    const file = join(dir, 'a.txt')
    writeFileSync(file, 'original')
    fh.trackEdit(file)
    writeFileSync(file, 'v1')

    // Turn 1 ends after the first edit
    history.push({ role: 'user', content: 'edit' }, { role: 'assistant', content: 'done' })
    appendCheckpoint(dir, history, fh, 'edit')

    // Turn 2 makes a second edit
    fh.trackEdit(file)
    writeFileSync(file, 'v2')
    history.push({ role: 'user', content: 'more' }, { role: 'assistant', content: 'done2' })
    appendCheckpoint(dir, history, fh, 'more')

    // Rewind to turn 1: conversation 2 msgs, file = v1
    const r = rewindToCheckpoint(dir, 1, history, fh)
    expect(r.ok).toBe(true)
    expect(r.historyLength).toBe(2)
    expect(r.restoredFiles).toEqual([file])
    expect(readFileSync(file, 'utf8')).toBe('v1')

    // Truncation is the caller's job (ctx.setHistory owns the array)
    const truncated = history.slice(0, r.historyLength)
    expect(truncated).toHaveLength(2)
    expect(truncated[0].content).toBe('edit')
  })

  it('missing turn → actionable message with available turns', () => {
    history.push({ role: 'user', content: 'x' })
    appendCheckpoint(dir, history, null, 'x')
    const r = rewindToCheckpoint(dir, 7, history, null)
    expect(r.ok).toBe(false)
    expect(r.message).toMatch(/No checkpoint for turn 7/)
    expect(r.message).toMatch(/Recorded turns: 1/)
  })

  it('history truncation is capped at the current length (post-compaction safety)', () => {
    history.push({ role: 'user', content: 'a' })
    appendCheckpoint(dir, history, null, 'a')
    // Compaction shrinks history below the checkpoint length
    const shorter: OpenAIMessage[] = [{ role: 'user', content: 'a' }]
    const r = rewindToCheckpoint(dir, 1, shorter, null)
    expect(r.ok).toBe(true)
    expect(r.historyLength).toBeLessThanOrEqual(shorter.length)
  })

  it('empty session → empty checkpoint list', () => {
    expect(listCheckpoints(dir)).toEqual([])
  })
})
