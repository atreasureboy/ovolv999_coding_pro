/**
 * v0.6.1 regression — ToolExecutor single finalizer (v0.5.6 §7).
 *
 * Every tool path (success, unknown tool, policy deny, permission deny)
 * MUST record its result in the per-run toolCallRegistry and emit
 * TOOL_COMPLETED exactly once. The MemoryModule validates tool_observed
 * evidence against this registry, so an unwired finalizer silently
 * rejects every memory candidate as "unknown toolCallId".
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { tmpdir } from 'os'
import { mkdtempSync, rmSync } from 'fs'
import { join } from 'path'
import OpenAI from 'openai'

import { ToolExecutor } from '../src/core/toolRuntime/toolExecutor.js'
import { ToolRegistry } from '../src/core/toolRuntime/toolRegistry.js'
import { ToolPolicy } from '../src/core/toolRuntime/toolPolicy.js'
import { PermissionManager } from '../src/core/permissionSystem.js'
import { ContextManager } from '../src/core/context/contextManager.js'
import { EventLog } from '../src/core/eventLog.js'
import { RunEventEmitter } from '../src/core/runtime/events.js'
import type { RegisteredToolResult } from '../src/core/runtime/runScopedContext.js'
import type { Tool, ToolContext } from '../src/core/types.js'
import type { Renderer } from '../src/ui/renderer.js'

let tmpDir = ''
beforeEach(() => {
  tmpDir = mkdtempSync(`${tmpdir()}/registry-`)
})
afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true })
})

const noopRenderer: Renderer = {
  raw: () => {}, info: () => {}, warn: () => {}, error: () => {},
  userMessage: () => {}, assistantMessage: () => {}, toolCall: () => {},
  toolResult: () => {}, cost: () => {}, compactionNotice: () => {},
  turnEnd: () => {}, planModeHeader: () => {},
} as never

function fakeTool(name: string, content: string, isError = false): Tool {
  return {
    name,
    definition: {
      type: 'function',
      function: {
        name,
        description: 'fake tool',
        parameters: { type: 'object', properties: {} },
      },
    },
    execute: async () => ({ content, isError }),
  }
}

function makeHarness(tools: Tool[]) {
  const registry = new ToolRegistry(noopRenderer)
  registry.reset(tools, [])
  const toolCallRegistry = new Map<string, RegisteredToolResult>()
  const eventEmitter = new RunEventEmitter()
  const eventLog = new EventLog(join(tmpDir, 'events.jsonl'))
  const client = new OpenAI({ apiKey: 'test', baseURL: 'http://localhost:0' })
  const contextManager = new ContextManager({
    client,
    model: 'test-model',
    maxContextTokens: 4096,
    maxOutputTokens: 1024,
    renderer: noopRenderer,
  })
  const executor = new ToolExecutor({
    toolRegistry: registry,
    toolPolicy: new ToolPolicy({}),
    permissionManager: new PermissionManager(),
    contextManager,
    notifyToolCall: () => {},
    renderer: noopRenderer,
    eventEmitter,
    eventLog,
    sharedState: { toolCallRegistry },
  })
  const signal = new AbortController().signal
  const context: ToolContext = {
    cwd: tmpDir,
    signal,
    permissionMode: 'bypassPermissions',
    execution: { runId: 'run-1', workspaceId: 'ws-1', workspacePath: tmpDir, signal },
  }
  return { executor, toolCallRegistry, eventEmitter, eventLog, context }
}

describe('ToolExecutor finalizer wires the per-run toolCallRegistry', () => {
  it('records successful tool results with original and exposed text', async () => {
    const { executor, toolCallRegistry, eventEmitter, context } = makeHarness([
      fakeTool('Echo', 'hello registry'),
    ])
    const completed: string[] = []
    eventEmitter.on('TOOL_COMPLETED', (e) => completed.push(e.callId))

    const result = await executor.execute('call-1', 'Echo', {}, context, false, 1)

    expect(result.content).toBe('hello registry')
    const entry = toolCallRegistry.get('call-1')
    expect(entry).toBeDefined()
    expect(entry!.runId).toBe('run-1')
    expect(entry!.toolName).toBe('Echo')
    expect(entry!.originalText).toBe('hello registry')
    expect(entry!.exposedText).toBe('hello registry')
    expect(entry!.isError).toBe(false)
    expect(entry!.truncated).toBe(false)
    expect(completed).toEqual(['call-1'])
  })

  it('records unknown-tool rejections', async () => {
    const { executor, toolCallRegistry, context } = makeHarness([])

    const result = await executor.execute('call-unknown', 'Nope', {}, context, false, 1)

    expect(result.isError).toBe(true)
    const entry = toolCallRegistry.get('call-unknown')
    expect(entry).toBeDefined()
    expect(entry!.isError).toBe(true)
    expect(entry!.exposedText).toContain('Unknown tool')
  })

  it('marks truncated results and keeps the marker in exposedText', async () => {
    const big = 'x'.repeat(30_000)
    const { executor, toolCallRegistry, context } = makeHarness([fakeTool('Big', big)])

    const result = await executor.execute('call-big', 'Big', {}, context, false, 1)

    expect(result.content.length).toBeLessThan(big.length)
    const entry = toolCallRegistry.get('call-big')
    expect(entry).toBeDefined()
    expect(entry!.truncated).toBe(true)
    expect(entry!.originalText.length).toBe(30_000)
    expect(entry!.exposedText.length).toBeLessThan(30_000)
  })

  it('rejects duplicate callIds without overwriting and logs an audit event', async () => {
    const { executor, toolCallRegistry, eventLog, context } = makeHarness([
      fakeTool('Echo', 'first'),
    ])

    await executor.execute('call-dup', 'Echo', {}, context, false, 1)
    await executor.execute('call-dup', 'Echo', {}, context, false, 1)

    expect(toolCallRegistry.get('call-dup')!.exposedText).toBe('first')
    const duplicates = eventLog
      .readAll()
      .filter((e) => e.type === 'tool_result_duplicate_call_id')
    expect(duplicates.length).toBe(1)
    expect(duplicates[0].detail.callId).toBe('call-dup')
  })

  it('satisfies the memory promotion contract (exposedText contains resultQuote)', async () => {
    const { classifyAgentInferredEvidence } = await import('../src/core/memoryCandidate.js')
    const { executor, toolCallRegistry, context } = makeHarness([
      fakeTool('Echo', 'package version is 0.6.1'),
    ])

    await executor.execute('call-mem', 'Echo', {}, context, false, 1)

    const verdict = classifyAgentInferredEvidence(
      [{ kind: 'tool_result', toolCallId: 'call-mem', resultQuote: 'version is 0.6.1' }],
      { toolCallRegistry },
    )
    expect(verdict.ok).toBe(true)
    if (verdict.ok) expect(verdict.strong).toBe('tool_result')
  })
})
