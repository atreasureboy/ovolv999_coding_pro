/**
 * UIStore tests — verifies the state container that bridges engine → React.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'
import { UIStore } from '../store.js'

describe('UIStore', () => {
  let store: UIStore

  beforeEach(() => {
    store = new UIStore()
  })

  describe('message management', () => {
    it('starts empty', () => {
      expect(store.getState().messages).toEqual([])
    })

    it('adds user messages with incremental IDs', () => {
      store.addUserMessage('hello')
      store.addUserMessage('world')
      const msgs = store.getState().messages
      expect(msgs).toHaveLength(2)
      expect(msgs[0]).toMatchObject({ type: 'user', text: 'hello', id: 1 })
      expect(msgs[1]).toMatchObject({ type: 'user', text: 'world', id: 2 })
    })

    it('adds tool start and updates result', () => {
      const id = store.addToolStart('Bash', { command: 'ls' })
      expect(store.getState().messages).toHaveLength(1)
      const msg = store.getState().messages[0]
      expect(msg.type).toBe('tool')
      if (msg.type !== 'tool') return
      expect(msg.name).toBe('Bash')
      expect(msg.input).toEqual({ command: 'ls' })
      expect(msg.result).toBeUndefined()

      store.setToolResult(id, 'file1\nfile2', false)
      const updated = store.getState().messages[0]
      if (updated.type !== 'tool') return
      expect(updated.result).toBe('file1\nfile2')
      expect(updated.isError).toBe(false)
    })

    it('adds various status message types', () => {
      store.addInfo('info text')
      store.addSuccess('success text')
      store.addWarn('warn text')
      store.addError('error text')
      const msgs = store.getState().messages
      expect(msgs.map((m) => m.type)).toEqual(['info', 'success', 'warn', 'error'])
    })

    it('skips empty warn messages', () => {
      store.addWarn('')
      store.addWarn('   ')
      expect(store.getState().messages).toHaveLength(0)
    })

    it('clears all messages', () => {
      store.addUserMessage('a')
      store.addAssistantMessage('b')
      store.clearMessages()
      expect(store.getState().messages).toEqual([])
    })
  })

  describe('streaming text', () => {
    it('accumulates tokens', () => {
      store.appendStreamingToken('Hello')
      store.appendStreamingToken(' world')
      expect(store.getState().streamingText).toBe('Hello world')
    })

    it('flushes as assistant message and clears buffer', () => {
      store.appendStreamingToken('Hello')
      store.appendStreamingToken(' world')
      store.flushStreamingText()
      expect(store.getState().streamingText).toBe('')
      expect(store.getState().messages).toHaveLength(1)
      expect(store.getState().messages[0]).toMatchObject({
        type: 'assistant',
        text: 'Hello world',
      })
    })

    it('does not create empty message on flush without text', () => {
      store.flushStreamingText()
      expect(store.getState().messages).toHaveLength(0)
    })

    it('batches token repaint notifications', () => {
      vi.useFakeTimers()
      let renders = 0
      const unsubscribe = store.subscribe(() => { renders++ })
      for (let index = 0; index < 100; index++) store.appendStreamingToken('x')
      expect(renders).toBe(0)
      vi.advanceTimersByTime(40)
      expect(renders).toBe(1)
      unsubscribe()
      store.reset()
      vi.useRealTimers()
    })
  })

  describe('agent tracking', () => {
    it('tracks agent start → done', () => {
      const id = store.addAgentStart('fix bug', 'explore')
      expect(store.getState().messages[0]).toMatchObject({
        type: 'agent',
        desc: 'fix bug',
        agentType: 'explore',
        status: 'running',
      })

      store.setAgentDone(id, true, 'fixed in src/foo.ts')
      expect(store.getState().messages[0]).toMatchObject({
        status: 'done',
        summary: 'fixed in src/foo.ts',
      })
    })

    it('tracks agent start → failed', () => {
      const id = store.addAgentStart('explore code', 'general')
      store.setAgentDone(id, false)
      expect(store.getState().messages[0]).toMatchObject({ status: 'failed' })
    })
  })

  describe('state setters', () => {
    it('sets running state', () => {
      store.setRunning(true)
      expect(store.getState().running).toBe(true)
      store.setRunning(false)
      expect(store.getState().running).toBe(false)
    })

    it('keeps completed history static while a turn is updating', () => {
      store.addUserMessage('before')
      expect(store.getState().committedThroughId).toBe(1)

      store.setRunning(true)
      const toolId = store.addToolStart('Read', { file_path: 'a.ts' })
      store.setSpinner(true, 'Thinking')
      store.setSpinner(true, 'Thinking')

      expect(store.getState().committedThroughId).toBe(1)
      const pendingTool = store.getState().messages.find((message) => message.id === toolId)
      expect(pendingTool).toMatchObject({ type: 'tool' })
      expect(pendingTool).not.toHaveProperty('result')

      store.setToolResult(toolId, 'content', false)
      store.setRunning(false)
      expect(store.getState().committedThroughId).toBe(toolId)
    })

    it('freezes completed turn output without waiting for the turn to end', () => {
      store.setRunning(true)
      store.addAssistantMessage('first response')
      expect(store.getState().committedThroughId).toBe(1)

      const toolId = store.addToolStart('Read', { file_path: 'a.ts' })
      store.addInfo('queued behind tool')
      expect(store.getState().committedThroughId).toBe(1)

      store.setToolResult(toolId, 'content', false)
      expect(store.getState().committedThroughId).toBe(3)
    })

    it('sets spinner state', () => {
      store.setSpinner(true, 'Thinking')
      expect(store.getState().spinnerActive).toBe(true)
      expect(store.getState().spinnerVerb).toBe('Thinking')
    })

    it('buffers reasoning without repainting the terminal', () => {
      let renders = 0
      const unsubscribe = store.subscribe(() => { renders++ })
      store.appendStreamingReasoning('private ')
      store.appendStreamingReasoning('reasoning')
      expect(store.getState().streamingReasoning).toBe('private reasoning')
      expect(renders).toBe(0)
      unsubscribe()
    })

    it('sets banner', () => {
      store.setBanner('1.0.0', 'gpt-4')
      expect(store.getState().banner).toEqual({ version: '1.0.0', model: 'gpt-4' })
    })

    it('sets interrupt overlay', () => {
      store.setInterrupt(true, 'fix the bug')
      expect(store.getState().interrupt).toEqual({ active: true, feedback: 'fix the bug' })
      store.setInterrupt(false)
      expect(store.getState().interrupt).toBeNull()
    })

    it('sets plan mode', () => {
      store.setPlanMode(true)
      expect(store.getState().planMode).toBe(true)
    })
  })

  describe('compact tracking', () => {
    it('tracks compact start and done', () => {
      store.addCompactStart(50000)
      store.addCompactDone(50000, 8000)
      const msgs = store.getState().messages
      expect(msgs).toHaveLength(2)
      expect(msgs[0]).toMatchObject({ type: 'compact', phase: 'start', origTokens: 50000 })
      expect(msgs[1]).toMatchObject({ type: 'compact', phase: 'done', sumTokens: 8000 })
    })
  })

  describe('subscribe / emit', () => {
    it('notifies listeners on state change', () => {
      let callCount = 0
      store.subscribe(() => { callCount++ })
      store.addUserMessage('test')
      expect(callCount).toBe(1)
      store.setRunning(true)
      expect(callCount).toBe(2)
    })

    it('unsubscribe stops notifications', () => {
      let callCount = 0
      const unsub = store.subscribe(() => { callCount++ })
      store.addUserMessage('a')
      expect(callCount).toBe(1)
      unsub()
      store.addUserMessage('b')
      expect(callCount).toBe(1)
    })
  })

  describe('reset', () => {
    it('resets to initial state', () => {
      store.addUserMessage('a')
      store.setRunning(true)
      store.setSpinner(true)
      store.reset()
      expect(store.getState().messages).toEqual([])
      expect(store.getState().running).toBe(false)
      expect(store.getState().spinnerActive).toBe(false)
    })
  })
})
