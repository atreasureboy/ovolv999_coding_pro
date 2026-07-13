import { describe, expect, it } from 'vitest'
import type { ClaudeCodeWorkerManager } from '../src/core/claudeCodeWorkerManager.js'
import { ClaudeCodeTool } from '../src/tools/claudeCode.js'
import type { ToolContext } from '../src/core/types.js'

function context(signal?: AbortSignal): ToolContext {
  return { cwd: '/', permissionMode: 'auto', signal }
}

function fakeManager(overrides: Partial<ClaudeCodeWorkerManager> = {}): ClaudeCodeWorkerManager {
  return {
    syncClaudeEnvironment: () => Promise.resolve([]),
    sessionExists: () => Promise.resolve(true),
    start: () => Promise.resolve({ session: 'worker-1', created: true, syncedEnv: [] }),
    send: () => Promise.resolve(),
    runTask: () => Promise.resolve({ session: 'worker-1', created: true, syncedEnv: [] }),
    capture: () => Promise.resolve('output'),
    waitFor: () => Promise.resolve({ matched: true, output: '[DONE]\nSummary: ok' }),
    list: () => Promise.resolve(['worker-1']),
    stop: () => Promise.resolve(),
    ...overrides,
  } as unknown as ClaudeCodeWorkerManager
}

describe('ClaudeCodeTool', () => {
  it('only treats capture and list as concurrency safe', () => {
    const tool = new ClaudeCodeTool(fakeManager())

    expect(tool.isConcurrencySafe({ action: 'capture' })).toBe(true)
    expect(tool.isConcurrencySafe({ action: 'list' })).toBe(true)
    expect(tool.isConcurrencySafe({ action: 'run' })).toBe(false)
    expect(tool.isConcurrencySafe({ action: 'stop' })).toBe(false)
  })

  it('returns a friendly error when capture session is missing', async () => {
    const tool = new ClaudeCodeTool(fakeManager({ sessionExists: () => Promise.resolve(false) }))

    const result = await tool.execute({ action: 'capture', session: 'missing' }, context())

    expect(result.isError).toBe(true)
    expect(result.content).toContain('session not found')
    expect(result.content).toContain('missing')
  })

  it('passes AbortSignal to waitFor', async () => {
    let seenSignal: AbortSignal | undefined
    const controller = new AbortController()
    const tool = new ClaudeCodeTool(fakeManager({
      waitFor: (options) => {
        seenSignal = options.signal
        return Promise.resolve({ matched: false, output: '', aborted: true })
      },
    }))

    await tool.execute({ action: 'wait', session: 'worker-1' }, context(controller.signal))

    expect(seenSignal).toBe(controller.signal)
  })

  it('uses sane default timeout when timeoutMs is invalid', async () => {
    let seenTimeout: number | undefined
    const tool = new ClaudeCodeTool(fakeManager({
      waitFor: (options) => {
        seenTimeout = options.timeoutMs
        return Promise.resolve({ matched: true, output: '[DONE]' })
      },
    }))

    await tool.execute({ action: 'wait', session: 'worker-1', timeoutMs: 'nope' }, context())

    expect(seenTimeout).toBe(120_000)
  })

  it('stop reports a friendly error when the session is gone', async () => {
    const tool = new ClaudeCodeTool(fakeManager({
      sessionExists: () => Promise.resolve(false),
      stop: () => Promise.resolve({ stopped: false }),
    }))

    const result = await tool.execute({ action: 'stop', session: 'ghost' }, context())

    expect(result.isError).toBe(true)
    expect(result.content).toContain('session not found')
    expect(result.content).toContain('ghost')
  })

  it('stop returns success when the worker was running', async () => {
    let calledSession: string | undefined
    const tool = new ClaudeCodeTool(fakeManager({
      stop: (session) => {
        calledSession = session
        return Promise.resolve({ stopped: true })
      },
    }))

    const result = await tool.execute({ action: 'stop', session: 'worker-1' }, context())

    expect(result.isError).toBe(false)
    expect(result.content).toContain('Stopped')
    expect(calledSession).toBe('worker-1')
  })

  it('send requires non-empty text', async () => {
    const tool = new ClaudeCodeTool(fakeManager())

    const result = await tool.execute({ action: 'send', session: 'worker-1', text: '' }, context())

    expect(result.isError).toBe(true)
    expect(result.content).toContain('text is required')
  })

  it('send surfaces a friendly error when the session is missing', async () => {
    const tool = new ClaudeCodeTool(fakeManager({ sessionExists: () => Promise.resolve(false) }))

    const result = await tool.execute({ action: 'send', session: 'ghost', text: 'hi' }, context())

    expect(result.isError).toBe(true)
    expect(result.content).toContain('session not found')
  })

  it('run requires a non-empty task', async () => {
    const tool = new ClaudeCodeTool(fakeManager())

    const result = await tool.execute({ action: 'run', session: 'worker-1', task: '' }, context())

    expect(result.isError).toBe(true)
    expect(result.content).toContain('task is required')
  })

  it('capture coerces NaN lines into the default 80', async () => {
    let seenLines: number | undefined
    const tool = new ClaudeCodeTool(fakeManager({
      capture: (_session, lines) => {
        seenLines = lines
        return Promise.resolve('pane output')
      },
    }))

    const result = await tool.execute({ action: 'capture', session: 'worker-1', lines: 'oops' }, context())

    expect(result.isError).toBe(false)
    expect(result.content).toBe('pane output')
    expect(seenLines).toBe(80)
  })

  it('list reports when there are no sessions', async () => {
    const tool = new ClaudeCodeTool(fakeManager({ list: () => Promise.resolve([]) }))

    const result = await tool.execute({ action: 'list' }, context())

    expect(result.isError).toBe(false)
    expect(result.content).toContain('No active tmux sessions')
  })

  it('list renders each session name on its own line', async () => {
    const tool = new ClaudeCodeTool(fakeManager({ list: () => Promise.resolve(['ovogo-a', 'ovogo-b']) }))

    const result = await tool.execute({ action: 'list' }, context())

    expect(result.isError).toBe(false)
    expect(result.content).toContain('ovogo-a')
    expect(result.content).toContain('ovogo-b')
  })

  it('wraps unexpected manager errors with a friendly prefix', async () => {
    const tool = new ClaudeCodeTool(fakeManager({
      start: () => Promise.reject(new Error('tmux blew up')),
    }))

    const result = await tool.execute({ action: 'start', session: 'worker-1' }, context())

    expect(result.isError).toBe(true)
    expect(result.content).toContain('ClaudeCode error')
    expect(result.content).toContain('tmux blew up')
  })

  it('rejects unknown actions with an explicit error', async () => {
    const tool = new ClaudeCodeTool(fakeManager())

    const result = await tool.execute({ action: 'explode' }, context())

    expect(result.isError).toBe(true)
    expect(result.content).toContain('Unknown action')
  })

  it('wait abort message is preserved in the output', async () => {
    const tool = new ClaudeCodeTool(fakeManager({
      waitFor: () => Promise.resolve({ matched: false, output: 'partial work', aborted: true }),
    }))

    const result = await tool.execute({ action: 'wait', session: 'worker-1' }, context())

    expect(result.isError).toBe(true)
    expect(result.content).toContain('Aborted')
    expect(result.content).toContain('partial work')
  })
})
