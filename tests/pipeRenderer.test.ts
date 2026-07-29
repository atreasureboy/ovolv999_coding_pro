/**
 * v0.4.1 WS3 — PipeRenderer output contract.
 *
 * The --pipe promise: stdout carries the ANSWER and nothing else. Every
 * diagnostic (banner, info, warnings, errors, tool progress, spinners,
 * cost) must stay off stdout — errors/warnings go to stderr, chrome is
 * suppressed entirely. In json mode even the answer is buffered (emitted
 * as one envelope by the caller), so stdout stays empty until flush.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { PipeRenderer, pipeExitCodeFor, isApiClassError, outcomeIsApiClassFailure } from '../src/ui/pipeRenderer.js'
import type { ModelCallAttempt } from '../src/core/runtime/turnOutcome.js'

describe('PipeRenderer — stdout is answer-only', () => {
  let outSpy: ReturnType<typeof vi.spyOn>
  let errSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    outSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    errSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
  })
  afterEach(() => {
    outSpy.mockRestore()
    errSpy.mockRestore()
  })

  const stdoutText = (): string => outSpy.mock.calls.map((c: unknown[]) => String(c[0])).join('')
  const stderrText = (): string => errSpy.mock.calls.map((c: unknown[]) => String(c[0])).join('')

  it('text mode streams raw tokens to stdout with no decoration', () => {
    const r = new PipeRenderer({ format: 'text' })
    r.streamToken('hello ')
    r.streamToken('world')
    expect(stdoutText()).toBe('hello world')
    expect(stdoutText()).not.toContain('●')
    expect(r.responseText).toBe('hello world')
  })

  it('json mode buffers tokens — stdout stays empty', () => {
    const r = new PipeRenderer({ format: 'json' })
    r.streamToken('buffered')
    expect(stdoutText()).toBe('')
    expect(r.responseText).toBe('buffered')
  })

  it('banner / spinner / prompt chrome never reach stdout or stderr', () => {
    const r = new PipeRenderer({ format: 'text' })
    r.banner('9.9.9', 'some-model')
    r.startSpinner('thinking')
    r.stopSpinner()
    r.humanPrompt('the task')
    expect(stdoutText()).toBe('')
    expect(stderrText()).not.toContain('DEVELOPER AGENT RUNTIME')
  })

  it('info/warn/success route to stderr, never stdout', () => {
    const r = new PipeRenderer({ format: 'text' })
    r.info('workspace /x')
    r.warn('careful')
    r.success('done')
    expect(stdoutText()).toBe('')
    expect(stderrText()).toContain('workspace /x')
    expect(stderrText()).toContain('careful')
    expect(stderrText()).toContain('done')
  })

  it('errors go to stderr, never stdout', () => {
    const r = new PipeRenderer({ format: 'text' })
    r.error('boom')
    expect(stdoutText()).toBe('')
    expect(stderrText()).toContain('boom')
  })

  it('tool progress stays off stdout', () => {
    const r = new PipeRenderer({ format: 'text' })
    r.toolStart('Bash', { command: 'ls' }, 'call-1')
    r.toolResult('Bash', 'file.txt', false, 'call-1')
    expect(stdoutText()).toBe('')
  })
})

describe('pipeExitCodeFor — the --pipe exit ladder', () => {
  it('completed → 0', () => {
    expect(pipeExitCodeFor('completed')).toBe(0)
  })

  it('every non-completed terminal status → 1', () => {
    for (const s of ['partial', 'blocked', 'failed', 'cancelled', 'exhausted'] as const) {
      expect(pipeExitCodeFor(s)).toBe(1)
    }
  })
})

describe('isApiClassError — exit-2 classifier', () => {
  it('OpenAI SDK errors with a numeric status are API-class', () => {
    const err = Object.assign(new Error('Incorrect API key'), { status: 401 })
    expect(isApiClassError(err)).toBe(true)
  })

  it('network errors are API-class', () => {
    expect(isApiClassError(Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:1'), { code: 'ECONNREFUSED' }))).toBe(true)
    expect(isApiClassError(new Error('request timed out'))).toBe(true)
  })

  it('plain logic errors are NOT API-class', () => {
    expect(isApiClassError(new Error('No prompt or stdin input provided'))).toBe(false)
  })
})

describe('outcomeIsApiClassFailure — absorbed API failures still exit 2', () => {
  const attempt = (over: Partial<ModelCallAttempt> = {}): ModelCallAttempt => ({
    profileId: 'p',
    model: 'm',
    provider: 'openai',
    startedAt: 0,
    endedAt: 1,
    status: 'failed',
    ...over,
  })
  const outcome = (status: 'completed' | 'failed' | 'blocked', attempts: ModelCallAttempt[]) => ({
    completion: { status, reasons: [], evidence: [], requiredNextActions: [] },
    modelAttempts: attempts,
  })

  it('failed turn whose only attempt died with a 401 error string → true', () => {
    const o = outcome('failed', [attempt({ error: '401 Incorrect API key provided: test-key.' })])
    expect(outcomeIsApiClassFailure(o)).toBe(true)
  })

  it('failed turn whose only attempt was rate_limited (no error string) → true', () => {
    const o = outcome('failed', [attempt({ status: 'rate_limited' })])
    expect(outcomeIsApiClassFailure(o)).toBe(true)
  })

  it('task-level failure after a SUCCESSFUL model call → false (exit 1)', () => {
    const o = outcome('failed', [
      attempt({ status: 'succeeded' }),
      attempt({ error: '401 Incorrect API key' }),
    ])
    expect(outcomeIsApiClassFailure(o)).toBe(false)
  })

  it('failed turn with NO model attempts → false (nothing to blame)', () => {
    expect(outcomeIsApiClassFailure(outcome('failed', []))).toBe(false)
  })

  it('completed turn is never an API-class failure', () => {
    const o = outcome('completed', [attempt({ error: '401 Incorrect API key' })])
    expect(outcomeIsApiClassFailure(o)).toBe(false)
  })

  it('failed attempt caused by an abort/logic error → false', () => {
    const o = outcome('failed', [attempt({ error: 'aborted by user' })])
    expect(outcomeIsApiClassFailure(o)).toBe(false)
  })
})
