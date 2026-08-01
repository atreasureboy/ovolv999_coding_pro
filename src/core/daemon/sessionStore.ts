/**
 * Session persistence — JSONL append-only log per session.
 *
 * Layout:
 *   ~/.ovolv999/sessions/<id>.meta.json   (meta: goal, cwd, startedAt)
 *   ~/.ovolv999/sessions/<id>.turns.jsonl  (one line per turn)
 *
 * The store is best-effort: a corrupted JSONL line is skipped, not
 * thrown. Each session caps at 10000 turns to prevent unbounded
 * memory growth; older turns are pruned at the head.
 */

import { mkdirSync, readFileSync, writeFileSync, existsSync, readdirSync, statSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { randomUUID } from 'node:crypto'

export interface SessionMeta {
  sessionId: string
  goal: string
  cwd: string
  startedAt: number
  status: 'running' | 'idle' | 'closed'
  model?: string
}

export interface PersistedTurn {
  ts: number
  user: string
  assistant: string
  status: 'completed' | 'failed' | 'partial' | 'blocked'
  tokens?: { input: number; output: number }
}

export const MAX_TURNS_PER_SESSION = 10_000

export function getSessionsDir(): string {
  return join(homedir(), '.ovolv999', 'sessions')
}

export function getMetaPath(sessionId: string): string {
  return join(getSessionsDir(), `${sessionId}.meta.json`)
}

export function getTurnsPath(sessionId: string): string {
  return join(getSessionsDir(), `${sessionId}.turns.jsonl`)
}

function ensureSessionsDir(): void {
  const dir = getSessionsDir()
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
}

export function createSessionId(): string {
  return randomUUID()
}

export function saveMeta(meta: SessionMeta): void {
  ensureSessionsDir()
  writeFileSync(getMetaPath(meta.sessionId), JSON.stringify(meta, null, 2))
}

export function loadMeta(sessionId: string): SessionMeta | null {
  const path = getMetaPath(sessionId)
  if (!existsSync(path)) return null
  try {
    const raw = readFileSync(path, 'utf8')
    return JSON.parse(raw) as SessionMeta
  } catch {
    return null
  }
}

export function deleteSession(sessionId: string): boolean {
  const metaPath = getMetaPath(sessionId)
  const turnsPath = getTurnsPath(sessionId)
  let deleted = false
  try {
    if (existsSync(metaPath)) {
      unlinkSync(metaPath)
      deleted = true
    }
    if (existsSync(turnsPath)) {
      unlinkSync(turnsPath)
      deleted = true
    }
  } catch {
    return false
  }
  return deleted
}

export function appendTurn(sessionId: string, turn: PersistedTurn): void {
  ensureSessionsDir()
  const path = getTurnsPath(sessionId)
  writeFileSync(path, JSON.stringify(turn) + '\n', { flag: 'a' })
}

export function loadTurns(sessionId: string): PersistedTurn[] {
  const path = getTurnsPath(sessionId)
  if (!existsSync(path)) return []
  let raw: string
  try {
    raw = readFileSync(path, 'utf8')
  } catch {
    return []
  }
  const out: PersistedTurn[] = []
  let count = 0
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue
    try {
      const parsed = JSON.parse(line) as PersistedTurn
      out.push(parsed)
      count++
      if (count >= MAX_TURNS_PER_SESSION) break
    } catch {
      // skip corrupted line — best-effort, do not throw
    }
  }
  return out
}

export function listSessions(): SessionMeta[] {
  ensureSessionsDir()
  const dir = getSessionsDir()
  if (!existsSync(dir)) return []
  const out: SessionMeta[] = []
  for (const entry of readdirSync(dir)) {
    if (!entry.endsWith('.meta.json')) continue
    const id = entry.replace(/\.meta\.json$/, '')
    const meta = loadMeta(id)
    if (meta) out.push(meta)
  }
  return out.sort((a, b) => b.startedAt - a.startedAt)
}

export interface SessionStats {
  sessionId: string
  turnCount: number
  totalTokens: { input: number; output: number }
  sizeBytes: number
  oldestTurnAt: number
  newestTurnAt: number
}

export function getSessionStats(sessionId: string): SessionStats | null {
  const meta = loadMeta(sessionId)
  if (!meta) return null
  const turns = loadTurns(sessionId)
  const path = getTurnsPath(sessionId)
  let sizeBytes = 0
  try {
    sizeBytes = statSync(path).size
  } catch {
    /* noop */
  }
  const totals = turns.reduce(
    (acc, t) => {
      acc.input += t.tokens?.input ?? 0
      acc.output += t.tokens?.output ?? 0
      return acc
    },
    { input: 0, output: 0 },
  )
  return {
    sessionId,
    turnCount: turns.length,
    totalTokens: totals,
    sizeBytes,
    oldestTurnAt: turns[0]?.ts ?? 0,
    newestTurnAt: turns[turns.length - 1]?.ts ?? 0,
  }
}
