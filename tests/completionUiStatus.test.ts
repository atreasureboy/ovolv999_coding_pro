import { describe, expect, it } from 'vitest'
import { completionAwareReason } from '../src/ui/ink/runInkRepl.js'

describe('completion UI status', () => {
  it('does not display partial, blocked, or incomplete runs as done', () => {
    expect(completionAwareReason('stop_sequence', 'partial')).toBe('completion_partial')
    expect(completionAwareReason('stop_sequence', 'blocked')).toBe('completion_blocked')
    expect(completionAwareReason('stop_sequence', 'incomplete')).toBe('completion_incomplete')
  })

  it('preserves successful and non-completion stop reasons', () => {
    expect(completionAwareReason('stop_sequence', 'completed')).toBe('stop_sequence')
    expect(completionAwareReason('interrupted', 'partial')).toBe('interrupted')
  })
})
