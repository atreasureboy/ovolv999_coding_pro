/**
 * BashTool — shell command execution with proper abort support
 *
 * Key change vs the previous promisified exec() approach:
 * We use exec() in callback form so we hold a reference to the ChildProcess.
 * When context.signal fires (Ctrl+C), we kill the entire process group
 * (SIGTERM → SIGKILL after 5 s)
 */

import { exec, spawn, execSync } from 'child_process'
import type { Tool, ToolContext, ToolDefinition, ToolResult } from '../core/types.js'
import { BASH_DESCRIPTION } from '../prompts/tools.js'
import { mkdirSync, accessSync, constants } from 'fs'
import { join } from 'path'
import { checkCommandPermission } from '../core/riskClassifier.js'

const MAX_OUTPUT_LENGTH = 30_000
const DEFAULT_TIMEOUT_MS = 1_800_000  // 30 min — long-running commands default
const MAX_TIMEOUT_MS = 14_400_000    // 4 h — max for very long tasks

// Shell detection — prioritize user override, then platform default.
// On Windows: prefer Git Bash if available, fall back to cmd.exe.
// Claude Code approach: use the system's native shell, don't force bash.
function detectShell(): string {
  if (process.env.OVOGO_SHELL) return process.env.OVOGO_SHELL
  if (process.platform === 'win32') {
    // Try Git Bash (common on Windows dev machines)
    const gitBashPaths = [
      'C:\\Program Files\\Git\\bin\\bash.exe',
      'C:\\Program Files (x86)\\Git\\bin\\bash.exe',
    ]
    for (const p of gitBashPaths) {
      try { accessSync(p, constants.X_OK); return p } catch { /* not found */ }
    }
    // Fall back to cmd.exe — always available on Windows
    return process.env.ComSpec || 'cmd.exe'
  }
  return '/bin/bash'
}
const SHELL = detectShell()
const IS_WIN_CMD = SHELL.endsWith('cmd.exe')

export interface BashInput {
  command: string
  timeout?: number
  run_in_background?: boolean
  description?: string
  follow_mode?: boolean   // Stream output to user's tmux pane for spectator view
}

function truncateOutput(output: string, maxLen: number): string {
  if (output.length <= maxLen) return output
  const half = Math.floor(maxLen / 2)
  const head = output.slice(0, half)
  const tail = output.slice(output.length - half)
  return `${head}\n\n[... ${output.length - maxLen} characters truncated ...]\n\n${tail}`
}

export class BashTool implements Tool {
  name = 'Bash'

  definition: ToolDefinition = {
    type: 'function',
    function: {
      name: 'Bash',
      description: BASH_DESCRIPTION,
      parameters: {
        type: 'object',
        properties: {
          command: {
            type: 'string',
            description: 'The bash command to execute',
          },
          timeout: {
            type: 'number',
            description: `Timeout in milliseconds. Default: ${DEFAULT_TIMEOUT_MS} (30 min). Max: ${MAX_TIMEOUT_MS} (4 h). For long-running commands, prefer run_in_background:true instead of raising timeout.`,
          },
          run_in_background: {
            type: 'boolean',
            description: 'Run command in background and return immediately',
          },
          description: {
            type: 'string',
            description: 'Brief description of what this command does (shown to user)',
          },
          follow_mode: {
            type: 'boolean',
            description: 'If true, stream output to a tmux pane for real-time user viewing (spectator mode). The LLM still receives the full output after completion.',
          },
        },
        required: ['command'],
      },
    },
  }

  /**
   * Per-input concurrency check (Claude Code pattern).
   * Read-only / query commands are safe to parallelize.
   * Mutating commands (install, build, write, git push) are NOT safe.
   */
  isConcurrencySafe(input: Record<string, unknown>): boolean {
    const command = typeof input.command === 'string' ? input.command.toLowerCase() : ''
    if (!command) return false

    // Background commands still run the pattern check below — two parallel
    // `npm install` in background will corrupt node_modules just the same.

    // Safe: read-only commands
    const safePatterns = [
      /^(ls|cat|head|tail|echo|pwd|whoami|date|which|whereis|file)\b/,
      /^(git\s+(status|log|diff|branch|show|blame|remote|rev-parse|config\s+--get)\b)/,
      /^(grep|rg|find|fd)\b/,
      /^(npm\s+(list|ls|view|info|outdated)\b)/,
      /^(pnpm\s+(list|ls|why)\b)/,
      /^(node\s+--version|npm\s+--version|pnpm\s+--version|npx\s+--version)/,
      /^(npx\s+tsc\s+--noemit)/,
      /^(npx\s+eslint\s+.*--check)/,
      /^(npx\s+prettier\s+.*--check)/,
      /^(test\s|-d\s|-f\s|-e\s)/,
    ]
    for (const pattern of safePatterns) {
      if (pattern.test(command)) return true
    }

    // Unsafe: commands that modify state
    const unsafePatterns = [
      /^(npm\s+(install|i|ci|uninstall|rm|publish)\b)/,
      /^(pnpm\s+(install|add|remove|rm)\b)/,
      /^(yarn\s+(add|remove|install)\b)/,
      /^(git\s+(add|commit|push|pull|merge|rebase|reset|checkout|stash|cherry-pick)\b)/,
      /^(rm\s|mv\s|cp\s|mkdir\s|rmdir\s|chmod\s|chown\s)/,
      /^(curl\s|wget\s)/,
      /^(docker\s|kubectl\s|terraform\s)/,
      /^(npm\s+run\s|pnpm\s+run\s|yarn\s)/,
      /(\|\||&&|;)/,  // chained commands — can't guarantee safety
    ]
    for (const pattern of unsafePatterns) {
      if (pattern.test(command)) return false
    }

    // Default: conservative — treat unknown commands as unsafe
    return false
  }

  async execute(input: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
    const { command, timeout, run_in_background, follow_mode } = input as unknown as BashInput

    if (!command || typeof command !== 'string') {
      return { content: 'Error: command is required and must be a string', isError: true }
    }

    // Risk classification (only active in 'ask' or 'deny' permission mode; 'auto' = no checks)
    const riskCheck = checkCommandPermission(command, context.permissionMode)
    if (!riskCheck.allowed) {
      return { content: riskCheck.reason, isError: true }
    }
    if ('warning' in riskCheck) {
      // In ask mode, warn but proceed (CLI single-user, no interactive approval gate)
      // The warning is visible in the renderer output
    }

    const timeoutMs = Math.min(
      typeof timeout === 'number' ? timeout : DEFAULT_TIMEOUT_MS,
      MAX_TIMEOUT_MS,
    )

    // ── Background mode (fire-and-forget with auto log redirect) ─────────────
    if (run_in_background) {
      // Auto-redirect stdout/stderr to a session-scoped log file so output
      // is never lost even if the caller forgets to add `> file 2>&1`.
      const bgLogDir = context.sessionDir ? join(context.sessionDir, '.bg_logs') : join(context.cwd, '.bg_logs')
      try { mkdirSync(bgLogDir, { recursive: true }) } catch { /* best-effort */ }

      const ts = Date.now()
      const safeCmd = command.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 40)
      const logFile = join(bgLogDir, `${ts}_${safeCmd}_${Math.random().toString(36).slice(2, 6)}.log`)

      // Append redirect if the caller didn't already redirect
      const alreadyRedirected = command.includes('>') || command.includes('2>&1') || command.includes('/dev/null')
      const actualCommand = alreadyRedirected ? command : `${command} >> "${logFile}" 2>&1`

      // Use appropriate shell flags: bash uses -c, cmd.exe uses /c
      const shellArgs = IS_WIN_CMD ? ['/c', actualCommand] : ['-c', actualCommand]
      let child: ReturnType<typeof spawn>
      try {
        child = spawn(SHELL, shellArgs, {
          cwd: context.cwd,
          env: process.env,
        })
      } catch (e) {
        return { content: `Failed to start background command: ${(e as Error).message}`, isError: true }
      }
      // Prevent ENOENT crash — spawn emits async 'error' if shell binary is missing
      child.on('error', () => {})
      child.unref()

      const redirectInfo = alreadyRedirected ? '' : `\nOutput redirected to: ${logFile}`
      return {
        content: `Command started in background (PID: ${child.pid})${redirectInfo}`,
        isError: false,
      }
    }

    // ── Foreground mode with abort support ──────────────────────
    // Use exec() callback form so we can kill the child on abort.
    // Kill by process group approach.
    return new Promise<ToolResult>((resolve) => {
      let settled = false

      // ── follow_mode: set up tmux spectator pane ───────────────
      let actualCommand = command
      let followCleanup: (() => void) | null = null
      let followModeHint = ''
      if (follow_mode) {
        const followLogDir = context.sessionDir ? join(context.sessionDir, '.bg_logs') : join(context.cwd, '.bg_logs')
        try { mkdirSync(followLogDir, { recursive: true }) } catch { /* best-effort */ }
        const ts = Date.now()
        const safeCmd = command.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 40)
        const followLogFile = join(followLogDir, `${ts}_${safeCmd}_follow.log`)

        // Wrap command: tee duplicates output so the LLM captures it AND the follow log gets it
        // Use platform-appropriate syntax
        if (IS_WIN_CMD) {
          actualCommand = `${command} 1>"${followLogFile}" 2>&1`
        } else {
          actualCommand = `{ ${command}; } 2>&1 | tee -a "${followLogFile}"`
        }

        // Launch a tmux session with tail -f for user viewing
        const tmuxSessionName = `ovogo-follow-${ts}`
        let paneJoined = false
        try {
          spawn('tmux', ['new-session', '-d', '-s', tmuxSessionName, '-x', '200', '-y', '50'], {
            cwd: context.cwd,
            detached: true,
          }).on('error', () => {})
          spawn('tmux', ['send-keys', '-t', tmuxSessionName, `tail -n +1 -f "${followLogFile}"`, 'Enter'], {
            cwd: context.cwd,
          }).on('error', () => {})
          // Try to join the follow pane into the user's current tmux window
          try {
            const currentTmux = process.env.TMUX_PANE ? process.env.TMUX?.split(',')[0]?.replace(/^\//, '') : null
            if (currentTmux) {
              spawn('tmux', ['join-pane', '-t', `${currentTmux}`, '-s', `${tmuxSessionName}`, '-l', '15'], {
                cwd: context.cwd,
              }).on('error', () => {})
              paneJoined = true
            }
          } catch { /* best-effort: user can manually attach */ }

          followModeHint = paneJoined
            ? '[Spectator pane embedded in tmux]'
            : `[Spectator: tmux attach -t ${tmuxSessionName}]`

          followCleanup = () => {
            try { spawn('tmux', ['kill-session', '-t', tmuxSessionName], { detached: true }).on('error', () => {}) } catch { /* ignore */ }
          }
        } catch { /* tmux not available, degrade gracefully */ }
      }

      const child = exec(
        actualCommand,
        {
          cwd: context.cwd,
          timeout: timeoutMs,
          maxBuffer: 50 * 1024 * 1024,
          env: { ...process.env, TERM: 'dumb' },
          shell: SHELL,
        },
        (err, stdout, stderr) => {
          // Remove the abort listener to prevent it firing after process ends
          if (context.signal) {
            context.signal.removeEventListener('abort', onAbort)
          }

          // Clean up follow mode resources
          if (followCleanup) {
            followCleanup()
          }

          if (settled) return
          settled = true

          // Check if we were cancelled
          if (context.signal?.aborted) {
            const partialOut = [stdout, stderr].filter(Boolean).join('\n').trimEnd()
            const partial = partialOut ? `\n\nPartial output before cancellation:\n${truncateOutput(partialOut, 5000)}` : ''
            resolve({ content: `Command cancelled (abort signal).${partial}\n\nHint: re-run with a smaller scope, or use run_in_background:true for long commands.`, isError: true })
            return
          }

          if (!err) {
            const combined = [stdout, stderr].filter(Boolean).join('\n').trimEnd()
            const prefix = follow_mode ? `[Spectator mode: output streamed to tmux pane] ${followModeHint}\n` : ''
            resolve({ content: truncateOutput(prefix + combined, MAX_OUTPUT_LENGTH) || '(no output)', isError: false })
            return
          }

          const nodeErr = err as NodeJS.ErrnoException & {
            killed?: boolean
            signal?: string
            stdout?: string
            stderr?: string
            code?: number
          }

          if (nodeErr.killed || nodeErr.signal === 'SIGTERM') {
            const partialOut = [nodeErr.stdout ?? stdout, nodeErr.stderr ?? stderr].filter(Boolean).join('\n').trimEnd()
            const partial = partialOut ? `\n\nPartial output before timeout:\n${truncateOutput(partialOut, 5000)}` : ''
            resolve({ content: `Command timed out after ${timeoutMs / 1000}s.${partial}\n\nHint: for long-running commands, use run_in_background:true and check results with TaskGet, or raise the timeout argument.`, isError: true })
            return
          }

          // Non-zero exit — provide stdout+stderr so the LLM can diagnose
          const out = [nodeErr.stdout ?? stdout, nodeErr.stderr ?? stderr].filter(Boolean).join('\n').trimEnd()
          const exitCode = nodeErr.code ?? 1
          const prefix = follow_mode ? `[Spectator mode: output streamed to tmux pane] ${followModeHint}\n` : ''

          // Error pattern detection — help the LLM diagnose common coding errors
          let hint = ''
          const lowerOut = out.toLowerCase()
          if (lowerOut.includes('command not found')) {
            hint = '\n\n[Hint: command not found — check if the tool is installed or in PATH. Try `which <cmd>` or install it.]'
          } else if (lowerOut.includes('no such file or directory')) {
            hint = '\n\n[Hint: file/directory not found — check the path. Use Glob to find the correct location.]'
          } else if (lowerOut.includes('permission denied')) {
            hint = '\n\n[Hint: permission denied — check file permissions or try with appropriate privileges.]'
          } else if (lowerOut.includes('econnrefused') || lowerOut.includes('etimedout')) {
            hint = '\n\n[Hint: connection error — check if the service is running and the port is correct.]'
          } else if (lowerOut.includes('cannot find module') || lowerOut.includes('could not resolve')) {
            hint = '\n\n[Hint: module not found — run `npm install` or check the import path.]'
          } else if (lowerOut.includes('syntax error') || lowerOut.includes('unexpected token')) {
            hint = '\n\n[Hint: syntax error — check for missing brackets, semicolons, or incorrect syntax.]'
          }

          resolve({
            content: truncateOutput(prefix + `Exit code: ${exitCode}\n${out}${hint}`, MAX_OUTPUT_LENGTH).trimEnd(),
            isError: false,  // non-zero exit is not necessarily fatal
          })
        },
      )

      // ── Abort handler — kill process (platform-aware) ─────────
      const onAbort = () => {
        if (settled) return
        settled = true

        const pid = child.pid
        if (pid !== undefined) {
          if (process.platform === 'win32') {
            // Windows: taskkill /F /T /PID kills the process tree
            try { execSync(`taskkill /F /T /PID ${pid}`, { stdio: 'ignore', timeout: 5000 }) } catch { /* best-effort */ }
            try { child.kill() } catch { /* ignore */ }
          } else {
            // Unix: kill process group (includes subshells)
            try { process.kill(-pid, 'SIGTERM') } catch {
              try { child.kill('SIGTERM') } catch { /* ignore */ }
            }
            // SIGKILL fallback after 5s for stubborn processes
            setTimeout(() => {
              try { process.kill(-pid, 'SIGKILL') } catch {
                try { child.kill('SIGKILL') } catch { /* ignore */ }
              }
            }, 5_000)
          }
        }

        resolve({ content: 'Command cancelled.', isError: true })
      }

      if (context.signal) {
        if (context.signal.aborted) {
          onAbort()
        } else {
          context.signal.addEventListener('abort', onAbort, { once: true })
        }
      }
    })
  }
}
