/**
 * Phase 4 (five_goal §八 P1-1, P1-2, P1-3):
 *
 * ResourceScheduler integration into ToolScheduler. Previously the
 * scheduler was optional / standalone — tools declared claims but
 * nothing honored them. Now:
 *
 *   P1-1: ToolScheduler accepts a `resourceScheduler` dep. Each tool
 *         call with declared claims is wrapped in acquire/release.
 *   P1-2: Acquire happens before execute; release happens in finally
 *         on every exit path (success, throw, abort, timeout). No
 *         path may leak a lock.
 *   P1-3: Atomic all-or-nothing acquire prevents deadlocks even when
 *         two tools ask for file1+file2 and file2+file1.
 */

import { describe, it, expect } from 'vitest'
import { ToolScheduler } from '../src/core/toolRuntime/toolScheduler.js'
import { ToolExecutor } from '../src/core/toolRuntime/toolExecutor.js'
import { ToolRegistry } from '../src/core/toolRuntime/toolRegistry.js'
import { SharedRuntimeState } from '../src/core/runtime/sharedState.js'
import { ContextManager } from '../src/core/context/contextManager.js'
import {
  ResourceScheduler,
  ResourceConflictError,
} from '../src/core/resourceScheduler.js'
import type { ResourceClaim } from '../src/core/executionRun.js'
import type { Tool, OpenAIMessage, ToolResult } from '../src/core/types.js'
import type { Renderer } from '../src/ui/renderer.js'

// ── Helpers ─────────────────────────────────────────────────────────────

function fakeRenderer(): Renderer {
  const r: Record<string, unknown> = {}
  for (const k of [
    'banner', 'info', 'warn', 'error', 'success',
    'startSpinner', 'stopSpinner',
    'beginAssistantText', 'endAssistantText', 'streamToken',
    'toolStart', 'toolResult',
    'compactStart', 'compactDone', 'contextWarning',
    'agentStart', 'agentDone', 'agentSummary', 'agentHeartbeat',
  ]) {
    r[k] = (...a: unknown[]) => undefined
  }
  return r as unknown as Renderer
}

function fakeOpenAIClient(): unknown {
  return { chat: { completions: { create: async () => ({ choices: [{ message: { content: '' } }] }) } } }
}

function makeContextManager() {
  return new ContextManager({
    client: fakeOpenAIClient() as never,
    model: 'm',
    renderer: fakeRenderer(),
  })
}

/** A tool that declares resource claims. */
function makeClaimTool(
  name: string,
  claimBuilder: (input: Record<string, unknown>) => ResourceClaim[],
  body: (input: Record<string, unknown>) => Promise<ToolResult> | ToolResult,
): Tool {
  return {
    name,
    metadata: { claims: claimBuilder },
    definition: {
      type: 'function',
      function: {
        name,
        description: `claim-declaring tool: ${name}`,
        parameters: { type: 'object', properties: {}, required: [] },
      },
    },
    async execute(input) {
      return body(input)
    },
    isConcurrencySafe: () => true,
  }
}

function makeScheduler(opts: {
  tools?: Tool[]
  resourceScheduler?: ResourceScheduler
  executorExecute?: (id: string, name: string, input: Record<string, unknown>) => Promise<ToolResult>
}) {
  const sharedState = new SharedRuntimeState(false)
  const renderer = fakeRenderer()
  const registry = new ToolRegistry(renderer)
  const tools = opts.tools ?? []
  for (const t of tools) registry.register(t)
  // Default: dispatch to the matching tool's execute method.
  const defaultExec = async (_id: string, name: string, input: Record<string, unknown>) => {
    const t = tools.find(x => x.name === name)
    if (!t) return { content: `unknown tool: ${name}`, isError: true }
    return t.execute(input, {} as never)
  }
  const executor = {
    execute: opts.executorExecute ?? defaultExec,
  } as unknown as ToolExecutor
  const scheduler = new ToolScheduler({
    executor,
    toolRegistry: registry,
    renderer,
    eventLog: undefined,
    hookRunner: undefined,
    contextManager: makeContextManager(),
    sharedState,
    eventEmitter: undefined,
    claimSoftAbort: () => false,
    resourceScheduler: opts.resourceScheduler,
  })
  return { scheduler, sharedState, registry }
}

// ─────────────────────────────────────────────────────────────────────
// P1-2: acquire before execute; release after (success path)
// ─────────────────────────────────────────────────────────────────────
describe('P1-2: ToolScheduler acquires + releases claims around execute', () => {
  it('acquires the declared claims before execute and releases after', async () => {
    const rs = new ResourceScheduler()
    const acquired: string[] = []
    let holdingsDuringExecute: number = -1

    const tool = makeClaimTool(
      'Edit',
      (input) => [{ type: 'file', key: String(input.path), access: 'write' }],
      async () => {
        holdingsDuringExecute = rs.snapshotHoldings().length
        return { content: 'edited', isError: false }
      },
    )
    const { scheduler } = makeScheduler({
      tools: [tool],
      resourceScheduler: rs,
      executorExecute: async (id, name, input) => {
        acquired.push(name)
        return tool.execute(input, {} as never)
      },
    })

    const messages: OpenAIMessage[] = []
    await scheduler.schedule(
      [{ tc: { id: 'tc1', name: 'Edit', arguments: JSON.stringify({ path: '/a' }) }, input: { path: '/a' } }],
      { cwd: '/r', permissionMode: 'auto' } as never,
      false,
      new AbortController(),
      messages,
      1,
    )

    expect(acquired).toEqual(['Edit'])
    // During execute the file was held.
    expect(holdingsDuringExecute).toBe(1)
    // After execute the lock is gone.
    expect(rs.snapshotHoldings().length).toBe(0)
  })

  it('releases claims even when execute throws', async () => {
    const rs = new ResourceScheduler()
    const tool = makeClaimTool(
      'Edit',
      (input) => [{ type: 'file', key: String(input.path), access: 'write' }],
      async () => { throw new Error('tool crashed') },
    )
    const { scheduler } = makeScheduler({
      tools: [tool],
      resourceScheduler: rs,
    })

    const messages: OpenAIMessage[] = []
    await expect(
      scheduler.schedule(
        [{ tc: { id: 'tc1', name: 'Edit', arguments: '{}' }, input: { path: '/a' } }],
        { cwd: '/r', permissionMode: 'auto' } as never,
        false,
        new AbortController(),
        messages,
        1,
      ),
    ).rejects.toThrow('tool crashed')

    // Critical: lock was released despite the throw.
    expect(rs.snapshotHoldings().length).toBe(0)
  })

  it('does NOT execute when acquire fails (conflict) — surfaces as blocked tool result', async () => {
    const rs = new ResourceScheduler()
    // Pre-acquire a conflicting write lock from a different runId.
    await rs.acquire('other-run', [{ type: 'file', key: '/a', access: 'write' }])

    let executed = false
    const tool = makeClaimTool(
      'Edit',
      (input) => [{ type: 'file', key: String(input.path), access: 'write' }],
      async () => { executed = true; return { content: 'should not run', isError: false } },
    )
    const { scheduler } = makeScheduler({
      tools: [tool],
      resourceScheduler: rs,
      // Use very short timeout so we don't hang the test.
    })

    // Override default timeout via constructor — set to 100ms.
    const rs2 = new ResourceScheduler({ defaultTimeoutMs: 100 })
    await rs2.acquire('other-run', [{ type: 'file', key: '/a', access: 'write' }])
    const { scheduler: scheduler2 } = makeScheduler({
      tools: [tool],
      resourceScheduler: rs2,
    })

    const messages: OpenAIMessage[] = []
    await scheduler2.schedule(
      [{ tc: { id: 'tc1', name: 'Edit', arguments: '{}' }, input: { path: '/a' } }],
      { cwd: '/r', permissionMode: 'auto' } as never,
      false,
      new AbortController(),
      messages,
      1,
    )

    expect(executed).toBe(false)
    // Tool result was surfaced as blocked (isError:true).
    expect(messages[0]?.content).toMatch(/blocked/)
    expect(messages[0]?.content).toMatch(/resource unavailable/)
  })
})

// ─────────────────────────────────────────────────────────────────────
// P1-3: deadlock avoidance — atomic acquire
// ─────────────────────────────────────────────────────────────────────
describe('P1-3: deadlock avoidance via atomic acquire', () => {
  it('two tools claiming file1+file2 and file2+file1 do not deadlock', async () => {
    const rs = new ResourceScheduler({ defaultTimeoutMs: 1000 })
    const callOrder: string[] = []

    const toolAB = makeClaimTool(
      'AB',
      () => [
        { type: 'file', key: '/file1', access: 'write' },
        { type: 'file', key: '/file2', access: 'write' },
      ],
      async () => {
        callOrder.push('AB-start')
        await new Promise(r => setTimeout(r, 50))
        callOrder.push('AB-end')
        return { content: 'AB', isError: false }
      },
    )
    const toolBA = makeClaimTool(
      'BA',
      () => [
        { type: 'file', key: '/file2', access: 'write' },
        { type: 'file', key: '/file1', access: 'write' },
      ],
      async () => {
        callOrder.push('BA-start')
        await new Promise(r => setTimeout(r, 50))
        callOrder.push('BA-end')
        return { content: 'BA', isError: false }
      },
    )

    const { scheduler } = makeScheduler({
      tools: [toolAB, toolBA],
      resourceScheduler: rs,
    })

    // Run them concurrently — atomic acquire guarantees one waits
    // for the other rather than both holding partial locks.
    const messages: OpenAIMessage[] = []
    await scheduler.schedule(
      [
        { tc: { id: 'tc1', name: 'AB', arguments: '{}' }, input: {} },
        { tc: { id: 'tc2', name: 'BA', arguments: '{}' }, input: {} },
      ],
      { cwd: '/r', permissionMode: 'auto' } as never,
      false,
      new AbortController(),
      messages,
      1,
    )

    // Both completed (no deadlock).
    expect(callOrder).toContain('AB-end')
    expect(callOrder).toContain('BA-end')
    // Locks fully released.
    expect(rs.snapshotHoldings().length).toBe(0)
  })

  it('abort signal releases the waiter and any partial hold', async () => {
    const rs = new ResourceScheduler({ defaultTimeoutMs: 10_000 })
    // Pre-hold /a exclusively from another run.
    await rs.acquire('other', [{ type: 'file', key: '/a', access: 'exclusive' }])

    const ac = new AbortController()
    const tool = makeClaimTool(
      'Edit',
      () => [{ type: 'file', key: '/a', access: 'write' }],
      async () => ({ content: 'ok', isError: false }),
    )
    const { scheduler } = makeScheduler({
      tools: [tool],
      resourceScheduler: rs,
    })

    // Schedule and abort after a short delay.
    const messages: OpenAIMessage[] = []
    const p = scheduler.schedule(
      [{ tc: { id: 'tc1', name: 'Edit', arguments: '{}' }, input: {} }],
      { cwd: '/r', permissionMode: 'auto', signal: ac.signal } as never,
      false,
      ac,
      messages,
      1,
    )
    setTimeout(() => ac.abort(), 50)
    await p

    // No leak — even though the waiter was waiting, abort released it.
    expect(rs.waiterCount()).toBe(0)
    expect(rs.snapshotHoldings().filter(h => h.runId !== 'other').length).toBe(0)
  })

  it('timeout releases the waiter (no partial lock)', async () => {
    const rs = new ResourceScheduler({ defaultTimeoutMs: 80 })
    await rs.acquire('other', [{ type: 'file', key: '/a', access: 'exclusive' }])

    const tool = makeClaimTool(
      'Edit',
      () => [{ type: 'file', key: '/a', access: 'write' }],
      async () => ({ content: 'ok', isError: false }),
    )
    const { scheduler } = makeScheduler({
      tools: [tool],
      resourceScheduler: rs,
    })

    const messages: OpenAIMessage[] = []
    await scheduler.schedule(
      [{ tc: { id: 'tc1', name: 'Edit', arguments: '{}' }, input: {} }],
      { cwd: '/r', permissionMode: 'auto' } as never,
      false,
      new AbortController(),
      messages,
      1,
    )

    // Waiter cleaned up after timeout.
    expect(rs.waiterCount()).toBe(0)
    expect(rs.snapshotHoldings().filter(h => h.runId !== 'other').length).toBe(0)
  })
})

// ─────────────────────────────────────────────────────────────────────
// P1-1: tools without claims bypass the scheduler (back-compat)
// ─────────────────────────────────────────────────────────────────────
describe('P1-1: tools without claims bypass the scheduler', () => {
  it('tool with no claims field executes normally without contacting scheduler', async () => {
    const rs = new ResourceScheduler()
    let executed = false
    const tool: Tool = {
      name: 'NoClaims',
      metadata: { concurrencySafe: true },
      definition: {
        type: 'function',
        function: {
          name: 'NoClaims',
          description: 'no claims',
          parameters: { type: 'object', properties: {}, required: [] },
        },
      },
      async execute() {
        executed = true
        return { content: 'ok', isError: false }
      },
      isConcurrencySafe: () => true,
    }
    const { scheduler } = makeScheduler({ tools: [tool], resourceScheduler: rs })

    const messages: OpenAIMessage[] = []
    await scheduler.schedule(
      [{ tc: { id: 'tc1', name: 'NoClaims', arguments: '{}' }, input: {} }],
      { cwd: '/r', permissionMode: 'auto' } as never,
      false,
      new AbortController(),
      messages,
      1,
    )

    expect(executed).toBe(true)
    expect(rs.snapshotHoldings().length).toBe(0)
  })

  it('no resourceScheduler wired — legacy behavior preserved', async () => {
    let executed = false
    const tool = makeClaimTool(
      'Edit',
      () => [{ type: 'file', key: '/a', access: 'write' }],
      async () => { executed = true; return { content: 'ok', isError: false } },
    )
    const { scheduler } = makeScheduler({ tools: [tool] })

    const messages: OpenAIMessage[] = []
    await scheduler.schedule(
      [{ tc: { id: 'tc1', name: 'Edit', arguments: '{}' }, input: {} }],
      { cwd: '/r', permissionMode: 'auto' } as never,
      false,
      new AbortController(),
      messages,
      1,
    )

    expect(executed).toBe(true)
  })
})
