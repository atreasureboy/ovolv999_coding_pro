/**
 * TmuxSession — 交互式终端会话管理工具
 *
 * 解决"本地交互式进程（Python REPL / Node.js / 交互式 CLI 等）无法程序化控制"的问题。
 * 传统 Bash 工具遇到交互式提示符会挂满超时。
 * TmuxSession 将进程运行在 tmux 后台会话中，通过 send-keys 注入输入，
 * 通过 capture-pane 捕获输出，用 wait_for 等待特定提示符出现。
 *
 * 典型流程（Python REPL）：
 *   1. TmuxSession({ action: "new", session: "python", command: "python3" })
 *   2. TmuxSession({ action: "wait_for", session: "python", pattern: ">>>" })
 *   3. TmuxSession({ action: "send", session: "python", text: "print('hello')" })
 *   4. TmuxSession({ action: "capture", session: "python", lines: 10 })
 */

import { exec as execCb } from 'child_process'
import { promisify } from 'util'
import type { Tool, ToolContext, ToolDefinition, ToolResult } from '../core/types.js'
import type { ResourceClaim } from '../core/executionRun.js'
import { str } from '../core/strings.js'

const exec = promisify(execCb)

/** Run a tmux sub-command and return stdout+stderr */
async function tmux(args: string): Promise<string> {
  try {
    const { stdout, stderr } = await exec(`tmux ${args}`)
    return (stdout + stderr).trim()
  } catch (e: unknown) {
    const err = e as { stdout?: string; stderr?: string; message?: string }
    const out = ((err.stdout ?? '') + (err.stderr ?? '')).trim()
    throw new Error(out || err.message || String(e), { cause: e })
  }
}

/** Check if a tmux session exists */
async function sessionExists(name: string): Promise<boolean> {
  try {
    await exec(`tmux has-session -t ${shellEsc(name)} 2>/dev/null`)
    return true
  } catch {
    return false
  }
}

/** Shell-escape a single argument (wrap in single quotes, escape internal single quotes) */
function shellEsc(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`
}

/** Split text into ≤50-char chunks for safe send-keys paste */
function chunkText(text: string, size = 50): string[] {
  const chunks: string[] = []
  for (let i = 0; i < text.length; i += size) {
    chunks.push(text.slice(i, i + size))
  }
  return chunks
}

export class TmuxSessionTool implements Tool {
  name = 'TmuxSession'
  metadata = { mutatesState: true, concurrencySafe: true, longRunning: true, claims: (): ResourceClaim[] => [{ type: 'process', key: 'tmux-session', access: 'exclusive' as const }] }

  definition: ToolDefinition = {
    type: 'function',
    function: {
      name: 'TmuxSession',
      description: `Manage local interactive terminal sessions (tmux) for processes requiring two-way interaction (Python REPL, Node.js, interactive CLIs).

## Actions

| action   | purpose |
|----------|---------|
| new      | Create a tmux session with optional initial command |
| send     | Send text to session (auto-appends Enter, chunks long text) |
| keys     | Send special keys (C-c / C-d / Escape / Enter) |
| capture  | Capture session screen or history (last N lines) |
| wait_for | Poll until output matches a regex pattern (wait for prompt) |
| list     | List all tmux sessions |
| kill     | Destroy a session |

## Standard Workflow

### Python REPL
\`\`\`
TmuxSession({ action: "new", session: "py", command: "python3" })
TmuxSession({ action: "wait_for", session: "py", pattern: ">>>" })
TmuxSession({ action: "send", session: "py", text: "import os; print(os.getcwd())" })
TmuxSession({ action: "capture", session: "py", lines: 10 })
\`\`\`

### Interrupt stuck process
\`\`\`
TmuxSession({ action: "keys", session: "py", key: "C-c" })
TmuxSession({ action: "capture", session: "py", lines: 5 })
\`\`\``,
      parameters: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            enum: ['new', 'send', 'keys', 'capture', 'wait_for', 'list', 'kill'],
            description: 'Operation type',
          },
          session: {
            type: 'string',
            description: 'Session name (created on "new", referenced by others). Use semantic names: py / node / cli-1',
          },
          command: {
            type: 'string',
            description: '(new) Command to run on session start, e.g. "python3". Empty creates a bare shell',
          },
          text: {
            type: 'string',
            description: '(send) Text to send, auto-appends Enter. Long text is chunked into 50-byte segments',
          },
          key: {
            type: 'string',
            description: '(keys) Special key names: C-c / C-d / Escape / Enter / Up / Down / Tab. Space-separated for multiple',
          },
          lines: {
            type: 'number',
            description: '(capture) Return last N lines of output, default 50. Set to 0 for full history (may be large)',
          },
          pattern: {
            type: 'string',
            description: '(wait_for) Regex pattern to wait for, e.g. ">>>" / "ready" / "\\\\$"',
          },
          timeout: {
            type: 'number',
            description: '(wait_for) Max wait in milliseconds, default 30000',
          },
          interval: {
            type: 'number',
            description: '(wait_for) Polling interval in milliseconds, default 1000',
          },
        },
        required: ['action'],
      },
    },
  }

  async execute(input: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
    switch (String(input.action)) {
      case 'new':      return this._new(input)
      case 'send':     return this._send(input)
      case 'keys':     return this._keys(input)
      case 'capture':  return this._capture(input)
      case 'wait_for': return this._waitFor(input, context)
      case 'list':     return this._list()
      case 'kill':     return this._kill(input)
      default:
        return { content: `Unknown action "${str(input.action)}". Use: new | send | keys | capture | wait_for | list | kill`, isError: true }
    }
  }

  // ── new ───────────────────────────────────────────────────────────────────

  private async _new(input: Record<string, unknown>): Promise<ToolResult> {
    const name    = str(input.session, `ovo-${Date.now()}`)
    const command = str(input.command)

    if (await sessionExists(name)) {
      return { content: `Session "${name}" already exists. Use capture to check its state, or kill to recreate.`, isError: false }
    }

    try {
      if (command) {
        // new-session -d (detached), -s name, then run command in the shell
        await tmux(`new-session -d -s ${shellEsc(name)}`)
        await tmux(`send-keys -t ${shellEsc(name)} ${shellEsc(command)} Enter`)
      } else {
        await tmux(`new-session -d -s ${shellEsc(name)}`)
      }

      return {
        content: [
          `[TmuxSession] Session "${name}" created.`,
          command ? `Running: ${command}` : 'Empty shell ready.',
          ``,
          `Next steps:`,
          `  TmuxSession({ action: "capture", session: "${name}", lines: 20 })         # check current output`,
          command ? `  TmuxSession({ action: "wait_for", session: "${name}", pattern: "..." })  # wait for prompt` : '',
          `  TmuxSession({ action: "send", session: "${name}", text: "your command" })  # send input`,
        ].filter(Boolean).join('\n'),
        isError: false,
      }
    } catch (e) {
      return { content: `Failed to create session "${name}": ${(e as Error).message}`, isError: true }
    }
  }

  // ── send ──────────────────────────────────────────────────────────────────

  private async _send(input: Record<string, unknown>): Promise<ToolResult> {
    const name = str(input.session)
    const text = str(input.text)

    if (!name) return { content: 'Error: session is required for send', isError: true }
    if (!text) return { content: 'Error: text is required for send', isError: true }

    if (!await sessionExists(name)) {
      return { content: `Session "${name}" not found. Use: TmuxSession({ action: "list" })`, isError: true }
    }

    try {
      // Split into chunks to avoid paste overflow
      const chunks = chunkText(text)
      for (const chunk of chunks) {
        await tmux(`send-keys -t ${shellEsc(name)} -l -- ${shellEsc(chunk)}`)
      }
      // Send Enter separately
      await tmux(`send-keys -t ${shellEsc(name)} Enter`)

      return {
        content: `Sent to "${name}": ${text.length > 80 ? text.slice(0, 80) + '…' : text}\nUse capture to see output.`,
        isError: false,
      }
    } catch (e) {
      return { content: `Failed to send to "${name}": ${(e as Error).message}`, isError: true }
    }
  }

  // ── keys ──────────────────────────────────────────────────────────────────

  private async _keys(input: Record<string, unknown>): Promise<ToolResult> {
    const name = str(input.session)
    const key  = str(input.key)

    if (!name) return { content: 'Error: session is required for keys', isError: true }
    if (!key)  return { content: 'Error: key is required for keys (e.g. C-c, C-d, Escape, Enter)', isError: true }

    if (!await sessionExists(name)) {
      return { content: `Session "${name}" not found. Use: TmuxSession({ action: "list" })`, isError: true }
    }

    try {
      await tmux(`send-keys -t ${shellEsc(name)} ${key}`)
      return { content: `Sent key "${key}" to "${name}".`, isError: false }
    } catch (e) {
      return { content: `Failed to send keys to "${name}": ${(e as Error).message}`, isError: true }
    }
  }

  // ── capture ───────────────────────────────────────────────────────────────

  private async _capture(input: Record<string, unknown>): Promise<ToolResult> {
    const name  = str(input.session)
    const lines = input.lines !== undefined ? Number(input.lines) : 50

    if (!name) return { content: 'Error: session is required for capture', isError: true }

    if (!await sessionExists(name)) {
      return { content: `Session "${name}" not found. Use: TmuxSession({ action: "list" })`, isError: true }
    }

    try {
      let output: string
      if (lines === 0) {
        // Full history
        output = await tmux(`capture-pane -t ${shellEsc(name)} -p -S -`)
      } else {
        // Last N lines — capture only what we need (avoid pulling full history)
        output = await tmux(`capture-pane -t ${shellEsc(name)} -p -S -${lines}`)
      }

      return {
        content: output.trim() || '(no output)',
        isError: false,
      }
    } catch (e) {
      return { content: `Failed to capture "${name}": ${(e as Error).message}`, isError: true }
    }
  }

  // ── wait_for ──────────────────────────────────────────────────────────────

  private async _waitFor(input: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
    const name     = str(input.session)
    const pattern  = str(input.pattern)
    const timeout  = Number(input.timeout  ?? 30_000)
    const interval = Number(input.interval ?? 1_000)

    if (!name)    return { content: 'Error: session is required for wait_for', isError: true }
    if (!pattern) return { content: 'Error: pattern is required for wait_for', isError: true }

    // Pre-aborted signal short-circuit — mirror the contract used by
    // WebFetch / WebSearch so the LLM gets a clear cancellation error
    // instead of an unrelated tmux error.
    if (context.signal?.aborted) {
      return { content: 'wait_for cancelled (signal already aborted).', isError: true }
    }

    if (!await sessionExists(name)) {
      return { content: `Session "${name}" not found. Use: TmuxSession({ action: "list" })`, isError: true }
    }

    let regex: RegExp
    try {
      regex = new RegExp(pattern)
    } catch {
      return { content: `Invalid regex pattern: "${pattern}"`, isError: true }
    }

    const deadline = Date.now() + timeout
    const signal = context.signal
    let lastOutput = ''

    while (Date.now() < deadline) {
      // Honor cancellation between polls too — otherwise a mid-flight
      // Ctrl+C would still wait for the next capture to finish.
      if (signal?.aborted) {
        return { content: 'wait_for cancelled.', isError: true }
      }

      try {
        const raw = await tmux(`capture-pane -t ${shellEsc(name)} -p -S -`)
        lastOutput = raw

        if (regex.test(raw)) {
          // Return last 30 lines as context
          const lines = raw.split('\n').slice(-30).join('\n')
          return {
            content: `[wait_for] Pattern "${pattern}" matched.\n\n${lines.trim()}`,
            isError: false,
          }
        }
      } catch (e) {
        return { content: `Error polling "${name}": ${(e as Error).message}`, isError: true }
      }

      // Race the inter-poll sleep against the abort signal — without
      // this a Ctrl+C fired during the sleep would only take effect on
      // the *next* capture, blowing past the user's intent.
      if (signal) {
        const aborted = await this._sleepWithAbort(interval, signal)
        if (aborted) return { content: 'wait_for cancelled.', isError: true }
      } else {
        await new Promise(r => setTimeout(r, interval))
      }
    }

    // Timeout — return last output for diagnosis
    const lastLines = lastOutput.split('\n').slice(-20).join('\n')
    return {
      content: [
        `[wait_for] Timeout after ${timeout}ms waiting for pattern "${pattern}" in session "${name}".`,
        ``,
        `Last output:`,
        lastLines.trim() || '(empty)',
        ``,
        `Troubleshooting:`,
        `  • Use capture to see full state: TmuxSession({ action: "capture", session: "${name}", lines: 50 })`,
        `  • If process is stuck, send Ctrl+C: TmuxSession({ action: "keys", session: "${name}", key: "C-c" })`,
        `  • Adjust pattern — it may be different from expected`,
      ].join('\n'),
      isError: true,
    }
  }

  /**
   * Sleep that races an AbortSignal. Returns true if the signal fired
   * during the wait, false on natural completion. Honors pre-aborted
   * signals without waiting.
   */
  private _sleepWithAbort(ms: number, signal: AbortSignal): Promise<boolean> {
    return new Promise((resolve) => {
      if (signal.aborted) return resolve(true)
      const timer = setTimeout(() => {
        signal.removeEventListener('abort', onAbort)
        resolve(false)
      }, ms)
      const onAbort = (): void => {
        clearTimeout(timer)
        resolve(true)
      }
      signal.addEventListener('abort', onAbort, { once: true })
    })
  }

  // ── list ──────────────────────────────────────────────────────────────────

  private async _list(): Promise<ToolResult> {
    try {
      const output = await tmux('list-sessions')
      if (!output) {
        return { content: 'No active tmux sessions.\nCreate one: TmuxSession({ action: "new", session: "py", command: "python3" })', isError: false }
      }
      return { content: `Active tmux sessions:\n${output}`, isError: false }
    } catch {
      return { content: 'No active tmux sessions (tmux server not running).\nCreate one: TmuxSession({ action: "new", session: "py", command: "python3" })', isError: false }
    }
  }

  // ── kill ──────────────────────────────────────────────────────────────────

  private async _kill(input: Record<string, unknown>): Promise<ToolResult> {
    const name = str(input.session)
    if (!name) return { content: 'Error: session is required for kill', isError: true }

    if (!await sessionExists(name)) {
      return { content: `Session "${name}" not found.`, isError: true }
    }

    try {
      await tmux(`kill-session -t ${shellEsc(name)}`)
      return { content: `Session "${name}" killed.`, isError: false }
    } catch (e) {
      return { content: `Failed to kill "${name}": ${(e as Error).message}`, isError: true }
    }
  }
}
