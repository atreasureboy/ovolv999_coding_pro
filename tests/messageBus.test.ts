import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import type {
  MessageBus} from '../src/core/messageBus.js';
import {
  getMessageBus,
  resetMessageBus,
  formatAgentList,
  formatMessage,
  formatMessageList,
  formatBusStats,
} from '../src/core/messageBus.js'

let bus: MessageBus

beforeEach(() => {
  resetMessageBus()
  bus = getMessageBus()
})

afterEach(() => {
  resetMessageBus()
})

describe('messageBus', () => {
  describe('agent registration', () => {
    it('registers an agent', () => {
      const info = bus.registerAgent('a1', 'Alpha', 'coordinator')
      expect(info.id).toBe('a1')
      expect(info.name).toBe('Alpha')
      expect(info.status).toBe('active')
    })

    it('unregisters an agent', () => {
      bus.registerAgent('a1', 'Alpha')
      expect(bus.unregisterAgent('a1')).toBe(true)
      expect(bus.getAgent('a1')).toBeUndefined()
    })

    it('returns false for unknown unregister', () => {
      expect(bus.unregisterAgent('unknown')).toBe(false)
    })

    it('lists agents', () => {
      bus.registerAgent('a1', 'Alpha')
      bus.registerAgent('a2', 'Beta')
      const agents = bus.listAgents()
      expect(agents).toHaveLength(2)
    })

    it('updates agent status', () => {
      bus.registerAgent('a1', 'Alpha')
      bus.updateAgentStatus('a1', 'busy')
      expect(bus.getAgent('a1')!.status).toBe('busy')
    })
  })

  describe('messaging', () => {
    it('sends a message between agents', () => {
      bus.registerAgent('a1', 'Alpha')
      bus.registerAgent('a2', 'Beta')
      const msg = bus.send('a1', 'a2', 'hello')
      expect(msg).toBeTruthy()
      expect(msg!.content).toBe('hello')
      expect(msg!.from).toBe('a1')
      expect(msg!.to).toBe('a2')
    })

    it('returns null for unknown sender', () => {
      bus.registerAgent('a2', 'Beta')
      expect(bus.send('unknown', 'a2', 'hi')).toBeNull()
    })

    it('returns null for unknown recipient', () => {
      bus.registerAgent('a1', 'Alpha')
      expect(bus.send('a1', 'unknown', 'hi')).toBeNull()
    })

    it('increments sender message count', () => {
      bus.registerAgent('a1', 'Alpha')
      bus.registerAgent('a2', 'Beta')
      bus.send('a1', 'a2', 'msg1')
      bus.send('a1', 'a2', 'msg2')
      expect(bus.getAgent('a1')!.messageCount).toBe(2)
    })

    it('receives message from queue', () => {
      bus.registerAgent('a1', 'Alpha')
      bus.registerAgent('a2', 'Beta')
      bus.send('a1', 'a2', 'hello')
      const msg = bus.receive('a2')
      expect(msg).toBeTruthy()
      expect(msg!.content).toBe('hello')
    })

    it('returns null when queue is empty', () => {
      bus.registerAgent('a1', 'Alpha')
      expect(bus.receive('a1')).toBeNull()
    })

    it('clears queue after receive', () => {
      bus.registerAgent('a1', 'Alpha')
      bus.registerAgent('a2', 'Beta')
      bus.send('a1', 'a2', 'msg')
      bus.receive('a2')
      expect(bus.getQueueSize('a2')).toBe(0)
    })

    it('supports replies', () => {
      bus.registerAgent('a1', 'Alpha')
      bus.registerAgent('a2', 'Beta')
      const original = bus.send('a1', 'a2', 'question?')
      const reply = bus.reply(original!.id, 'a2', 'answer!')
      expect(reply).toBeTruthy()
      expect(reply!.to).toBe('a1')
      expect(reply!.replyTo).toBe(original!.id)
    })
  })

  describe('message filtering', () => {
    it('filters by sender', () => {
      bus.registerAgent('a1', 'Alpha')
      bus.registerAgent('a2', 'Beta')
      bus.registerAgent('a3', 'Gamma')
      bus.send('a1', 'a2', 'msg1')
      bus.send('a1', 'a3', 'msg2')
      bus.send('a2', 'a3', 'msg3')

      const fromA1 = bus.getMessages({ from: 'a1' })
      expect(fromA1).toHaveLength(2)
    })

    it('filters by recipient', () => {
      bus.registerAgent('a1', 'Alpha')
      bus.registerAgent('a2', 'Beta')
      bus.send('a1', 'a2', 'msg1')
      bus.send('a1', 'a2', 'msg2')

      const toA2 = bus.getMessages({ to: 'a2' })
      expect(toA2).toHaveLength(2)
    })

    it('filters by type', () => {
      bus.registerAgent('a1', 'Alpha')
      bus.registerAgent('a2', 'Beta')
      bus.send('a1', 'a2', 'q', 'question')
      bus.send('a1', 'a2', 'r', 'result')

      const questions = bus.getMessages({ type: 'question' })
      expect(questions).toHaveLength(1)
      expect(questions[0].content).toBe('q')
    })
  })

  describe('stats', () => {
    it('reports bus stats', () => {
      bus.registerAgent('a1', 'Alpha')
      bus.registerAgent('a2', 'Beta')
      bus.send('a1', 'a2', 'msg')

      const stats = bus.getStats()
      expect(stats.totalMessages).toBe(1)
      expect(stats.totalAgents).toBe(2)
    })
  })

  describe('clear', () => {
    it('clears all messages and queues', () => {
      bus.registerAgent('a1', 'Alpha')
      bus.registerAgent('a2', 'Beta')
      bus.send('a1', 'a2', 'msg')
      bus.clear()
      expect(bus.getMessages()).toHaveLength(0)
      expect(bus.getQueueSize('a2')).toBe(0)
    })
  })

  describe('formatting', () => {
    it('formats agent list', () => {
      bus.registerAgent('a1', 'Alpha', 'coordinator')
      const out = formatAgentList(bus.listAgents())
      expect(out).toContain('Alpha')
      expect(out).toContain('coordinator')
    })

    it('formats empty agent list', () => {
      expect(formatAgentList([])).toContain('No agents')
    })

    it('formats a message', () => {
      bus.registerAgent('a1', 'Alpha')
      bus.registerAgent('a2', 'Beta')
      const msg = bus.send('a1', 'a2', 'test message')!
      const out = formatMessage(msg)
      expect(out).toContain('a1')
      expect(out).toContain('a2')
      expect(out).toContain('test message')
    })

    it('formats message list', () => {
      bus.registerAgent('a1', 'Alpha')
      bus.registerAgent('a2', 'Beta')
      bus.send('a1', 'a2', 'msg1')
      bus.send('a1', 'a2', 'msg2')
      const out = formatMessageList(bus.getMessages())
      expect(out).toContain('msg1')
      expect(out).toContain('msg2')
    })

    it('formats empty message list', () => {
      expect(formatMessageList([])).toContain('No messages')
    })

    it('formats stats', () => {
      const out = formatBusStats({ totalMessages: 5, totalAgents: 2, activeAgents: 1 })
      expect(out).toContain('5')
      expect(out).toContain('2')
      expect(out).toContain('1')
    })
  })
})
