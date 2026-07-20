/**
 * Pipe Mode — Unix pipeline integration.
 *
 * Enables ovolv999 to be used in shell pipelines:
 *   echo "explain" | ovolv999 --pipe
 *   cat file.ts | ovolv999 --pipe "add types"
 *   ovolv999 --pipe "generate tests" < file.ts
 *
 * Reads stdin as context, processes with the LLM, writes result to stdout.
 * No interactive UI — purely for scripting and automation.
 *
 * Exit codes:
 *   0 = success
 *   1 = error (message on stderr)
 *   2 = API error (details on stderr)
 */

import { createInterface } from 'readline'
import { execSync } from 'child_process'
import { existsSync, readFileSync } from 'fs'
import { join, resolve } from 'path'

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
  /** Token usage estimate */
  estimatedInputTokens: number
  /** Token usage estimate */
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

// ── Context Gathering ───────────────────────────────────────────────────────

/**
 * Gather lightweight project context (file list, package.json).
 */
export function gatherProjectContext(cwd: string): string {
  const parts: string[] = []

  // package.json
  const pkgPath = join(resolve(cwd), 'package.json')
  if (existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'))
      parts.push(`Project: ${pkg.name ?? 'unnamed'} v${pkg.version ?? '0.0.0'}`)
      if (pkg.description) parts.push(`Description: ${pkg.description}`)
      if (pkg.scripts) {
        const scripts = Object.entries(pkg.scripts).slice(0, 10)
        parts.push(`Scripts: ${scripts.map(([k]) => k).join(', ')}`)
      }
    } catch { /* best-effort */ }
  }

  // Git branch
  try {
    const branch = execSync('git rev-parse --abbrev-ref HEAD', {
      cwd, encoding: 'utf8', stdio: 'pipe',
    }).trim()
    parts.push(`Git branch: ${branch}`)
  } catch { /* not a git repo */ }

  return parts.join('\n')
}

// ── Token Estimation ────────────────────────────────────────────────────────

/**
 * Rough token estimate (4 chars ≈ 1 token).
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4)
}

// ── Main Pipe Execution ─────────────────────────────────────────────────────

/**
 * Execute a pipe-mode request.
 * This function handles the full flow: read stdin → build prompt → call LLM → return result.
 *
 * The actual LLM call is delegated to a caller-provided function so this
 * module remains testable without a real API.
 */
export async function executePipe(
  options: PipeOptions,
  stdinContent: string,
  llmCall: (prompt: string, options: PipeOptions) => Promise<string>,
): Promise<PipeResult> {
  const startTime = Date.now()

  const fullPrompt = buildPrompt(options.prompt, stdinContent, options)
  const response = await llmCall(fullPrompt, options)

  return {
    response,
    stdinContent,
    fullPrompt,
    estimatedInputTokens: estimateTokens(fullPrompt),
    estimatedOutputTokens: estimateTokens(response),
    durationMs: Date.now() - startTime,
  }
}

// ── Output Formatter ────────────────────────────────────────────────────────

/**
 * Format a pipe result for stdout output.
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

// ── CLI Argument Parser ─────────────────────────────────────────────────────

/**
 * Parse pipe-mode CLI arguments.
 * Returns null if required args are missing.
 */
export function parsePipeArgs(argv: string[]): PipeOptions | null {
  const options: Partial<PipeOptions> = {}
  const promptParts: string[] = []

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--cwd' || arg === '-C') {
      options.cwd = argv[++i]
    } else if (arg === '--model' || arg === '-m') {
      options.model = argv[++i]
    } else if (arg === '--format' || arg === '-f') {
      options.format = argv[++i] as 'text' | 'json'
    } else if (arg === '--no-context') {
      options.includeContext = false
    } else if (arg === '--max-stdin') {
      options.maxStdinBytes = parseInt(argv[++i], 10)
    } else if (arg === '--base-url') {
      options.baseURL = argv[++i]
    } else if (arg === '--help' || arg === '-h') {
      // Help will be handled by caller
      return null
    } else if (!arg.startsWith('-')) {
      promptParts.push(arg)
    }
  }

  options.prompt = promptParts.join(' ').trim() || undefined
  options.cwd = options.cwd ?? process.cwd()

  return options as PipeOptions
}

/**
 * Get the help text for pipe mode.
 */
export function getPipeHelp(): string {
  return [
    'ovolv999 --pipe — Unix pipeline mode',
    '',
    'Usage:',
    '  echo "prompt" | ovolv999 --pipe [options]',
    '  cat file.ts | ovolv999 --pipe "add types to this code"',
    '  ovolv999 --pipe "generate tests" < file.ts',
    '',
    'Options:',
    '  -C, --cwd <dir>       Working directory (default: current)',
    '  -m, --model <name>    Model to use (default: gpt-4o or from env)',
    '  -f, --format <fmt>    Output format: text (default) or json',
    '      --no-context      Skip project context gathering',
    '      --max-stdin <n>   Max stdin bytes (default: 1048576)',
    '      --base-url <url>  API base URL',
    '  -h, --help            Show this help',
    '',
    'Exit codes:',
    '  0 = success',
    '  1 = error (message on stderr)',
    '  2 = API error',
    '',
    'Examples:',
    '  echo "explain SOLID principles" | ovolv999 --pipe',
    '  cat src/parser.ts | ovolv999 --pipe "find bugs" --format json',
    '  git diff | ovolv999 --pipe "review this diff"',
  ].join('\n')
}
