import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  getSessionsDir,
  createSessionId,
  saveMeta,
  loadMeta,
  appendTurn,
  loadTurns,
  listSessions,
  deleteSession,
  getSessionStats,
  MAX_TURNS_PER_SESSION,
  type SessionMeta,
  type PersistedTurn,
} from '../../../src/core/daemon/sessionStore.js'

describe('sessionStore', () => {
  let tmpHome: string
  let oldHome: string | undefined

  beforeEach(() => {
    tmpHome = mkdtempSync(join(tmpdir(), 'ovolv999-session-'))
    oldHome = process.env.HOME
    process.env.HOME = tmpHome
  })
  afterEach(() => {
    process.env.HOME = oldHome
    rmSync(tmpHome, { recursive: true, force: true })
  })

  it('creates sessions dir on demand', () => {
    saveMeta({
      sessionId: 'abc',
      goal: 'test',
      cwd: '/tmp',
      startedAt: Date.now(),
      status: 'running',
    })
    expect(existsSync(getSessionsDir())).toBe(true)
  })

  it('round-trips meta via saveMeta/loadMeta', () => {
    const meta: SessionMeta = {
      sessionId: 's-1',
      goal: 'refactor',
      cwd: '/home/u/proj',
      startedAt: Date.now(),
      status: 'idle',
      model: 'claude-sonnet-4-6',
    }
    saveMeta(meta)
    const loaded = loadMeta('s-1')
    expect(loaded).toEqual(meta)
  })

  it('returns null for missing meta', () => {
    expect(loadMeta('does-not-exist')).toBeNull()
  })

  it('appends and loads turns', () => {
    const id = createSessionId()
    saveMeta({ sessionId: id, goal: 'g', cwd: '/tmp', startedAt: Date.now(), status: 'running' })
    const turns: PersistedTurn[] = [
      { ts: 1, user: 'hi', assistant: 'hello', status: 'completed' },
      { ts: 2, user: 'how are you?', assistant: 'fine', status: 'completed', tokens: { input: 10, output: 20 } },
    ]
    for (const turn of turns) appendTurn(id, turn)
    const loaded = loadTurns(id)
    expect(loaded).toEqual(turns)
  })

  it('skips corrupted JSONL lines', () => {
    const id = createSessionId()
    saveMeta({ sessionId: id, goal: 'g', cwd: '/tmp', startedAt: Date.now(), status: 'running' })
    appendTurn(id, { ts: 1, user: 'good', assistant: 'bad', status: 'completed' })
    const path = join(getSessionsDir(), `${id}.turns.jsonl`)
    writeFileSync(path, '{ broken json\n', { flag: 'a' })
    appendTurn(id, { ts: 2, user: 'second', assistant: 'reply', status: 'completed' })
    const loaded = loadTurns(id)
    expect(loaded.length).toBe(2)
    expect(loaded[0]?.user).toBe('good')
    expect(loaded[1]?.user).toBe('second')
  })

  it('caps loaded turns at MAX_TURNS_PER_SESSION', () => {
    const id = createSessionId()
    saveMeta({ sessionId: id, goal: 'g', cwd: '/tmp', startedAt: Date.now(), status: 'running' })
    for (let i = 0; i < MAX_TURNS_PER_SESSION + 50; i++) {
      appendTurn(id, { ts: i, user: `u${i}`, assistant: `a${i}`, status: 'completed' })
    }
    const loaded = loadTurns(id)
    expect(loaded.length).toBe(MAX_TURNS_PER_SESSION)
  })

  it('lists sessions sorted by startedAt desc', () => {
    const id1 = createSessionId()
    const id2 = createSessionId()
    saveMeta({ sessionId: id1, goal: 'old', cwd: '/tmp', startedAt: 1000, status: 'closed' })
    saveMeta({ sessionId: id2, goal: 'new', cwd: '/tmp', startedAt: 2000, status: 'running' })
    const list = listSessions()
    expect(list.map((s) => s.sessionId)).toEqual([id2, id1])
  })

  it('deletes session files', () => {
    const id = createSessionId()
    saveMeta({ sessionId: id, goal: 'g', cwd: '/tmp', startedAt: Date.now(), status: 'running' })
    appendTurn(id, { ts: 1, user: 'u', assistant: 'a', status: 'completed' })
    expect(deleteSession(id)).toBe(true)
    expect(loadMeta(id)).toBeNull()
    expect(loadTurns(id)).toEqual([])
  })

  it('computes session stats', () => {
    const id = createSessionId()
    saveMeta({ sessionId: id, goal: 'g', cwd: '/tmp', startedAt: 100, status: 'running' })
    appendTurn(id, { ts: 100, user: 'u1', assistant: 'a1', status: 'completed', tokens: { input: 50, output: 60 } })
    appendTurn(id, { ts: 200, user: 'u2', assistant: 'a2', status: 'completed', tokens: { input: 70, output: 80 } })
    const stats = getSessionStats(id)
    expect(stats?.turnCount).toBe(2)
    expect(stats?.totalTokens).toEqual({ input: 120, output: 140 })
    expect(stats?.oldestTurnAt).toBe(100)
    expect(stats?.newestTurnAt).toBe(200)
  })

  it('returns null stats for missing session', () => {
    expect(getSessionStats('does-not-exist')).toBeNull()
  })
})
