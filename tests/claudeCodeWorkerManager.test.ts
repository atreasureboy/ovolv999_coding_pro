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

    const synced = await manager.syncClaudeEnvironment({
      ANTHROPIC_AUTH_TOKEN: 'secret-token',
      ANTHROPIC_BASE_URL: 'https://example.test',
    })

    expect(synced).toEqual(['ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL'])
    expect(calls).toEqual([
      ['set-environment', '-g', 'ANTHROPIC_AUTH_TOKEN', 'secret-token'],
      ['set-environment', '-g', 'ANTHROPIC_BASE_URL', 'https://example.test'],
    ])
  })

  it('starts a new tmux session when missing', async () => {
    const { calls, runner } = fakeRunner((args) => {
      if (args[0] === 'has-session') throw new Error('missing')
    })
    const manager = new ClaudeCodeWorkerManager(runner)

    const result = await manager.start({ session: 'worker-1', cwd: '/repo', command: 'claude' })

    expect(result).toMatchObject({ session: 'worker-1', created: true })
    expect(calls).toContainEqual(['has-session', '-t', 'worker-1'])
    expect(calls).toContainEqual(['new-session', '-d', '-s', 'worker-1', '-c', '/repo', 'claude'])
  })

  it('reuses an existing tmux session', async () => {
    const { calls, runner } = fakeRunner()
    const manager = new ClaudeCodeWorkerManager(runner)

    const result = await manager.start({ session: 'worker-1', cwd: '/repo' })

    expect(result).toMatchObject({ session: 'worker-1', created: false })
    expect(calls).not.toContainEqual(['new-session', '-d', '-s', 'worker-1', '-c', '/repo', 'claude'])
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
    expect(calls[3][0]).toBe('delete-buffer')
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
})
