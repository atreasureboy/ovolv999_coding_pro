/**
 * Tests for src/core/backgroundSession.ts
 *
 * The actual detached-spawn path spawns real processes — we test it
 * with a harmless sleep/echo so it stays fast and deterministic. The
 * metadata/log/attach/liveness logic is exercised directly.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import {
  getSessionsDir, getMetadataPath, getLogPath, getExitPath,
  generateSessionId, saveMetadata, loadMetadata, updateMetadata,
  isPidAlive, refreshSessionStatus,
  startBackgroundSession, stopSession, listSessions, getSession,
  readSessionLogs, getLogSize, attachToSession,
  removeSession, cleanStaleSessions,
  formatSessionList, formatSessionDetail,
  type SessionMetadata,
} from '../src/core/backgroundSession.js'
import { existsSync, rmSync, mkdirSync, writeFileSync, mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { homedir } from 'os'

let testHome: string
let origHome: string | undefined

beforeAll(() => {
  testHome = mkdtempSync(join(tmpdir(), 'ovolv999-bg-'))
  origHome = process.env.HOME
  process.env.HOME = testHome
})

afterAll(() => {
  if (origHome !== undefined) process.env.HOME = origHome
  rmSync(testHome, { recursive: true, force: true })
})

beforeEach(() => {
  const dir = getSessionsDir()
  if (existsSync(dir)) rmSync(dir, { recursive: true, force: true })
  mkdirSync(dir, { recursive: true })
})

function makeMeta(overrides: Partial<SessionMetadata> = {}): SessionMetadata {
  return {
    id: generateSessionId(),
    task: 'test task',
    cwd: '/tmp',
    pid: null,
    startedAt: new Date().toISOString(),
    status: 'running',
    logPath: '/tmp/test.log',
    ...overrides,
  }
}

describe('backgroundSession', () => {
  describe('ID generation', () => {
    it('generates session-IDs with prefix', () => {
      const id = generateSessionId()
      expect(id).toMatch(/^sess-/)
    })
    it('generates unique IDs', () => {
      const a = generateSessionId()
      const b = generateSessionId()
      expect(a).not.toBe(b)
    })
  })

  describe('paths', () => {
    it('sessions dir is under home/.ovolv999', () => {
      expect(getSessionsDir()).toContain('.ovolv999')
      expect(getSessionsDir()).toContain('sessions')
    })
    it('metadata path ends with <id>.json', () => {
      expect(getMetadataPath('foo')).toMatch(/foo\.json$/)
    })
    it('log path ends with <id>.log', () => {
      expect(getLogPath('foo')).toMatch(/foo\.log$/)
    })
    it('exit path ends with <id>.exit', () => {
      expect(getExitPath('foo')).toMatch(/foo\.exit$/)
    })
  })

  describe('metadata I/O', () => {
    it('returns null when no metadata file', () => {
      expect(loadMetadata('nope')).toBeNull()
    })

    it('saveMetadata + loadMetadata round-trips', () => {
      const meta = makeMeta({ id: 'sess-1', task: 'hello' })
      saveMetadata(meta)
      const loaded = loadMetadata('sess-1')
      expect(loaded).not.toBeNull()
      expect(loaded!.task).toBe('hello')
    })

    it('updateMetadata patches fields', () => {
      saveMetadata(makeMeta({ id: 'sess-2', status: 'running' }))
      const updated = updateMetadata('sess-2', { status: 'completed', exitCode: 0 })
      expect(updated).not.toBeNull()
      expect(updated!.status).toBe('completed')
      expect(updated!.exitCode).toBe(0)
    })

    it('updateMetadata returns null for unknown id', () => {
      expect(updateMetadata('nope', { status: 'completed' })).toBeNull()
    })
  })

  describe('isPidAlive', () => {
    it('returns true for the current process', () => {
      expect(isPidAlive(process.pid)).toBe(true)
    })
    it('returns false for nonexistent pid', () => {
      expect(isPidAlive(999_999)).toBe(false)
    })
    it('returns false for null/0', () => {
      expect(isPidAlive(null)).toBe(false)
      expect(isPidAlive(0)).toBe(false)
    })
  })

  describe('refreshSessionStatus', () => {
    it('returns null for unknown session', () => {
      expect(refreshSessionStatus('nope')).toBeNull()
    })

    it('marks session completed when exit file shows 0', () => {
      saveMetadata(makeMeta({ id: 'sess-r1', pid: 999_999, status: 'running' }))
      writeFileSync(getExitPath('sess-r1'), '0\n')
      const meta = refreshSessionStatus('sess-r1')
      expect(meta!.status).toBe('completed')
      expect(meta!.exitCode).toBe(0)
    })

    it('marks session failed when exit file shows nonzero', () => {
      saveMetadata(makeMeta({ id: 'sess-r2', pid: 999_999, status: 'running' }))
      writeFileSync(getExitPath('sess-r2'), '1\n')
      const meta = refreshSessionStatus('sess-r2')
      expect(meta!.status).toBe('failed')
    })

    it('leaves running session alone if pid alive and no exit file', () => {
      saveMetadata(makeMeta({ id: 'sess-r3', pid: process.pid, status: 'running' }))
      const meta = refreshSessionStatus('sess-r3')
      expect(meta!.status).toBe('running')
    })

    it('marks unknown when pid dead and no exit file', () => {
      saveMetadata(makeMeta({ id: 'sess-r4', pid: 999_999, status: 'running' }))
      const meta = refreshSessionStatus('sess-r4')
      expect(['unknown', 'stopped', 'failed']).toContain(meta!.status)
    })
  })

  describe('listSessions', () => {
    it('returns empty when no sessions', () => {
      expect(listSessions()).toEqual([])
    })

    it('lists multiple sessions sorted by startedAt desc', () => {
      saveMetadata(makeMeta({ id: 'a', startedAt: '2024-01-01T00:00:00Z' }))
      saveMetadata(makeMeta({ id: 'b', startedAt: '2024-01-02T00:00:00Z' }))
      const list = listSessions()
      expect(list.length).toBe(2)
      expect(list[0].id).toBe('b')
      expect(list[1].id).toBe('a')
    })
  })

  describe('readSessionLogs / getLogSize', () => {
    it('returns empty when no log file', () => {
      expect(readSessionLogs('nope')).toBe('')
      expect(getLogSize('nope')).toBe(0)
    })

    it('reads full log', () => {
      writeFileSync(getLogPath('l1'), 'line1\nline2\nline3\n')
      expect(readSessionLogs('l1')).toContain('line1')
      expect(readSessionLogs('l1')).toContain('line3')
      expect(getLogSize('l1')).toBe(18)
    })

    it('reads tail N lines', () => {
      writeFileSync(getLogPath('l2'), 'a\nb\nc\nd\ne\n')
      const tail = readSessionLogs('l2', { tailLines: 2 })
      expect(tail).toContain('d')
      expect(tail).toContain('e')
      expect(tail).not.toContain('a')
    })

    it('reads from offset', () => {
      writeFileSync(getLogPath('l3'), '0123456789')
      const fromOffset = readSessionLogs('l3', { startOffset: 5 })
      expect(fromOffset).toBe('56789')
    })

    it('returns empty when offset beyond size', () => {
      writeFileSync(getLogPath('l4'), 'short')
      expect(readSessionLogs('l4', { startOffset: 100 })).toBe('')
    })
  })

  describe('attachToSession', () => {
    it('returns null for unknown session', () => {
      expect(attachToSession('nope')).toBeNull()
    })

    it('returns a handle with stream, stop, metadata', () => {
      saveMetadata(makeMeta({ id: 'att1', status: 'running', pid: process.pid }))
      const handle = attachToSession('att1')
      expect(handle).not.toBeNull()
      expect(handle!.stream).toBeDefined()
      expect(typeof handle!.stop).toBe('function')
      expect(handle!.metadata.id).toBe('att1')
      handle!.stop()
    })

    it('stop() ends the stream', async () => {
      saveMetadata(makeMeta({ id: 'att2', status: 'running', pid: process.pid }))
      const handle = attachToSession('att2', 50)!
      handle.stop()
      // After stop, iterator should complete
      const iter = handle.stream[Symbol.asyncIterator]()
      const result = await iter.next()
      expect(result.done).toBe(true)
    })
  })

  describe('stopSession', () => {
    it('returns false for unknown session', () => {
      expect(stopSession('nope')).toBe(false)
    })

    it('marks a dead session as stopped', () => {
      saveMetadata(makeMeta({ id: 's1', pid: 999_999, status: 'running' }))
      expect(stopSession('s1', 10)).toBe(true)
      const meta = loadMetadata('s1')
      expect(meta!.status).toBe('stopped')
    })
  })

  describe('removeSession', () => {
    it('returns false for unknown session', () => {
      expect(removeSession('nope')).toBe(false)
    })

    it('removes metadata, log, and exit files', () => {
      saveMetadata(makeMeta({ id: 'rm1', pid: null, status: 'completed' }))
      writeFileSync(getLogPath('rm1'), 'logs')
      writeFileSync(getExitPath('rm1'), '0\n')
      expect(removeSession('rm1')).toBe(true)
      expect(existsSync(getMetadataPath('rm1'))).toBe(false)
      expect(existsSync(getLogPath('rm1'))).toBe(false)
      expect(existsSync(getExitPath('rm1'))).toBe(false)
    })

    it('refuses to remove running session without force', () => {
      saveMetadata(makeMeta({ id: 'rm2', pid: process.pid, status: 'running' }))
      expect(removeSession('rm2', false)).toBe(false)
      expect(existsSync(getMetadataPath('rm2'))).toBe(true)
    })

    it('force removes running session', () => {
      saveMetadata(makeMeta({ id: 'rm3', pid: process.pid, status: 'running' }))
      expect(removeSession('rm3', true)).toBe(true)
      expect(existsSync(getMetadataPath('rm3'))).toBe(false)
    })
  })

  describe('cleanStaleSessions', () => {
    it('removes old non-running sessions', () => {
      const old = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString()
      saveMetadata(makeMeta({ id: 'old1', startedAt: old, status: 'completed', pid: null }))
      saveMetadata(makeMeta({ id: 'new1', status: 'completed', pid: null }))
      const removed = cleanStaleSessions()
      expect(removed).toBe(1)
      expect(loadMetadata('old1')).toBeNull()
      expect(loadMetadata('new1')).not.toBeNull()
    })

    it('never removes running sessions', () => {
      const old = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString()
      saveMetadata(makeMeta({ id: 'old-run', startedAt: old, status: 'running', pid: process.pid }))
      const removed = cleanStaleSessions()
      expect(removed).toBe(0)
    })
  })

  describe('formatSessionList', () => {
    it('handles empty list', () => {
      expect(formatSessionList([])).toContain('No background sessions')
    })

    it('lists sessions with ids', () => {
      const out = formatSessionList([
        makeMeta({ id: 'sess-a', task: 'do thing', status: 'running' }),
      ])
      expect(out).toContain('sess-a')
      expect(out).toContain('do thing')
    })

    it('truncates long tasks', () => {
      const long = 'x'.repeat(80)
      const out = formatSessionList([makeMeta({ id: 'sess-b', task: long })])
      expect(out).toContain('...')
    })
  })

  describe('formatSessionDetail', () => {
    it('shows all fields', () => {
      const out = formatSessionDetail(makeMeta({
        id: 'sess-d', task: 'detail task', status: 'completed',
        pid: 1234, exitCode: 0, model: 'gpt-4',
      }))
      expect(out).toContain('sess-d')
      expect(out).toContain('detail task')
      expect(out).toContain('completed')
      expect(out).toContain('1234')
      expect(out).toContain('gpt-4')
    })
  })

  describe('startBackgroundSession (integration)', () => {
    it('creates metadata and log files', () => {
      // Use a trivial task with a fake bin to avoid actually launching ovolv999
      process.env.OVOGV999_BIN = '/dev/null'
      try {
        const result = startBackgroundSession({ task: 'noop' })
        expect(result.sessionId).toMatch(/^sess-/)
        expect(existsSync(getMetadataPath(result.sessionId))).toBe(true)
        expect(existsSync(getLogPath(result.sessionId))).toBe(true)
        const meta = loadMetadata(result.sessionId)
        expect(meta!.task).toBe('noop')
        expect(meta!.status).toBe('running')
      } finally {
        delete process.env.OVOGV999_BIN
      }
    }, 10000)
  })
})
