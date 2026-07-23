/**
 * Phase 6b (five_goal §十三 P2-4/P2-5): RuntimeModelState shared object.
 *
 *   - SharedRuntimeState.modelState is the canonical model source.
 *   - updateModelState() bumps version + notifies subscribers.
 *   - engine.setModel() writes to sharedState + emits MODEL_CHANGED.
 *   - Subscribers receive updates without holding private copies.
 */

import { describe, it, expect } from 'vitest'
import { SharedRuntimeState, type RuntimeModelState } from '../src/core/runtime/sharedState.js'

describe('P2-4: RuntimeModelState shared object', () => {
  it('initializes with the provided model', () => {
    const s = new SharedRuntimeState(false, 'gpt-4o')
    expect(s.modelState.model).toBe('gpt-4o')
    expect(s.modelState.version).toBe(0)
  })

  it('updateModelState bumps version and notifies subscribers', () => {
    const s = new SharedRuntimeState(false, 'gpt-4o')
    const updates: RuntimeModelState[] = []
    const unsub = s.onModelStateChanged((state) => updates.push(state))

    s.updateModelState({ model: 'claude-sonnet' })
    expect(s.modelState.model).toBe('claude-sonnet')
    expect(s.modelState.version).toBe(1)
    expect(updates).toHaveLength(1)
    expect(updates[0].model).toBe('claude-sonnet')

    s.updateModelState({ model: 'claude-opus', contextWindow: 200000 })
    expect(s.modelState.version).toBe(2)
    expect(s.modelState.contextWindow).toBe(200000)
    expect(updates).toHaveLength(2)

    unsub()
    s.updateModelState({ model: 'gpt-4o' })
    expect(updates).toHaveLength(2) // no more notifications after unsub
  })

  it('multiple subscribers all receive updates', () => {
    const s = new SharedRuntimeState(false, 'm1')
    let calls1 = 0, calls2 = 0
    const unsub1 = s.onModelStateChanged(() => calls1++)
    const unsub2 = s.onModelStateChanged(() => calls2++)

    s.updateModelState({ model: 'm2' })
    expect(calls1).toBe(1)
    expect(calls2).toBe(1)

    unsub1()
    s.updateModelState({ model: 'm3' })
    expect(calls1).toBe(1) // unsubscribed
    expect(calls2).toBe(2)

    unsub2()
  })

  it('a throwing listener does not block other listeners', () => {
    const s = new SharedRuntimeState(false, 'm1')
    let received = false
    s.onModelStateChanged(() => { throw new Error('boom') })
    s.onModelStateChanged(() => { received = true })

    s.updateModelState({ model: 'm2' })
    expect(received).toBe(true)
  })

  it('capabilities can be stored alongside model', () => {
    const s = new SharedRuntimeState(false, 'gpt-4o')
    s.updateModelState({
      model: 'gpt-4o',
      capabilities: {
        streaming: true,
        toolCalls: true,
        vision: false,
        maxOutputTokens: 16384,
      } as never,
    })
    expect(s.modelState.capabilities).toBeDefined()
    expect(s.modelState.version).toBe(1)
  })
})
