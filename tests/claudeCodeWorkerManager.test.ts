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
    const prompt = buildClaudeWorkerPrompt('Refactor settings loader', 'Only edit src/config/settings.ts', 'fixed-id')
    // P0-5: prompt is now task-id-bound. The header sentinel is
    // [TASK_START <id>] and the completion sentinel is [TASK_DONE <id>],
    // so a reused tmux session cannot satisfy waitFor() with a stale
    // [DONE] from a previous run.
    expect(prompt).toContain('[TASK_START fixed-id]')
    expect(prompt).toContain('Refactor settings loader')
    expect(prompt).toContain('Only edit src/config/settings.ts')
    expect(prompt).toContain('[TASK_DONE fixed-id]')
    expect(prompt).toContain('Do not commit')
    // Legacy [DONE] sentinel must NOT appear (would re-introduce the
    // false-positive-on-reuse bug).
    expect(prompt).not.toMatch(/^\[DONE\]$/m)
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

    const result = await manager.runTask({
      session: 'worker-1',
      cwd: '/repo',
      task: 'Add tests',
      instructions: 'Do not commit.',
    })

    const bufferCall = calls.find((args) => args[0] === 'set-buffer')
    expect(bufferCall?.join('\n')).toContain('Add tests')
    // P0-5: the prompt now contains [TASK_DONE <id>] (not bare [DONE])
    // and runTask returns the taskId so waitFor() can bind to it.
    expect(bufferCall?.join('\n')).toMatch(/\[TASK_DONE [0-9a-f-]+\]/)
    expect(result.taskId).toMatch(/^[0-9a-f-]+$/)
  })

  it('P0-5: runTask uses caller-provided taskId verbatim', async () => {
    const { calls, runner } = fakeRunner((args) => {
      if (args[0] === 'has-session') throw new Error('missing')
    })
    const manager = new ClaudeCodeWorkerManager(runner)

    const result = await manager.runTask({
      session: 'worker-stable',
      cwd: '/repo',
      task: 'stable task',
      taskId: 'stable-id-123',
    })

    expect(result.taskId).toBe('stable-id-123')
    const bufferCall = calls.find((args) => args[0] === 'set-buffer')
    expect(bufferCall?.join('\n')).toContain('[TASK_START stable-id-123]')
    expect(bufferCall?.join('\n')).toContain('[TASK_DONE stable-id-123]')
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

  // ─────────────────────────────────────────────────────────────────
  // P0-5 regression: task-id-bound completion prevents stale [DONE]
  // ─────────────────────────────────────────────────────────────────

  it('P0-5: waitFor(taskId) does NOT match a stale [TASK_DONE] from a different task', async () => {
    // Simulate a reused tmux pane whose history still contains the
    // PREVIOUS task's completion sentinel. Pre-fix, this caused
    // waitFor()'s first poll iteration to match immediately and
    // report a success that had never happened.
    const { runner } = fakeRunner(() => ({
      stdout: '[TASK_START old-task-id]\n...work...\n[TASK_DONE old-task-id]\n',
    }))
    const manager = new ClaudeCodeWorkerManager(runner)
    await expect(manager.waitFor({
      session: 'worker-1',
      taskId: 'new-task-id',
      timeoutMs: 10,
      intervalMs: 5,
    })).resolves.toMatchObject({ matched: false })
  })

  it('P0-5: waitFor(taskId) DOES match the [TASK_DONE <id>] line for THIS task', async () => {
    const { runner } = fakeRunner(() => ({
      stdout: 'progress...\n[TASK_DONE my-fresh-id]\nSummary: ok\n',
    }))
    const manager = new ClaudeCodeWorkerManager(runner)
    await expect(manager.waitFor({
      session: 'worker-1',
      taskId: 'my-fresh-id',
      timeoutMs: 50,
      intervalMs: 5,
    })).resolves.toMatchObject({ matched: true })
  })

  it('P0-5: waitFor(taskId) ignores inline substrings (anchored match)', async () => {
    // The summary prose mentions "[TASK_DONE my-id]" mid-line. The
    // anchored ^...$ pattern must NOT match.
    const { runner } = fakeRunner(() => ({
      stdout: 'I will print [TASK_DONE my-id] when done.\nstill working\n',
    }))
    const manager = new ClaudeCodeWorkerManager(runner)
    await expect(manager.waitFor({
      session: 'worker-1',
      taskId: 'my-id',
      timeoutMs: 10,
      intervalMs: 5,
    })).resolves.toMatchObject({ matched: false })
  })

  it('P0-5: legacy callers passing pattern (no taskId) still work as before', async () => {
    // Backwards-compat: callers that haven't migrated to taskId get
    // the pre-fix behavior verbatim (matches DEFAULT_DONE_PATTERN).
    const { runner } = fakeRunner(() => ({ stdout: 'irrelevant\n[DONE]\n' }))
    const manager = new ClaudeCodeWorkerManager(runner)
    await expect(manager.waitFor({
      session: 'worker-1',
      timeoutMs: 50,
      intervalMs: 5,
    })).resolves.toMatchObject({ matched: true })
  })

  it('P0-5: caller-supplied pattern still wins over taskId', async () => {
    // Documented precedence: pattern > taskId > DEFAULT_DONE_PATTERN.
    // A caller that supplies BOTH explicitly wants the custom pattern.
    const { runner } = fakeRunner(() => ({ stdout: 'CUSTOM_MARKER_X\n' }))
    const manager = new ClaudeCodeWorkerManager(runner)
    await expect(manager.waitFor({
      session: 'worker-1',
      taskId: 'never-appears',
      pattern: '^CUSTOM_MARKER_X$',
      timeoutMs: 50,
      intervalMs: 5,
    })).resolves.toMatchObject({ matched: true })
  })
})
