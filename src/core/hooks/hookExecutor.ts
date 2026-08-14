/**
 * Hook executor — spawns a child process for a single hook command.
 *
 * Protocol (JSON stdin/stdout):
 *   - Writes one line of JSON-encoded HookInput to stdin.
 *   - Closes stdin.
 *   - Reads stdout. If the output parses as a single JSON object,
 *     treats it as HookOutput. Otherwise treats the raw text as
 *     stdout text (with a warning).
 *   - Exit code 0 → success. Non-zero → non-blocking error.
 *
 * Honors:
 *   - AbortSignal — kills the child process tree
 *   - timeout — kills the child process tree on timeout
 *   - HOOK_OUTPUT_MAX_BYTES — caps stdout read
 *
 * Best-effort: never throws to the caller. Returns a HookResult-shaped
 * struct so the runner can record success/failure for /trace.
 */

import { spawn } from 'child_process'
import {
  HOOK_DEFAULT_TIMEOUT_MS,
  HOOK_OUTPUT_MAX_BYTES,
  parseHookOutput,
  type HookInput,
  type HookOutput,
} from './hookProtocol.js'
import type { HookCommandConfig } from './hooksConfig.js'

export interface HookExecResult {
  hookName: string
  command: string
  ok: boolean
  exitCode: number | null
  signal: NodeJS.Signals | null
  durationMs: number
  timedOut: boolean
  cancelled: boolean
  output: HookOutput | null
  rawStdoutPreview?: string
  error?: string
}

interface SpawnOptions {
  shell?: boolean
  env?: NodeJS.ProcessEnv
  cwd?: string
}

function killTree(pid: number): void {
  try {
    process.kill(-pid, 'SIGKILL')
  } catch {
    try {
      process.kill(pid, 'SIGKILL')
    } catch {
      /* noop */
    }
  }
}

export async function executeHookCommand(
  cmd: HookCommandConfig,
  input: HookInput,
  options: {
    signal?: AbortSignal
    cwd?: string
    env?: NodeJS.ProcessEnv
    timeoutMs?: number
  } = {},
): Promise<HookExecResult> {
  const timeoutMs = options.signal?.aborted
    ? 0
    : options.timeoutMs ?? cmd.timeout ?? HOOK_DEFAULT_TIMEOUT_MS

  const hookName = `${cmd.command} (${input.hook_event_name})`
  const startedAt = Date.now()
  const inputJson = JSON.stringify(input)

  // Round 26 re-audit (D3): back-compat env contract from the legacy
  // flat-schema runner — hooks written against $OVOGO_TOOL_NAME /
  // $OVOGO_PROMPT / $OVOGO_TOOL_RESULT keep working alongside the CC
  // stdin-JSON protocol.
  const legacyEnv: Record<string, string> = {}
  const MAX_ENV_VALUE_LEN = 4096
  const s = (v: unknown): string | undefined =>
    typeof v === 'string' ? v.slice(0, MAX_ENV_VALUE_LEN) : undefined
  if ('tool_name' in input && typeof input.tool_name === 'string') {
    legacyEnv.OVOGO_TOOL_NAME = input.tool_name
  }
  if ('tool_input' in input) {
    const ti = s(JSON.stringify(input.tool_input ?? {}))
    if (ti) legacyEnv.OVOGO_TOOL_INPUT = ti
  }
  if ('tool_result' in input && input.tool_result && typeof input.tool_result === 'object') {
    const tr = input.tool_result as { content?: unknown; is_error?: unknown }
    const content = s(typeof tr.content === 'string' ? tr.content : '')
    if (content) legacyEnv.OVOGO_TOOL_RESULT = content
    legacyEnv.OVOGO_TOOL_IS_ERROR = String(tr.is_error === true)
  }
  if ('prompt' in input) {
    const p = s(input.prompt)
    if (p) legacyEnv.OVOGO_PROMPT = p
  }
  legacyEnv.OVOGO_HOOK_EVENT = input.hook_event_name
  legacyEnv.OVOGO_SESSION_ID = input.session_id

  if (options.signal?.aborted) {
    return {
      hookName,
      command: cmd.command,
      ok: false,
      exitCode: null,
      signal: null,
      durationMs: 0,
      timedOut: false,
      cancelled: true,
      output: null,
      error: 'aborted before start',
    }
  }

  return new Promise<HookExecResult>((resolve) => {
    let stdout = ''
    let stderr = ''
    let resolved = false

    const spawnOpts: SpawnOptions = {
      shell: true,
      env: { ...process.env, ...legacyEnv, ...options.env },
      cwd: options.cwd,
    }

    const finalize = (result: HookExecResult): void => {
      if (resolved) return
      resolved = true
      resolve(result)
    }

    let timeoutHandle: NodeJS.Timeout | null = null

    let child: ReturnType<typeof spawn>
    try {
      child = spawn(cmd.command, [], {
        ...spawnOpts,
        stdio: ['pipe', 'pipe', 'pipe'],
        detached: process.platform !== 'win32',
      })
    } catch (err) {
      resolve({
        hookName,
        command: cmd.command,
        ok: false,
        exitCode: null,
        signal: null,
        durationMs: Date.now() - startedAt,
        timedOut: false,
        cancelled: false,
        output: null,
        error: `spawn failed: ${(err as Error).message}`,
      })
      return
    }

    // The 'error' event (e.g. ENOENT) is emitted asynchronously — it MUST
    // be attached immediately after spawn so no early-return path (the
    // pre-aborted branch below) can leave it listener-less. An unhandled
    // 'error' on a ChildProcess crashes the process.
    const onAbort = (): void => {
      if (child.pid != null) killTree(child.pid)
      const rawPreview = stdout.length > 500 ? stdout.slice(0, 500) + '…' : stdout
      finalize({
        hookName,
        command: cmd.command,
        ok: false,
        exitCode: null,
        signal: 'SIGKILL',
        durationMs: Date.now() - startedAt,
        timedOut: false,
        cancelled: true,
        output: null,
        rawStdoutPreview: rawPreview,
        error: 'aborted',
      })
    }

    child.on('error', (err) => {
      if (timeoutHandle) clearTimeout(timeoutHandle)
      if (options.signal) options.signal.removeEventListener('abort', onAbort)
      finalize({
        hookName,
        command: cmd.command,
        ok: false,
        exitCode: null,
        signal: null,
        durationMs: Date.now() - startedAt,
        timedOut: false,
        cancelled: false,
        output: null,
        error: `spawn error: ${err.message}`,
      })
    })

    if (timeoutMs > 0) {
      timeoutHandle = setTimeout(() => {
        if (child.pid != null) killTree(child.pid)
        const rawPreview = stdout.length > 500 ? stdout.slice(0, 500) + '…' : stdout
        finalize({
          hookName,
          command: cmd.command,
          ok: false,
          exitCode: null,
          signal: 'SIGKILL',
          durationMs: Date.now() - startedAt,
          timedOut: true,
          cancelled: false,
          output: null,
          rawStdoutPreview: rawPreview,
          error: `timeout after ${timeoutMs}ms`,
        })
      }, timeoutMs)
    }

    if (options.signal) {
      if (options.signal.aborted) {
        // Pre-abort discovered after spawn: kill the child, clear the
        // armed timeout (previously leaked for the full timeoutMs), then
        // bail.
        if (timeoutHandle) clearTimeout(timeoutHandle)
        onAbort()
        return
      }
      options.signal.addEventListener('abort', onAbort, { once: true })
    }

    child.stdout?.setEncoding('utf8')
    child.stderr?.setEncoding('utf8')
    child.stdout?.on('data', (chunk: string) => {
      if (stdout.length < HOOK_OUTPUT_MAX_BYTES) {
        stdout += chunk
      }
    })
    child.stderr?.on('data', (chunk: string) => {
      if (stderr.length < HOOK_OUTPUT_MAX_BYTES) {
        stderr += chunk
      }
    })

    // EPIPE guard: a hook that exits without draining stdin (echo,
    // printf, …) makes the write below fail ASYNCHRONOUSLY — the
    // try/catch cannot see it, and an unhandled stream 'error' would
    // crash the whole CLI via the process-level crash handler. Swallow:
    // the hook's exit path already carries the outcome.
    child.stdin?.on('error', () => { /* best-effort: hook did not read stdin */ })

    child.on('close', (code, signal) => {
      if (timeoutHandle) clearTimeout(timeoutHandle)
      if (options.signal) options.signal.removeEventListener('abort', onAbort)
      const durationMs = Date.now() - startedAt
      const ok = code === 0 && !stderr
      const output = parseHookOutput(stdout)
      finalize({
        hookName,
        command: cmd.command,
        ok,
        exitCode: code,
        signal,
        durationMs,
        timedOut: false,
        cancelled: false,
        output,
        rawStdoutPreview: output ? undefined : stdout.slice(0, 200),
        error: ok ? undefined : stderr || `exit ${code}`,
      })
    })

    try {
      child.stdin?.write(inputJson)
      child.stdin?.end()
    } catch (err) {
      if (timeoutHandle) clearTimeout(timeoutHandle)
      if (options.signal) options.signal.removeEventListener('abort', onAbort)
      finalize({
        hookName,
        command: cmd.command,
        ok: false,
        exitCode: null,
        signal: null,
        durationMs: Date.now() - startedAt,
        timedOut: false,
        cancelled: false,
        output: null,
        error: `stdin write failed: ${(err as Error).message}`,
      })
    }
  })
}

/**
 * Run multiple hooks in parallel with a single shared abort signal.
 * Returns the per-hook results in the order they were passed in.
 */
export async function executeHooksParallel(
  cmds: HookCommandConfig[],
  input: HookInput,
  options: {
    signal?: AbortSignal
    cwd?: string
    env?: NodeJS.ProcessEnv
    timeoutMs?: number
  } = {},
): Promise<HookExecResult[]> {
  return Promise.all(cmds.map((cmd) => executeHookCommand(cmd, input, options)))
}
