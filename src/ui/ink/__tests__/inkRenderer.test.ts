/**
 * InkRenderer tests — verifies the bridge from engine callbacks to UIStore.
 */

import { describe, it, expect, beforeEach } from 'vitest'
import { UIStore } from '../store.js'
import { InkRenderer } from '../inkRenderer.js'

describe('InkRenderer', () => {
  let store: UIStore
  let renderer: InkRenderer

  beforeEach(() => {
    store = new UIStore()
    renderer = new InkRenderer(store)
  })

  it('banner sets store banner', () => {
    renderer.banner('2.0.0', 'gpt-4o')
    expect(store.getState().banner).toEqual({ version: '2.0.0', model: 'gpt-4o' })
  })

  it('streamToken accumulates and flushes', () => {
    renderer.streamToken('Hello')
    renderer.streamToken(' world')
    expect(store.getState().streamingText).toBe('Hello world')
    expect(store.getState().messages).toHaveLength(0)

    renderer.endAssistantText()
    expect(store.getState().streamingText).toBe('')
    expect(store.getState().messages).toHaveLength(1)
    expect(store.getState().messages[0]).toMatchObject({
      type: 'assistant',
      text: 'Hello world',
    })
  })

  it('keeps the fixed progress row while buffering tokens', () => {
    renderer.startSpinner('Working')
    expect(store.getState().spinnerActive).toBe(true)

    renderer.streamToken('text')
    expect(store.getState().spinnerActive).toBe(true)
  })

  it('toolStart + toolResult creates tool message', () => {
    renderer.toolStart('Bash', { command: 'echo hi' })
    expect(store.getState().messages).toHaveLength(1)
    expect(store.getState().messages[0]).toMatchObject({
      type: 'tool',
      name: 'Bash',
      input: { command: 'echo hi' },
    })

    renderer.toolResult('Bash', 'hi', false)
    expect(store.getState().messages[0]).toMatchObject({
      result: 'hi',
      isError: false,
    })
  })

  it('sequential tool calls track results independently', () => {
    // Sequential: start A → result A → start B → result B
    renderer.toolStart('Read', { file_path: '/a' })
    renderer.toolResult('Read', 'content A', false)
    expect(store.getState().messages[0]).toMatchObject({ result: 'content A' })

    renderer.toolStart('Read', { file_path: '/b' })
    renderer.toolResult('Read', 'content B', false)
    expect(store.getState().messages[1]).toMatchObject({ result: 'content B' })
  })

  it('error tool result sets isError', () => {
    renderer.toolStart('Bash', { command: 'false' })
    renderer.toolResult('Bash', 'command failed', true)
    expect(store.getState().messages[0]).toMatchObject({ isError: true })
  })

  it('agentStart + agentDone tracks lifecycle', () => {
    renderer.agentStart('fix bug', 'general-purpose')
    expect(store.getState().messages[0]).toMatchObject({ status: 'running' })

    renderer.agentDone('fix bug', true)
    expect(store.getState().messages[0]).toMatchObject({ status: 'done' })
  })

  it('status methods push messages', () => {
    renderer.info('info')
    renderer.success('success')
    renderer.warn('warn')
    renderer.error('error')
    const types = store.getState().messages.map((m) => m.type)
    expect(types).toEqual(['info', 'success', 'warn', 'error'])
  })

  it('spinner control', () => {
    renderer.startSpinner('Thinking')
    expect(store.getState().spinnerActive).toBe(true)
    expect(store.getState().spinnerVerb).toBe('Thinking')

    renderer.stopSpinner()
    expect(store.getState().spinnerActive).toBe(false)
  })

  it('compact tracking', () => {
    renderer.compactStart(50000)
    renderer.compactDone(50000, 8000)
    const msgs = store.getState().messages
    expect(msgs).toHaveLength(2)
    expect(msgs[0]).toMatchObject({ type: 'compact', phase: 'start' })
    expect(msgs[1]).toMatchObject({ type: 'compact', phase: 'done' })
  })

  it('context warning', () => {
    renderer.contextWarning(80000, 128000, 0.625)
    expect(store.getState().messages[0]).toMatchObject({
      type: 'context-warning',
      tokens: 80000,
      max: 128000,
      pct: 0.625,
    })
  })

  it('plan mode', () => {
    renderer.planModeStart()
    expect(store.getState().planMode).toBe(true)
  })

  it('interrupt overlay', () => {
    renderer.writeInterruptPrompt()
    expect(store.getState().interrupt).toEqual({ active: true })

    renderer.interruptInjected('fix the loop')
    expect(store.getState().interrupt).toEqual({ active: true, feedback: 'fix the loop' })
  })

  it('humanPrompt is a no-op (App handles user messages)', () => {
    renderer.humanPrompt('test')
    expect(store.getState().messages).toHaveLength(0)
  })

  it('destroy stops spinner', () => {
    renderer.startSpinner()
    renderer.destroy()
    expect(store.getState().spinnerActive).toBe(false)
  })
})
