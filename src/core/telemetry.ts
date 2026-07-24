/**
 * Telemetry — anonymous local usage analytics
 *
 * Collects aggregate metrics about how ovolv999 is used: tool call
 * counts, session duration, token usage, error rates. All data is
 * LOCAL-FIRST — nothing is sent anywhere unless the user explicitly
 * exports it. Opt-in; disabled by default.
 *
 * Storage: ~/.ovolv999/telemetry.json (append-only event log + aggregates)
 *
 * The user can:
 *   - View stats: 'ovolv999 telemetry stats'
 *   - Export: 'ovolv999 telemetry export > stats.json'
 *   - Clear: 'ovolv999 telemetry clear'
 *   - Enable/disable: 'ovolv999 telemetry on|off'
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'

// ── Types ───────────────────────────────────────────────────────────────────

export type TelemetryEventType =
  | 'session_start' | 'session_end'
  | 'tool_call' | 'tool_error'
  | 'compact' | 'micro_compact' | 'snip'
  | 'api_call' | 'api_error'
  | 'permission_request' | 'permission_deny'
  | 'background_task_start' | 'background_task_end'
  | 'skill_load' | 'skill_use'

export interface TelemetryEvent {
  type: TelemetryEventType
  timestamp: string
  /** Duration in ms (for events that have a duration) */
  durationMs?: number
  /** Tool name (for tool_call / tool_error) */
  tool?: string
  /** Model name (for api_call) */
  model?: string
  /** Token counts (for api_call / compact) */
  tokensIn?: number
  tokensOut?: number
  /** Error message (for error events) */
  error?: string
  /** Cost in USD (for api_call) */
  cost?: number
  /** Arbitrary metadata */
  meta?: Record<string, unknown>
}

export interface TelemetryAggregates {
  totalSessions: number
  totalToolCalls: number
  totalApiCalls: number
  totalTokensIn: number
  totalTokensOut: number
  totalCost: number
  totalErrors: number
  totalCompacts: number
  totalDurationMs: number
  toolCallCounts: Record<string, number>
  errorCounts: Record<string, number>
  modelUsage: Record<string, number>
  eventsByType: Record<string, number>
  firstEventAt: string
  lastEventAt: string
}

export interface TelemetryConfig {
  enabled: boolean
  /** Max events to store (ring buffer) */
  maxEvents: number
  /** Include detailed metadata (tool names, model names) */
  detailed: boolean
}

// ── Config ──────────────────────────────────────────────────────────────────

export const DEFAULT_CONFIG: TelemetryConfig = {
  enabled: false,
  maxEvents: 10_000,
  detailed: true,
}

function getConfigPath(): string {
  return join(homedir(), '.ovolv999', 'telemetry-config.json')
}

export function loadConfig(): TelemetryConfig {
  const path = getConfigPath()
  if (!existsSync(path)) return { ...DEFAULT_CONFIG }
  try {
    return { ...DEFAULT_CONFIG, ...(JSON.parse(readFileSync(path, 'utf8')) as Partial<TelemetryConfig>) }
  } catch {
    return { ...DEFAULT_CONFIG }
  }
}

export function saveConfig(config: TelemetryConfig): void {
  const path = getConfigPath()
  const dir = join(path, '..')
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  writeFileSync(path, JSON.stringify(config, null, 2))
}

export function setEnabled(enabled: boolean): TelemetryConfig {
  const config = loadConfig()
  config.enabled = enabled
  saveConfig(config)
  return config
}

// ── Event Storage ───────────────────────────────────────────────────────────

function getLogPath(): string {
  return join(homedir(), '.ovolv999', 'telemetry.json')
}

let eventBuffer: TelemetryEvent[] = []
let bufferLoaded = false

function loadBuffer(): void {
  if (bufferLoaded) return
  bufferLoaded = true
  const path = getLogPath()
  if (!existsSync(path)) return
  try {
    eventBuffer = JSON.parse(readFileSync(path, 'utf8')) as TelemetryEvent[]
  } catch {
    eventBuffer = []
  }
}

function flushBuffer(): void {
  const config = loadConfig()
  if (!config.enabled) return
  const path = getLogPath()
  const dir = join(path, '..')
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })

  // Trim to maxEvents (ring buffer)
  if (eventBuffer.length > config.maxEvents) {
    eventBuffer = eventBuffer.slice(-config.maxEvents)
  }

  writeFileSync(path, JSON.stringify(eventBuffer, null, 2))
}

// ── Recording ───────────────────────────────────────────────────────────────

export function record(event: TelemetryEvent): void {
  const config = loadConfig()
  if (!config.enabled) return

  loadBuffer()

  // Strip metadata if not in detailed mode
  if (!config.detailed) {
    const stripped: TelemetryEvent = { type: event.type, timestamp: event.timestamp }
    if (event.durationMs) stripped.durationMs = event.durationMs
    eventBuffer.push(stripped)
  } else {
    eventBuffer.push(event)
  }

  flushBuffer()
}

export function recordToolCall(tool: string, durationMs: number): void {
  record({ type: 'tool_call', timestamp: new Date().toISOString(), tool, durationMs })
}

export function recordToolError(tool: string, error: string): void {
  record({ type: 'tool_error', timestamp: new Date().toISOString(), tool, error })
}

export function recordApiCall(model: string, tokensIn: number, tokensOut: number, cost: number, durationMs: number): void {
  record({ type: 'api_call', timestamp: new Date().toISOString(), model, tokensIn, tokensOut, cost, durationMs })
}

export function recordApiError(model: string, error: string): void {
  record({ type: 'api_error', timestamp: new Date().toISOString(), model, error })
}

export function recordSessionStart(): void {
  record({ type: 'session_start', timestamp: new Date().toISOString() })
}

export function recordSessionEnd(durationMs: number): void {
  record({ type: 'session_end', timestamp: new Date().toISOString(), durationMs })
}

export function recordCompact(tokensBefore: number, tokensAfter: number): void {
  record({
    type: 'compact',
    timestamp: new Date().toISOString(),
    tokensIn: tokensBefore,
    tokensOut: tokensAfter,
  })
}

// ── Aggregation ─────────────────────────────────────────────────────────────

export function getEvents(filter?: { type?: TelemetryEventType; since?: string }): TelemetryEvent[] {
  loadBuffer()
  let events = [...eventBuffer]
  if (filter?.type) events = events.filter((e) => e.type === filter.type)
  if (filter?.since) events = events.filter((e) => e.timestamp >= filter.since!)
  return events
}

export function getAggregates(): TelemetryAggregates {
  loadBuffer()
  const events = eventBuffer

  const agg: TelemetryAggregates = {
    totalSessions: 0,
    totalToolCalls: 0,
    totalApiCalls: 0,
    totalTokensIn: 0,
    totalTokensOut: 0,
    totalCost: 0,
    totalErrors: 0,
    totalCompacts: 0,
    totalDurationMs: 0,
    toolCallCounts: {},
    errorCounts: {},
    modelUsage: {},
    eventsByType: {},
    firstEventAt: events[0]?.timestamp ?? new Date().toISOString(),
    lastEventAt: events[events.length - 1]?.timestamp ?? new Date().toISOString(),
  }

  for (const e of events) {
    // Count by type
    agg.eventsByType[e.type] = (agg.eventsByType[e.type] ?? 0) + 1

    switch (e.type) {
      case 'session_start':
        agg.totalSessions++
        break
      case 'session_end':
        agg.totalDurationMs += e.durationMs ?? 0
        break
      case 'tool_call':
        agg.totalToolCalls++
        if (e.tool) agg.toolCallCounts[e.tool] = (agg.toolCallCounts[e.tool] ?? 0) + 1
        break
      case 'tool_error':
      case 'api_error':
        agg.totalErrors++
        if (e.tool) agg.errorCounts[e.tool] = (agg.errorCounts[e.tool] ?? 0) + 1
        else if (e.model) agg.errorCounts[e.model] = (agg.errorCounts[e.model] ?? 0) + 1
        break
      case 'api_call':
        agg.totalApiCalls++
        agg.totalTokensIn += e.tokensIn ?? 0
        agg.totalTokensOut += e.tokensOut ?? 0
        agg.totalCost += e.cost ?? 0
        if (e.model) agg.modelUsage[e.model] = (agg.modelUsage[e.model] ?? 0) + 1
        break
      case 'compact':
      case 'micro_compact':
      case 'snip':
        agg.totalCompacts++
        break
    }
  }

  return agg
}

// ── Export / Clear ──────────────────────────────────────────────────────────

export function exportData(): { config: TelemetryConfig; events: TelemetryEvent[]; aggregates: TelemetryAggregates } {
  return {
    config: loadConfig(),
    events: getEvents(),
    aggregates: getAggregates(),
  }
}

export function clearData(): number {
  loadBuffer()
  const count = eventBuffer.length
  eventBuffer = []
  const path = getLogPath()
  if (existsSync(path)) writeFileSync(path, '[]')
  return count
}

// ── Formatting ──────────────────────────────────────────────────────────────

export function formatAggregates(agg: TelemetryAggregates): string {
  const lines = [
    'Telemetry Summary:',
    `  Period: ${agg.firstEventAt} to ${agg.lastEventAt}`,
    `  Sessions: ${agg.totalSessions}`,
    `  Duration: ${formatDuration(agg.totalDurationMs)}`,
    '',
    'Usage:',
    `  Tool calls: ${agg.totalToolCalls}`,
    `  API calls: ${agg.totalApiCalls}`,
    `  Tokens: ${agg.totalTokensIn.toLocaleString()} in / ${agg.totalTokensOut.toLocaleString()} out`,
    `  Cost: $${agg.totalCost.toFixed(4)}`,
    `  Errors: ${agg.totalErrors}`,
    `  Compacts: ${agg.totalCompacts}`,
  ]

  const topTools = Object.entries(agg.toolCallCounts)
    .sort(([, a], [, b]) => b - a)
    .slice(0, 10)
  if (topTools.length > 0) {
    lines.push('', 'Top tools:')
    for (const [tool, count] of topTools) {
      lines.push(`  ${tool}: ${count}`)
    }
  }

  const models = Object.entries(agg.modelUsage)
  if (models.length > 0) {
    lines.push('', 'Models:')
    for (const [model, count] of models) {
      lines.push(`  ${model}: ${count} calls`)
    }
  }

  return lines.join('\n')
}

export function formatConfig(config: TelemetryConfig): string {
  const lines = [
    'Telemetry Configuration:',
    `  Enabled: ${config.enabled ? '✓ (collecting)' : '✗ (disabled)'}`,
    `  Max events: ${config.maxEvents.toLocaleString()}`,
    `  Detailed: ${config.detailed ? 'yes (includes tool/model names)' : 'no (aggregate counts only)'}`,
  ]
  return lines.join('\n')
}

export function formatEvent(event: TelemetryEvent): string {
  const parts = [event.timestamp, event.type]
  if (event.tool) parts.push(`tool=${event.tool}`)
  if (event.model) parts.push(`model=${event.model}`)
  if (event.durationMs) parts.push(`${event.durationMs}ms`)
  if (event.cost) parts.push(`$${event.cost.toFixed(4)}`)
  if (event.tokensIn) parts.push(`${event.tokensIn}in`)
  if (event.tokensOut) parts.push(`${event.tokensOut}out`)
  if (event.error) parts.push(`error="${event.error.slice(0, 60)}"`)
  return parts.join(' ')
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`
  if (ms < 3_600_000) return `${(ms / 60_000).toFixed(1)}m`
  return `${(ms / 3_600_000).toFixed(1)}h`
}
