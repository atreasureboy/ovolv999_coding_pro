/**
 * Phase 1 (five_goal §一/§二): Engine dependency assembly audit.
 *
 * Verifies that the Engine constructor wires ALL infrastructure in
 * the correct order:
 *   - ExecutionRunRegistry always exists (not gated on persistence)
 *   - createTools receives the registry (AgentTool + ClaudeCodeTool)
 *   - ResourceScheduler is instantiated and passed to ToolScheduler
 *   - AgentTool.runRegistry is non-undefined in the production wiring
 *   - ClaudeCodeTool.runRegistry is non-undefined in the production wiring
 *   - ToolScheduler.deps.resourceScheduler is non-undefined
 *
 * These tests construct a REAL Engine (not a mock coordinator) and
 * inspect its internal wiring to prove the main execution chain is
 * connected end-to-end.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { tmpdir } from 'os'
import { mkdtempSync, rmSync } from 'fs'
import { ExecutionEngine } from '../src/core/engine.js'
import { ExecutionRunRegistry } from '../src/core/executionRun.js'
import { ResourceScheduler } from '../src/core/resourceScheduler.js'
import type { AgentTool, ClaudeCodeTool } from '../src/tools/index.js'
import type { EngineConfig } from '../src/core/types.js'
import type { Renderer } from '../src/ui/renderer.js'

let tmpDir = ''
beforeEach(() => { tmpDir = mkdtempSync(`${tmpdir()}/engine-wire-`) })
afterEach(() => { rmSync(tmpDir, { recursive: true, force: true }) })

const noopRenderer: Renderer = {
  raw: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  userMessage: () => {},
  assistantMessage: () => {},
  toolCall: () => {},
  toolResult: () => {},
  cost: () => {},
  compactionNotice: () => {},
  turnEnd: () => {},
  planModeHeader: () => {},
} as never

function makeConfig(overrides: Partial<EngineConfig> = {}): EngineConfig {
  return {
    model: 'test-model',
    apiKey: 'test-key',
    baseURL: 'http://localhost:9999',
    cwd: tmpDir,
    maxContextTokens: 4096,
    maxOutputTokens: 1024,
    ...overrides,
  } as EngineConfig
}

describe('Phase 1: Engine wires Registry into Tools + ResourceScheduler into ToolScheduler', () => {
  it('getRunRegistry() returns a non-null ExecutionRunRegistry even without persistence', () => {
    const engine = new ExecutionEngine(makeConfig(), noopRenderer)
    const reg = engine.getRunRegistry()
    expect(reg).toBeInstanceOf(ExecutionRunRegistry)
    expect(reg).toBeDefined()
    engine.dispose()
  })

  it('getRunRegistry() returns a non-null registry even WITH persistence configured', () => {
    const engine = new ExecutionEngine(
      makeConfig({ executionRunLogDir: tmpDir }),
      noopRenderer,
    )
    const reg = engine.getRunRegistry()
    expect(reg).toBeInstanceOf(ExecutionRunRegistry)
    engine.dispose()
  })

  it('getResourceScheduler() returns a non-null ResourceScheduler', () => {
    const engine = new ExecutionEngine(makeConfig(), noopRenderer)
    const rs = engine.getResourceScheduler()
    expect(rs).toBeInstanceOf(ResourceScheduler)
    expect(rs).toBeDefined()
    engine.dispose()
  })

  it('AgentTool in the production tool list has a non-undefined runRegistry', () => {
    const engine = new ExecutionEngine(makeConfig(), noopRenderer)
    const tools = engine.getTools()
    const agent = tools.find((t) => t.name === 'Agent') as AgentTool
    expect(agent).toBeDefined()
    const reg = (agent as unknown as { runRegistry: unknown }).runRegistry
    expect(reg).toBeDefined()
    expect(reg).toBeInstanceOf(ExecutionRunRegistry)
    engine.dispose()
  })

  it('ClaudeCodeTool in the production tool list has a non-undefined runRegistry', () => {
    const engine = new ExecutionEngine(makeConfig(), noopRenderer)
    const tools = engine.getTools()
    const claude = tools.find((t) => t.name === 'ClaudeCode') as ClaudeCodeTool
    expect(claude).toBeDefined()
    const reg = (claude as unknown as { runRegistry: unknown }).runRegistry
    expect(reg).toBeDefined()
    expect(reg).toBeInstanceOf(ExecutionRunRegistry)
    engine.dispose()
  })

  it('ToolScheduler has a non-undefined resourceScheduler dep', () => {
    const engine = new ExecutionEngine(makeConfig(), noopRenderer)
    const scheduler = engine.getToolScheduler()
    const deps = (scheduler as unknown as { deps: { resourceScheduler?: ResourceScheduler } }).deps
    expect(deps.resourceScheduler).toBeDefined()
    expect(deps.resourceScheduler).toBeInstanceOf(ResourceScheduler)
    engine.dispose()
  })

  it('Registry + ResourceScheduler + Tools form a consistent triad', () => {
    const engine = new ExecutionEngine(makeConfig(), noopRenderer)
    const reg = engine.getRunRegistry()
    const rs = engine.getResourceScheduler()
    expect(reg).toBeDefined()
    expect(rs).toBeDefined()
    const tools = engine.getTools()
    const agent = tools.find((t) => t.name === 'Agent') as AgentTool
    const agentReg = (agent as unknown as { runRegistry: unknown }).runRegistry
    expect(agentReg).toBe(engine.getRunRegistry())
    engine.dispose()
  })
})
