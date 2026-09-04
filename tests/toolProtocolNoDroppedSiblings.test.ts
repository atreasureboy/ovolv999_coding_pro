/**
 * Tool-protocol invariant regression: EVERY tool call must produce a tool
 * message, even when a sibling (or the call itself) escapes with a throw.
 *
 * The scheduler previously used Promise.all over the parallel batch — one
 * rejection dropped the results of ALL calls in the batch, so the next
 * llm_call sent assistant tool_calls with no matching tool messages, which
 * OpenAI-compatible providers hard-reject (400). One throwing hook, module
 * listener, or permission prompt could kill an otherwise healthy turn.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { tmpdir } from 'os'
import { mkdtempSync, rmSync } from 'fs'
import OpenAI from 'openai'

import { ToolScheduler } from '../src/core/toolRuntime/toolScheduler.js'
import { ToolExecutor } from '../src/core/toolRuntime/toolExecutor.js'
import { ToolRegistry } from '../src/core/toolRuntime/toolRegistry.js'
import { ToolPolicy } from '../src/core/toolRuntime/toolPolicy.js'
import { PermissionManager } from '../src/core/permissionSystem.js'
import { ContextManager } from '../src/core/context/contextManager.js'
import { SharedRuntimeState } from '../src/core/runtime/sharedState.js'
import type { Tool, ToolContext, OpenAIMessage } from '../src/core/types.js'
import type { Renderer } from '../src/ui/renderer.js'
import type { RegisteredToolResult } from '../src/core/runtime/runScopedContext.js'

let tmpDir = ''
beforeEach(() => {
  tmpDir = mkdtempSync(`${tmpdir()}/protocol-`)
})
afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true })
})

const noopRenderer = {
  raw: () => {}, info: () => {}, warn: () => {}, error: () => {},
  userMessage: () => {}, assistantMessage: () => {}, toolCall: () => {},
  toolStart: () => {}, toolStop: () => {},
  toolResult: () => {}, cost: () => {}, compactionNotice: () => {},
  turnEnd: () => {}, planModeHeader: () => {},
} as never as Renderer

function makeTool(name: string, claims: () => unknown[], behavior: 'ok' | 'throw'): Tool {
  return {
    name,
    metadata: { claims },
    definition: {
      type: 'function',
      function: { name, description: 'probe', parameters: { type: 'object', properties: {} } },
    },
    execute: async () => {
      if (behavior === 'throw') throw new Error(`boom-${name}`)
      return { content: `ok-${name}`, isError: false }
    },
  } as unknown as Tool
}

function call(name: string, id: string): { tc: { id: string; name: string; arguments: string }; input: Record<string, unknown> } {
  return { tc: { id, name, arguments: '{}' }, input: {} }
}

function makeScheduler(tools: Tool[], opts?: { notifyThrows?: boolean; promptThrows?: boolean; escapeCallId?: string }) {
  const registry = new ToolRegistry(noopRenderer)
  registry.reset(tools, [])
  const client = new OpenAI({ apiKey: 'test', baseURL: 'http://localhost:0' })
  const contextManager = new ContextManager({
    client,
    model: 'test-model',
    maxContextTokens: 4096,
    maxOutputTokens: 1024,
    renderer: noopRenderer,
  })
  const toolCallRegistry = new Map<string, RegisteredToolResult>()
  const executor = opts?.escapeCallId
    ? // Simulates a throw ESCAPING executor.execute() (hook/prompt/renderer
      // escape paths that predate the executor hardening) — the scheduler
      // contract under test: an escaped call must not corrupt the batch.
      ({
        execute: async (callId: string) => {
          if (callId === opts.escapeCallId) throw new Error(`escaped-${callId}`)
          return { content: 'ok-escape-sibling', isError: false }
        },
      } as unknown as ToolExecutor)
    : new ToolExecutor({
        toolRegistry: registry,
        toolPolicy: new ToolPolicy({}),
        permissionManager: {
          check: () => 'ask',
          formatMode: () => 'default',
        } as unknown as PermissionManager,
        contextManager,
        notifyToolCall: opts?.notifyThrows
          ? () => { throw new Error('module listener exploded') }
          : () => {},
        requestPermission: opts?.promptThrows
          ? async () => { throw new Error('readline closed') }
          : async () => ({ approved: true }),
        renderer: noopRenderer,
        sharedState: { toolCallRegistry },
      })
  const scheduler = new ToolScheduler({
    executor,
    toolRegistry: registry,
    renderer: noopRenderer,
    contextManager,
    sharedState: new SharedRuntimeState(false),
    claimSoftAbort: () => false,
  })
  const signal = new AbortController().signal
  const toolContext: ToolContext = {
    cwd: tmpDir,
    signal,
    permissionMode: 'default',
    execution: { runId: 'run-1', workspaceId: 'ws-1', workspacePath: tmpDir, signal },
  }
  return { scheduler, toolContext, toolCallRegistry }
}

const toolMessages = (messages: OpenAIMessage[]): OpenAIMessage[] =>
  messages.filter((m) => m.role === 'tool')

describe('tool-protocol invariant: no dropped tool messages', () => {
  it('parallel batch: one throwing sibling does not drop the others’ results', async () => {
    // Distinct read claims → both calls join ONE parallel batch.
    const a = makeTool('ProbeA', () => [{ type: 'file', key: 'a.txt', access: 'read' }], 'ok')
    const b = makeTool('ProbeB', () => [{ type: 'file', key: 'b.txt', access: 'read' }], 'ok')
    const { scheduler, toolContext } = makeScheduler([a, b], { escapeCallId: 'tc_b' })
    const messages: OpenAIMessage[] = []

    const { aborted } = await scheduler.schedule(
      [call('ProbeA', 'tc_a'), call('ProbeB', 'tc_b')],
      toolContext, false, new AbortController(), messages, 1,
    )

    expect(aborted).toBe(false)
    const results = toolMessages(messages)
    expect(results).toHaveLength(2)
    expect(results.map((m) => m.content)).toContain('ok-escape-sibling')
    const failed = results.find((m) => m.tool_call_id === 'tc_b')
    expect(String(failed?.content)).toContain('tool execution failed')
    expect(String(failed?.content)).toContain('escaped-tc_b')
  })

  it('serial batch: an escaped throw becomes a structured error result', async () => {
    // No claims → serial by contract §六.3.
    const bad = makeTool('ProbeBad', () => [], 'ok')
    const { scheduler, toolContext } = makeScheduler([bad], { escapeCallId: 'tc_bad' })
    const messages: OpenAIMessage[] = []

    await scheduler.schedule(
      [call('ProbeBad', 'tc_bad')],
      toolContext, false, new AbortController(), messages, 1,
    )

    const results = toolMessages(messages)
    expect(results).toHaveLength(1)
    expect(String(results[0].content)).toContain('escaped-tc_bad')
    expect(String(results[0].content)).toContain('tool execution failed')
  })

  it('executor survives a throwing module notifyToolCall and keeps the real result', async () => {
    const ok = makeTool('ProbeOk', () => [], 'ok')
    const { scheduler, toolContext } = makeScheduler([ok], { notifyThrows: true })
    const messages: OpenAIMessage[] = []

    await scheduler.schedule([call('ProbeOk', 'tc_ok')], toolContext, false, new AbortController(), messages, 1)

    const results = toolMessages(messages)
    expect(results).toHaveLength(1)
    expect(results[0].content).toBe('ok-ProbeOk')
  })

  it('a throwing permission prompt fails CLOSED as a deny, not a rejection', async () => {
    const ok = makeTool('ProbeAsk', () => [], 'ok')
    const { scheduler, toolContext } = makeScheduler([ok], { promptThrows: true })
    const messages: OpenAIMessage[] = []

    await scheduler.schedule([call('ProbeAsk', 'tc_ask')], toolContext, false, new AbortController(), messages, 1)

    const results = toolMessages(messages)
    expect(results).toHaveLength(1)
    expect(String(results[0].content)).toContain('permission prompt failed')
  })
})
