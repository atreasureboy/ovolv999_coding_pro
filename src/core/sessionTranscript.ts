/**
 * Session Transcript Export
 *
 * Exports full session transcripts in multiple formats:
 *   - JSON (structured, machine-readable)
 *   - Markdown (human-readable)
 *   - Plain text (simple log)
 *
 * Transcripts include:
 *   - Session metadata (id, timestamps, model, mode)
 *   - All user messages and assistant responses
 *   - Tool calls and their results
 *   - Token usage and cost tracking
 */

import { writeFileSync, mkdirSync, existsSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'

// ── Types ───────────────────────────────────────────────────────────────────

export interface TranscriptMessage {
  role: 'user' | 'assistant' | 'system' | 'tool'
  content: string
  timestamp: string
  toolCalls?: Array<{
    name: string
    input: Record<string, unknown>
    output?: string
    duration?: number
  }>
  tokenUsage?: {
    input: number
    output: number
    cacheRead?: number
    cacheWrite?: number
  }
  cost?: number
  model?: string
}

export interface TranscriptMetadata {
  sessionId: string
  startTime: string
  endTime?: string
  model?: string
  mode?: string
  cwd?: string
  totalTokens?: number
  totalCost?: number
  messageCount?: number
  toolCallCount?: number
}

export interface SessionTranscript {
  metadata: TranscriptMetadata
  messages: TranscriptMessage[]
}

export type ExportFormat = 'json' | 'markdown' | 'text'

// ── Builders ────────────────────────────────────────────────────────────────

export function buildTranscript(
  metadata: TranscriptMetadata,
  messages: TranscriptMessage[],
): SessionTranscript {
  const totalTokens = messages.reduce(
    (sum, m) => sum + (m.tokenUsage?.input ?? 0) + (m.tokenUsage?.output ?? 0),
    0,
  )
  const totalCost = messages.reduce((sum, m) => sum + (m.cost ?? 0), 0)
  const toolCallCount = messages.reduce(
    (sum, m) => sum + (m.toolCalls?.length ?? 0),
    0,
  )

  return {
    metadata: {
      ...metadata,
      totalTokens,
      totalCost,
      messageCount: messages.length,
      toolCallCount,
    },
    messages,
  }
}

// ── Formatters ──────────────────────────────────────────────────────────────

export function formatAsJson(transcript: SessionTranscript): string {
  return JSON.stringify(transcript, null, 2)
}

export function formatAsMarkdown(transcript: SessionTranscript): string {
  const lines: string[] = []
  const m = transcript.metadata

  lines.push(`# Session Transcript`)
  lines.push('')
  lines.push(`| Field | Value |`)
  lines.push(`|-------|-------|`)
  lines.push(`| Session ID | ${m.sessionId} |`)
  lines.push(`| Start | ${m.startTime} |`)
  if (m.endTime) lines.push(`| End | ${m.endTime} |`)
  if (m.model) lines.push(`| Model | ${m.model} |`)
  if (m.mode) lines.push(`| Mode | ${m.mode} |`)
  if (m.cwd) lines.push(`| Working Directory | ${m.cwd} |`)
  if (m.totalTokens) lines.push(`| Total Tokens | ${m.totalTokens.toLocaleString()} |`)
  if (m.totalCost !== undefined) lines.push(`| Total Cost | $${m.totalCost.toFixed(4)} |`)
  lines.push(`| Messages | ${m.messageCount ?? transcript.messages.length} |`)
  if (m.toolCallCount) lines.push(`| Tool Calls | ${m.toolCallCount} |`)
  lines.push('')
  lines.push('---')
  lines.push('')

  for (const msg of transcript.messages) {
    const time = msg.timestamp ? new Date(msg.timestamp).toLocaleTimeString() : ''
    const roleLabel = {
      user: '🧑 User',
      assistant: '🤖 Assistant',
      system: '⚙️ System',
      tool: '🔧 Tool',
    }[msg.role] ?? msg.role

    lines.push(`## ${roleLabel} ${time ? `\`${time}\`` : ''}`)
    lines.push('')

    if (msg.model) {
      lines.push(`*Model: ${msg.model}*`)
      lines.push('')
    }

    lines.push(msg.content || '*(empty)*')
    lines.push('')

    if (msg.toolCalls && msg.toolCalls.length > 0) {
      lines.push('**Tool Calls:**')
      for (const tc of msg.toolCalls) {
        lines.push(`- \`${tc.name}\``)
        const inputStr = Object.entries(tc.input)
          .map(([k, v]) => `${k}=${typeof v === 'string' ? v.slice(0, 100) : JSON.stringify(v).slice(0, 100)}`)
          .join(', ')
        lines.push(`  - Input: ${inputStr}`)
        if (tc.output) {
          const out = tc.output.slice(0, 200)
          lines.push(`  - Output: \`${out}\``)
        }
        if (tc.duration !== undefined) {
          lines.push(`  - Duration: ${tc.duration}ms`)
        }
      }
      lines.push('')
    }

    if (msg.tokenUsage) {
      const usage = `*Tokens: ${msg.tokenUsage.input} in, ${msg.tokenUsage.output} out*`
      lines.push(usage)
      lines.push('')
    }

    if (msg.cost !== undefined && msg.cost > 0) {
      lines.push(`*Cost: $${msg.cost.toFixed(4)}*`)
      lines.push('')
    }

    lines.push('---')
    lines.push('')
  }

  return lines.join('\n')
}

export function formatAsText(transcript: SessionTranscript): string {
  const lines: string[] = []
  const m = transcript.metadata

  lines.push(`=== Session Transcript ===`)
  lines.push(`Session: ${m.sessionId}`)
  lines.push(`Start: ${m.startTime}`)
  if (m.endTime) lines.push(`End: ${m.endTime}`)
  if (m.model) lines.push(`Model: ${m.model}`)
  if (m.mode) lines.push(`Mode: ${m.mode}`)
  if (m.totalTokens) lines.push(`Tokens: ${m.totalTokens}`)
  if (m.totalCost !== undefined) lines.push(`Cost: $${m.totalCost.toFixed(4)}`)
  lines.push('')

  for (const msg of transcript.messages) {
    const time = msg.timestamp ? new Date(msg.timestamp).toLocaleTimeString() : ''
    lines.push(`[${msg.role.toUpperCase()}] ${time}`)
    lines.push(msg.content)
    if (msg.toolCalls) {
      for (const tc of msg.toolCalls) {
        lines.push(`  > ${tc.name}(${JSON.stringify(tc.input).slice(0, 200)})`)
        if (tc.output) lines.push(`  < ${tc.output.slice(0, 200)}`)
      }
    }
    lines.push('')
  }

  return lines.join('\n')
}

export function formatTranscript(transcript: SessionTranscript, format: ExportFormat = 'markdown'): string {
  switch (format) {
    case 'json': return formatAsJson(transcript)
    case 'markdown': return formatAsMarkdown(transcript)
    case 'text': return formatAsText(transcript)
  }
}

// ── Export ──────────────────────────────────────────────────────────────────

export function getTranscriptDir(): string {
  return join(homedir(), '.ovolv999', 'transcripts')
}

export function exportTranscript(
  transcript: SessionTranscript,
  format: ExportFormat = 'markdown',
  outputPath?: string,
): string {
  const content = formatTranscript(transcript, format)
  const ext = format === 'json' ? 'json' : format === 'markdown' ? 'md' : 'txt'

  const dir = getTranscriptDir()
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })

  const filename = outputPath ?? `${transcript.metadata.sessionId}.${ext}`
  const fullPath = filename.includes('/') || filename.includes('\\')
    ? filename
    : join(dir, filename)

  writeFileSync(fullPath, content, 'utf8')
  return fullPath
}

// ── Stats ───────────────────────────────────────────────────────────────────

export function getTranscriptStats(transcript: SessionTranscript): {
  messageCount: number
  userMessages: number
  assistantMessages: number
  toolCalls: number
  toolNames: Record<string, number>
  totalTokens: number
  totalCost: number
  durationMs: number
} {
  const toolNames: Record<string, number> = {}
  let toolCalls = 0
  let userMessages = 0
  let assistantMessages = 0
  let totalTokens = 0
  let totalCost = 0

  for (const msg of transcript.messages) {
    if (msg.role === 'user') userMessages++
    if (msg.role === 'assistant') assistantMessages++
    if (msg.toolCalls) {
      for (const tc of msg.toolCalls) {
        toolCalls++
        toolNames[tc.name] = (toolNames[tc.name] ?? 0) + 1
      }
    }
    if (msg.tokenUsage) {
      totalTokens += msg.tokenUsage.input + msg.tokenUsage.output
    }
    totalCost += msg.cost ?? 0
  }

  let durationMs = 0
  if (transcript.metadata.startTime) {
    const start = new Date(transcript.metadata.startTime).getTime()
    const end = transcript.metadata.endTime
      ? new Date(transcript.metadata.endTime).getTime()
      : Date.now()
    durationMs = end - start
  }

  return {
    messageCount: transcript.messages.length,
    userMessages,
    assistantMessages,
    toolCalls,
    toolNames,
    totalTokens,
    totalCost,
    durationMs,
  }
}

export function formatStats(stats: ReturnType<typeof getTranscriptStats>): string {
  const lines: string[] = []
  lines.push(`Messages: ${stats.messageCount} (${stats.userMessages} user, ${stats.assistantMessages} assistant)`)
  lines.push(`Tool calls: ${stats.toolCalls}`)
  if (Object.keys(stats.toolNames).length > 0) {
    const sorted = Object.entries(stats.toolNames).sort((a, b) => b[1] - a[1])
    lines.push(`Top tools: ${sorted.slice(0, 5).map(([n, c]) => `${n}(${c})`).join(', ')}`)
  }
  lines.push(`Tokens: ${stats.totalTokens.toLocaleString()}`)
  lines.push(`Cost: $${stats.totalCost.toFixed(4)}`)
  lines.push(`Duration: ${(stats.durationMs / 1000 / 60).toFixed(1)}min`)
  return lines.join('\n')
}
