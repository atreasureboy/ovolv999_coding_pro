import { describe, it, expect } from 'vitest'
import { RunEventEmitter, type RunEvent } from '../src/core/runtime/events.js'

describe('RunEventEmitter', () => {
  it('delivers events to subscribers of the matching type', () => {
    const emitter = new RunEventEmitter()
    const received: RunEvent[] = []
    emitter.on('RUN_STARTED', (e) => received.push(e))
    emitter.on('RUN_COMPLETED', (e) => received.push(e))

    emitter.emit({ type: 'RUN_STARTED', userMessage: 'hello' })
    emitter.emit({ type: 'MODEL_REQUESTED', model: 'gpt-4' })
    emitter.emit({ type: 'RUN_COMPLETED', result: { stopped: true, reason: 'stop_sequence', output: 'done' } })

    expect(received).toHaveLength(2)
    expect(received[0].type).toBe('RUN_STARTED')
    expect(received[1].type).toBe('RUN_COMPLETED')
  })

  it('unsubscribe stops delivering events', () => {
    const emitter = new RunEventEmitter()
    const received: string[] = []
    const unsub = emitter.on('TOOL_STARTED', (e) => received.push(e.toolName))

    emitter.emit({ type: 'TOOL_STARTED', callId: '1', toolName: 'Bash', input: {} })
    unsub()
    emitter.emit({ type: 'TOOL_STARTED', callId: '2', toolName: 'Read', input: {} })

    expect(received).toEqual(['Bash'])
  })

  it('subscriber failures do not break the emitter or other subscribers', () => {
    const emitter = new RunEventEmitter()
    const results: string[] = []

    emitter.on('TOOL_COMPLETED', () => { throw new Error('boom') })
    emitter.on('TOOL_COMPLETED', (e) => results.push(e.toolName))

    expect(() =>
      emitter.emit({
        type: 'TOOL_COMPLETED',
        callId: '1',
        toolName: 'Bash',
        result: { content: 'ok', isError: false },
      }),
    ).not.toThrow()
    expect(results).toEqual(['Bash'])
  })

  it('clear removes all subscribers', () => {
    const emitter = new RunEventEmitter()
    const received: string[] = []
    emitter.on('RUN_STARTED', () => received.push('a'))
    emitter.on('RUN_STARTED', () => received.push('b'))

    emitter.clear()
    emitter.emit({ type: 'RUN_STARTED', userMessage: 'test' })

    expect(received).toEqual([])
  })

  it('emit with no subscribers is a no-op', () => {
    const emitter = new RunEventEmitter()
    expect(() =>
      emitter.emit({ type: 'BOOT_COMPLETED', moduleCount: 0, toolCount: 0 }),
    ).not.toThrow()
  })
})
