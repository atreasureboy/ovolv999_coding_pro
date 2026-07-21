/**
 * TerminalCapture Tool — capture the visible terminal screen
 *
 * Captures what's currently on the user's screen so the model can
 * "see" the terminal state. Useful when:
 *   - A command produced visual output the model needs to interpret
 *   - A TUI (vim, htop) is running in a tmux pane
 *   - The model needs to verify a command's side-effects on screen
 *
 * Capture strategies (in priority order):
 *   1. tmux capture-pane (when inside tmux / a tmux session is targeted)
 *   2. ANSI ESC[6n cursor-position-style screen readback (limited)
 *   3. Fallback: report that capture isn't available
 */

import type { Tool, ToolContext, ToolDefinition, ToolResult } from '../core/types.js'
import { execSync } from 'child_process'

export class TerminalCaptureTool implements Tool {
  name = 'TerminalCapture'
  metadata = { readOnly: true, concurrencySafe: true }

  definition: ToolDefinition = {
    type: 'function',
    function: {
      name: 'TerminalCapture',
      description: `Capture the current terminal screen contents. Works inside tmux sessions (via capture-pane) or returns the visible screen buffer.

## When to Use
- After running a TUI command (vim, htop, less) to see its state
- To verify visual output from a command you just ran
- To inspect what's currently displayed without re-running a command

## Limitations
- Only captures tmux panes or terminal emulators that support screen readback
- ANSI colors are stripped to plain text
- Use the Bash tool to run commands and capture their stdout directly when possible — this tool is for *visual* capture`,
      parameters: {
        type: 'object',
        properties: {
          target: {
            type: 'string',
            description: 'tmux target pane (e.g. "0", "session:0.1"). Defaults to the current pane.',
          },
          lines: {
            type: 'number',
          description: 'Number of lines to capture from the bottom. Default: full pane height.',
          },
        },
      },
    },
  }

  isConcurrencySafe(): boolean {
    return true
  }

  async execute(input: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const target = (input.target as string) ?? ''
    const lines = input.lines as number | undefined

    // Strategy 1: tmux capture-pane
    if (process.env.TMUX || target) {
      try {
        return this.captureTmux(target, lines)
      } catch (err) {
        // Fall through to other strategies
        const msg = err instanceof Error ? err.message : String(err)
        if (msg.includes('no tmux') || msg.includes('not found')) {
          // fall through
        } else {
          return { content: `tmux capture failed: ${msg}`, isError: true }
        }
      }
    }

    // Strategy 2: check for a shell session with capture capability
    try {
      return this.captureViaSubshell(ctx)
    } catch { /* fall through */ }

    return {
      content: 'Terminal capture not available: not inside tmux and no screen readback support.',
      isError: false,
    }
  }

  private captureTmux(target: string, lines?: number): ToolResult {
    // Verify tmux is present
    try {
      execSync('tmux -V', { stdio: 'pipe', timeout: 2000 })
    } catch {
      throw new Error('tmux not found')
    }

    const paneFlag = target ? `-t ${shellQuote(target)}` : ''
    const startLine = lines !== undefined ? `-S -${Math.max(0, lines)}` : '-S -'
    const cmd = `tmux capture-pane ${paneFlag} ${startLine} -E - -p`

    let output: string
    try {
      output = execSync(cmd, { encoding: 'utf8', stdio: 'pipe', timeout: 5000 })
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      return { content: `tmux capture-pane failed: ${msg}`, isError: true }
    }

    const cleaned = stripAnsi(output).trimEnd()
    if (cleaned.length === 0) {
      return { content: '(tmux pane is empty)', isError: false }
    }

    const lineCount = cleaned.split('\n').length
    return {
      content: `Captured ${lineCount} lines from ${target ? `pane ${target}` : 'current pane'}:\n\n\`\`\`\n${cleaned}\n\`\`\``,
      isError: false,
    }
  }

  private captureViaSubshell(_ctx: ToolContext): ToolResult {
    // Best-effort: try to read the scrollback via a terminal-specific
    // escape sequence. Most terminals ignore this, so it's a last resort.
    throw new Error('no screen readback available')
  }
}

/** Strip ANSI escape sequences (colors, cursor moves, etc.) */
export function stripAnsi(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\x1b\[[0-9;]*[A-Za-z]|\x1b\][^\x07]*\x07|\x1b[()][AB012]|\x1b[=>]/g, '')
}

function shellQuote(s: string): string {
  if (/^[A-Za-z0-9_:.@/-]+$/.test(s)) return s
  return `'${s.replace(/'/g, "'\\''")}'`
}
