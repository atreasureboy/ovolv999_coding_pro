/**
 * Inter-Agent Messaging
 *
 * Lets multiple agents communicate via a message bus.
 * Supports:
 *   - SendMessage: send a message to another agent
 *   - Monitor: watch for messages from other agents
 *   - REPL: interactive read-eval-print loop for debugging agents
 *
 * Inspired by claude-code's inter-agent communication.
 */

import { randomUUID } from 'crypto'
import { EventEmitter } from 'events'

// ── Types ───────────────────────────────────────────────────────────────────

export interface AgentMessage {
  id: string
  from: string
  to: string
  content: string
  timestamp: string
  type: 'message' | 'question' | 'result' | 'error' | 'status'
  replyTo?: string
  metadata?: Record<string, unknown>
}

export interface AgentInfo {
  id: string
  name: string
  role: string
  status: 'active' | 'idle' | 'busy' | 'stopped'
  startedAt: string
  lastSeen: string
  messageCount: number
}

// ── Message Bus ─────────────────────────────────────────────────────────────

export class MessageBus extends EventEmitter {
  private agents = new Map<string, AgentInfo>()
  private messages: AgentMessage[] = []
  private queues = new Map<string, AgentMessage[]>()
  private maxMessages: number

  constructor(maxMessages = 1000) {
    super()
    this.maxMessages = maxMessages
  }

  registerAgent(id: string, name: string, role = 'worker'): AgentInfo {
    const now = new Date().toISOString()
    const info: AgentInfo = {
      id,
      name,
      role,
      status: 'active',
      startedAt: now,
      lastSeen: now,
      messageCount: 0,
    }
    this.agents.set(id, info)
    this.queues.set(id, [])
    this.emit('agent-registered', info)
    return info
  }

  unregisterAgent(id: string): boolean {
    const existed = this.agents.delete(id)
    this.queues.delete(id)
    if (existed) this.emit('agent-unregistered', id)
    return existed
  }

  getAgent(id: string): AgentInfo | undefined {
    return this.agents.get(id)
  }

  listAgents(): AgentInfo[] {
    return Array.from(this.agents.values())
  }

  updateAgentStatus(id: string, status: AgentInfo['status']): void {
    const agent = this.agents.get(id)
    if (agent) {
      agent.status = status
      agent.lastSeen = new Date().toISOString()
    }
  }

  send(from: string, to: string, content: string, type: AgentMessage['type'] = 'message', metadata?: Record<string, unknown>): AgentMessage | null {
    if (!this.agents.has(from)) return null
    if (!this.agents.has(to)) return null

    const message: AgentMessage = {
      id: randomUUID(),
      from,
      to,
      content,
      timestamp: new Date().toISOString(),
      type,
      metadata,
    }

    this.messages.push(message)
    if (this.messages.length > this.maxMessages) {
      this.messages.shift()
    }

    const queue = this.queues.get(to)
    if (queue) {
      queue.push(message)
      this.emit(`message:${to}`, message)
    }

    const sender = this.agents.get(from)
    if (sender) {
      sender.messageCount++
      sender.lastSeen = new Date().toISOString()
    }

    return message
  }

  reply(originalMessageId: string, from: string, content: string, type: AgentMessage['type'] = 'result'): AgentMessage | null {
    const original = this.messages.find(m => m.id === originalMessageId)
    if (!original) return null

    const message = this.send(from, original.from, content, type)
    if (message) message.replyTo = originalMessageId
    return message
  }

  /**
   * Dequeue the next message for `agentId`.
   *
   * - If a message is already queued: returns it synchronously.
   * - If `timeout > 0`: returns a Promise that resolves with the next
   *   arriving message (or null on timeout). Callers MUST await the
   *   result when passing a positive timeout.
   * - Otherwise: returns null synchronously.
   *
   * The union return type is intentional — the synchronous and async
   * branches are distinguished by the `timeout` argument.
   */
  receive(agentId: string, timeout = 0): AgentMessage | null | Promise<AgentMessage | null> {
    const queue = this.queues.get(agentId)
    if (!queue) return null

    if (queue.length > 0) {
      return queue.shift()!
    }

    if (timeout > 0) {
      return new Promise<AgentMessage | null>((resolve) => {
        const timer = setTimeout(() => {
          this.off(`message:${agentId}`, handler)
          resolve(null)
        }, timeout)
        // Bounded long-poll must not keep the process alive on its own —
        // if nothing else is pending the caller is gone anyway.
        if (typeof timer.unref === 'function') timer.unref()

        const handler = (msg: AgentMessage): void => {
          clearTimeout(timer)
          this.off(`message:${agentId}`, handler)
          const q = this.queues.get(agentId)
          if (q && q.length > 0) resolve(q.shift()!)
          else resolve(msg)
        }
        this.once(`message:${agentId}`, handler)
      })
    }

    return null
  }

  getMessages(filter?: { from?: string; to?: string; type?: AgentMessage['type'] }): AgentMessage[] {
    let result = this.messages
    if (filter?.from) result = result.filter(m => m.from === filter.from)
    if (filter?.to) result = result.filter(m => m.to === filter.to)
    if (filter?.type) result = result.filter(m => m.type === filter.type)
    return result
  }

  getQueueSize(agentId: string): number {
    return this.queues.get(agentId)?.length ?? 0
  }

  clear(): void {
    this.messages = []
    for (const queue of this.queues.values()) {
      queue.length = 0
    }
  }

  getStats(): { totalMessages: number; totalAgents: number; activeAgents: number } {
    const now = Date.now()
    const activeAgents = Array.from(this.agents.values()).filter(a => {
      return now - new Date(a.lastSeen).getTime() < 60_000 && a.status !== 'stopped'
    }).length

    return {
      totalMessages: this.messages.length,
      totalAgents: this.agents.size,
      activeAgents,
    }
  }
}

// ── Global Bus ──────────────────────────────────────────────────────────────

let globalBus: MessageBus | null = null

export function getMessageBus(): MessageBus {
  if (!globalBus) globalBus = new MessageBus()
  return globalBus
}

export function resetMessageBus(): void {
  if (globalBus) {
    globalBus.clear()
    globalBus = null
  }
}

// ── Formatting ──────────────────────────────────────────────────────────────

export function formatAgentList(agents: AgentInfo[]): string {
  if (agents.length === 0) return 'No agents registered.'
  const lines: string[] = [`Agents (${agents.length}):`]
  for (const a of agents) {
    const icon = { active: '●', idle: '○', busy: '◐', stopped: '✗' }[a.status]
    const msgs = a.messageCount > 0 ? ` (${a.messageCount} msgs)` : ''
    lines.push(`  ${icon} ${a.name} [${a.role}] — ${a.status}${msgs}`)
  }
  return lines.join('\n')
}

export function formatMessage(msg: AgentMessage): string {
  const typeIcon = { message: '→', question: '?', result: '✓', error: '✗', status: 'ℹ' }[msg.type]
  const lines = [
    `${typeIcon} [${msg.timestamp}] ${msg.from} → ${msg.to} (${msg.type})`,
    `  ${msg.content}`,
  ]
  if (msg.replyTo) lines.push(`  (reply to ${msg.replyTo})`)
  return lines.join('\n')
}

export function formatMessageList(messages: AgentMessage[]): string {
  if (messages.length === 0) return 'No messages.'
  return messages.map(formatMessage).join('\n---\n')
}

export function formatBusStats(stats: { totalMessages: number; totalAgents: number; activeAgents: number }): string {
  return [
    'Message Bus Stats:',
    `  Total messages: ${stats.totalMessages}`,
    `  Total agents: ${stats.totalAgents}`,
    `  Active agents: ${stats.activeAgents}`,
  ].join('\n')
}
