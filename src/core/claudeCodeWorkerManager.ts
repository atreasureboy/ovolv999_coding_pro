import { execFile as execFileCb } from 'child_process'
import { promisify } from 'util'

const execFile = promisify(execFileCb)

export interface TmuxResult {
  stdout: string
  stderr: string
}

export type TmuxRunner = (args: string[]) => Promise<TmuxResult>

export interface ClaudeWorkerStartOptions {
  session: string
  cwd: string
  command?: string
}

export interface ClaudeWorkerTaskOptions extends ClaudeWorkerStartOptions {
  task: string
  instructions?: string
}

export interface ClaudeWorkerWaitOptions {
  session: string
  pattern?: string
  timeoutMs?: number
  intervalMs?: number
  lines?: number
  signal?: AbortSignal
}

export interface ClaudeWorkerWaitResult {
  matched: boolean
  output: string
  aborted?: boolean
}

const DEFAULT_CLAUDE_COMMAND = 'claude'
const DEFAULT_DONE_PATTERN = '^\\[DONE\\]$'
const CLAUDE_ENV_KEYS = [
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_BASE_URL',
  'ANTHROPIC_MODEL',
  'ANTHROPIC_DEFAULT_SONNET_MODEL',
  'ANTHROPIC_DEFAULT_OPUS_MODEL',
  'ANTHROPIC_DEFAULT_HAIKU_MODEL',
  'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC',
]

function collectClaudeEnvironment(env: NodeJS.ProcessEnv): Array<[string, string]> {
  const entries: Array<[string, string]> = []
  for (const key of CLAUDE_ENV_KEYS) {
    const value = env[key]
    if (!value) continue
    if (value.includes('\n')) {
      throw new Error(`Refusing to sync multiline environment variable: ${key}`)
    }
    entries.push([key, value])
  }
  return entries
}

export function claudeWorkerSessionName(name: string): string {
  const clean = name
    .trim()
    .replace(/[^a-zA-Z0-9_.-]/g, '-')
    .replace(/^-+|-+$/g, '')
  return clean || `ovogo-claude-${Date.now()}`
}

export function buildClaudeWorkerPrompt(task: string, instructions?: string): string {
  return [
    '[OVOGO WORKER TASK]',
    '',
    'You are a Claude Code worker controlled by a supervisor agent.',
    'Follow the task exactly. Keep changes narrowly scoped.',
    'Do not commit. Do not push. Do not modify unrelated files.',
    'When complete, print a final block that starts with [DONE].',
    '',
    '[TASK]',
    task,
    '',
    instructions ? '[INSTRUCTIONS]\n' + instructions + '\n' : '',
    '[FINAL OUTPUT FORMAT]',
    '[DONE]',
    'Summary:',
    'Files:',
    'Tests:',
  ].filter(Boolean).join('\n')
}

function compilePattern(pattern: string): RegExp {
  try {
    return new RegExp(pattern, 'm')
  } catch {
    throw new Error('Invalid regex pattern: ' + pattern)
  }
}

function delay(ms: number, signal?: AbortSignal): Promise<'done' | 'aborted'> {
  if (signal?.aborted) return Promise.resolve('aborted')
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve('done')
    }, ms)
    const onAbort = () => {
      clearTimeout(timer)
      resolve('aborted')
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

async function defaultTmuxRunner(args: string[]): Promise<TmuxResult> {
  try {
    const { stdout, stderr } = await execFile('tmux', args, {
      encoding: 'utf8',
      maxBuffer: 1024 * 1024,
    })
    return { stdout, stderr }
  } catch (error: unknown) {
    const err = error as { stdout?: string; stderr?: string; message?: string }
    const message = [err.stdout, err.stderr, err.message].filter(Boolean).join('\n').trim()
    throw new Error(message || String(error), { cause: error })
  }
}

export class ClaudeCodeWorkerManager {
  constructor(private readonly runner: TmuxRunner = defaultTmuxRunner) {}

  async syncClaudeEnvironment(session: string, env: NodeJS.ProcessEnv = process.env): Promise<string[]> {
    const entries = collectClaudeEnvironment(env)
    for (const [key, value] of entries) {
      await this.runner(['set-environment', '-t', session, key, value])
    }
    return entries.map(([key]) => key)
  }

  async sessionExists(session: string): Promise<boolean> {
    try {
      await this.runner(['has-session', '-t', session])
      return true
    } catch {
      return false
    }
  }

  async start(options: ClaudeWorkerStartOptions): Promise<{ session: string; created: boolean; syncedEnv: string[] }> {
    const session = claudeWorkerSessionName(options.session)
    const envEntries = collectClaudeEnvironment(process.env)
    const syncedEnv = envEntries.map(([key]) => key)
    if (await this.sessionExists(session)) {
      await this.syncClaudeEnvironment(session)
      return { session, created: false, syncedEnv }
    }

    await this.runner([
      'new-session',
      '-d',
      '-s',
      session,
      '-c',
      options.cwd,
      ...envEntries.flatMap(([key, value]) => ['-e', `${key}=${value}`]),
      options.command ?? DEFAULT_CLAUDE_COMMAND,
    ])
    return { session, created: true, syncedEnv }
  }

  async send(session: string, text: string): Promise<void> {
    if (!text || !text.trim()) {
      throw new Error('Cannot send empty text to worker')
    }
    const buffer = `ovogo-${Date.now()}-${Math.random().toString(16).slice(2)}`
    await this.runner(['set-buffer', '-b', buffer, text])
    try {
      await this.runner(['paste-buffer', '-t', session, '-b', buffer])
      await this.runner(['send-keys', '-t', session, 'Enter'])
      // Claude Code's terminal editor may keep the pasted text staged after the
      // first Enter. A second Enter reliably submits while a blank follow-up is
      // ignored by the idle prompt.
      await this.runner(['send-keys', '-t', session, 'Enter'])
    } finally {
      try {
        await this.runner(['delete-buffer', '-b', buffer])
      } catch {
        // best-effort cleanup; stale buffers are harmless and small
      }
    }
  }

  async runTask(options: ClaudeWorkerTaskOptions): Promise<{ session: string; created: boolean; syncedEnv: string[] }> {
    const started = await this.start(options)
    await this.send(started.session, buildClaudeWorkerPrompt(options.task, options.instructions))
    return started
  }

  async capture(session: string, lines = 80): Promise<string> {
    const safeLines = Number.isFinite(lines) ? lines : 80
    const start = safeLines <= 0 ? '-' : `-${Math.max(1, Math.floor(safeLines))}`
    const { stdout } = await this.runner(['capture-pane', '-t', session, '-p', '-S', start])
    return stdout.trim()
  }

  async waitFor(options: ClaudeWorkerWaitOptions): Promise<ClaudeWorkerWaitResult> {
    const pattern = options.pattern ?? DEFAULT_DONE_PATTERN
    const timeoutMs = Math.max(1, options.timeoutMs ?? 120_000)
    const intervalMs = Math.max(100, options.intervalMs ?? 2_000)
    const deadline = Date.now() + timeoutMs
    const regex = compilePattern(pattern)
    let output = ''

    while (Date.now() <= deadline) {
      if (options.signal?.aborted) return { matched: false, output, aborted: true }
      output = await this.capture(options.session, options.lines ?? 120)
      if (regex.test(output)) return { matched: true, output }
      const remainingMs = deadline - Date.now()
      if (remainingMs <= 0) break
      const state = await delay(Math.min(intervalMs, remainingMs), options.signal)
      if (state === 'aborted') return { matched: false, output, aborted: true }
    }

    return { matched: false, output }
  }

  async list(): Promise<string[]> {
    try {
      const { stdout } = await this.runner(['list-sessions', '-F', '#S'])
      return stdout.split('\n').map((line) => line.trim()).filter(Boolean)
    } catch {
      return []
    }
  }

  /** Like `list()` but throws when tmux itself is unreachable. */
  async listOrThrow(): Promise<string[]> {
    const { stdout } = await this.runner(['list-sessions', '-F', '#S'])
    return stdout.split('\n').map((line) => line.trim()).filter(Boolean)
  }

  /**
   * Kill a tmux session.  Idempotent — returns `{ stopped: false }` when the
   * session is already gone so callers don't need a pre-check.
   */
  async stop(session: string): Promise<{ stopped: boolean }> {
    if (!await this.sessionExists(session)) return { stopped: false }
    await this.runner(['kill-session', '-t', session])
    return { stopped: true }
  }
}
