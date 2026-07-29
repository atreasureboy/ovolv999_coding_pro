/**
 * Pipe Mode — Unix pipeline integration.
 *
 * Enables ovolv999 to be used in shell pipelines:
 *   echo "explain" | ovolv999 --pipe
 *   cat file.ts | ovolv999 --pipe "add types"
 *   ovolv999 --pipe "generate tests" < file.ts
 *
 * v0.4.1 WS3: --pipe now runs the full ExecutionEngine (tools enabled)
 * via src/cli/engineAssembly.ts. This module keeps the pure pieces every
 * pipe path shares: stdin reading, prompt construction, token estimation,
 * and the FROZEN json envelope (`formatPipeOutput`) that sshRemote.ts
 * consumes — its keys are pinned by tests/pipeMode.test.ts.
 *
 * The deleted `executePipe` / `gatherProjectContext` / `parsePipeArgs`
 * belonged to the old raw one-shot path; that path survives frozen as the
 * hidden --llm-only flag in bin/ovogogogo.ts (sshRemote's latency contract).
 *
 * Exit codes (--pipe):
 *   0 = completed
 *   1 = partial / blocked / exhausted / cancelled / failed (status on stderr)
 *   2 = API error (details on stderr)
 */

import { createInterface } from 'readline'

// ── Types ───────────────────────────────────────────────────────────────────

export interface PipeOptions {
  /** User prompt (from command-line args). If omitted, stdin is the prompt. */
  prompt?: string
  /** Working directory */
  cwd: string
  /** Model to use (default: from env or 'gpt-4o') */
  model?: string
  /** Max tokens to read from stdin (default: 1MB) */
  maxStdinBytes?: number
  /** Output format */
  format?: 'text' | 'json'
  /** Whether to include file context from cwd */
  includeContext?: boolean
  /** API key (default: from env) */
  apiKey?: string
  /** Base URL (default: from env or OpenAI) */
  baseURL?: string
}

export interface PipeResult {
  /** The LLM response text */
  response: string
  /** Stdin content that was used as context */
  stdinContent: string
  /** Full prompt sent to the LLM */
  fullPrompt: string
  /** Input tokens — real costTracker values on the engine path, estimates on --llm-only */
  estimatedInputTokens: number
  /** Output tokens — real costTracker values on the engine path, estimates on --llm-only */
  estimatedOutputTokens: number
  /** Duration in ms */
  durationMs: number
}

// ── Stdin Reader ────────────────────────────────────────────────────────────

/**
 * Read all of stdin as a string.
 * Rejects if input exceeds maxBytes.
 */
export function readStdin(maxBytes = 1_048_576): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = ''
    let byteCount = 0
    let settled = false

    const rl = createInterface({
      input: process.stdin,
      terminal: false,
    })

    const timeout = setTimeout(() => {
      if (!settled) {
        settled = true
        rl.close()
        reject(new Error('stdin read timed out (10s)'))
      }
    }, 10_000)

    rl.on('line', (line: string) => {
      byteCount += Buffer.byteLength(line + '\n', 'utf8')
      if (byteCount > maxBytes) {
        if (!settled) {
          settled = true
          clearTimeout(timeout)
          rl.close()
          reject(new Error(`stdin exceeded ${maxBytes} bytes`))
        }
        return
      }
      data += line + '\n'
    })

    rl.on('close', () => {
      if (!settled) {
        settled = true
        clearTimeout(timeout)
        // Remove trailing newline if we added one
        resolve(data.endsWith('\n') ? data.slice(0, -1) : data)
      }
    })

    rl.on('error', (err: Error) => {
      if (!settled) {
        settled = true
        clearTimeout(timeout)
        reject(err)
      }
    })
  })
}

// ── Prompt Builder ──────────────────────────────────────────────────────────

/**
 * Build the full prompt from user prompt + stdin context.
 */
export function buildPrompt(prompt: string | undefined, stdinContent: string, options: PipeOptions): string {
  const parts: string[] = []

  // System context about the working directory
  if (options.includeContext !== false) {
    parts.push(`Working directory: ${options.cwd}`)
    parts.push('')
  }

  // If stdin has content, include it as context
  if (stdinContent.trim()) {
    // Detect if stdin looks like a file
    const lineCount = stdinContent.split('\n').length
    const truncated = lineCount > 1000
      ? stdinContent.split('\n').slice(0, 1000).join('\n') + '\n... (truncated)'
      : stdinContent

    parts.push('--- Input (from stdin) ---')
    parts.push(truncated)
    parts.push('--- End Input ---')
    parts.push('')
  }

  // User prompt
  if (prompt) {
    parts.push(prompt)
  } else if (stdinContent.trim()) {
    // No explicit prompt, but stdin has content — ask for analysis
    parts.push('Analyze and respond to the input above.')
  } else {
    throw new Error('No prompt or stdin input provided')
  }

  return parts.join('\n')
}

// ── Token Estimation ────────────────────────────────────────────────────────

/**
 * Rough token estimate (4 chars ≈ 1 token). Used only by the frozen
 * --llm-only raw path; the engine-backed --pipe reports real costTracker
 * usage instead.
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4)
}

// ── Output Formatter ────────────────────────────────────────────────────────

/**
 * Format a pipe result for stdout output.
 *
 * FROZEN CONTRACT: the json envelope shape `{ response, stats: {
 * inputTokens, outputTokens, durationMs } }` is consumed by sshRemote.ts
 * (via --llm-only) and pinned by tests/pipeMode.test.ts. Do not add,
 * rename, or nest keys without a versioned migration.
 */
export function formatPipeOutput(result: PipeResult, format: 'text' | 'json' = 'text'): string {
  if (format === 'json') {
    return JSON.stringify({
      response: result.response,
      stats: {
        inputTokens: result.estimatedInputTokens,
        outputTokens: result.estimatedOutputTokens,
        durationMs: result.durationMs,
      },
    }, null, 2)
  }

  // text format: just the response
  return result.response
}

// ── Help ────────────────────────────────────────────────────────────────────

/**
 * Get the help text for pipe mode. Flags mirror what bin/ovogogogo.ts
 * parseArgs actually accepts (v0.4.1: one parser owns the whole CLI).
 */
export function getPipeHelp(): string {
  return [
    'ovolv999 --pipe — Unix pipeline mode (full execution engine)',
    '',
    'Usage:',
    '  echo "prompt" | ovolv999 --pipe [options]',
    '  cat file.ts | ovolv999 --pipe "add types to this code"',
    '  ovolv999 --pipe "generate tests" < file.ts',
    '',
    'Runs the same engine as interactive mode: tools are enabled and the',
    'model can read/edit files in the working directory. stdout carries',
    'ONLY the answer; banners, progress and errors go to stderr.',
    '',
    'Options:',
    '      --cwd <dir>       Working directory (default: current)',
    '      --model <name>    Model to use (default: from env/config)',
    '      --format <fmt>    Output format: text (default) or json',
    '      --no-context      Skip the stdin/context prompt framing',
    '      --max-stdin <n>   Max stdin bytes (default: 1048576)',
    '      --base-url <url>  API base URL (overrides env/config)',
    '  -h, --help            Show this help',
    '',
    'Exit codes:',
    '  0 = task completed',
    '  1 = task ended partial/blocked/exhausted/cancelled/failed',
    '  2 = API error',
    '',
    'Examples:',
    '  echo "explain SOLID principles" | ovolv999 --pipe',
    '  cat src/parser.ts | ovolv999 --pipe "find bugs" --format json',
    '  git diff | ovolv999 --pipe "review this diff"',
    '',
    'Note: the v0.4.0 raw single-shot behavior (no tools, no engine boot)',
    'is frozen as the hidden --llm-only flag for latency-sensitive',
    'automation; new users should prefer --pipe.',
  ].join('\n')
}
