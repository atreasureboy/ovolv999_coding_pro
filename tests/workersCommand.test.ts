import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { ClaudeCodeWorkerManager } from '../src/core/claudeCodeWorkerManager.js'
import {
  dispatchSlashCommand,
  type SlashCommandContext,
  type SlashCommandResult,
} from '../src/commands/index.js'
// Side-effect import — registers every built-in /command (including /workers).
import '../src/commands/builtin.js'
import { resetWorkerManager, setWorkerManager } from '../src/commands/builtin.js'

function fakeManager(overrides: Partial<ClaudeCodeWorkerManager> = {}): ClaudeCodeWorkerManager {
  return {
    syncClaudeEnvironment: () => Promise.resolve([]),
    sessionExists: () => Promise.resolve(true),
    start: () => Promise.resolve({ session: 'ovogo-claude-worker', created: true, syncedEnv: [] }),
    send: () => Promise.resolve(),
    runTask: () => Promise.resolve({ session: 'ovogo-claude-worker', created: true, syncedEnv: [] }),
    capture: () => Promise.resolve('output'),
    waitFor: () => Promise.resolve({ matched: true, output: '[DONE]' }),
    list: () => Promise.resolve(['ovogo-claude-worker']),
    listOrThrow: () => Promise.resolve(['ovogo-claude-worker']),
    stop: () => Promise.resolve({ stopped: true }),
    ...overrides,
  } as unknown as ClaudeCodeWorkerManager
}

function ctx(cwd = '/repo'): SlashCommandContext {
  return {
    engine: {} as SlashCommandContext['engine'],
    renderer: {} as SlashCommandContext['renderer'],
    history: [],
    cwd,
    setHistory: () => undefined,
    runPrompt: () => undefined,
  }
}

async function runWorkers(args: string, cwd = '/repo'): Promise<SlashCommandResult | null> {
  return dispatchSlashCommand(`/workers ${args}`.trim(), ctx(cwd))
}

function textOf(result: SlashCommandResult | null): string {
  if (!result || result.type !== 'text') throw new Error('expected text result, got ' + JSON.stringify(result))
  return result.value
}

describe('/workers slash command', () => {
  beforeEach(() => {
    // builtin.ts is statically imported above, so the /workers command is
    // already registered for this test file's lifetime. Reset only the
    // injected manager so each test gets a fresh fake.
    resetWorkerManager()
  })

  afterEach(() => {
    resetWorkerManager()
  })

  it('defaults to list when no subcommand is given', async () => {
    setWorkerManager(fakeManager({ list: () => Promise.resolve(['ovogo-claude-worker']) }))

    const result = await runWorkers('')
    const text = textOf(result)
    expect(text).toContain('Worker sessions:')
    expect(text).toContain('ovogo-claude-worker')
  })

  it('list filters out non-ovogo sessions and shows an empty message', async () => {
    setWorkerManager(fakeManager({
      list: () => Promise.resolve(['other-tool', 'ovogo-claude-worker']),
    }))
    const text = textOf(await runWorkers('list'))
    expect(text).toContain('ovogo-claude-worker')
    expect(text).not.toContain('other-tool')

    setWorkerManager(fakeManager({ list: () => Promise.resolve([]) }))
    const empty = textOf(await runWorkers('list'))
    expect(empty).toContain('No ovogo worker sessions')
  })

  it('start reports created vs reused and the synced env list', async () => {
    setWorkerManager(fakeManager({
      start: () => Promise.resolve({
        session: 'ovogo-claude-worker',
        created: true,
        syncedEnv: ['ANTHROPIC_API_KEY', 'ANTHROPIC_BASE_URL'],
      }),
    }))
    const text = textOf(await runWorkers('start'))
    expect(text).toContain('Worker: ovogo-claude-worker')
    expect(text).toContain('Status: started')
    expect(text).toContain('ANTHROPIC_API_KEY')
    expect(text).toContain('ANTHROPIC_BASE_URL')

    setWorkerManager(fakeManager({
      start: () => Promise.resolve({ session: 'ovogo-claude-worker', created: false, syncedEnv: [] }),
    }))
    const reused = textOf(await runWorkers('start'))
    expect(reused).toContain('Status: already running')
    expect(reused).toContain('Synced env: none')
  })

  it('start passes the cwd from the slash context to the manager', async () => {
    let seenCwd: string | undefined
    setWorkerManager(fakeManager({
      start: (options) => {
        seenCwd = options.cwd
        return Promise.resolve({ session: 'ovogo-claude-worker', created: true, syncedEnv: [] })
      },
    }))

    await runWorkers('start', '/tmp/project')
    expect(seenCwd).toBe('/tmp/project')
  })

  it('start honors an explicit session name from the command line', async () => {
    let seenSession: string | undefined
    setWorkerManager(fakeManager({
      start: (options) => {
        seenSession = options.session
        return Promise.resolve({ session: 'custom-name', created: true, syncedEnv: [] })
      },
    }))

    await runWorkers('start custom-name')
    expect(seenSession).toBe('custom-name')
  })

  it('capture reports a friendly error when the session is missing', async () => {
    setWorkerManager(fakeManager({
      sessionExists: (session) => Promise.resolve(session === 'ovogo-claude-worker'),
    }))

    const text = textOf(await runWorkers('capture ghost-session'))
    expect(text).toContain('Worker session not found')
    expect(text).toContain('ghost-session')
  })

  it('capture passes a numeric line count to the manager', async () => {
    let seenLines: number | undefined
    setWorkerManager(fakeManager({
      capture: (_session, lines) => {
        seenLines = lines
        return Promise.resolve('pane text')
      },
    }))

    const text = textOf(await runWorkers('capture ovogo-claude-worker 25'))
    expect(text).toBe('pane text')
    expect(seenLines).toBe(25)
  })

  it('capture falls back to 80 lines when the argument is non-numeric', async () => {
    let seenLines: number | undefined
    setWorkerManager(fakeManager({
      capture: (_session, lines) => {
        seenLines = lines
        return Promise.resolve('pane text')
      },
    }))

    await runWorkers('capture ovogo-claude-worker not-a-number')
    expect(seenLines).toBe(80)
  })

  it('capture uses 80 when no line count is supplied', async () => {
    let seenLines: number | undefined
    setWorkerManager(fakeManager({
      capture: (_session, lines) => {
        seenLines = lines
        return Promise.resolve('pane text')
      },
    }))

    await runWorkers('capture ovogo-claude-worker')
    expect(seenLines).toBe(80)
  })

  it('capture prints (no output) when the manager returns an empty string', async () => {
    setWorkerManager(fakeManager({ capture: () => Promise.resolve('') }))
    const text = textOf(await runWorkers('capture ovogo-claude-worker'))
    expect(text).toBe('(no output)')
  })

  it('stop requires an explicit session name', async () => {
    let stopCalls = 0
    setWorkerManager(fakeManager({
      stop: () => {
        stopCalls++
        return Promise.resolve({ stopped: true })
      },
    }))

    const text = textOf(await runWorkers('stop'))
    expect(text).toContain('Usage:')
    expect(stopCalls).toBe(0)
  })

  it('stop reports success when a session was actually killed', async () => {
    setWorkerManager(fakeManager({
      stop: () => Promise.resolve({ stopped: true }),
    }))

    const text = textOf(await runWorkers('stop ovogo-claude-worker'))
    expect(text).toBe('Stopped worker: ovogo-claude-worker')
  })

  it('stop reports a friendly message when the worker was not running', async () => {
    setWorkerManager(fakeManager({
      stop: () => Promise.resolve({ stopped: false }),
    }))

    const text = textOf(await runWorkers('stop ghost'))
    expect(text).toContain('Worker not running')
    expect(text).toContain('ghost')
  })

  it('wraps unexpected manager errors with a friendly prefix', async () => {
    setWorkerManager(fakeManager({
      list: () => Promise.reject(new Error('tmux is unavailable')),
    }))

    const text = textOf(await runWorkers('list'))
    expect(text).toContain('Workers command failed')
    expect(text).toContain('tmux is unavailable')
  })

  it('prints the usage line for unknown subcommands', async () => {
    setWorkerManager(fakeManager())

    const text = textOf(await runWorkers('explode'))
    expect(text).toContain('Usage:')
  })

  it('returns null when no slash prefix is used', async () => {
    setWorkerManager(fakeManager())
    const result = await dispatchSlashCommand('workers list', ctx())
    expect(result).toBeNull()
  })
})