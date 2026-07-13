import { describe, expect, it } from 'vitest'
import {
  buildClaudeWorkerPrompt,
  claudeWorkerSessionName,
  ClaudeCodeWorkerManager,
  type TmuxRunner,
} from '../src/core/claudeCodeWorkerManager.js'

function fakeRunner(handler?: (args: string[]) => { stdout?: string; stderr?: string } | void): {
  calls: string[][]
  runner: TmuxRunner
} {
  const calls: string[][] = []
  return {
    calls,
    runner: (args: string[]) => {
      calls.push(args)
      const result = handler?.(args)
      return Promise.resolve({ stdout: result?.stdout ?? '', stderr: result?.stderr ?? '' })
    },
  }
}

describe('ClaudeCodeWorkerManager', () => {
  it('sanitizes tmux session names', () => {
    expect(claudeWorkerSessionName(' worker 1 / test ')).toBe('worker-1---test')
    expect(claudeWorkerSessionName('')).toMatch(/^ovogo-claude-/)
  })

  it('builds a worker prompt with completion protocol', () => {
    const prompt = buildClaudeWorkerPrompt('Refactor settings loader', 'Only edit src/config/settings.ts')
    expect(prompt).toContain('[OVOGO WORKER TASK]')
    expect(prompt).toContain('Refactor settings loader')
    expect(prompt).toContain('Only edit src/config/settings.ts')
    expect(prompt).toContain('[DONE]')
    expect(prompt).toContain('Do not commit')
  })

  it('syncs only present Claude environment variables', async () => {
    const { calls, runner } = fakeRunner()
    const manager = new ClaudeCodeWorkerManager(runner)

    const synced = await manager.syncClaudeEnvironment('worker-1', {
      ANTHROPIC_AUTH_TOKEN: 'secret-token',
      ANTHROPIC_BASE_URL: 'https://example.test',
    })

    expect(synced).toEqual(['ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL'])
    expect(calls).toEqual([
      ['set-environment', '-t', 'worker-1', 'ANTHROPIC_AUTH_TOKEN', 'secret-token'],
      ['set-environment', '-t', 'worker-1', 'ANTHROPIC_BASE_URL', 'https://example.test'],
    ])
  })

  it('rejects multiline Claude environment variables', async () => {
    const { runner } = fakeRunner()
    const manager = new ClaudeCodeWorkerManager(runner)

    await expect(manager.syncClaudeEnvironment('worker-1', {
      ANTHROPIC_AUTH_TOKEN: 'line1\nline2',
    })).rejects.toThrow('multiline environment variable')
  })

  it('starts a new tmux session when missing', async () => {
    const { calls, runner } = fakeRunner((args) => {
      if (args[0] === 'has-session') throw new Error('missing')
    })
    const manager = new ClaudeCodeWorkerManager(runner)

    const result = await manager.start({ session: 'worker-1', cwd: '/repo', command: 'claude' })

    expect(result).toMatchObject({ session: 'worker-1', created: true })
    expect(calls).toContainEqual(['has-session', '-t', 'worker-1'])
    const newSession = calls.find((args) => args[0] === 'new-session')
    expect(newSession?.slice(0, 6)).toEqual(['new-session', '-d', '-s', 'worker-1', '-c', '/repo'])
    expect(newSession?.at(-1)).toBe('claude')
  })

  it('reuses an existing tmux session', async () => {
    const { calls, runner } = fakeRunner()
    const manager = new ClaudeCodeWorkerManager(runner)

    const result = await manager.start({ session: 'worker-1', cwd: '/repo' })

    expect(result).toMatchObject({ session: 'worker-1', created: false })
    expect(calls.some((args) => args[0] === 'new-session')).toBe(false)
  })

  it('sends text via tmux buffer and enter key', async () => {
    const { calls, runner } = fakeRunner()
    const manager = new ClaudeCodeWorkerManager(runner)

    await manager.send('worker-1', 'hello\nworld')

    expect(calls[0][0]).toBe('set-buffer')
    expect(calls[0]).toContain('hello\nworld')
    expect(calls[1][0]).toBe('paste-buffer')
    expect(calls[1]).toContain('worker-1')
    expect(calls[2]).toEqual(['send-keys', '-t', 'worker-1', 'Enter'])
    expect(calls[3]).toEqual(['send-keys', '-t', 'worker-1', 'Enter'])
    expect(calls[4][0]).toBe('delete-buffer')
  })

  it('runs a task by starting then sending the structured prompt', async () => {
    const { calls, runner } = fakeRunner((args) => {
      if (args[0] === 'has-session') throw new Error('missing')
    })
    const manager = new ClaudeCodeWorkerManager(runner)

    await manager.runTask({
      session: 'worker-1',
      cwd: '/repo',
      task: 'Add tests',
      instructions: 'Do not commit.',
    })

    const bufferCall = calls.find((args) => args[0] === 'set-buffer')
    expect(bufferCall?.join('\n')).toContain('Add tests')
    expect(bufferCall?.join('\n')).toContain('[DONE]')
  })

  it('captures pane output with bounded history', async () => {
    const { calls, runner } = fakeRunner(() => ({ stdout: 'line1\nline2\n' }))
    const manager = new ClaudeCodeWorkerManager(runner)

    await expect(manager.capture('worker-1', 20)).resolves.toBe('line1\nline2')
    expect(calls[0]).toEqual(['capture-pane', '-t', 'worker-1', '-p', '-S', '-20'])
  })

  it('waitFor requires the default DONE marker on its own line', async () => {
    const { runner } = fakeRunner(() => ({ stdout: 'inline [DONE] marker\n' }))
    const manager = new ClaudeCodeWorkerManager(runner)

    await expect(manager.waitFor({
      session: 'worker-1',
      timeoutMs: 10,
      intervalMs: 100,
    })).resolves.toMatchObject({ matched: false })
  })

  it('waitFor aborts through AbortSignal', async () => {
    const { runner } = fakeRunner(() => ({ stdout: 'still running\n' }))
    const manager = new ClaudeCodeWorkerManager(runner)
    const controller = new AbortController()
    controller.abort()

    await expect(manager.waitFor({
      session: 'worker-1',
      timeoutMs: 10_000,
      signal: controller.signal,
    })).resolves.toMatchObject({ matched: false, aborted: true })
  })

  it('waitFor reports invalid regex patterns clearly', async () => {
    const { runner } = fakeRunner()
    const manager = new ClaudeCodeWorkerManager(runner)

    await expect(manager.waitFor({
      session: 'worker-1',
      pattern: '[',
    })).rejects.toThrow('Invalid regex pattern')
  })

  it('rejects empty or whitespace-only text in send()', async () => {
    const { calls, runner } = fakeRunner()
    const manager = new ClaudeCodeWorkerManager(runner)

    await expect(manager.send('worker-1', '')).rejects.toThrow('Cannot send empty text')
    await expect(manager.send('worker-1', '   \n  ')).rejects.toThrow('Cannot send empty text')
    expect(calls.length).toBe(0)
  })

  it('falls back to safe line count when capture gets a non-finite value', async () => {
    const { calls, runner } = fakeRunner(() => ({ stdout: 'hello\n' }))
    const manager = new ClaudeCodeWorkerManager(runner)

    await expect(manager.capture('worker-1', Number.NaN)).resolves.toBe('hello')
    expect(calls[0]).toEqual(['capture-pane', '-t', 'worker-1', '-p', '-S', '-80'])
  })

  it('treats lines <= 0 as full history in capture', async () => {
    const { calls, runner } = fakeRunner(() => ({ stdout: 'pane output\n' }))
    const manager = new ClaudeCodeWorkerManager(runner)

    await expect(manager.capture('worker-1', 0)).resolves.toBe('pane output')
    expect(calls[0]).toEqual(['capture-pane', '-t', 'worker-1', '-p', '-S', '-'])
  })

  it('floor()s fractional line counts', async () => {
    const { calls, runner } = fakeRunner(() => ({ stdout: 'output\n' }))
    const manager = new ClaudeCodeWorkerManager(runner)

    await manager.capture('worker-1', 12.9)
    expect(calls[0]).toEqual(['capture-pane', '-t', 'worker-1', '-p', '-S', '-12'])
  })

  it('stop() is idempotent — returns stopped:false when session is gone', async () => {
    const { calls, runner } = fakeRunner((args) => {
      if (args[0] === 'has-session') throw new Error('missing')
    })
    const manager = new ClaudeCodeWorkerManager(runner)

    await expect(manager.stop('ghost')).resolves.toEqual({ stopped: false })
    expect(calls.some((c) => c[0] === 'kill-session')).toBe(false)
  })

  it('stop() returns stopped:true after kill-session', async () => {
    const { runner } = fakeRunner()
    const manager = new ClaudeCodeWorkerManager(runner)

    await expect(manager.stop('worker-1')).resolves.toEqual({ stopped: true })
  })

  it('listOrThrow() propagates tmux errors instead of swallowing them', async () => {
    const { runner } = fakeRunner(() => {
      throw new Error('tmux: command not found')
    })
    const manager = new ClaudeCodeWorkerManager(runner)

    await expect(manager.listOrThrow()).rejects.toThrow('tmux: command not found')
  })

  it('list() swallows tmux errors and returns [] for a clean fallback', async () => {
    const { runner } = fakeRunner(() => {
      throw new Error('tmux: command not found')
    })
    const manager = new ClaudeCodeWorkerManager(runner)

    await expect(manager.list()).resolves.toEqual([])
  })

  it('claudeWorkerSessionName produces a stable fallback when input is fully stripped', () => {
    const fallback = claudeWorkerSessionName('   /  ')
    expect(fallback).toMatch(/^ovogo-claude-\d+$/)
    // Trimming-only input collapses to a single dash that gets stripped
    const stripped = claudeWorkerSessionName('!!!')
    expect(stripped).toMatch(/^ovogo-claude-\d+$/)
  })
})
