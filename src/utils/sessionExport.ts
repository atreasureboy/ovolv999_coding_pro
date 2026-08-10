/**
 * Session Export — export conversation history to shareable formats.
 *
 * Supports:
 *   - markdown: human-readable with headers and code blocks
 *   - json: raw message array (for re-import or analysis)
 *   - text: plain text, no formatting
 *   - transcript: chat-style with timestamps
 *
 * Inspired by Claude Code's export functionality.
 */

import { writeFileSync } from 'fs'
import { join, resolve } from 'path'
import type { OpenAIMessage } from '../core/types.js'

export type { OpenAIMessage }

// ── Types ───────────────────────────────────────────────────────────────────

export type ExportFormat = 'markdown' | 'json' | 'text' | 'transcript'

export interface ExportOptions {
  format: ExportFormat
  /** Include tool calls and results (default: true for markdown/transcript) */
  includeTools?: boolean
  /** Include reasoning/thinking (default: false) */
  includeReasoning?: boolean
  /** Title for the export (default: "Conversation") */
  title?: string
  /** Max characters per message before truncation (0 = no limit) */
  maxCharsPerMessage?: number
}

export interface ExportResult {
  content: string
  format: ExportFormat
  /** Number of messages exported */
  messageCount: number
  /** Number of characters in the export */
  charCount: number
}

// ── Formatters ──────────────────────────────────────────────────────────────

/**
 * Export conversation messages in the specified format.
 */
export function exportSession(messages: OpenAIMessage[], options: ExportOptions): ExportResult {
  const { format } = options
  let content: string

  switch (format) {
    case 'markdown':
      content = toMarkdown(messages, options)
      break
    case 'json':
      content = toJSON(messages, options)
      break
    case 'text':
      content = toText(messages, options)
      break
    case 'transcript':
      content = toTranscript(messages, options)
      break
    default:
      throw new Error(`Unknown export format: ${String(format)}`)
  }

  return {
    content,
    format,
    messageCount: messages.length,
    charCount: content.length,
  }
}

// ── Markdown ────────────────────────────────────────────────────────────────

function toMarkdown(messages: OpenAIMessage[], options: ExportOptions): string {
  const title = options.title ?? 'Conversation Export'
  const includeTools = options.includeTools ?? true
  const includeReasoning = options.includeReasoning ?? false
  const maxLen = options.maxCharsPerMessage ?? 0

  const lines: string[] = [
    `# ${title}`,
    '',
    `*Exported: ${new Date().toISOString()}*`,
    `*Messages: ${messages.length}*`,
    '',
    '---',
    '',
  ]

  for (const msg of messages) {
    const content = extractContent(msg)
    const truncated = maxLen > 0 && content.length > maxLen
      ? content.slice(0, maxLen) + '\n\n*(truncated)*'
      : content

    switch (msg.role) {
      case 'user':
        lines.push('## User', '')
        lines.push(truncated)
        lines.push('')
        break

      case 'assistant':
        lines.push('## Assistant', '')
        if (includeReasoning) {
          const reasoning = (msg as OpenAIMessage & { reasoning?: string }).reasoning
          if (reasoning) {
            lines.push('<details><summary>Reasoning</summary>', '')
            lines.push('```')
            lines.push(reasoning)
            lines.push('```')
            lines.push('</details>', '')
          }
        }
        lines.push(truncated)
        lines.push('')
        if (includeTools && msg.tool_calls && msg.tool_calls.length > 0) {
          lines.push('<details><summary>Tool Calls</summary>', '')
          for (const call of msg.tool_calls) {
            lines.push(`**${call.function?.name ?? 'unknown'}**`)
            lines.push('```json')
            try {
              const args = call.function?.arguments ? (JSON.parse(call.function.arguments) as Record<string, unknown>) : {}
              lines.push(JSON.stringify(args, null, 2))
            } catch {
              lines.push(call.function?.arguments ?? '{}')
            }
            lines.push('```')
          }
          lines.push('</details>', '')
        }
        break

      case 'tool':
        if (includeTools) {
          const toolName = msg.name ?? 'tool'
          lines.push(`<details><summary>Tool Result: ${toolName}</summary>`, '')
          lines.push('```')
          lines.push(truncated)
          lines.push('```')
          lines.push('</details>', '')
        }
        break

      case 'system':
        // Skip system messages in export
        break
    }

    lines.push('---', '')
  }

  return lines.join('\n')
}

// ── JSON ────────────────────────────────────────────────────────────────────

function toJSON(messages: OpenAIMessage[], _options: ExportOptions): string {
  return JSON.stringify(messages, null, 2)
}

// ── Plain Text ──────────────────────────────────────────────────────────────

function toText(messages: OpenAIMessage[], options: ExportOptions): string {
  const includeTools = options.includeTools ?? false
  const maxLen = options.maxCharsPerMessage ?? 0
  const lines: string[] = []

  for (const msg of messages) {
    if (msg.role === 'system') continue

    const label = msg.role === 'user' ? 'YOU' : msg.role === 'assistant' ? 'AI' : 'TOOL'
    let content = extractContent(msg)

    if (maxLen > 0 && content.length > maxLen) {
      content = content.slice(0, maxLen) + '...'
    }

    lines.push(`[${label}]`)
    lines.push(content)

    if (includeTools && msg.tool_calls) {
      for (const call of msg.tool_calls) {
        lines.push(`  → ${call.function?.name}`)
      }
    }

    lines.push('')
  }

  return lines.join('\n')
}

// ── Transcript ──────────────────────────────────────────────────────────────

function toTranscript(messages: OpenAIMessage[], options: ExportOptions): string {
  const includeTools = options.includeTools ?? true
  const maxLen = options.maxCharsPerMessage ?? 0
  const lines: string[] = []

  let msgIdx = 0
  for (const msg of messages) {
    if (msg.role === 'system') continue
    msgIdx++

    // Use consistent timestamp format (HH:MM:SS)
    const now = new Date(Date.now() - (messages.length - msgIdx) * 1000)
    const hh = String(now.getHours()).padStart(2, '0')
    const mm = String(now.getMinutes()).padStart(2, '0')
    const ss = String(now.getSeconds()).padStart(2, '0')
    const timestamp = `${hh}:${mm}:${ss}`
    const speaker = msg.role === 'user' ? 'User' : msg.role === 'assistant' ? 'Assistant' : 'Tool'
    let content = extractContent(msg)

    if (maxLen > 0 && content.length > maxLen) {
      content = content.slice(0, maxLen) + '...'
    }

    lines.push(`[${timestamp}] ${speaker}:`)
    lines.push(content)

    if (includeTools && msg.tool_calls) {
      for (const call of msg.tool_calls) {
        const name = call.function?.name ?? 'unknown'
        let args = ''
        try {
          const parsed = call.function?.arguments ? (JSON.parse(call.function.arguments) as Record<string, unknown>) : {}
          args = Object.entries(parsed)
            .map(([k, v]) => `${k}=${typeof v === 'string' ? `"${v.slice(0, 50)}"` : String(v)}`)
            .join(', ')
        } catch { /* best-effort */ }
        lines.push(`  [tool] ${name}(${args})`)
      }
    }

    lines.push('')
  }

  return lines.join('\n')
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function extractContent(msg: OpenAIMessage): string {
  if (typeof msg.content === 'string') return msg.content
  if (Array.isArray(msg.content)) {
    return msg.content
      .map(part => {
        if (part.type === 'text') return part.text
        if (part.type === 'image_url') return '[image]'
        return JSON.stringify(part)
      })
      .join('\n')
  }
  return ''
}

// ── File Writer ─────────────────────────────────────────────────────────────

/**
 * Export session to a file.
 * Returns the file path.
 */
export function exportSessionToFile(
  messages: OpenAIMessage[],
  cwd: string,
  filename: string,
  options: ExportOptions,
): string {
  const result = exportSession(messages, options)
  const filePath = join(resolve(cwd), filename)
  writeFileSync(filePath, result.content, 'utf8')
  return filePath
}

/**
 * Generate a default filename based on format and timestamp.
 */
export function defaultFilename(format: ExportFormat): string {
  const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
  const ext = format === 'markdown' ? 'md' : format === 'json' ? 'json' : 'txt'
  return `session-${ts}.${ext}`
}
