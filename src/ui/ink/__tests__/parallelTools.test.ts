/**
 * Tests for parallel tool call UI matching (Requirement 3: out-of-order parallel completion).
 */

import { describe, it, expect, beforeEach } from 'vitest'
import { UIStore } from '../store.js'
import { InkRenderer } from '../inkRenderer.js'

describe('Parallel Tool Out-Of-Order Matching', () => {
  let store: UIStore
  let renderer: InkRenderer

  beforeEach(() => {
    store = new UIStore()
    renderer = new InkRenderer(store)
  })

  it('matches out-of-order parallel tool completions using callId', () => {
    // Start tool 1 and tool 2 in parallel
    renderer.toolStart('Bash', { command: 'sleep 5' }, 'call_1')
    renderer.toolStart('Read', { file_path: 'a.txt' }, 'call_2')

    const state1 = store.getState()
    expect(state1.messages).toHaveLength(2)
    expect(state1.messages[0]).toMatchObject({ name: 'Bash', callId: 'call_1' })
    expect(state1.messages[1]).toMatchObject({ name: 'Read', callId: 'call_2' })
    const m1 = state1.messages[0]
    const m2 = state1.messages[1]
    if (m1.type === 'tool') expect(m1.result).toBeUndefined()
    if (m2.type === 'tool') expect(m2.result).toBeUndefined()

    // Finish tool 2 BEFORE tool 1 (out of order)
    renderer.toolResult('Read', 'content of a.txt', false, 'call_2')

    const state2 = store.getState()
    const m2_0 = state2.messages[0]
    const m2_1 = state2.messages[1]
    if (m2_0.type === 'tool') expect(m2_0.result).toBeUndefined()
    if (m2_1.type === 'tool') expect(m2_1.result).toBe('content of a.txt')

    // Now finish tool 1
    renderer.toolResult('Bash', 'done sleep', false, 'call_1')

    const state3 = store.getState()
    const m3_0 = state3.messages[0]
    const m3_1 = state3.messages[1]
    if (m3_0.type === 'tool') expect(m3_0.result).toBe('done sleep')
    if (m3_1.type === 'tool') expect(m3_1.result).toBe('content of a.txt')
  })
})
