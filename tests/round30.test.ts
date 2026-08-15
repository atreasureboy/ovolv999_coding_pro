/**
 * Round 30 regression tests — targeted HEAD-audit fixes.
 *
 * 1. /rewind turn semantics: created files (delete when created after the
 *    anchor; restore first-write content when created before it), future
 *    checkpoint truncation, tail-read numbering continuity.
 * 2. TodoStore session isolation (multi-engine, same process).
 * (Cumulative-usage + single-emission regressions live in
 *  tests/model/anthropicAdapter.test.ts.)
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, appendFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  appendCheckpoint,
  listCheckpoints,
  rewindToCheckpoint,
} from '../src/core/conversationCheckpoints.js'
import { FileHistory } from '../src/core/fileHistory.js'
import {
  ensureLoaded, updateTodos, getTodos, renderTodoPromptBlock, resetTodos,
} from '../src/core/todoStore.js'
import type { OpenAIMessage } from '../src/core/types.js'

describe('/rewind turn — created-file semantics + branch truncation', () => {
  let dir: string
  let fh: FileHistory
  let history: OpenAIMessage[]

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'r30-cp-'))
    fh = new FileHistory(dir)
    history = [{ role: 'user', content: 'start' }]
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('file created AFTER the anchor is deleted by the rewind', () => {
    appendCheckpoint(dir, history, fh, 'turn1') // anchor 1: no created files

    // Turn 2 creates a brand-new file (Write marks the creation AFTER
    // the successful write — markCreated, not trackEdit)
    const created = join(dir, 'brand-new.ts')
    writeFileSync(created, 'first write')
    fh.markCreated(created)
    history.push({ role: 'assistant', content: 'created file' })
    appendCheckpoint(dir, history, fh, 'turn2')

    // Turn 3 edits it again (now trackEdit backs up the first write)
    fh.trackEdit(created)
    writeFileSync(created, 'second write')
    appendCheckpoint(dir, history, fh, 'turn3')

    const r = rewindToCheckpoint(dir, 1, history, fh)
    expect(r.ok).toBe(true)
    expect(r.deletedFiles).toEqual([created])
    expect(existsSync(created)).toBe(false)
    // Future anchors (2,3) are GONE — no stale branch left behind
    expect(listCheckpoints(dir).map((c) => c.turn)).toEqual([1])
    expect(r.truncatedCheckpoints).toBe(2)
  })

  it('file created BEFORE the anchor keeps existing; later edits rewind to first-write content', () => {
    // Turn 1 creates the file (markCreated mirrors the Write tool)
    const created = join(dir, 'new-module.ts')
    writeFileSync(created, 'v1 content')
    fh.markCreated(created)
    history.push({ role: 'assistant', content: 'created' })
    appendCheckpoint(dir, history, fh, 'turn1') // anchor: createdFiles=[created], files={} (no versions yet)

    // Turn 2 edits it — trackEdit now snapshots 'v1 content' as version 0
    fh.trackEdit(created)
    writeFileSync(created, 'v2 content')
    appendCheckpoint(dir, history, fh, 'turn2') // files={created:1}

    // Rewind to turn 1: file must still EXIST with its turn-1 content
    const r = rewindToCheckpoint(dir, 1, history, fh)
    expect(r.ok).toBe(true)
    expect(r.deletedFiles).toEqual([]) // created BEFORE the anchor → kept
    expect(existsSync(created)).toBe(true)
    expect(readFileSync(created, 'utf8')).toBe('v1 content')
  })

  it('appends after a rewind continue numbering from the truncation point (no anchor collision)', () => {
    appendCheckpoint(dir, history, fh, 't1')
    history.push({ role: 'assistant', content: 'a' })
    appendCheckpoint(dir, history, fh, 't2')
    history.push({ role: 'assistant', content: 'b' })
    appendCheckpoint(dir, history, fh, 't3')

    rewindToCheckpoint(dir, 1, history, fh)
    // New turn after the rewind: numbering must be 2 (the stale 2/3 are gone)
    appendCheckpoint(dir, history, fh, 'post-rewind')
    const turns = listCheckpoints(dir).map((c) => c.turn)
    expect(turns).toEqual([1, 2])
  })

  it('append path never full-parses: anchors stay 1 line each and numbering is monotonic', () => {
    for (let i = 0; i < 30; i++) {
      history.push({ role: 'assistant', content: `t${i}` })
      appendCheckpoint(dir, history, fh, `prompt ${i}`)
    }
    const cps = listCheckpoints(dir)
    expect(cps).toHaveLength(30)
    expect(cps[29].turn).toBe(30)
    // Tail-read numbering survives a torn final line (partial write crash)
    const p = join(dir, 'checkpoints.jsonl')
    appendFileSync(p, '{"turn":31,"historyLen', 'utf8') // torn line
    appendCheckpoint(dir, history, fh, 'after torn')
    const last = listCheckpoints(dir).at(-1)
    expect(last?.turn).toBe(31)
    expect(last?.prompt).toBe('after torn')
  })
})

describe('TodoStore — multi-session isolation (same process)', () => {
  let dirA: string
  let dirB: string

  beforeEach(() => {
    dirA = mkdtempSync(join(tmpdir(), 'r30-todoA-'))
    dirB = mkdtempSync(join(tmpdir(), 'r30-todoB-'))
    resetTodos()
  })
  afterEach(() => {
    rmSync(dirA, { recursive: true, force: true })
    rmSync(dirB, { recursive: true, force: true })
  })

  it('two engines in one process keep independent checklists', () => {
    // Main agent (dirA) plans; sub-agent engine (dirB) plans its own list
    ensureLoaded(dirA)
    updateTodos([{ id: '1', content: 'MAIN task', status: 'in_progress', priority: 'high' }], dirA)
    ensureLoaded(dirB)
    updateTodos([{ id: '1', content: 'SUB task', status: 'pending', priority: 'low' }], dirB)

    expect(getTodos(dirA).map((t) => t.content)).toEqual(['MAIN task'])
    expect(getTodos(dirB).map((t) => t.content)).toEqual(['SUB task'])

    // Prompt blocks are per-engine — the sub-agent's list must NOT leak
    // into the main agent's system prompt (the pre-fix behavior).
    expect(renderTodoPromptBlock(dirA)).toContain('MAIN task')
    expect(renderTodoPromptBlock(dirA)).not.toContain('SUB task')
    expect(renderTodoPromptBlock(dirB)).toContain('SUB task')
  })

  it('undefined-sessionDir engines share the legacy default bucket', () => {
    ensureLoaded(undefined)
    updateTodos([{ id: 'x', content: 'shared', status: 'pending', priority: 'medium' }], undefined)
    expect(getTodos(undefined).map((t) => t.content)).toEqual(['shared'])
    expect(renderTodoPromptBlock(undefined)).toContain('shared')
    // And a dir-keyed session does not see it
    expect(renderTodoPromptBlock(dirA)).toBe('')
  })
})
