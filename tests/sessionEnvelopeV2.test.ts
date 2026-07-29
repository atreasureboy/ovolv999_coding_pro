/**
 * v0.4.1 WS7 — Session Envelope v2 (session truth).
 *
 * /resume and /sessions must show the REAL verdict of the last turn:
 *   - saveSession(dir, history, outcome?) persists an OutcomeSummary;
 *   - listSessionsDetailed reads status ONLY from that envelope truth;
 *   - v1 legacy files (no outcome ever stored) list as 'unknown' —
 *     the old "changed files ⇒ Completed" guess is gone;
 *   - corrupt / foreign-version files warn once on stderr and list as
 *     'corrupt' / 'unknown' instead of silently rendering 'Completed';
 *   - v1 → v2 migration preserves messages and updatedAt verbatim.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  saveSession,
  loadSession,
  loadSessionEnvelope,
  listSessionsDetailed,
  createSessionDir,
  summarizeOutcome,
  CorruptSessionError,
  UnknownSessionVersionError,
  CURRENT_SESSION_VERSION,
  CURRENT_SESSION_SCHEMA,
  V1_SESSION_SCHEMA,
} from '../src/core/sessionManager.js'
import { resetWarnOnce } from '../src/utils/warnOnce.js'
import type { TurnOutcome } from '../src/core/runtime/turnOutcome.js'
import type { OpenAIMessage } from '../src/core/types.js'

function makeOutcome(status: TurnOutcome['completion']['status'], overrides: Partial<TurnOutcome> = {}): TurnOutcome {
  return {
    runId: 'run-1',
    stopReason: 'stop_sequence',
    completion: {
      status,
      reasons: status === 'blocked' ? ['verification failed: npm test'] : [],
      evidence: [{ type: 'contract', detail: 'evidence detail' }],
      requiredNextActions: status === 'partial' ? ['finish the remaining module'] : [],
    },
    output: 'done',
    changedFiles: ['broken.ts'],
    artifacts: [],
    verification: { executed: true, passed: status === 'completed', failed: [] },
    modelAttempts: [
      { profileId: 'p', model: 'model-a', provider: 'openai', startedAt: 0, endedAt: 1, status: 'failed' },
      { profileId: 'p', model: 'model-b', provider: 'openai', startedAt: 2, endedAt: 3, status: 'succeeded' },
    ],
    durationMs: 1234,
    stopped: status === 'completed',
    reason: 'completed',
    ...overrides,
  }
}

const HISTORY: OpenAIMessage[] = [
  { role: 'user', content: 'fix the broken file' },
  {
    role: 'assistant',
    content: null,
    tool_calls: [
      { id: 'call_1', type: 'function', function: { name: 'Edit', arguments: '{"file_path":"/tmp/x/broken.ts"}' } },
    ],
  },
  { role: 'tool', tool_call_id: 'call_1', content: 'edited' },
]

function writeRawEnvelope(sessionDir: string, envelope: unknown): void {
  mkdirSync(sessionDir, { recursive: true })
  writeFileSync(join(sessionDir, 'history.json'), JSON.stringify(envelope), 'utf8')
}

describe('sessionEnvelopeV2', () => {
  let cwd: string
  let stderrSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), 'envelope-v2-'))
    resetWarnOnce()
    stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
  })
  afterEach(() => {
    stderrSpy.mockRestore()
    try { rmSync(cwd, { recursive: true, force: true }) } catch { /* best-effort */ }
  })

  it('persists a blocked verdict and /resume lists the real status', () => {
    const dir = createSessionDir(cwd, new Date('2026-01-02T03:04:05Z'))
    saveSession(dir, HISTORY, summarizeOutcome(makeOutcome('blocked')))

    const listed = listSessionsDetailed(cwd)
    expect(listed).toHaveLength(1)
    expect(listed[0].status).toBe('blocked')
    // changedFiles come from the OUTCOME, not a message scan.
    expect(listed[0].changedFiles).toEqual(['broken.ts'])
  })

  it('persists a partial verdict with its required next actions', () => {
    const dir = createSessionDir(cwd, new Date('2026-01-02T03:04:06Z'))
    const summary = summarizeOutcome(makeOutcome('partial'))
    saveSession(dir, HISTORY, summary)

    const envelope = loadSessionEnvelope(dir)
    expect(envelope?.lastOutcome?.status).toBe('partial')
    expect(envelope?.lastOutcome?.requiredNextActions).toEqual(['finish the remaining module'])
    expect(envelope?.lastOutcome?.lastModel).toBe('model-b') // succeeded attempt wins
    expect(envelope?.lastOutcome?.durationMs).toBe(1234)

    const listed = listSessionsDetailed(cwd)
    expect(listed[0].status).toBe('partial')
  })

  it('two-arg saveSession writes no lastOutcome key (byte-shape compat)', () => {
    const dir = createSessionDir(cwd, new Date('2026-01-02T03:04:07Z'))
    saveSession(dir, HISTORY)

    const raw = JSON.parse(readFileSync(join(dir, 'history.json'), 'utf8')) as Record<string, unknown>
    expect('lastOutcome' in raw).toBe(false)
    expect(raw.version).toBe(CURRENT_SESSION_VERSION)
    expect(raw.schema).toBe(CURRENT_SESSION_SCHEMA)
    // And the file still loads.
    expect(loadSession(dir)).toHaveLength(HISTORY.length)
    expect(listSessionsDetailed(cwd)[0].status).toBe('unknown')
  })

  it('v1 legacy envelope migrates verbatim and lists as unknown — never guessed', () => {
    const updatedAt = '2025-12-31T23:59:59.000Z'
    const dir = join(cwd, 'sessions', 'session_2025-12-31_235959')
    writeRawEnvelope(dir, {
      version: 1,
      schema: V1_SESSION_SCHEMA,
      updatedAt,
      messages: HISTORY,
    })

    const envelope = loadSessionEnvelope(dir)
    expect(envelope?.version).toBe(CURRENT_SESSION_VERSION)
    expect(envelope?.schema).toBe(CURRENT_SESSION_SCHEMA)
    expect(envelope?.updatedAt).toBe(updatedAt) // upgrade ≠ user edit
    expect(envelope?.lastOutcome).toBeUndefined()
    expect(envelope?.messages).toEqual(HISTORY) // verbatim, tool_call_id intact

    const listed = listSessionsDetailed(cwd)
    expect(listed[0].status).toBe('unknown') // the guess is gone
    // The file scan still NAMES touched files (v1 fallback) — but it can
    // never set status.
    expect(listed[0].changedFiles).toEqual(['broken.ts'])
  })

  it('corrupt history.json lists as corrupt and warns exactly once', () => {
    const dir = join(cwd, 'sessions', 'session_2026-01-01_000000')
    writeRawEnvelope(dir, '{this is not json')

    const first = listSessionsDetailed(cwd)
    expect(first[0].status).toBe('corrupt')
    const second = listSessionsDetailed(cwd)
    expect(second[0].status).toBe('corrupt')
    // One warning per process per session, never a stderr flood.
    const warns = stderrSpy.mock.calls.filter((c: unknown[]) => String(c[0]).includes('corrupt'))
    expect(warns).toHaveLength(1)
  })

  it('foreign version (newer build) throws UnknownSessionVersionError and lists as unknown', () => {
    const dir = join(cwd, 'sessions', 'session_2026-01-01_000001')
    writeRawEnvelope(dir, {
      version: 99,
      schema: 'ovogo.session.v99',
      updatedAt: '2026-01-01T00:00:01.000Z',
      messages: HISTORY,
    })

    expect(() => loadSessionEnvelope(dir)).toThrow(UnknownSessionVersionError)
    const listed = listSessionsDetailed(cwd)
    expect(listed[0].status).toBe('unknown')
  })

  it('malformed lastOutcome on a v2 file is corruption, not truth', () => {
    const dir = join(cwd, 'sessions', 'session_2026-01-01_000002')
    writeRawEnvelope(dir, {
      version: 2,
      schema: CURRENT_SESSION_SCHEMA,
      updatedAt: '2026-01-01T00:00:02.000Z',
      messages: HISTORY,
      lastOutcome: { status: 'done', changedFiles: 'nope' },
    })

    expect(() => loadSessionEnvelope(dir)).toThrow(CorruptSessionError)
    expect(listSessionsDetailed(cwd)[0].status).toBe('corrupt')
  })

  it('saveSession rejects a malformed outcome BEFORE any disk write', () => {
    const dir = createSessionDir(cwd, new Date('2026-01-02T03:04:08Z'))
    saveSession(dir, HISTORY) // baseline write
    const before = readFileSync(join(dir, 'history.json'), 'utf8')

    expect(() =>
      saveSession(dir, HISTORY, { status: 'completed' } as never),
    ).toThrow(TypeError)
    // The prior good file is untouched.
    expect(readFileSync(join(dir, 'history.json'), 'utf8')).toBe(before)
  })

  it('summarizeOutcome prefers the model that ANSWERED after a fallback chain', () => {
    const summary = summarizeOutcome(makeOutcome('completed'))
    expect(summary.status).toBe('completed')
    expect(summary.lastModel).toBe('model-b') // last succeeded, not model-a
    expect(summary.verification).toEqual({ executed: true, passed: true })
    expect(summary.blockers).toEqual([])
  })

  it('summarizeOutcome omits lastModel/durationMs when the source lacks them', () => {
    const summary = summarizeOutcome(makeOutcome('completed', { modelAttempts: [], durationMs: undefined }))
    expect(summary.lastModel).toBeUndefined()
    expect(summary.durationMs).toBeUndefined()
    expect(summary.verification).toEqual({ executed: true, passed: true })
  })
})
