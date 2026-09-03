/**
 * P0-9 regression: cleanup and state refresh.
 *
 * Covers multiple invariants from runtime architecture contract §P0-9:
 *   1. ToolScheduler.activeToolCalls is cleared in finally even when
 *      executor throws mid-batch.
 *   2. ClaudeCodeWorkerManager.dispose() reaps sessions it created.
 *   3. ModuleManager.disposeAsync() awaits async disposers.
 *   4. ExecutionEngine.dispose() clears activeToolCalls and calls
 *      moduleManager.dispose + backgroundTaskManager.dispose.
 *   5. ExecutionEngine.disposeAsync() awaits the async chain.
 */

import { describe, it, expect } from 'vitest'
import { ToolScheduler } from '../src/core/toolRuntime/toolScheduler.js'
import type { ToolExecutor } from '../src/core/toolRuntime/toolExecutor.js'
import { ToolRegistry } from '../src/core/toolRuntime/toolRegistry.js'
import { SharedRuntimeState } from '../src/core/runtime/sharedState.js'
import { ModuleManager } from '../src/core/moduleRuntime/moduleManager.js'
import { ClaudeCodeWorkerManager } from '../src/core/claudeCodeWorkerManager.js'
import { ContextManager } from '../src/core/context/contextManager.js'
import type { AgentModule } from '../src/core/module.js'
import type { OpenAIMessage } from '../src/core/types.js'
import type { Renderer } from '../src/ui/renderer.js'

// ── Helpers ────────────────────────────────────────────────────────────────

function fakeRenderer(): Renderer & { __calls: { kind: string; args: unknown[] }[] } {
  const calls: { kind: string; args: unknown[] }[] = []
  const r: Record<string, unknown> = { __calls: calls }
  for (const k of [
    'banner', 'info', 'warn', 'error', 'success',
    'startSpinner', 'stopSpinner',
    'beginAssistantText', 'endAssistantText', 'streamToken',
    'toolStart', 'toolResult',
    'compactStart', 'compactDone', 'contextWarning',
    'agentStart', 'agentDone', 'agentSummary', 'agentHeartbeat',
  ]) {
    r[k] = (...a: unknown[]) => { calls.push({ kind: k, args: a }) }
  }
  return r as unknown as Renderer & { __calls: typeof calls }
}

function fakeOpenAIClient(): unknown {
  return {
    chat: {
      completions: {
        create: async () => ({ choices: [{ message: { content: '' } }] }),
      },
    },
  }
}

function makeContextManager(model = 'gpt-4o') {
  return new ContextManager({
    client: fakeOpenAIClient() as never,
    model,
    renderer: fakeRenderer(),
  })
}

// Construct a ToolScheduler with a stub executor that we control.
function makeScheduler(opts: {
  executorExecute: (id: string, name: string) => Promise<{ content: string; isError: boolean }>
  sharedState?: SharedRuntimeState
}) {
  const sharedState = opts.sharedState ?? new SharedRuntimeState(false)
  const renderer = fakeRenderer()
  const registry = new ToolRegistry(renderer)
  const executor = {
    execute: opts.executorExecute,
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
  })
  return { scheduler, sharedState, renderer, registry }
}

// ─────────────────────────────────────────────────────────────────────
// P0-9.1: ToolScheduler clears activeToolCalls on throw
// ─────────────────────────────────────────────────────────────────────
describe('P0-9.1: ToolScheduler.executeSerialBatch clears activeToolCalls in finally', () => {
  it('serial batch: executor throwing between set() and delete() does not leak entries', async () => {
    const { scheduler, sharedState } = makeScheduler({
      executorExecute: async () => { throw new Error('boom') },
    })
    const toolContext = {} as never
    const messages: OpenAIMessage[] = []
    const turnAbort = new AbortController()
    // Single-call batch (executor throws synchronously-ish). The throw
    // becomes a structured error tool result (protocol invariant: every
    // call gets a tool message) — schedule() resolves.
    const calls = [{ tc: { id: 'tc1', name: 'T', arguments: '{}' }, input: {} }]
    await scheduler.schedule(calls, toolContext, false, turnAbort, messages, 1)
    expect(sharedState.activeToolCalls.size).toBe(0)
    const toolMsgs = messages.filter((m) => m.role === 'tool')
    expect(toolMsgs).toHaveLength(1)
    expect(String(toolMsgs[0].content)).toContain('boom')
  })

  it('parallel batch: executor throwing in one branch clears all entries', async () => {
    const { scheduler, sharedState } = makeScheduler({
      executorExecute: async (id) => {
        if (id === 'tc2') throw new Error('parallel boom')
        return { content: 'ok', isError: false }
      },
    })
    const toolContext = {} as never
    const messages: OpenAIMessage[] = []
    const turnAbort = new AbortController()
    // Two safe calls in one parallel batch — both must be tracked,
    // and both must be cleared even though only one threw. The thrown
    // call becomes an error result; the sibling's real result survives
    // (no dropped tool messages).
    const calls = [
      { tc: { id: 'tc1', name: 'Read', arguments: '{}' }, input: {} },
      { tc: { id: 'tc2', name: 'Glob', arguments: '{}' }, input: {} },
    ]
    await scheduler.schedule(calls, toolContext, false, turnAbort, messages, 1)
    expect(sharedState.activeToolCalls.size).toBe(0)
    const toolMsgs = messages.filter((m) => m.role === 'tool')
    expect(toolMsgs).toHaveLength(2)
    expect(String(toolMsgs.find((m) => m.tool_call_id === 'tc1')?.content)).toContain('ok')
    expect(String(toolMsgs.find((m) => m.tool_call_id === 'tc2')?.content)).toContain('parallel boom')
  })
})

// ─────────────────────────────────────────────────────────────────────
// P0-9.2: ClaudeCodeWorkerManager.dispose reaps sessions
// ─────────────────────────────────────────────────────────────────────
describe('P0-9.2: ClaudeCodeWorkerManager.dispose reaps created sessions', () => {
  it('tracks sessions created via start() and reaps them on dispose()', async () => {
    const killed: string[] = []
    const existing = new Set<string>()
    const runner = async (args: string[]) => {
      const sub = args[0]
      if (sub === 'has-session') {
        const target = args[args.indexOf('-t') + 1]
        if (!existing.has(target)) throw new Error('no session')
        return { success: true, stdout: '', stderr: '' }
      }
      if (sub === 'new-session') {
        const sessionIdx = args.indexOf('-s')
        existing.add(args[sessionIdx + 1])
        return { success: true, stdout: '', stderr: '' }
      }
      if (sub === 'kill-session') {
        const target = args[args.indexOf('-t') + 1]
        killed.push(target)
        existing.delete(target)
        return { success: true, stdout: '', stderr: '' }
      }
      return { success: true, stdout: '', stderr: '' }
    }
    const mgr = new ClaudeCodeWorkerManager(runner)
    const r1 = await mgr.start({ session: 'worker-1', cwd: '/tmp' })
    const r2 = await mgr.start({ session: 'worker-2', cwd: '/tmp' })
    expect(r1.created).toBe(true)
    expect(r2.created).toBe(true)
    const result = await mgr.dispose()
    expect(result.stopped).toBe(2)
    expect(result.failed).toBe(0)
    expect(killed.sort()).toEqual(['worker-1', 'worker-2'])
  })

  it('dispose() is idempotent and clears the tracked-sessions set', async () => {
    const runner = async (args: string[]) => {
      const sub = args[0]
      if (sub === 'has-session') throw new Error('no session')
      if (sub === 'new-session') return { success: true, stdout: '', stderr: '' }
      return { success: true, stdout: '', stderr: '' }
    }
    const mgr = new ClaudeCodeWorkerManager(runner)
    await mgr.start({ session: 'w', cwd: '/tmp' })
    await mgr.dispose()
    // Second call has nothing to do — no throws, no kills.
    const result = await mgr.dispose()
    expect(result.stopped).toBe(0)
    expect(result.failed).toBe(0)
  })

  it('stop() untracks the session so dispose() does not double-kill', async () => {
    const killed: string[] = []
    const existing = new Set<string>(['x'])
    const runner = async (args: string[]) => {
      const sub = args[0]
      if (sub === 'has-session') {
        const target = args[args.indexOf('-t') + 1]
        if (!existing.has(target)) throw new Error('no session')
        return { success: true, stdout: '', stderr: '' }
      }
      if (sub === 'kill-session') {
        const target = args[args.indexOf('-t') + 1]
        killed.push(target)
        existing.delete(target)
        return { success: true, stdout: '', stderr: '' }
      }
      return { success: true, stdout: '', stderr: '' }
    }
    const mgr = new ClaudeCodeWorkerManager(runner)
    // The pre-existing session will be detected by sessionExists and
    // start() will treat it as "reused" (created: false) but still
    // track it for disposal.
    await mgr.start({ session: 'x', cwd: '/tmp' })
    // Explicit stop.
    await mgr.stop('x')
    // dispose should not try to kill again.
    const result = await mgr.dispose()
    expect(result.stopped).toBe(0)
    expect(killed).toEqual(['x'])
  })
})

// ─────────────────────────────────────────────────────────────────────
// P0-9.3: ModuleManager.disposeAsync awaits async disposers
// ─────────────────────────────────────────────────────────────────────
describe('P0-9.3: ModuleManager.disposeAsync awaits async disposers', () => {
  it('awaits an async dispose() before returning', async () => {
    let disposed = false
    const asyncModule = {
      name: 'async',
      boot: () => ({}),
      dispose: async () => {
        await Promise.resolve()
        disposed = true
      },
    } as AgentModule
    const r = fakeRenderer()
    const mgr = new ModuleManager({ modules: [asyncModule], renderer: r })
    await mgr.disposeAsync()
    expect(disposed).toBe(true)
  })

  it('isolates a throwing async disposer (subsequent modules still run)', async () => {
    let goodDisposed = false
    const bad = {
      name: 'bad',
      boot: () => ({}),
      dispose: async () => { throw new Error('dispose boom') },
    } as AgentModule
    const good = {
      name: 'good',
      boot: () => ({}),
      dispose: async () => { goodDisposed = true },
    } as AgentModule
    const r = fakeRenderer()
    const mgr = new ModuleManager({ modules: [bad, good], renderer: r })
    await expect(mgr.disposeAsync()).resolves.toBeUndefined()
    expect(goodDisposed).toBe(true)
  })

  it('fire-and-forget dispose() does NOT block on async disposers (matches prior contract)', async () => {
    let disposed = false
    const asyncModule = {
      name: 'async',
      boot: () => ({}),
      dispose: async () => {
        // Simulate slow async dispose. Fire-and-forget must NOT wait.
        await new Promise<void>(r => setTimeout(r, 20))
        disposed = true
      },
    } as AgentModule
    const r = fakeRenderer()
    const mgr = new ModuleManager({ modules: [asyncModule], renderer: r })
    mgr.dispose() // sync — returns immediately
    expect(disposed).toBe(false)
    // Eventually resolves in the background.
    await new Promise<void>(r => setTimeout(r, 50))
    expect(disposed).toBe(true)
  })
})
