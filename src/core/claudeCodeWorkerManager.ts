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
}

const DEFAULT_CLAUDE_COMMAND = 'claude'
const DEFAULT_DONE_PATTERN = '\\[DONE\\]'
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

  async syncClaudeEnvironment(env: NodeJS.ProcessEnv = process.env): Promise<string[]> {
    const synced: string[] = []
    for (const key of CLAUDE_ENV_KEYS) {
      const value = env[key]
      if (!value) continue
      await this.runner(['set-environment', '-g', key, value])
      synced.push(key)
    }
    return synced
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
    const syncedEnv = await this.syncClaudeEnvironment()
    if (await this.sessionExists(session)) {
      return { session, created: false, syncedEnv }
    }

    await this.runner([
      'new-session',
      '-d',
      '-s',
      session,
      '-c',
      options.cwd,
      options.command ?? DEFAULT_CLAUDE_COMMAND,
    ])
    return { session, created: true, syncedEnv }
  }

  async send(session: string, text: string): Promise<void> {
    const buffer = `ovogo-${Date.now()}-${Math.random().toString(16).slice(2)}`
    await this.runner(['set-buffer', '-b', buffer, text])
    try {
      await this.runner(['paste-buffer', '-t', session, '-b', buffer])
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
    const start = lines <= 0 ? '-' : `-${Math.max(1, Math.floor(lines))}`
    const { stdout } = await this.runner(['capture-pane', '-t', session, '-p', '-S', start])
    return stdout.trim()
  }

  async waitFor(options: ClaudeWorkerWaitOptions): Promise<{ matched: boolean; output: string }> {
    const pattern = options.pattern ?? DEFAULT_DONE_PATTERN
    const timeoutMs = Math.max(1, options.timeoutMs ?? 120_000)
    const intervalMs = Math.max(100, options.intervalMs ?? 2_000)
    const deadline = Date.now() + timeoutMs
    const regex = new RegExp(pattern)
    let output = ''

    while (Date.now() <= deadline) {
      output = await this.capture(options.session, options.lines ?? 120)
      if (regex.test(output)) return { matched: true, output }
      await new Promise((resolve) => setTimeout(resolve, intervalMs))
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

  async stop(session: string): Promise<void> {
    await this.runner(['kill-session', '-t', session])
  }
}
