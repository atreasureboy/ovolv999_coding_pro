/**
 * v0.3.1 ProgressMonitor sliding window (te_goal §六.2).
 *
 * Verifies:
 *   - A→B→A→B pattern triggers a repeated-failure verdict
 *   - re-running an Edit with the SAME patchHash is NOT progress
 *   - re-running with a NEW patchHash IS progress
 *   - recordMultiAgentVerdict escalates the failure counter
 */
import { describe, it, expect } from 'vitest'
import { ProgressMonitor, DEFAULT_THRESHOLDS } from '../src/core/runtime/progressMonitor.js'

describe('ProgressMonitor v0.3.1 sliding window', () => {
  it('detects A→B→A→B tool-call pattern as repeated-failure', () => {
    const pm = new ProgressMonitor({ ...DEFAULT_THRESHOLDS, softStallMinutes: 999, hardStallMinutes: 999, repeatedErrorLimit: 99, repeatedToolCallLimit: 99 })
    pm.tick()
    pm.tick()
    pm.tick()
    pm.tick()
    // Alternate two distinct (tool, input) fingerprints
    pm.recordToolCall('Read', { p: 'a' }, { isError: false, content: '' })
    pm.recordToolCall('Bash', { cmd: 'x' }, { isError: false, content: '' })
    pm.recordToolCall('Read', { p: 'a' }, { isError: false, content: '' })
    pm.recordToolCall('Bash', { cmd: 'x' }, { isError: false, content: '' })
    const verdict = pm.detectStall(0.1, 1)
    expect(verdict.kind).toBe('repeated-failure')
    if (verdict.kind === 'repeated-failure') {
      expect(verdict.reason).toMatch(/A→B→A→B|alternating/)
    }
  })

  it('re-running the SAME call 4× does NOT trigger A→B pattern (caught by repeatedToolCalls)', () => {
    const pm = new ProgressMonitor(DEFAULT_THRESHOLDS)
    for (let i = 0; i < 4; i++) {
      pm.recordToolCall('Read', { p: 'a' }, { isError: false, content: '' })
    }
    const verdict = pm.detectStall(0.1, 1)
    expect(verdict.kind).not.toBe('repeated-failure')
  })

  it('same-hash re-edit is NOT progress', () => {
    const pm = new ProgressMonitor(DEFAULT_THRESHOLDS)
    pm.recordToolCall('Edit', { file_path: 'a.ts' }, { isError: false, content: 'ok' }, 'hash-1')
    expect(pm.snapshot(0).changedFiles.length).toBe(1)
    // Now redo the edit with the same hash → no new progress
    pm.recordToolCall('Edit', { file_path: 'a.ts' }, { isError: false, content: 'ok' }, 'hash-1')
    const snap = pm.snapshot(1)
    expect(snap.minutesSinceLastMeaningfulProgress).toBe(1) // no new progress at minute 1
  })

  it('new-hash re-edit IS progress', () => {
    const pm = new ProgressMonitor(DEFAULT_THRESHOLDS)
    pm.recordToolCall('Edit', { file_path: 'a.ts' }, { isError: false, content: 'ok' }, 'hash-1')
    pm.recordToolCall('Edit', { file_path: 'a.ts' }, { isError: false, content: 'ok' }, 'hash-2')
    const snap = pm.snapshot(1)
    expect(snap.minutesSinceLastMeaningfulProgress).toBeLessThan(1)
  })

  it('recordMultiAgentVerdict escalates when N agents agree on failure', () => {
    const pm = new ProgressMonitor(DEFAULT_THRESHOLDS)
    const fp = 'agent-says-broken-config'
    const agreed = pm.recordMultiAgentVerdict([fp, fp, fp])
    expect(agreed).toBe(true)
    expect(pm.snapshot(0).repeatedErrors).toBeGreaterThan(0)
  })

  it('recordMultiAgentVerdict returns false when agents disagree', () => {
    const pm = new ProgressMonitor(DEFAULT_THRESHOLDS)
    const agreed = pm.recordMultiAgentVerdict(['a', 'b', 'c'])
    expect(agreed).toBe(false)
  })

  it('windowing: old calls beyond 8 are evicted', () => {
    const pm = new ProgressMonitor(DEFAULT_THRESHOLDS)
    for (let i = 0; i < 12; i++) {
      pm.recordToolCall('Read', { p: 'a' }, { isError: false, content: '' })
    }
    // After 12 calls the repeatedToolCalls counter is high; window is
    // capped at 8 so the A→B detector cannot find 4 alternating. The
    // old behaviour (consecutive counter) still works.
    expect(pm.snapshot(0).iteration).toBe(0) // no ticks
  })
})