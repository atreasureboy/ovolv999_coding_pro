import { describe, it, expect } from 'vitest'
import { ProgressMonitor, DEFAULT_THRESHOLDS, interventionMessageForStall, type StallVerdict } from '../src/core/runtime/progressMonitor.js'
import { evaluateCompletion } from '../src/core/runtime/completionContract.js'

const ok = { isError: false, content: 'done' }
const err = (msg: string) => ({ isError: true, content: msg })

describe('ProgressMonitor + StallDetector (Phase 4)', () => {
  it('a real file edit is meaningful progress (resets stall timer)', () => {
    const m = new ProgressMonitor({ ...DEFAULT_THRESHOLDS, softStallMinutes: 5 })
    m.tick()
    // 10 min elapsed with no progress → soft stall
    expect(m.detectStall(10).kind).toBe('soft-stall')
    // an Edit to a NEW file is meaningful progress
    m.recordToolCall('Edit', { file_path: '/a/src/x.ts' }, ok)
    expect(m.detectStall(10).kind).toBe('progressing') // timer reset to 10
    expect(m.detectStall(16).kind).toBe('soft-stall') // 6 min since progress
  })

  it('re-reading the same file is NOT meaningful progress', () => {
    const m = new ProgressMonitor({ ...DEFAULT_THRESHOLDS, softStallMinutes: 5, repeatedToolCallLimit: 5 })
    m.tick()
    for (let i = 0; i < 4; i++) m.recordToolCall('Read', { file_path: '/a.ts' }, ok)
    // many identical Reads do not reset the stall timer
    expect(m.snapshot(20).minutesSinceLastMeaningfulProgress).toBeGreaterThan(5)
  })

  it('detects repeated identical tool calls as soft stall', () => {
    const m = new ProgressMonitor({ ...DEFAULT_THRESHOLDS, repeatedToolCallLimit: 3 })
    m.tick()
    m.recordToolCall('Bash', { command: 'npm test' }, err('fail 1'))
    m.recordToolCall('Bash', { command: 'npm test' }, err('fail 1')) // same input
    m.recordToolCall('Bash', { command: 'npm test' }, err('fail 1')) // same input
    const v = m.detectStall(1)
    expect(v.kind === 'soft-stall' || v.kind === 'repeated-failure').toBe(true)
  })

  it('escalates consecutive identical errors to root-cause subtask', () => {
    const m = new ProgressMonitor({ ...DEFAULT_THRESHOLDS, repeatedErrorLimit: 3 })
    m.tick()
    m.recordToolCall('Bash', { command: 'x' }, err('ENOENT: no such file'))
    m.recordToolCall('Bash', { command: 'y' }, err('ENOENT: no such file'))
    m.recordToolCall('Bash', { command: 'z' }, err('ENOENT: no such file'))
    const v = m.detectStall(1)
    expect(v.kind).toBe('repeated-failure')
    if (v.kind === 'repeated-failure') expect(v.action).toBe('root-cause-subtask')
  })

  it('flags budget pressure → narrow-scope', () => {
    const m = new ProgressMonitor({ ...DEFAULT_THRESHOLDS, budgetPressureFraction: 0.25 })
    m.tick()
    const v = m.detectStall(1, 0.1) // 10% budget remaining
    expect(v.kind).toBe('budget-pressure')
  })

  it('hard stall escalates to critic after the longer threshold', () => {
    const m = new ProgressMonitor({ ...DEFAULT_THRESHOLDS, softStallMinutes: 5, hardStallMinutes: 12 })
    m.tick()
    expect(m.detectStall(6).kind).toBe('soft-stall')
    expect(m.detectStall(13).kind).toBe('hard-stall')
  })

  it('a drop in failing tests is meaningful progress', () => {
    const m = new ProgressMonitor(DEFAULT_THRESHOLDS)
    m.tick()
    m.recordVerification(10)
    const before = m.snapshot(20).minutesSinceLastMeaningfulProgress
    m.recordVerification(4) // 6 fewer failures
    const after = m.snapshot(20).minutesSinceLastMeaningfulProgress
    expect(after).toBeLessThanOrEqual(before)
    expect(m.snapshot(20).verificationDelta).toBe(-6)
  })
})

describe('interventionMessageForStall (Phase 4 active intervention)', () => {
  it('returns null for progressing (no intervention)', () => {
    expect(interventionMessageForStall({ kind: 'progressing' })).toBeNull()
  })

  it('returns null for blocked (terminal transition handles it)', () => {
    expect(interventionMessageForStall({ kind: 'blocked', reason: 'x', action: 'report-blocked' })).toBeNull()
  })

  it('returns a role:system nudge (NOT user) for soft/hard/repeated/budget', () => {
    const cases: Array<Extract<StallVerdict, { reason: string }>> = [
      { kind: 'soft-stall', reason: 'no progress 10min', action: 'summarize-and-replan' },
      { kind: 'hard-stall', reason: 'no progress 25min', action: 'escalate-critic' },
      { kind: 'repeated-failure', reason: '3 identical errors', action: 'root-cause-subtask' },
      { kind: 'budget-pressure', reason: 'budget 10%', action: 'narrow-scope' },
    ]
    for (const v of cases) {
      const msg = interventionMessageForStall(v)
      expect(msg).not.toBeNull()
      expect(msg!.role).toBe('system') // NOT 'user' — must not forge user input
      expect(msg!.content.length).toBeGreaterThan(0)
      expect(msg!.content).toContain(v.reason)
    }
  })

  it('hard-stall nudge instructs to STOP and re-analyse', () => {
    const msg = interventionMessageForStall({ kind: 'hard-stall', reason: 'r', action: 'escalate-critic' })!
    expect(msg.content).toMatch(/STOP|first principles|blocker/i)
  })
})

describe('CompletionContract (Phase 4)', () => {
  const base = {
    taskKind: 'mutation' as const,
    modelStopped: true,
    acceptanceCriteria: [
      { id: 'a', description: 'tests pass', satisfied: true },
      { id: 'b', description: 'lint clean', satisfied: true },
    ],
    verification: { executed: false, passed: false, failed: [] as string[] },
    activeWorkers: [] as Array<{ id: string; status: 'pending' | 'running' | 'completed' | 'failed' | 'cancelled' }>,
    unresolvedBlockers: [] as string[],
    changedFiles: [] as string[],
    reviewerFindings: [] as string[],
    budgetState: { remaining: 1, exceeded: false },
  }

  it('blocks completion when a child worker is still running', () => {
    const v = evaluateCompletion({
      ...base,
      verification: { executed: true, passed: true, failed: [] },
      changedFiles: ['a.ts'],
      activeWorkers: [{ id: 'w1', status: 'running' }],
    })
    expect(v.status).toBe('blocked')
  })

  it('blocks completion when verification ran but failed', () => {
    const v = evaluateCompletion({
      ...base,
      verification: { executed: true, passed: false, failed: ['x'] },
      changedFiles: ['a.ts'],
    })
    expect(v.status).toBe('blocked')
  })

  it('completes only when all criteria met + verification passed', () => {
    const v = evaluateCompletion({
      ...base,
      verification: { executed: true, passed: true, failed: [] },
      changedFiles: ['a.ts'],
    })
    expect(v.status).toBe('completed')
  })

  it('reports partial when some criteria remain but real changes exist', () => {
    const v = evaluateCompletion({
      ...base,
      acceptanceCriteria: [
        { id: 'a', description: 'tests pass', satisfied: true },
        { id: 'b', description: 'lint clean', satisfied: false },
      ],
      verification: { executed: true, passed: true, failed: [] },
      changedFiles: ['a.ts'],
    })
    expect(v.status).toBe('partial')
  })

  it('reports incomplete when nothing changed and criteria remain', () => {
    const v = evaluateCompletion({
      ...base,
      acceptanceCriteria: [
        { id: 'a', description: 'tests pass', satisfied: false },
        { id: 'b', description: 'lint clean', satisfied: false },
      ],
      changedFiles: [],
    })
    expect(v.status).toBe('incomplete')
  })

  it('with no declared criteria requires a verifiable change', () => {
    const v = evaluateCompletion({ ...base, acceptanceCriteria: [], changedFiles: [] })
    expect(v.status).toBe('incomplete')
    const v2 = evaluateCompletion({ ...base, acceptanceCriteria: [], changedFiles: ['a.ts'] })
    expect(v2.status).toBe('completed')
  })
})
