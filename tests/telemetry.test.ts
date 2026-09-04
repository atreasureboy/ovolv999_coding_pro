/**
 * Tests for src/core/telemetry.ts
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import {
  DEFAULT_CONFIG, loadConfig, saveConfig, setEnabled,
  record, recordToolCall, recordApiCall, recordSessionStart,
  getEvents, getAggregates, exportData, clearData,
  formatAggregates, formatConfig, formatEvent,
  type TelemetryEvent,
} from '../src/core/telemetry.js'
import { existsSync, rmSync, mkdtempSync, writeFileSync, readFileSync, mkdirSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { homedir } from 'os'

let testHome: string
let origHome: string | undefined

beforeAll(() => {
  testHome = mkdtempSync(join(tmpdir(), 'ovolv999-tel-'))
  origHome = process.env.HOME
  process.env.HOME = testHome
})

afterAll(() => {
  if (origHome !== undefined) process.env.HOME = origHome
  rmSync(testHome, { recursive: true, force: true })
})

beforeEach(() => {
  const dir = join(homedir(), '.ovolv999')
  if (existsSync(dir)) rmSync(dir, { recursive: true, force: true })
})

describe('telemetry', () => {
  describe('config', () => {
    it('disabled by default', () => {
      expect(DEFAULT_CONFIG.enabled).toBe(false)
    })

    it('loads defaults when no config', () => {
      const cfg = loadConfig()
      expect(cfg.enabled).toBe(false)
      expect(cfg.maxEvents).toBe(10_000)
    })

    it('saveConfig + loadConfig round-trips', () => {
      saveConfig({ enabled: true, maxEvents: 5000, detailed: false })
      const cfg = loadConfig()
      expect(cfg.enabled).toBe(true)
      expect(cfg.maxEvents).toBe(5000)
      expect(cfg.detailed).toBe(false)
    })

    it('setEnabled toggles', () => {
      setEnabled(true)
      expect(loadConfig().enabled).toBe(true)
      setEnabled(false)
      expect(loadConfig().enabled).toBe(false)
    })
  })

  describe('recording (disabled)', () => {
    it('does not record when disabled', () => {
      record({ type: 'tool_call', timestamp: new Date().toISOString() })
      expect(getEvents()).toEqual([])
    })
  })

  describe('recording (enabled)', () => {
    beforeEach(() => {
      setEnabled(true)
      clearData()
    })

    it('records events', () => {
      record({ type: 'session_start', timestamp: new Date().toISOString() })
      const events = getEvents()
      expect(events.length).toBe(1)
      expect(events[0].type).toBe('session_start')
    })

    it('recordToolCall adds event', () => {
      recordToolCall('Bash', 1500)
      const events = getEvents({ type: 'tool_call' })
      expect(events.length).toBe(1)
      expect(events[0].tool).toBe('Bash')
      expect(events[0].durationMs).toBe(1500)
    })

    it('recordApiCall adds event', () => {
      recordApiCall('gpt-4', 1000, 500, 0.05, 2000)
      const events = getEvents({ type: 'api_call' })
      expect(events.length).toBe(1)
      expect(events[0].model).toBe('gpt-4')
      expect(events[0].tokensIn).toBe(1000)
      expect(events[0].cost).toBe(0.05)
    })

    it('recordSessionStart adds event', () => {
      recordSessionStart()
      expect(getEvents({ type: 'session_start' }).length).toBe(1)
    })

    it('getEvents filters by type', () => {
      recordSessionStart()
      recordToolCall('Read', 100)
      recordToolCall('Grep', 50)
      const toolCalls = getEvents({ type: 'tool_call' })
      expect(toolCalls.length).toBe(2)
    })

    it('getEvents filters by since', () => {
      record({ type: 'session_start', timestamp: '2020-01-01T00:00:00Z' })
      record({ type: 'session_start', timestamp: '2024-01-01T00:00:00Z' })
      const since = getEvents({ since: '2023-01-01T00:00:00Z' })
      expect(since.length).toBe(1)
    })
  })

  describe('aggregates', () => {
    beforeEach(() => {
      setEnabled(true)
      clearData()
    })

    it('returns zeroed aggregates when empty', () => {
      const agg = getAggregates()
      expect(agg.totalToolCalls).toBe(0)
      expect(agg.totalApiCalls).toBe(0)
    })

    it('counts tool calls', () => {
      recordToolCall('Bash', 100)
      recordToolCall('Bash', 200)
      recordToolCall('Read', 50)
      const agg = getAggregates()
      expect(agg.totalToolCalls).toBe(3)
      expect(agg.toolCallCounts['Bash']).toBe(2)
      expect(agg.toolCallCounts['Read']).toBe(1)
    })

    it('sums tokens and cost', () => {
      recordApiCall('gpt-4', 1000, 500, 0.05, 1000)
      recordApiCall('gpt-4', 2000, 300, 0.03, 2000)
      const agg = getAggregates()
      expect(agg.totalApiCalls).toBe(2)
      expect(agg.totalTokensIn).toBe(3000)
      expect(agg.totalTokensOut).toBe(800)
      expect(agg.totalCost).toBeCloseTo(0.08, 4)
    })

    it('counts errors', () => {
      record({ type: 'tool_error', timestamp: new Date().toISOString(), tool: 'Bash', error: 'fail' })
      const agg = getAggregates()
      expect(agg.totalErrors).toBe(1)
    })

    it('tracks model usage', () => {
      recordApiCall('claude', 100, 50, 0.01, 500)
      recordApiCall('gpt-4', 200, 100, 0.02, 500)
      recordApiCall('claude', 100, 50, 0.01, 500)
      const agg = getAggregates()
      expect(agg.modelUsage['claude']).toBe(2)
      expect(agg.modelUsage['gpt-4']).toBe(1)
    })

    it('counts compacts', () => {
      record({ type: 'compact', timestamp: new Date().toISOString(), tokensIn: 50000, tokensOut: 5000 })
      record({ type: 'micro_compact', timestamp: new Date().toISOString() })
      const agg = getAggregates()
      expect(agg.totalCompacts).toBe(2)
    })
  })

  describe('clearData', () => {
    beforeEach(() => {
      setEnabled(true)
    })

    it('clears all events', () => {
      recordSessionStart()
      expect(getEvents().length).toBeGreaterThan(0)
      const cleared = clearData()
      expect(cleared).toBeGreaterThan(0)
      expect(getEvents()).toEqual([])
    })
  })

  describe('exportData', () => {
    beforeEach(() => {
      setEnabled(true)
      clearData()
    })

    it('exports config + events + aggregates', () => {
      recordSessionStart()
      const data = exportData()
      expect(data.config).toBeDefined()
      expect(data.events.length).toBeGreaterThan(0)
      expect(data.aggregates).toBeDefined()
    })
  })

  describe('formatting', () => {
    it('formatAggregates shows summary', () => {
      setEnabled(true)
      clearData()
      recordToolCall('Bash', 100)
      recordApiCall('gpt-4', 1000, 500, 0.05, 1000)
      const out = formatAggregates(getAggregates())
      expect(out).toContain('Telemetry Summary')
      expect(out).toContain('Tool calls: 1')
      expect(out).toContain('Bash')
    })

    it('formatConfig shows enabled', () => {
      const out = formatConfig({ enabled: true, maxEvents: 5000, detailed: true })
      expect(out).toContain('Enabled: ✓')
      expect(out).toContain('5,000')
    })

    it('formatConfig shows disabled', () => {
      const out = formatConfig({ enabled: false, maxEvents: 10000, detailed: false })
      expect(out).toContain('Enabled: ✗')
      expect(out).toContain('disabled')
    })

    it('formatEvent includes key fields', () => {
      const event: TelemetryEvent = {
        type: 'tool_call', timestamp: '2024-01-01T00:00:00Z',
        tool: 'Bash', durationMs: 1500, cost: 0.01,
      }
      const out = formatEvent(event)
      expect(out).toContain('tool_call')
      expect(out).toContain('Bash')
      expect(out).toContain('1500ms')
    })
  })
})

describe('telemetry store corruption guards', () => {
  it('config: backs up a corrupt file, then setEnabled rewrites real values', () => {
    const dir = join(homedir(), '.ovolv999')
    mkdirSync(dir, { recursive: true })
    const path = join(dir, 'telemetry-config.json')
    const backup = `${path}.corrupt`
    writeFileSync(path, '{"enabled": torn', 'utf8')

    expect(loadConfig()).toEqual({ ...DEFAULT_CONFIG })
    expect(readFileSync(backup, 'utf8')).toBe('{"enabled": torn')

    setEnabled(true)
    expect(loadConfig().enabled).toBe(true)
    expect(readFileSync(backup, 'utf8')).toBe('{"enabled": torn')
  })

  it('config: rejects shape-violating values (string enabled)', () => {
    const dir = join(homedir(), '.ovolv999')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'telemetry-config.json'), JSON.stringify({ enabled: 'yes' }), 'utf8')
    expect(loadConfig()).toEqual({ ...DEFAULT_CONFIG })
  })

  it('events: corrupt event history is backed up, not silently discarded', async () => {
    const { vi } = await import('vitest')
    const dir = join(homedir(), '.ovolv999')
    mkdirSync(dir, { recursive: true })
    const eventsPath = join(dir, 'telemetry.json')
    const backup = `${eventsPath}.corrupt`
    writeFileSync(eventsPath, '[{"type": torn', 'utf8')

    // Fresh module instance — loadBuffer latches `bufferLoaded`.
    vi.resetModules()
    const mod = await import('../src/core/telemetry.js')
    mod.setEnabled(true)
    mod.record({ type: 'tool_call', timestamp: new Date().toISOString(), tool: 'Bash', durationMs: 1 })

    expect(readFileSync(backup, 'utf8')).toBe('[{"type": torn')
    expect(mod.getEvents().length).toBe(1)
  })
})
