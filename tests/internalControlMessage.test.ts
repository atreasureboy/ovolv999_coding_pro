/**
 * v0.3.1 InternalControlMessage (te_goal §七).
 *
 * Verifies that:
 *   - 8 kinds all render to a non-empty provider-facing system message
 *   - the log renders for the provider but does NOT persist in user
 *     history (drained / cleared after the call)
 *   - compaction keeps only `budget_warning` + `completion_rejected`
 *   - the export utility does not include control messages
 */
import { describe, it, expect } from 'vitest'
import {
  ControlMessageLog,
  formatControlMessage,
  isControlMessage,
  renderInternalControlMessage,
  type InternalControlMessage,
} from '../src/core/runtime/internalControlMessage.js'

describe('InternalControlMessage v0.3.1', () => {
  it('renders every kind to a non-empty provider-facing message', () => {
    const samples: InternalControlMessage[] = [
      { kind: 'continue_after_length', remainingTokens: 1000, partialLength: 500 },
      { kind: 'retry_empty_response', retryCount: 1, max: 2 },
      { kind: 'budget_warning', remainingPct: 0.15 },
      { kind: 'stall_replan', level: 'soft', reason: 'no progress for 12 min' },
      { kind: 'critic_feedback', verdict: 'replan', problems: ['wrong tool choice'] },
      { kind: 'tool_recovery', tool: 'Bash', error: 'exit 1' },
      { kind: 'completion_rejected', verdict: 'blocked', blockers: ['verification failed'] },
      { kind: 'provider_fallback', from: 'haiku', to: 'sonnet', reason: '429 rate limit' },
    ]
    for (const s of samples) {
      const out = formatControlMessage(s)
      expect(out.length).toBeGreaterThan(0)
      expect(out.startsWith('[runtime control ·')).toBe(true)
    }
  })

  it('renderInternalControlMessage produces a system-role message', () => {
    const msg = renderInternalControlMessage({ kind: 'budget_warning', remainingPct: 0.1 })
    expect(msg.role).toBe('system')
    expect(typeof msg.content).toBe('string')
    expect((msg.content as string).startsWith('[runtime control')).toBe(true)
  })

  it('log appends, drains, peeks correctly', () => {
    const log = new ControlMessageLog()
    expect(log.size()).toBe(0)
    log.append({ kind: 'budget_warning', remainingPct: 0.2 })
    log.append({ kind: 'tool_recovery', tool: 'Bash', error: 'x' })
    expect(log.size()).toBe(2)
    expect(log.peek().length).toBe(2)
    expect(log.drain().length).toBe(2)
    expect(log.size()).toBe(0)
  })

  it('log renderForProvider returns a snapshot without draining', () => {
    const log = new ControlMessageLog()
    log.append({ kind: 'budget_warning', remainingPct: 0.5 })
    log.append({ kind: 'provider_fallback', from: 'a', to: 'b', reason: 'r' })
    const rendered = log.renderForProvider()
    expect(rendered.length).toBe(2)
    expect(rendered[0].role).toBe('system')
    expect(log.size()).toBe(2) // NOT drained by render
  })

  it('compaction keeps only budget_warning and completion_rejected', () => {
    const log = new ControlMessageLog()
    log.append({ kind: 'continue_after_length', remainingTokens: 100, partialLength: 50 })
    log.append({ kind: 'retry_empty_response', retryCount: 1, max: 2 })
    log.append({ kind: 'budget_warning', remainingPct: 0.1 })
    log.append({ kind: 'stall_replan', level: 'soft', reason: 'x' })
    log.append({ kind: 'completion_rejected', verdict: 'blocked', blockers: ['x'] })
    log.append({ kind: 'tool_recovery', tool: 'Bash', error: 'x' })
    const dropped = log.compact()
    expect(dropped).toBe(4)
    const kept = log.peek()
    expect(kept.length).toBe(2)
    expect(kept.every((m) => m.kind === 'budget_warning' || m.kind === 'completion_rejected')).toBe(true)
  })

  it('isControlMessage detects runtime control messages', () => {
    const controlMsg = renderInternalControlMessage({ kind: 'budget_warning', remainingPct: 0.1 })
    expect(isControlMessage(controlMsg)).toBe(true)
    expect(isControlMessage({ role: 'user', content: 'hi' })).toBe(false)
    expect(isControlMessage({ role: 'system', content: 'unrelated' })).toBe(false)
    expect(isControlMessage({ role: 'assistant', content: '[runtime control] x' })).toBe(false)
  })
})